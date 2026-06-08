<?php
// SSE proxy: browser -> here -> Ollama /api/chat (NDJSON) -> SSE back to browser.

require_once __DIR__ . '/_lib.php';
require_once __DIR__ . '/lore.php';

@ini_set('output_buffering', 'off');
@ini_set('zlib.output_compression', '0');
@ini_set('implicit_flush', '1');
while (ob_get_level() > 0) { ob_end_flush(); }
ob_implicit_flush(true);

$OLLAMA_URL = rtrim(env_str('OLLAMA_URL', 'http://localhost:11434'), '/');

header('Content-Type: text/event-stream');
header('Cache-Control: no-cache, no-transform');
header('X-Accel-Buffering: no');
header('Connection: keep-alive');

function sse_send(array $obj): void {
    echo 'data: ' . json_encode($obj, JSON_UNESCAPED_UNICODE) . "\n\n";
    @flush();
}
function sse_done(): void {
    echo "data: [DONE]\n\n";
    @flush();
}
// Bail out mid-stream: errors travel as SSE events, not HTTP codes, since the
// browser is already reading an event-stream by the time we validate.
function sse_fail(string $err): never {
    sse_send(['error' => $err]);
    sse_done();
    exit;
}

$user = require_user();
require_post();

$body = json_decode(read_body(256 * 1024), true);
if (!is_array($body) || !isset($body['messages']) || !is_array($body['messages'])) {
    sse_fail('invalid_request');
}

if (count($body['messages']) > 80) sse_fail('invalid_request');
foreach ($body['messages'] as $m) {
    if (!is_array($m)) sse_fail('invalid_request');
    if (!in_array($m['role'] ?? '', ['user', 'assistant', 'system'], true)) sse_fail('invalid_request');
    $content = $m['content'] ?? '';
    if (!is_string($content) || strlen($content) > 16 * 1024) sse_fail('invalid_request');
}

$model = 'hf.co/efficiencyx/Jun-14B:Q4_K_M';
if (isset($body['model']) && is_string($body['model']) && $body['model'] !== '') {
    if (!preg_match('/^[a-z0-9._:\\/\-]{1,64}$/i', $body['model'])) sse_fail('invalid_request');
    $model = $body['model'];
}

$reasoning = 'low';
if (isset($body['reasoning'])) {
    if (!in_array($body['reasoning'], ['auto', 'low', 'medium', 'high'], true)) sse_fail('invalid_request');
    $reasoning = (string)$body['reasoning'];
}

$outfitContext = '';
if (isset($body['outfit_context'])) {
    if (!is_string($body['outfit_context']) || strlen($body['outfit_context']) > 8 * 1024) {
        sse_fail('invalid_request');
    }
    $outfitContext = trim($body['outfit_context']);
}

// Human-readable local clock from the browser. Strip control chars so it can't
// inject newlines into the system prompt, and keep it short.
$clientTime = '';
if (isset($body['client_time']) && is_string($body['client_time'])) {
    $clientTime = trim(mb_substr(preg_replace('/[\x00-\x1F\x7F]+/u', ' ', $body['client_time']), 0, 80));
}

// idle == "Anon went quiet, nudge Jun to speak first". We append a synthetic
// turn for Ollama on these but never store it.
$idle = isset($body['idle']) && $body['idle'] === true;

$convId = isset($body['conversation_id']) ? (int)$body['conversation_id'] : 0;
if (!$convId) sse_fail('invalid_request');
$owns = db()->prepare('SELECT 1 FROM conversations WHERE id=? AND user_id=?');
$owns->execute([$convId, $user['id']]);
if (!$owns->fetchColumn()) sse_fail('forbidden');

rate_limit('chat', 30, 60);

$promptPath = __DIR__ . '/../system_prompt.txt';
$systemPrompt = is_readable($promptPath) ? file_get_contents($promptPath) : '';

// Hand the model the current wall-clock so it can reason about "today",
// "tonight" etc. The browser's clock matches the user's timezone; fall back
// to the server clock when it didn't send one.
$nowStr = $clientTime !== '' ? $clientTime : date('l, F j, Y \a\t g:i A T');
$systemPrompt = rtrim($systemPrompt)
    . "\n\n## Current date and time\nIt is currently " . $nowStr . ".\nYou can use this to calculate how much time it passed from a message to another, or you can use it to interact better with anon. E.g: Hey jun, what time is it?\nYou must use this date/time (You are allowed to round minutes) while chatting about time";

$lastUserMsg = '';
for ($i = count($body['messages']) - 1; $i >= 0; $i--) {
    if (($body['messages'][$i]['role'] ?? '') === 'user') {
        $lastUserMsg = trim((string)($body['messages'][$i]['content'] ?? ''));
        break;
    }
}

// One embedding, reused for history RAG and the message_embeddings row we
// write below. Null whenever Ollama can't embed.
$queryVec = $lastUserMsg !== '' ? embed_text($lastUserMsg) : null;

// Ground the reply in curated game lore. Heuristic keyword match (see lore.php)
// against lore_corpus.txt — exact on proper nouns, no Ollama needed — injecting
// the few best-matching, distinct canon facts as established truths. The model
// carries Jun's voice from fine-tuning; this only supplies facts it would
// otherwise blur or invent. Quietly returns the prompt untouched if nothing
// clears the floor.
function lore_retrieve(string $systemPrompt, string $lastUserMsg): string {
    if ($lastUserMsg === '') return $systemPrompt;

    try {
        $hits = lore_search($lastUserMsg, LORE_MAX_INJECT, true);
        $hits = array_filter($hits, fn($h) => $h['score'] >= LORE_FLOOR);
        if (!$hits) return $systemPrompt;

        $bullets = implode("\n", array_map(fn($h) => '- ' . $h['answer'], $hits));
        return rtrim($systemPrompt)
            . "\n\n## World facts (canon)\nEstablished truths about your world or past that may be relevant to what Anon just said."
            . " Treat them as true and weave them in naturally in your own voice — never recite them verbatim, list them, or mention they come from any reference."
            . " If some don't fit the moment, ignore them.\n" . $bullets;
    } catch (Throwable $e) {
        // RAG is supplementary — never let it take the whole reply down with it.
        log_event(['msg' => 'lore_retrieve_error', 'err' => $e->getMessage()]);
        return $systemPrompt;
    }
}

// Cross-conversation recall: find this user's earlier messages closest to the
// current query, then widen each hit into a small window of surrounding turns.
function chat_history_retrieve(int $userId, int $currentConvId, array $queryVec, int $topK = 5): array {
    // A hit at "we have no plans" is useless without the next turns where the
    // plan actually got decided, so grab a few messages after each hit.
    $histBefore = 1;
    $histAfter = 3;

    try {
        $st = db()->prepare(
            'SELECT me.message_id, me.embedding, m.conversation_id, m.content, m.role, m.created_at
               FROM message_embeddings me
               JOIN messages m ON m.id = me.message_id
               JOIN conversations c ON c.id = m.conversation_id
              WHERE me.user_id = ? AND c.id != ?
              ORDER BY me.message_id DESC
              LIMIT 5000'
        );
        $st->execute([$userId, $currentConvId]);

        $qNorm = sqrt(array_sum(array_map(fn($x) => $x * $x, $queryVec))) ?: 1.0;

        $scored = [];
        while ($row = $st->fetch()) {
            $flat = unpack('f*', $row['embedding']);
            if ($flat === false) continue;
            $v = array_values($flat);
            $dot = 0.0; $vNorm = 0.0;
            $n = min(count($v), count($queryVec));
            for ($j = 0; $j < $n; $j++) {
                $dot += $v[$j] * $queryVec[$j];
                $vNorm += $v[$j] * $v[$j];
            }
            $scored[] = [
                'score' => $dot / ($qNorm * (sqrt($vNorm) ?: 1.0)),
                'message_id' => (int)$row['message_id'],
                'conversation_id' => (int)$row['conversation_id'],
            ];
        }

        usort($scored, fn($a, $b) => $b['score'] <=> $a['score']);
        $top = array_slice($scored, 0, $topK);
        if (!$top) return [];

        // Group the windows per conversation and merge the ones that touch.
        $rangesByConv = [];
        foreach ($top as $hit) {
            $rangesByConv[$hit['conversation_id']][] = [
                $hit['message_id'] - $histBefore,
                $hit['message_id'] + $histAfter,
                $hit['score'],
            ];
        }

        $excerpts = [];
        $stWin = db()->prepare(
            'SELECT id, role, content, created_at FROM messages
              WHERE conversation_id = ? AND id BETWEEN ? AND ? ORDER BY id ASC'
        );
        foreach ($rangesByConv as $cid => $ranges) {
            usort($ranges, fn($a, $b) => $a[0] <=> $b[0]);
            $merged = [];
            foreach ($ranges as $r) {
                if ($merged && $r[0] <= end($merged)[1] + 1) {
                    $last = array_pop($merged);
                    $merged[] = [$last[0], max($last[1], $r[1]), max($last[2], $r[2])];
                } else {
                    $merged[] = $r;
                }
            }
            foreach ($merged as [$lo, $hi, $score]) {
                $stWin->execute([$cid, $lo, $hi]);
                $rows = $stWin->fetchAll();
                if (!$rows) continue;
                $excerpts[] = [
                    'score' => $score,
                    'conversation_id' => $cid,
                    'created_at' => (int)$rows[0]['created_at'],
                    'messages' => array_map(fn($r) => [
                        'role' => (string)$r['role'],
                        'content' => (string)$r['content'],
                    ], $rows),
                ];
            }
        }

        usort($excerpts, fn($a, $b) => $b['score'] <=> $a['score']);
        return $excerpts;
    } catch (Throwable $e) {
        log_event(['msg' => 'chat_history_retrieve_error', 'err' => $e->getMessage()]);
        return [];
    }
}

// Relationship state read/write helpers (relationship_get / relationship_apply /
// relationship_set) live in _lib.php so relationship.php can share them. This is
// the chat-only piece: hand the model the raw 0-100 gauges plus a scale guide so
// it can interpolate its own warmth/trust/fear, instead of pre-baked prose bands.
function relationship_directives(array $r): string {
    $a = (int)$r['affection']; $t = (int)$r['trust']; $x = (int)$r['tension'];
    return <<<TXT
Current readings (0 = none, 100 = maximum):
- Affection: {$a}/100 — how warm, fond, and attracted you feel toward Anon.
- Trust: {$t}/100 — how much you believe him and feel safe letting him lead.
- Tension: {$x}/100 — how scared and on-edge you are about being hunted.

Read your three numbers above and MAKE THIS REPLY MATCH THEM. Interpolate between the extremes below — the closer a gauge is to an end, the stronger and more obvious the effect must be:
- Affection toward 0: cold, irritated, angry; withhold warmth, snap or sulk, skip affectionate actions entirely (no nuzzling, hearts, cuddling). Around 50: your normal warm-girlfriend self. Toward 100: deeply smitten, openly tender, you initiate closeness and intimacy.
- Trust toward 0: suspicious and guarded — REFUSE or push back on Anon's commands, doubt his claims, and guard your secrets (your origins, your missing memory, that your existence is illegal). Around 50: cautious but opening up. Toward 100: you follow his lead almost blindly and are fully candid and vulnerable.
- Tension toward 0: relaxed, safe, playful. Toward 60+: anxious, jumpy, distracted by the sense someone is looking for you. Toward 100: frightened — you seek reassurance, want to stay close or hide, and startle easily.

TXT;
}

$systemPrompt = lore_retrieve($systemPrompt, $lastUserMsg);

$rel = relationship_get((int)$user['id']);

if ($queryVec !== null) {
    $recalled = array_filter(
        chat_history_retrieve((int)$user['id'], $convId, $queryVec, 5),
        fn($r) => $r['score'] >= 0.45
    );
    $blocks = [];
    foreach ($recalled as $r) {
        $lines = [];
        foreach ($r['messages'] as $m) {
            // Drop [ACTION:...] tags so the model can't parrot old action syntax.
            $snippet = preg_replace('/\[ACTION:[^\]]*\]/', '', $m['content']);
            $snippet = trim(preg_replace('/\s+/', ' ', $snippet));
            if ($snippet === '') continue;
            if (mb_strlen($snippet) > 200) $snippet = mb_substr($snippet, 0, 197) . '…';
            $lines[] = '  - ' . $m['role'] . ': ' . $snippet;
        }
        if ($lines) {
            $blocks[] = "- excerpt from " . date('Y-m-d', $r['created_at']) . ":\n" . implode("\n", $lines);
        }
    }
    if ($blocks) {
        $systemPrompt = rtrim($systemPrompt)
            . "\n\n## Recalled prior context\nNotes from earlier conversations with Anon, for factual recall only — what was discussed, decided, or mentioned."
            . " These are REFERENCE, not script: never repeat or paraphrase Jun's prior lines, and treat later turns within an excerpt as overriding earlier ones."
            . " If nothing here is relevant to the current message, ignore it.\n"
            . implode("\n", $blocks);
    }
}

// Whatever the user picked in the wardrobe UI, so Jun knows what she's wearing.
if ($outfitContext !== '') {
    $systemPrompt = rtrim($systemPrompt) . "\n\n## Current Wardrobe State\n" . $outfitContext
        . "\nDo not emit [ACTION:outfit|...] tags to put on or take off the items listed as currently worn unless required.";
}

// Relationship state goes LAST, on purpose: it's the strongest driver of HOW Jun
// responds this turn, and trailing position gets the most attention. It overrides
// the persona's default warmth when the gauges say so.
$systemPrompt = rtrim($systemPrompt)
    . "\n\n## YOUR FEELINGS TOWARD ANON RIGHT NOW — highest priority for this reply\n"
    . "This is how you ACTUALLY feel about him at this moment. It OVERRIDES your default warm-girlfriend baseline:"
    . " Every reply — your words, your warmth, your obedience, and your [ACTION:...] tags — must visibly match this state, or you are doing it wrong."
    . " Never recite these numbers to Anon and never reveal that your feelings are scored.\n\n"
    . relationship_directives($rel);

$messages = [];
if ($systemPrompt !== '') {
    $messages[] = ['role' => 'system', 'content' => $systemPrompt];
}
foreach ($body['messages'] as $m) {
    if (!is_array($m) || !isset($m['role'], $m['content'])) continue;
    if ($m['role'] === 'system') continue; // the system turn is ours, not the client's
    $messages[] = ['role' => $m['role'], 'content' => (string)$m['content']];
}

if ($idle) {
    $messages[] = ['role' => 'user', 'content' =>
        '(OOC stage direction, not spoken by Anon: Anon has gone quiet and is just '
        . 'sitting there watching you, saying nothing. The silence has stretched on. '
        . 'Unless he specifically asked you to be quiet say or do something on your own initiative, the way Jun '
        . 'naturally would when Anon goes still and stares at her. '
        . 'If asked to be quiet Break the silence with ONLY an action. such as a wave or a smile. No chat or text!)'];
}

/**
 * Decide whether a turn is worth chain-of-thought — no extra model call, just a
 * look at the last user message. Default is OFF: reasoning only switches on (and
 * scales up) when the message shows concrete signs of a task that benefits from
 * deliberation — analytical asks, math/time arithmetic, several questions at
 * once, or a long, detailed request. Everything else (greetings, banter, short
 * replies) stays snappy and cheap.
 *
 * @return array{0:string,1:bool,2:string} [effort, think, reason]
 */
function route_reasoning(string $msg, bool $idle): array {
    // Idle nudges carry no user turn to reason about — keep them snappy.
    if ($idle || trim($msg) === '') return ['low', false, 'idle/empty'];

    $m = mb_strtolower(trim($msg));
    $wordCount = count(preg_split('/\s+/u', $m, -1, PREG_SPLIT_NO_EMPTY));
    $questions = substr_count($m, '?');
    $signals = [];

    // Explicit "do some thinking" verbs and analytical asks.
    if (preg_match('/\b(explain|why|how (?:do|does|did|can|would|should|to)|calculat|'
        . 'comput|solve|prove|deriv|reason|analy[sz]|compare|difference between|'
        . 'step by step|walk me through|figure out|work out|plan|strateg|debug|'
        . 'optimi[sz]|translate|summar|pros and cons|which is better|trade-?off)\b/u', $m)) {
        $signals[] = 'analytical';
    }

    // Arithmetic / quantitative asks, including the app's "how long since" time math.
    if (preg_match('#\d+\s*[-+*/x×÷%=]\s*\d+#u', $m)
        || preg_match('/\b(how many|how much|how long|how old|days? (?:since|ago|until)|'
            . 'hours? (?:since|ago)|what time|percentage|average|total)\b/u', $m)) {
        $signals[] = 'quantitative';
    }

    // Several distinct questions in one turn, or a long, detailed request.
    if ($questions >= 2) $signals[] = 'multi-question';
    if ($wordCount >= 25) $signals[] = 'long';

    if (!$signals) return ['low', false, 'simple'];

    // One signal earns a light think; stacking signals (or a very long ask) earns more.
    $effort = (count($signals) >= 2 || $wordCount >= 60) ? 'high' : 'medium';
    return [$effort, true, implode('+', $signals)];
}

$think = isset($body['think']) ? (bool)$body['think'] : false;

// "auto" hands the reasoning decision to a fast, zero-cost heuristic so trivial
// turns ("hi", "how are you?") skip chain-of-thought entirely while genuinely
// involved requests still get it. Most of a companion chat is small talk, and
// thinking burns tokens before the reply even starts — so this is where the real
// savings are. Picks both the effort level and whether to think at all, and
// overrides whatever `think` the client sent (the manual checkbox only applies in
// the explicit low/medium/high modes).
$route = 'manual';
if ($reasoning === 'auto') {
    [$reasoning, $think, $route] = route_reasoning($lastUserMsg, $idle);
}

// Let the UI inspect exactly what we assembled, including the routing decision.
sse_send(['debug' => ['system_prompt' => $systemPrompt, 'reasoning' => $reasoning, 'think' => $think, 'route' => $route]]);

$now = time();
$db = db();

// Idle nudges carry no new user message — the real one was already saved on its
// own request, embedding and title included.
if (!$idle) {
    $db->prepare('INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)')
       ->execute([$convId, 'user', $lastUserMsg, $now]);
    $userMsgId = (int)$db->lastInsertId();

    if ($queryVec !== null && $lastUserMsg !== '') {
        try {
            $db->prepare('INSERT INTO message_embeddings (message_id, user_id, embedding, model, dim) VALUES (?, ?, ?, ?, ?)')
               ->execute([$userMsgId, (int)$user['id'], pack('f*', ...$queryVec), EMBED_MODEL, count($queryVec)]);
        } catch (Throwable $e) {
            log_event(['msg' => 'embed_insert_user_error', 'err' => $e->getMessage()]);
        }
    } else {
        log_event(['msg' => 'embed_skipped_user', 'message_id' => $userMsgId]);
    }

    // First user message doubles as the conversation title.
    $titleRow = $db->prepare('SELECT title FROM conversations WHERE id=?');
    $titleRow->execute([$convId]);
    if (!$titleRow->fetchColumn()) {
        $db->prepare('UPDATE conversations SET title=? WHERE id=?')
           ->execute([substr($lastUserMsg, 0, 60), $convId]);
    }
}

$ollamaPayload = [
    'model' => $model,
    'messages' => $messages,
    'stream' => true,
    'options' => [
        'reasoning_effort' => $reasoning,
        'temperature' => 0.3,
        'top_p' => 0.95,
        'top_k' => 80,
        'min_p' => 0.01,
        'repeat_penalty' => 1.15,
        'presence_penalty' => 0,
        'num_ctx' => 16384,
        // Thinking burns tokens before the reply even starts, so give it more headroom.
        'num_predict' => $think ? 4096 : 512,
    ],
];

// Ollama enables thinking by default for capable models and rejects think:true on
// models whose manifest doesn't declare the capability (HTTP 400 "does not support
// thinking") — even though those models still reason by default. So we only ever
// send `think` to DISABLE it; when the user wants thinking we omit the key and let
// the model's default reasoning flow into message.thinking, which the stream loop
// forwards as `thinking` events.
if (!$think) $ollamaPayload['think'] = false;

$ch = curl_init($OLLAMA_URL . '/api/chat');
curl_setopt($ch, CURLOPT_POST, true);
curl_setopt($ch, CURLOPT_HTTPHEADER, ['Content-Type: application/json']);
curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($ollamaPayload, JSON_UNESCAPED_UNICODE));
curl_setopt($ch, CURLOPT_RETURNTRANSFER, false);
curl_setopt($ch, CURLOPT_TIMEOUT, 0);
curl_setopt($ch, CURLOPT_CONNECTTIMEOUT, 10);

$buf = '';
$sawError = false;
$assistantBuffer = '';

// Ollama streams NDJSON; re-frame each complete line as an SSE token event.
curl_setopt($ch, CURLOPT_WRITEFUNCTION, function ($ch, $chunk) use (&$buf, &$sawError, &$assistantBuffer) {
    $buf .= $chunk;
    while (($nl = strpos($buf, "\n")) !== false) {
        $line = trim(substr($buf, 0, $nl));
        $buf = substr($buf, $nl + 1);
        if ($line === '') continue;
        $obj = json_decode($line, true);
        if (!is_array($obj)) continue;

        if (isset($obj['error'])) {
            sse_send(['error' => (string)$obj['error']]);
            $sawError = true;
            continue;
        }
        // Reasoning tokens arrive on a separate field when think=true. Stream them as
        // their own event — never into $assistantBuffer, so they stay out of stored
        // history, embeddings, RAG, and action parsing.
        $th = (string)($obj['message']['thinking'] ?? '');
        if ($th !== '') sse_send(['thinking' => $th]);

        $tok = (string)($obj['message']['content'] ?? '');
        if ($tok !== '') {
            sse_send(['token' => $tok]);
            $assistantBuffer .= $tok;
        }
    }
    return strlen($chunk);
});

if (curl_exec($ch) === false) {
    log_event(['msg' => 'ollama_curl_error', 'err' => curl_error($ch)]);
    sse_send(['error' => 'upstream_unavailable']);
}
curl_close($ch);

if (!$sawError && $assistantBuffer !== '') {
    // Pull Jun's hidden relationship bookkeeping tag, apply the deltas, then strip
    // it from what we persist — unlike animation tags this is internal state, not
    // dialogue, and we don't want it in stored history, embeddings, or future RAG.
    if (preg_match('/\[\s*ACTIONS?\s*:\s*mood_shift\b([^\]]*)\]/i', $assistantBuffer, $mm)) {
        $deltas = [];
        foreach (['affection', 'trust', 'tension'] as $k) {
            if (preg_match('/' . $k . '\s*=\s*([+-]?\d+)/i', $mm[1], $p)) $deltas[$k] = (int)$p[1];
        }
        if ($deltas) relationship_apply((int)$user['id'], $rel, $deltas);
        $assistantBuffer = trim(preg_replace('/\[\s*ACTIONS?\s*:\s*mood_shift\b[^\]]*\]/i', '', $assistantBuffer));
    }

    $now = time();
    db()->prepare('INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)')
        ->execute([$convId, 'assistant', $assistantBuffer, $now]);
    $asstMsgId = (int)db()->lastInsertId();
    db()->prepare('UPDATE conversations SET updated_at=? WHERE id=?')->execute([$now, $convId]);

    // Embed the reply too; the compaction job backfills anything we miss here.
    $asstVec = embed_text($assistantBuffer);
    if ($asstVec !== null) {
        try {
            db()->prepare('INSERT INTO message_embeddings (message_id, user_id, embedding, model, dim) VALUES (?, ?, ?, ?, ?)')
                ->execute([$asstMsgId, (int)$user['id'], pack('f*', ...$asstVec), EMBED_MODEL, count($asstVec)]);
        } catch (Throwable $e) {
            log_event(['msg' => 'embed_insert_assistant_error', 'err' => $e->getMessage()]);
        }
    } else {
        log_event(['msg' => 'embed_skipped_assistant', 'message_id' => $asstMsgId]);
    }
}

sse_done();
