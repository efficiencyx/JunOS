<?php
// SSE proxy: client -> Ollama /api/chat (NDJSON stream) -> SSE to browser.

require_once __DIR__ . '/_lib.php';

@ini_set('output_buffering', 'off');
@ini_set('zlib.output_compression', '0');
@ini_set('implicit_flush', '1');
while (ob_get_level() > 0) { ob_end_flush(); }
ob_implicit_flush(true);

// Ollama base URL: env-configurable so the PHP container can reach the
// ollama service over the docker network. Defaults to localhost for the
// bare-metal `php -S` setup.
$OLLAMA_URL = rtrim(omega_env('OLLAMA_URL', 'http://localhost:11434'), '/');

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

$user = omega_require_user();
omega_require_post();

$raw = omega_read_body(256 * 1024);
$body = json_decode($raw, true);
if (!is_array($body) || !isset($body['messages']) || !is_array($body['messages'])) {
    sse_send(['error' => 'invalid_request']);
    sse_done();
    exit;
}

// ── Input validation ──────────────────────────────────────────────────────────

// messages[] length ≤ 80
if (count($body['messages']) > 80) {
    sse_send(['error' => 'invalid_request']);
    sse_done();
    exit;
}

// Validate each message
foreach ($body['messages'] as $m) {
    if (!is_array($m)) {
        sse_send(['error' => 'invalid_request']);
        sse_done();
        exit;
    }
    $role = $m['role'] ?? '';
    // Allow system here just to filter it out later; only user/assistant pass through
    if (!in_array($role, ['user', 'assistant', 'system'], true)) {
        sse_send(['error' => 'invalid_request']);
        sse_done();
        exit;
    }
    $content = $m['content'] ?? '';
    if (!is_string($content) || strlen($content) > 16 * 1024) {
        sse_send(['error' => 'invalid_request']);
        sse_done();
        exit;
    }
}

// model: optional, must match safe pattern if present
$model = 'hf.co/efficiencyx/Jun-14B:Q4_K_M';
if (isset($body['model']) && is_string($body['model']) && $body['model'] !== '') {
    if (!preg_match('/^[a-z0-9._:\\/\-]{1,64}$/i', $body['model'])) {
        sse_send(['error' => 'invalid_request']);
        sse_done();
        exit;
    }
    $model = $body['model'];
}

// reasoning: optional enum
$reasoning = 'low';
if (isset($body['reasoning'])) {
    if (!in_array($body['reasoning'], ['low', 'medium', 'high'], true)) {
        sse_send(['error' => 'invalid_request']);
        sse_done();
        exit;
    }
    $reasoning = (string)$body['reasoning'];
}

// outfit_context: optional, max 8 KB
$outfitContext = '';
if (isset($body['outfit_context'])) {
    if (!is_string($body['outfit_context']) || strlen($body['outfit_context']) > 8 * 1024) {
        sse_send(['error' => 'invalid_request']);
        sse_done();
        exit;
    }
    $outfitContext = trim($body['outfit_context']);
}

// client_time: optional human-readable local time from the browser. Single line,
// short. Control chars/newlines stripped so it can't disrupt the system prompt.
$clientTime = '';
if (isset($body['client_time']) && is_string($body['client_time'])) {
    $ct = preg_replace('/[\x00-\x1F\x7F]+/u', ' ', $body['client_time']);
    $clientTime = trim(mb_substr($ct, 0, 80));
}

// idle: optional boolean. When true the client isn't sending a new user message —
// it's reporting that Anon has gone quiet, and wants Jun to break the silence.
// We append a synthetic stage-direction turn for Ollama but never persist it.
$idle = isset($body['idle']) && $body['idle'] === true;

// ── Conversation ownership check ──────────────────────────────────────────────

$convId = isset($body['conversation_id']) ? (int)$body['conversation_id'] : 0;
if (!$convId) {
    sse_send(['error' => 'invalid_request']);
    sse_done();
    exit;
}
$owns = omega_db()->prepare('SELECT 1 FROM conversations WHERE id=? AND user_id=?');
$owns->execute([$convId, $user['id']]);
if (!$owns->fetchColumn()) {
    sse_send(['error' => 'forbidden']);
    sse_done();
    exit;
}

// ── Rate limit ────────────────────────────────────────────────────────────────

omega_rate_limit('chat', 30, 60);

// ── System prompt ─────────────────────────────────────────────────────────────

$promptPath = __DIR__ . '/../system_prompt.txt';
$systemPrompt = is_readable($promptPath) ? file_get_contents($promptPath) : '';

// Give the model awareness of the current date and time so it can reason about
// time-relative references ("today", "tonight", "what day is it"). Prefer the
// browser's local time (matches the user's clock + timezone); fall back to the
// server clock if the client didn't send one.
$nowStr = $clientTime !== '' ? $clientTime : date('l, F j, Y \a\t g:i A T');
$systemPrompt = rtrim($systemPrompt)
    . "\n\n## Current date and time\nIt is currently " . $nowStr . ".\nYou can use this to calculate how muchh time it passed from a message to another, or you can use it to interact better with anon. E.g: Hey jun, what time is it?\nYou must use this date/time (You are allowed to round minutes) while chatting about time";

// Find last user message — used for embedding (voice RAG + history RAG + live append).
$lastUserMsg = '';
for ($i = count($body['messages']) - 1; $i >= 0; $i--) {
    if (($body['messages'][$i]['role'] ?? '') === 'user') {
        $lastUserMsg = trim((string)($body['messages'][$i]['content'] ?? ''));
        break;
    }
}

// Embed once; reuse for voice retrieval, history retrieval, and the live-append
// of the user message's row in message_embeddings. Null on any failure.
$queryVec = $lastUserMsg !== '' ? omega_embed($lastUserMsg) : null;

// Retrieve top-K voice exemplars from the embedded corpus and append them.
// No-ops silently if the index hasn't been built yet or the query vec is null.
function voice_retrieve(string $systemPrompt, ?array $queryVec): string {
    try {
        if ($queryVec === null) return $systemPrompt;

        $metaPath   = __DIR__ . '/../voice_meta.json';
        $corpusPath = __DIR__ . '/../voice_corpus.txt';
        $binPath    = __DIR__ . '/../voice_index.bin';

        if (!is_readable($metaPath) || !is_readable($corpusPath) || !is_readable($binPath)) {
            return $systemPrompt;
        }

        // Load index (warm-cache via APCu if available).
        static $idx = null;
        if ($idx === null && function_exists('apcu_fetch')) {
            $idx = apcu_fetch('voice_index_v1') ?: null;
        }
        if ($idx === null) {
            $meta  = json_decode(file_get_contents($metaPath), true);
            $lines = file($corpusPath, FILE_IGNORE_NEW_LINES);
            $dim   = (int)($meta['dim'] ?? 0);
            $count = (int)($meta['count'] ?? 0);
            if ($dim <= 0 || $count <= 0) return $systemPrompt;

            $binContent = file_get_contents($binPath);
            if ($binContent === false || strlen($binContent) === 0) return $systemPrompt;
            $flat    = unpack('f*', $binContent);
            $vectors = [];
            for ($i = 0; $i < $count; $i++) {
                $v = [];
                $base = $i * $dim + 1; // unpack is 1-indexed
                for ($j = 0; $j < $dim; $j++) $v[] = $flat[$base + $j];
                $vectors[] = $v;
            }
            $idx = ['lines' => $lines, 'vectors' => $vectors, 'model' => $meta['model'], 'dim' => $dim];
            if (function_exists('apcu_store')) apcu_store('voice_index_v1', $idx, 0);
        }

        // Cosine similarity over all vectors, pick top 8.
        $qNorm = 0.0;
        foreach ($queryVec as $x) $qNorm += $x * $x;
        $qNorm = sqrt($qNorm) ?: 1.0;

        $scores = [];
        foreach ($idx['vectors'] as $i => $v) {
            $dot = 0.0; $vNorm = 0.0;
            foreach ($v as $j => $vj) { $dot += $vj * $queryVec[$j]; $vNorm += $vj * $vj; }
            $scores[$i] = $dot / ($qNorm * (sqrt($vNorm) ?: 1.0));
        }
        arsort($scores);
        $top = array_slice($scores, 0, 8, true);

        // Build voice section and append to system prompt.
        $bullets = [];
        foreach ($top as $i => $_) $bullets[] = '- "' . $idx['lines'][$i] . '"';

        return rtrim($systemPrompt)
            . "\n\n## Voice Reference\nExamples of how Jun phrased things in similar moments."
            . " Match the cadence, register, and brevity. Do not copy verbatim.\n"
            . implode("\n", $bullets);

    } catch (Throwable $e) {
        omega_log(['msg' => 'voice_retrieve_error', 'err' => $e->getMessage()]);
        return $systemPrompt;
    }
}

// Retrieve prior cross-conversation messages from this user's history that are
// semantically close to the current query. Returns rows with cosine scores.
function chat_history_retrieve(int $userId, int $currentConvId, array $queryVec, int $topK = 5): array {
    // Window size around each hit (messages before / after, in same conversation).
    // Expansion captures follow-up refinement: e.g. "we have no plans" matches the
    // query, but the actual plan was decided in the next few messages.
    $histBefore = 1;
    $histAfter  = 3;

    try {
        $st = omega_db()->prepare(
            'SELECT me.message_id, me.embedding, m.conversation_id, m.content, m.role, m.created_at
               FROM message_embeddings me
               JOIN messages m ON m.id = me.message_id
               JOIN conversations c ON c.id = m.conversation_id
              WHERE me.user_id = ? AND c.id != ?
              ORDER BY me.message_id DESC
              LIMIT 5000'
        );
        $st->execute([$userId, $currentConvId]);

        $qNorm = 0.0;
        foreach ($queryVec as $x) $qNorm += $x * $x;
        $qNorm = sqrt($qNorm) ?: 1.0;

        $scored = [];
        while ($row = $st->fetch()) {
            $flat = unpack('f*', $row['embedding']);
            if ($flat === false) continue;
            $v = array_values($flat);
            $dot = 0.0; $vNorm = 0.0;
            $n = min(count($v), count($queryVec));
            for ($j = 0; $j < $n; $j++) {
                $dot   += $v[$j] * $queryVec[$j];
                $vNorm += $v[$j] * $v[$j];
            }
            $score = $dot / ($qNorm * (sqrt($vNorm) ?: 1.0));
            $scored[] = [
                'score'           => $score,
                'message_id'      => (int)$row['message_id'],
                'conversation_id' => (int)$row['conversation_id'],
                'content'         => (string)$row['content'],
                'role'            => (string)$row['role'],
                'created_at'      => (int)$row['created_at'],
            ];
        }

        usort($scored, fn($a, $b) => $b['score'] <=> $a['score']);
        $top = array_slice($scored, 0, $topK);
        if (!$top) return [];

        // Expand each hit into a window of surrounding messages from the same
        // conversation, then merge overlapping windows per conversation into
        // contiguous id-ranges. The result is a list of conversation excerpts.
        $rangesByConv = [];
        foreach ($top as $hit) {
            $cid = $hit['conversation_id'];
            $lo  = $hit['message_id'] - $histBefore;
            $hi  = $hit['message_id'] + $histAfter;
            $rangesByConv[$cid][] = [$lo, $hi, $hit['score']];
        }

        $excerpts = [];
        $stWin = omega_db()->prepare(
            'SELECT id, role, content, created_at
               FROM messages
              WHERE conversation_id = ? AND id BETWEEN ? AND ?
              ORDER BY id ASC'
        );
        foreach ($rangesByConv as $cid => $ranges) {
            // Merge overlapping ranges.
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
                    'score'           => $score,
                    'conversation_id' => $cid,
                    'created_at'      => (int)$rows[0]['created_at'],
                    'messages'        => array_map(fn($r) => [
                        'role'    => (string)$r['role'],
                        'content' => (string)$r['content'],
                    ], $rows),
                ];
            }
        }

        usort($excerpts, fn($a, $b) => $b['score'] <=> $a['score']);
        return $excerpts;
    } catch (Throwable $e) {
        omega_log(['msg' => 'chat_history_retrieve_error', 'err' => $e->getMessage()]);
        return [];
    }
}

$systemPrompt = voice_retrieve($systemPrompt, $queryVec);

// Inject recalled prior context from previous conversations of this user.
if ($queryVec !== null) {
    $recalled = chat_history_retrieve((int)$user['id'], $convId, $queryVec, 5);
    $recalled = array_filter($recalled, fn($r) => $r['score'] >= 0.45);
    if (!empty($recalled)) {
        $blocks = [];
        foreach ($recalled as $r) {
            $date  = date('Y-m-d', $r['created_at']);
            $lines = [];
            foreach ($r['messages'] as $m) {
                $snippet = preg_replace('/\s+/', ' ', $m['content']);
                // Strip [ACTION:...] tags from recalled assistant text so the
                // model can't echo old action syntax verbatim.
                $snippet = preg_replace('/\[ACTION:[^\]]*\]/', '', $snippet);
                $snippet = trim(preg_replace('/\s+/', ' ', $snippet));
                if ($snippet === '') continue;
                if (mb_strlen($snippet) > 200) $snippet = mb_substr($snippet, 0, 197) . '…';
                $lines[] = '  - ' . $m['role'] . ': ' . $snippet;
            }
            if ($lines) $blocks[] = "- excerpt from " . $date . ":\n" . implode("\n", $lines);
        }
        if ($blocks) {
            $systemPrompt = rtrim($systemPrompt)
                . "\n\n## Recalled prior context\nNotes from earlier conversations with Anon, for factual recall only — what was discussed, decided, or mentioned."
                . " These are REFERENCE, not script: never repeat or paraphrase Jun's prior lines, and treat later turns within an excerpt as overriding earlier ones."
                . " If nothing here is relevant to the current message, ignore it.\n"
                . implode("\n", $blocks);
        }
    }
}

// Append current outfit state (chosen by the user via the UI) so the model
// knows what Jun is wearing without being told in chat.
// TODO: if $outfitContext is empty (future API-only clients that don't run the
// JS Outfit module), read preferences.data for this user and synthesize the
// describe string from `omega.outfit.v1` server-side. See Plan 5.
if ($outfitContext !== '') {
    $systemPrompt = rtrim($systemPrompt) . "\n\n## Current Wardrobe State\n" . $outfitContext
        . "\nDo not emit [ACTION:outfit|...] tags to put on or take off the items listed as currently worn unless required.";
}

$messages = [];
if ($systemPrompt !== '') {
    $messages[] = ['role' => 'system', 'content' => $systemPrompt];
}
foreach ($body['messages'] as $m) {
    if (!is_array($m) || !isset($m['role'], $m['content'])) continue;
    if ($m['role'] === 'system') continue; // system is server-controlled
    $messages[] = ['role' => $m['role'], 'content' => (string)$m['content']];
}

// Idle nudge: server-controlled stage direction so Jun speaks first. Framed as an
// out-of-character cue (not Anon's words) so the model narrates/speaks on its own.
if ($idle) {
    $messages[] = ['role' => 'user', 'content' =>
        '(OOC stage direction, not spoken by Anon: Anon has gone quiet and is just '
        . 'sitting there watching you, saying nothing. The silence has stretched on. '
        . 'Break it yourself — say or do something on your own initiative, the way Jun '
        . 'naturally would when Anon goes still and stares at her.)'];
}

$think = isset($body['think']) ? (bool)$body['think'] : false;

// Emit the fully-assembled system prompt (time context + RAG + outfit) as a
// debug event so the UI can show exactly what was sent to the model.
sse_send(['debug' => ['system_prompt' => $systemPrompt]]);

// ── Persist incoming user message ─────────────────────────────────────────────

$now = time();
$db  = omega_db();

// On an idle nudge there's no new user message to store — the previous user turn
// (and its embedding/title) was already persisted on its own request.
if (!$idle) {
    $db->prepare(
        'INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)'
    )->execute([$convId, 'user', $lastUserMsg, $now]);
    $userMsgId = (int)$db->lastInsertId();

    // Live-append embedding for the user message (reuse $queryVec computed above).
    if ($queryVec !== null && $lastUserMsg !== '') {
        try {
            $blob = pack('f*', ...$queryVec);
            $db->prepare(
                'INSERT INTO message_embeddings (message_id, user_id, embedding, model, dim) VALUES (?, ?, ?, ?, ?)'
            )->execute([$userMsgId, (int)$user['id'], $blob, OMEGA_EMBED_MODEL, count($queryVec)]);
        } catch (Throwable $e) {
            omega_log(['msg' => 'embed_insert_user_error', 'err' => $e->getMessage()]);
        }
    } else {
        omega_log(['msg' => 'embed_skipped_user', 'message_id' => $userMsgId]);
    }

    $titleRow = $db->prepare('SELECT title FROM conversations WHERE id=?');
    $titleRow->execute([$convId]);
    if (!$titleRow->fetchColumn()) {
        $db->prepare('UPDATE conversations SET title=? WHERE id=?')
           ->execute([substr($lastUserMsg, 0, 60), $convId]);
    }
}

$ollamaPayload = [
    'model'    => $model,
    'messages' => $messages,
    'stream'   => true,
    'think'    => $think,
    'options'  => [
        'reasoning_effort' => $reasoning,
        'temperature'      => 0.3,
        'top_p'            => 0.95,
        'top_k'            => 80,
        'min_p'            => 0.01,
        'repeat_penalty'   => 1.15,
        'presence_penalty' => 0,
        'num_ctx'          => 16384,
        'num_predict'      => 512,
    ],
];

$ch = curl_init($OLLAMA_URL . '/api/chat');
curl_setopt($ch, CURLOPT_POST, true);
curl_setopt($ch, CURLOPT_HTTPHEADER, ['Content-Type: application/json']);
curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($ollamaPayload, JSON_UNESCAPED_UNICODE));
curl_setopt($ch, CURLOPT_RETURNTRANSFER, false);
curl_setopt($ch, CURLOPT_TIMEOUT, 0);
curl_setopt($ch, CURLOPT_CONNECTTIMEOUT, 10);

$buf             = '';
$emittedAny      = false;
$sawError        = false;
$assistantBuffer = '';

curl_setopt($ch, CURLOPT_WRITEFUNCTION, function ($ch, $chunk) use (&$buf, &$emittedAny, &$sawError, &$assistantBuffer) {
    $buf .= $chunk;
    while (($nl = strpos($buf, "\n")) !== false) {
        $line = substr($buf, 0, $nl);
        $buf = substr($buf, $nl + 1);
        $line = trim($line);
        if ($line === '') continue;
        $obj = json_decode($line, true);
        if (!is_array($obj)) continue;

        if (isset($obj['error'])) {
            sse_send(['error' => (string)$obj['error']]);
            $sawError = true;
            continue;
        }
        if (isset($obj['message']['content'])) {
            $tok = (string)$obj['message']['content'];
            if ($tok !== '') {
                sse_send(['token' => $tok]);
                $emittedAny = true;
                $assistantBuffer .= $tok;
            }
        }
        if (!empty($obj['done'])) {
            // Let outer code emit DONE after curl returns.
        }
    }
    return strlen($chunk);
});

$ok = curl_exec($ch);
if ($ok === false) {
    $err = curl_error($ch);
    omega_log(['msg' => 'ollama_curl_error', 'err' => $err]);
    sse_send(['error' => 'upstream_unavailable']);
}
curl_close($ch);

if (!$sawError && $assistantBuffer !== '') {
    $now = time();
    omega_db()->prepare(
        'INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)'
    )->execute([$convId, 'assistant', $assistantBuffer, $now]);
    $asstMsgId = (int)omega_db()->lastInsertId();
    omega_db()->prepare('UPDATE conversations SET updated_at=? WHERE id=?')
              ->execute([$now, $convId]);

    // Live-append embedding for the assistant message. Compaction backfills failures.
    $asstVec = omega_embed($assistantBuffer);
    if ($asstVec !== null) {
        try {
            $blob = pack('f*', ...$asstVec);
            omega_db()->prepare(
                'INSERT INTO message_embeddings (message_id, user_id, embedding, model, dim) VALUES (?, ?, ?, ?, ?)'
            )->execute([$asstMsgId, (int)$user['id'], $blob, OMEGA_EMBED_MODEL, count($asstVec)]);
        } catch (Throwable $e) {
            omega_log(['msg' => 'embed_insert_assistant_error', 'err' => $e->getMessage()]);
        }
    } else {
        omega_log(['msg' => 'embed_skipped_assistant', 'message_id' => $asstMsgId]);
    }
}

sse_done();
