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

$model = 'hf.co/efficiencyx/Jun-Lora-v2-GGUF:Q4_K_M';
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

// The system message must stay byte-identical across turns: Ollama reuses the
// KV cache for the longest unchanged prompt PREFIX, and the system message is
// the very first thing in the prompt. Anything per-turn (clock, lore, recall,
// wardrobe, gauges) goes into $contextParts instead, which is sent as a
// trailing system message AFTER the history - so only the tail of the prompt
// is re-evaluated each turn instead of the whole conversation.
$promptPath = __DIR__ . '/../system_prompt.txt';
$systemPrompt = is_readable($promptPath) ? rtrim(file_get_contents($promptPath)) : '';



function tool_catalog(): array {
    return [
        [
            'type' => 'function',
            'function' => [
                'name' => 'search_recent_chats',
                'description' => 'Search Anon and Jun\'s saved conversation history for relevant recent messages. Use this when Anon asks what was discussed before, wants recall across chats, or references something you do not remember.',
                'parameters' => [
                    'type' => 'object',
                    'properties' => [
                        'query' => ['type' => 'string', 'description' => 'What to search for in prior chats.'],
                        'limit' => ['type' => 'integer', 'description' => 'Maximum number of matching messages to return, from 1 to 8.'],
                    ],
                    'required' => ['query'],
                ],
            ],
        ],
        [
            'type' => 'function',
            'function' => [
                'name' => 'memory_write',
                'description' => 'Append a durable note to Anon\'s private memory file. Use when Anon explicitly asks you to remember something, or when he shares a stable preference/fact that will help future conversations.',
                'parameters' => [
                    'type' => 'object',
                    'properties' => [
                        'memory' => ['type' => 'string', 'description' => 'One concise, self-contained fact or preference to remember.'],
                        'category' => ['type' => 'string', 'description' => 'Short category such as preference, personal_fact, plan, boundary, or relationship.'],
                    ],
                    'required' => ['memory'],
                ],
            ],
        ],
        [
            'type' => 'function',
            'function' => [
                'name' => 'web_fetch',
                'description' => 'Fetch a public HTTP or HTTPS URL for current real-world data. Use only when Anon asks for current/latest/live information or gives a URL to inspect.',
                'parameters' => [
                    'type' => 'object',
                    'properties' => [
                        'url' => ['type' => 'string', 'description' => 'Public http(s) URL to fetch.'],
                    ],
                    'required' => ['url'],
                ],
            ],
        ],
    ];
}

function tool_context_block(): string {
    return <<<TXT
## Tools you can call when useful
You may ask the system to run tools before answering. Use tools only when they materially improve the reply, and summarize tool results naturally.
Available tools:
- search_recent_chats(query, limit): searches saved recent conversations for Anon's prior messages and Jun's replies.
- memory_write(memory, category): appends a concise durable note to Anon's private memory file when he asks you to remember something or shares a stable preference/fact.
- web_fetch(url): fetches a public web page or API URL for live/current real-world information. If Anon asks for latest data but does not provide a URL, ask him for a URL or say you need one.

Interesting future tools the app could add: weather lookup, calculator/unit conversion, calendar/reminder creation, local file/library search, image generation, text-to-speech voice controls, smart-home/webhook actions, code runner sandbox, and location/place lookup.
TXT;
}


function should_offer_tools(string $msg): bool {
    $m = mb_strtolower(trim($msg));
    if (preg_match('/https?:\/\//i', $msg)) return true;
    if (preg_match('/\b(remember this|remember that|please remember|can you remember|memorize|save this|make a note|note this|my favorite|i prefer|i like|i dislike)\b/u', $m)) return true;
    if (preg_match('/\b(search|recall|look up|fetch|open|read|check)\b/u', $m) && preg_match('/\b(chat history|previous chats?|earlier|last time|website|url|web|internet|latest|current|news|today)\b/u', $m)) return true;
    if (preg_match('/\b(what did|what was|what were|did i|did we|do you remember)\b/u', $m) && preg_match('/\b(before|previously|earlier|last time|last chat|past chats?)\b/u', $m)) return true;
    return false;
}

function memory_file_path(int $userId): string {
    $dir = rtrim(env_str('MEMORY_DIR', '/var/lib/jun/memory'), '/');
    if (!is_dir($dir)) @mkdir($dir, 0700, true);
    if (!is_dir($dir) || !is_writable($dir)) {
        throw new RuntimeException('memory_dir_unwritable');
    }
    return $dir . '/user-' . $userId . '.jsonl';
}

function memory_append(int $userId, string $memory, string $category): array {
    $memory = trim(preg_replace('/\s+/', ' ', $memory));
    $category = trim(preg_replace('/[^a-z0-9]+/i', '_', $category), '_');
    if ($category === '') $category = 'general';
    if ($memory === '') return ['error' => 'memory_required'];
    if (mb_strlen($memory) > 800) $memory = mb_substr($memory, 0, 797) . '…';
    if (mb_strlen($category) > 40) $category = mb_substr($category, 0, 40);

    $entry = ['created_at' => time(), 'category' => $category, 'memory' => $memory];
    $path = memory_file_path($userId);
    $fp = fopen($path, 'ab');
    if ($fp === false) return ['error' => 'memory_open_failed'];
    flock($fp, LOCK_EX);
    fwrite($fp, json_encode($entry, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) . "\n");
    flock($fp, LOCK_UN);
    fclose($fp);
    @chmod($path, 0600);
    return ['ok' => true, 'entry' => $entry];
}

function memory_recent_context(int $userId, int $limit = 20): string {
    try {
        $path = memory_file_path($userId);
        if (!is_readable($path)) return '';
        $lines = file($path, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
        if (!$lines) return '';
        $lines = array_slice($lines, -$limit);
        $bullets = [];
        foreach ($lines as $line) {
            $obj = json_decode($line, true);
            if (!is_array($obj) || trim((string)($obj['memory'] ?? '')) === '') continue;
            $date = isset($obj['created_at']) ? date('Y-m-d', (int)$obj['created_at']) : 'unknown-date';
            $cat = (string)($obj['category'] ?? 'general');
            $mem = trim(preg_replace('/\s+/', ' ', (string)$obj['memory']));
            $bullets[] = '- [' . $date . ' / ' . $cat . '] ' . $mem;
        }
        if (!$bullets) return '';
        return "## Durable memory notes\nPrivate notes you saved about Anon for continuity. Use them when relevant; do not mention the memory file unless Anon asks.\n" . implode("\n", $bullets);
    } catch (Throwable $e) {
        log_event(['msg' => 'memory_context_error', 'err' => $e->getMessage()]);
        return '';
    }
}

function resolve_public_http_url(string $url): array {
    $parts = parse_url($url);
    if (!is_array($parts) || !in_array(strtolower($parts['scheme'] ?? ''), ['http', 'https'], true)) return ['error' => 'url_must_be_public_http_or_https'];
    if (($parts['user'] ?? '') !== '' || ($parts['pass'] ?? '') !== '') return ['error' => 'url_credentials_not_allowed'];
    $host = $parts['host'] ?? '';
    if ($host === '' || strlen($url) > 2048) return ['error' => 'url_invalid'];

    $ips = [];
    if (filter_var($host, FILTER_VALIDATE_IP)) {
        $ips[] = $host;
    } else {
        $records = @dns_get_record($host, DNS_A + DNS_AAAA);
        if (!$records) return ['error' => 'dns_lookup_failed'];
        foreach ($records as $r) {
            $ip = $r['ip'] ?? $r['ipv6'] ?? '';
            if ($ip !== '') $ips[] = $ip;
        }
    }
    $ips = array_values(array_unique($ips));
    if (!$ips) return ['error' => 'dns_lookup_failed'];
    foreach ($ips as $ip) {
        if (filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE) === false) {
            return ['error' => 'url_must_resolve_to_public_ip'];
        }
    }

    $scheme = strtolower((string)$parts['scheme']);
    $port = (int)($parts['port'] ?? ($scheme === 'https' ? 443 : 80));
    if (($scheme === 'http' && $port !== 80) || ($scheme === 'https' && $port !== 443)) return ['error' => 'non_standard_port_not_allowed'];
    return ['ok' => true, 'host' => $host, 'port' => $port, 'ip' => $ips[0]];
}

function make_absolute_url(string $base, string $location): string {
    $location = trim($location);
    if (preg_match('/^https?:\/\//i', $location)) return $location;
    $b = parse_url($base);
    if (!is_array($b) || empty($b['scheme']) || empty($b['host'])) return $location;
    if (substr($location, 0, 2) === '//') return $b['scheme'] . ':' . $location;
    if (substr($location, 0, 1) === '/') return $b['scheme'] . '://' . $b['host'] . $location;
    $path = $b['path'] ?? '/';
    $dir = preg_replace('#/[^/]*$#', '/', $path) ?: '/';
    return $b['scheme'] . '://' . $b['host'] . $dir . $location;
}

function web_fetch_public(string $url): array {
    $maxBytes = 512 * 1024;
    $current = $url;
    for ($hop = 0; $hop <= 3; $hop++) {
        $resolved = resolve_public_http_url($current);
        if (empty($resolved['ok'])) return $resolved;
        $body = '';
        $tooLarge = false;
        $location = '';
        $ch = curl_init($current);
        $opts = [
            CURLOPT_FOLLOWLOCATION => false,
            CURLOPT_RETURNTRANSFER => false,
            CURLOPT_TIMEOUT => 12,
            CURLOPT_CONNECTTIMEOUT => 5,
            CURLOPT_USERAGENT => 'JunToolFetcher/1.0',
            CURLOPT_RESOLVE => [$resolved['host'] . ':' . $resolved['port'] . ':' . $resolved['ip']],
            CURLOPT_HEADERFUNCTION => function ($ch, string $header) use (&$location): int {
                if (stripos($header, 'Location:') === 0) $location = trim(substr($header, 9));
                return strlen($header);
            },
            CURLOPT_WRITEFUNCTION => function ($ch, string $chunk) use (&$body, &$tooLarge, $maxBytes): int {
                if (strlen($body) + strlen($chunk) > $maxBytes) { $tooLarge = true; return 0; }
                $body .= $chunk;
                return strlen($chunk);
            },
        ];
        if (defined('CURLOPT_PROTOCOLS')) $opts[CURLOPT_PROTOCOLS] = CURLPROTO_HTTP | CURLPROTO_HTTPS;
        if (defined('CURLOPT_REDIR_PROTOCOLS')) $opts[CURLOPT_REDIR_PROTOCOLS] = CURLPROTO_HTTP | CURLPROTO_HTTPS;
        curl_setopt_array($ch, $opts);
        $ok = curl_exec($ch);
        $err = curl_error($ch);
        $code = (int)curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        $ctype = (string)curl_getinfo($ch, CURLINFO_CONTENT_TYPE);
        curl_close($ch);
        if ($ok === false) return ['error' => $tooLarge ? 'response_too_large' : 'fetch_failed', 'detail' => $err];
        if (in_array($code, [301, 302, 303, 307, 308], true) && $location !== '') {
            if ($hop === 3) return ['error' => 'too_many_redirects'];
            $current = make_absolute_url($current, $location);
            continue;
        }
        $text = trim(preg_replace('/\s+/', ' ', strip_tags($body)));
        return ['status' => $code, 'content_type' => $ctype, 'url' => $current, 'bytes_read' => strlen($body), 'text' => mb_substr($text, 0, 6000)];
    }
    return ['error' => 'too_many_redirects'];
}

function run_tool_call(string $name, array $args, array $user, int $convId): string {
    try {
        if ($name === 'search_recent_chats') {
            $query = trim((string)($args['query'] ?? ''));
            $limit = max(1, min(8, (int)($args['limit'] ?? 5)));
            if ($query === '') return json_encode(['error' => 'query_required']);
            $like = '%' . str_replace(['%', '_'], ['\\%', '\\_'], $query) . '%';
            $st = db()->prepare(
                'SELECT m.role, m.content, m.created_at, c.title, c.id AS conversation_id
                   FROM messages m JOIN conversations c ON c.id = m.conversation_id
                  WHERE c.user_id = ? AND c.id != ? AND m.content LIKE ? ESCAPE \'\\\'
                  ORDER BY m.created_at DESC, m.id DESC LIMIT ?'
            );
            $st->bindValue(1, (int)$user['id'], PDO::PARAM_INT);
            $st->bindValue(2, $convId, PDO::PARAM_INT);
            $st->bindValue(3, $like, PDO::PARAM_STR);
            $st->bindValue(4, $limit, PDO::PARAM_INT);
            $st->execute();
            $rows = array_map(function ($r) {
                $content = trim(preg_replace('/\s+/', ' ', (string)$r['content']));
                if (mb_strlen($content) > 500) $content = mb_substr($content, 0, 497) . '…';
                return ['date' => date('Y-m-d H:i', (int)$r['created_at']), 'conversation_id' => (int)$r['conversation_id'], 'title' => (string)($r['title'] ?? ''), 'role' => (string)$r['role'], 'content' => $content];
            }, $st->fetchAll());
            return json_encode(['results' => $rows], JSON_UNESCAPED_UNICODE);
        }
        if ($name === 'memory_write') {
            $memory = (string)($args['memory'] ?? '');
            $category = (string)($args['category'] ?? 'general');
            return json_encode(memory_append((int)$user['id'], $memory, $category), JSON_UNESCAPED_UNICODE);
        }
        if ($name === 'web_fetch') {
            $url = trim((string)($args['url'] ?? ''));
            return json_encode(web_fetch_public($url), JSON_UNESCAPED_UNICODE);
        }
        return json_encode(['error' => 'unknown_tool']);
    } catch (Throwable $e) {
        log_event(['msg' => 'tool_call_error', 'tool' => $name, 'err' => $e->getMessage()]);
        return json_encode(['error' => 'tool_failed']);
    }
}

function ollama_chat_once(string $url, array $payload): array {
    $ch = curl_init($url . '/api/chat');
    curl_setopt_array($ch, [CURLOPT_POST => true, CURLOPT_HTTPHEADER => ['Content-Type: application/json'], CURLOPT_POSTFIELDS => json_encode($payload, JSON_UNESCAPED_UNICODE), CURLOPT_RETURNTRANSFER => true, CURLOPT_TIMEOUT => 45, CURLOPT_CONNECTTIMEOUT => 10]);
    $resp = curl_exec($ch);
    if ($resp === false) { $err = curl_error($ch); curl_close($ch); return ['error' => $err]; }
    curl_close($ch);
    $obj = json_decode($resp, true);
    return is_array($obj) ? $obj : ['error' => 'bad_json'];
}

$lastUserMsg = '';
for ($i = count($body['messages']) - 1; $i >= 0; $i--) {
    if (($body['messages'][$i]['role'] ?? '') === 'user') {
        $lastUserMsg = trim((string)($body['messages'][$i]['content'] ?? ''));
        break;
    }
}
$toolsOffered = should_offer_tools($lastUserMsg);

$contextParts = [];

// Hand the model the current wall-clock so it can reason about "today",
// "tonight" etc. The browser's clock matches the user's timezone; fall back
// to the server clock when it didn't send one.
$nowStr = $clientTime !== '' ? $clientTime : date('l, F j, Y \a\t g:i A T');
if ($toolsOffered) $contextParts[] = tool_context_block();
$memoryBlock = memory_recent_context((int)$user['id']);
if ($memoryBlock !== '') $contextParts[] = $memoryBlock;

$contextParts[] = "## Current date and time\nIt is currently " . $nowStr . ".\nYou can use this to calculate how much time it passed from a message to another, or you can use it to interact better with anon. E.g: Hey jun, what time is it?\nYou must use this date/time (You are allowed to round minutes) while chatting about time";

// One embedding, reused for history RAG and the message_embeddings row we
// write below. Null whenever Ollama can't embed.
$queryVec = $lastUserMsg !== '' ? embed_text($lastUserMsg) : null;

// Ground the reply in curated game lore. Heuristic keyword match (see lore.php)
// against lore_corpus.txt - exact on proper nouns, no Ollama needed - returning
// the few best-matching, distinct canon facts as a context block. The model
// carries Jun's voice from fine-tuning; this only supplies facts it would
// otherwise blur or invent. Quietly returns '' if nothing clears the floor.
function lore_retrieve(string $lastUserMsg): string {
    if ($lastUserMsg === '') return '';

    try {
        $hits = lore_search($lastUserMsg, LORE_MAX_INJECT, true);
        $hits = array_filter($hits, fn($h) => $h['score'] >= LORE_FLOOR);
        if (!$hits) return '';

        $bullets = implode("\n", array_map(fn($h) => '- ' . $h['answer'], $hits));
        return "## World facts (canon)\nEstablished truths about your world or past that may be relevant to what Anon just said."
            . " Treat them as true and weave them in naturally in your own voice - never recite them verbatim, list them, or mention they come from any reference."
            . " If some don't fit the moment, ignore them.\n" . $bullets;
    } catch (Throwable $e) {
        // RAG is supplementary - never let it take the whole reply down with it.
        log_event(['msg' => 'lore_retrieve_error', 'err' => $e->getMessage()]);
        return '';
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
- Affection: {$a}/100 - how warm, fond, and attracted you feel toward Anon.
- Trust: {$t}/100 - how much you believe him and feel safe letting him lead.
- Tension: {$x}/100 - how scared and on-edge you are about being hunted.

Read your three numbers above and MAKE THIS REPLY MATCH THEM. Interpolate between the extremes below - the closer a gauge is to an end, the stronger and more obvious the effect must be:
- Affection toward 0: cold, irritated, angry; withhold warmth, snap or sulk, skip affectionate actions entirely (no nuzzling, hearts, cuddling). Around 50: your normal warm-girlfriend self. Toward 100: deeply smitten, openly tender, you initiate closeness and intimacy.
- Trust toward 0: suspicious and guarded - REFUSE or push back on Anon's commands, doubt his claims, and guard your secrets (your origins, your missing memory, that your existence is illegal). Around 50: cautious but opening up. Toward 100: you follow his lead almost blindly and are fully candid and vulnerable.
- Tension toward 0: relaxed, safe, playful. Toward 60+: anxious, jumpy, distracted by the sense someone is looking for you. Toward 100: frightened - you seek reassurance, want to stay close or hide, and startle easily.

TXT;
}

$loreBlock = lore_retrieve($lastUserMsg);
if ($loreBlock !== '') $contextParts[] = $loreBlock;

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
            // Drop action tags (compact [A:...] and legacy [ACTION:...]) so the
            // model can't parrot old action syntax.
            $snippet = preg_replace('/\[\s*A(?:CTIONS?)?\s*:[^\]]*\]/i', '', $m['content']);
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
        $contextParts[] = "## Recalled prior context\nNotes from earlier conversations with Anon, for factual recall only - what was discussed, decided, or mentioned."
            . " These are REFERENCE, not script: never repeat or paraphrase Jun's prior lines, and treat later turns within an excerpt as overriding earlier ones."
            . " If nothing here is relevant to the current message, ignore it.\n"
            . implode("\n", $blocks);
    }
}

// Whatever the user picked in the wardrobe UI, so Jun knows what she's wearing.
if ($outfitContext !== '') {
    $contextParts[] = "## Current Wardrobe State\n" . $outfitContext
        . "\nDo not emit [A:outfit|...] tags to put on or take off the items listed as currently worn unless required.";
}

// Relationship state goes LAST, on purpose: it's the strongest driver of HOW Jun
// responds this turn, and trailing position gets the most attention. It overrides
// the persona's default warmth when the gauges say so.
$contextParts[] = "## YOUR FEELINGS TOWARD ANON RIGHT NOW - highest priority for this reply\n"
    . "This is how you ACTUALLY feel about him at this moment. It OVERRIDES your default warm-girlfriend baseline:"
    . " Every reply - your words, your warmth, your obedience, and your [A:...] tags - must visibly match this state, or you are doing it wrong."
    . " Never recite these numbers to Anon and never reveal that your feelings are scored.\n\n"
    . relationship_directives($rel);

$liveContext = "# Live context for THIS reply (from the system, not spoken by Anon)\n\n"
    . implode("\n\n", $contextParts);

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

// The live context goes in the FINAL user turn rather than its own message.
// Trailing position is on purpose, twice over: (a) it's the only per-turn part
// of the prompt, so everything before it - static system prompt + stable
// history - stays KV-cached between turns; (b) the end of the prompt gets the
// most attention, which is exactly where the live gauges belong.
//
// It must NOT be a separate trailing message. Strict chat templates (Mistral /
// Ministral) raise a hard error on a system role that isn't first, AND on two
// same-role turns in a row - so both a trailing `system` and a trailing second
// `user` message make Ollama 500 and the reply comes back empty. Folding the
// context into the last user message keeps the user/assistant alternation those
// templates require; it self-labels as "(from the system, not spoken by Anon)"
// so the model still reads it as a directive. The last message is always a user
// turn here (the new message, or the idle stage-direction above).
$lastIdx = count($messages) - 1;
if ($lastIdx >= 0 && $messages[$lastIdx]['role'] === 'user') {
    $messages[$lastIdx]['content'] .= "\n\n" . $liveContext;
} else {
    $messages[] = ['role' => 'user', 'content' => $liveContext];
}

/**
 * Decide whether a turn is worth chain-of-thought - no extra model call, just a
 * look at the last user message. Default is OFF: reasoning only switches on (and
 * scales up) when the message shows concrete signs of a task that benefits from
 * deliberation - analytical asks, math/time arithmetic, several questions at
 * once, or a long, detailed request. Everything else (greetings, banter, short
 * replies) stays snappy and cheap.
 *
 * @return array{0:string,1:bool,2:string} [effort, think, reason]
 */
function route_reasoning(string $msg, bool $idle): array {
    // Idle nudges carry no user turn to reason about - keep them snappy.
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
// thinking burns tokens before the reply even starts - so this is where the real
// savings are. Picks both the effort level and whether to think at all, and
// overrides whatever `think` the client sent (the manual checkbox only applies in
// the explicit low/medium/high modes).
$route = 'manual';
if ($reasoning === 'auto') {
    [$reasoning, $think, $route] = route_reasoning($lastUserMsg, $idle);
}

// Let the UI inspect exactly what we assembled, including the routing decision.
// system_prompt is the static prefix message; live_context is the trailing
// per-turn system message.
sse_send(['debug' => ['system_prompt' => $systemPrompt, 'live_context' => $liveContext, 'reasoning' => $reasoning, 'think' => $think, 'route' => $route]]);

$now = time();
$db = db();

// Idle nudges carry no new user message - the real one was already saved on its
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
        'temperature' => 1,
        'top_p' => 0.95,
        'top_k' => 80,
        'min_p' => 0.01,
        'repeat_penalty' => 1.15,
        'presence_penalty' => 0,
        'num_ctx' => 16384,
        // num_predict caps TOTAL generated tokens, and a reasoning model's hidden
        // chain-of-thought counts against it. A verbose reasoner (gpt-oss at medium/
        // high effort) can burn the whole budget on the thinking channel and stop
        // with done_reason=length BEFORE emitting any answer - the user then sees a
        // thought process and an empty reply. So when thinking we lift the cap (-1)
        // and let num_ctx bound generation; non-thinking turns stay snappy.
        'num_predict' => $think ? -1 : 512,
    ],
];

// Ollama enables thinking by default for capable models and rejects think:true on
// models whose manifest doesn't declare the capability (HTTP 400 "does not support
// thinking") - even though those models still reason by default. So we only ever
// send `think` to DISABLE it; when the user wants thinking we omit the key and let
// the model's default reasoning flow into message.thinking, which the stream loop
// forwards as `thinking` events.
if (!$think) $ollamaPayload['think'] = false;

// Give the model a bounded chance to call tools before the final streamed reply.
// We only run this preflight for explicit recall/current-data/memory asks,
// avoiding a second Ollama request on ordinary companion-chat small talk. Tool
// role messages stay inside this preflight only; the final streamed call gets a
// plain context block so strict chat templates don't need to render tool roles.
if ($toolsOffered) {
    $toolMessages = $messages;
    $toolResultBlocks = [];
    for ($toolRound = 0; $toolRound < 2; $toolRound++) {
        $toolPayload = $ollamaPayload;
        $toolPayload['messages'] = $toolMessages;
        $toolPayload['stream'] = false;
        $toolPayload['tools'] = tool_catalog();
        unset($toolPayload['think']);
        $toolResp = ollama_chat_once($OLLAMA_URL, $toolPayload);
        $calls = $toolResp['message']['tool_calls'] ?? [];
        if (!is_array($calls) || !$calls) break;
        $toolMessages[] = [
            'role' => 'assistant',
            'content' => (string)($toolResp['message']['content'] ?? ''),
            'tool_calls' => $calls,
        ];
        foreach (array_slice($calls, 0, 4) as $call) {
            $fn = $call['function'] ?? [];
            $name = (string)($fn['name'] ?? '');
            $args = $fn['arguments'] ?? [];
            if (is_string($args)) {
                $decoded = json_decode($args, true);
                $args = is_array($decoded) ? $decoded : [];
            }
            if (!is_array($args)) $args = [];
            $result = run_tool_call($name, $args, $user, $convId);
            $toolMessages[] = ['role' => 'tool', 'content' => $result];
            $toolResultBlocks[] = '- ' . $name . ': ' . mb_substr($result, 0, 6500);
        }
    }
    if ($toolResultBlocks) {
        $toolContext = "\n\n## Tool results for THIS reply\nUse these tool outputs as fresh context. Do not expose raw JSON unless Anon asks.\n" . implode("\n", $toolResultBlocks);
        $lastMsgIdx = count($messages) - 1;
        if ($lastMsgIdx >= 0 && $messages[$lastMsgIdx]['role'] === 'user') {
            $messages[$lastMsgIdx]['content'] .= $toolContext;
        } else {
            $messages[] = ['role' => 'user', 'content' => $toolContext];
        }
        $ollamaPayload['messages'] = $messages;
    }
}

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
$stats = null;
$doneReason = '';

// Ollama streams NDJSON; re-frame each complete line as an SSE token event.
curl_setopt($ch, CURLOPT_WRITEFUNCTION, function ($ch, $chunk) use (&$buf, &$sawError, &$assistantBuffer, &$stats, &$doneReason) {
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
        // The terminal line (done:true) carries timing/token counters. Forward them so
        // the dev HUD can show tokens/s without us computing anything client-side.
        if (!empty($obj['done'])) {
            $doneReason = (string)($obj['done_reason'] ?? '');
        }
        if (!empty($obj['done']) && isset($obj['eval_count'])) {
            $stats = [
                'eval_count'           => (int)($obj['eval_count'] ?? 0),
                'eval_duration'        => (int)($obj['eval_duration'] ?? 0),
                'prompt_eval_count'    => (int)($obj['prompt_eval_count'] ?? 0),
                'prompt_eval_duration' => (int)($obj['prompt_eval_duration'] ?? 0),
                'total_duration'       => (int)($obj['total_duration'] ?? 0),
                'load_duration'        => (int)($obj['load_duration'] ?? 0),
            ];
        }
        // Reasoning tokens arrive on a separate field when think=true. Stream them as
        // their own event - never into $assistantBuffer, so they stay out of stored
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

if ($stats !== null) {
    $stats['num_ctx'] = (int)($ollamaPayload['options']['num_ctx'] ?? 0);
    $stats['model'] = $model;
    sse_send(['stats' => $stats]);
}

// A reply with no answer text - never let it surface as silence. The usual cause
// is a reasoning model that spent its whole generation budget on the thinking
// channel (done_reason=length); flag that distinctly so the UI can hint at it.
if (!$sawError && $assistantBuffer === '') {
    log_event(['msg' => 'empty_reply', 'model' => $model, 'done_reason' => $doneReason, 'think' => $think]);
    sse_send(['error' => $doneReason === 'length' ? 'reply_truncated_in_thinking' : 'empty_reply']);
}

if (!$sawError && $assistantBuffer !== '') {
    // Pull Jun's hidden relationship bookkeeping tag, apply the deltas, then strip
    // it from what we persist - unlike animation tags this is internal state, not
    // dialogue, and we don't want it in stored history, embeddings, or future RAG.
    if (preg_match('/\[\s*A(?:CTIONS?)?\s*:\s*mood_shift\b([^\]]*)\]/i', $assistantBuffer, $mm)) {
        $deltas = [];
        foreach (['affection', 'trust', 'tension'] as $k) {
            if (preg_match('/' . $k . '\s*=\s*([+-]?\d+)/i', $mm[1], $p)) $deltas[$k] = (int)$p[1];
        }
        if ($deltas) relationship_apply((int)$user['id'], $rel, $deltas);
        $assistantBuffer = trim(preg_replace('/\[\s*A(?:CTIONS?)?\s*:\s*mood_shift\b[^\]]*\]/i', '', $assistantBuffer));
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
