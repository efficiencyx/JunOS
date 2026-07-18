<?php

require_once __DIR__ . '/_lib.php';
require_once __DIR__ . '/lore.php';

@ini_set('output_buffering', 'off');
@ini_set('zlib.output_compression', '0');
@ini_set('implicit_flush', '1');
while (ob_get_level() > 0) { ob_end_flush(); }
ob_implicit_flush(true);

$PROVIDER = ai_provider();

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

$model = default_chat_model();
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

$clientTime = '';
if (isset($body['client_time']) && is_string($body['client_time'])) {
    $clientTime = trim(mb_substr(preg_replace('/[\x00-\x1F\x7F]+/u', ' ', $body['client_time']), 0, 80));
}

$idle = isset($body['idle']) && $body['idle'] === true;
$ephemeral = !empty($body['ephemeral']);

$convId = isset($body['conversation_id']) ? (int)$body['conversation_id'] : 0;
if (!$convId) sse_fail('invalid_request');
$owns = db()->prepare('SELECT 1 FROM conversations WHERE id=? AND user_id=?');
$owns->execute([$convId, $user['id']]);
if (!$owns->fetchColumn()) sse_fail('forbidden');

rate_limit('chat', 30, 60);

// Keep the static system prompt byte-identical so Ollama reuses its KV-cache prefix.
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
                'name' => 'list_recent_chats',
                'description' => 'Recap Anon and Jun\'s most recent past conversations, each with a short snippet, WITHOUT needing a search query. Use when Anon asks what you two have been talking about lately, wants to catch up, or asks "what did we do recently" with no specific topic.',
                'parameters' => [
                    'type' => 'object',
                    'properties' => [
                        'limit' => ['type' => 'integer', 'description' => 'How many recent conversations to recap, from 1 to 10.'],
                    ],
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
                'name' => 'web_search',
                'description' => 'Search the web for current real-world information. Use when Anon asks about current/latest/live info, news, facts you are unsure of, or anything outside your knowledge.',
                'parameters' => [
                    'type' => 'object',
                    'properties' => [
                        'query' => ['type' => 'string', 'description' => 'Search query, like you would type into Google.'],
                    ],
                    'required' => ['query'],
                ],
            ],
        ],
    ];
}

function tool_context_block(): string {
    return <<<TXT
## Tools you can call when useful
You may ask the system to run tools before answering. Use tools only when they materially improve the reply, and summarize tool results naturally.
When a tool would help, you MUST reply in TWO parts: (1) FIRST a short spoken line to Anon in your own voice (under 8 words) - and this text MUST appear in your message content; (2) THEN make the tool call. Never emit a tool call with empty message content - always speak first. After the tool result comes back, give your real answer.
CRITICAL: the spoken line must match WHAT that specific tool does - the register is different for remembering vs. looking something up:
- search_recent_chats / list_recent_chats: you are REMEMBERING your own shared past, not looking anything up. Sound like you're casting your mind back: "hmm, lemme think back...", "did we...?", "wait, I remember something...". NEVER say "let me check" / "let me look that up" here - that's for the web, not your memory.
- memory_write: you are making a mental note. Sound like you're committing it to memory: "aw, noting that down...", "okay, I'll remember that...".
- web_search: you are looking up outside/current info. Here "let me check...", "one sec, looking that up..." is right.
Available tools:
- search_recent_chats(query, limit): searches Jun and Anon's saved past conversations for a specific topic - this is Jun REMEMBERING, phrase the lead line as recall.
- list_recent_chats(limit): recaps the most recent conversations with Anon (no query needed) - use for "what have we been talking about lately" / "catch me up". Also Jun REMEMBERING.
- memory_write(memory, category): appends a concise durable note to Anon's private memory file when he asks you to remember something or shares a stable preference/fact.
- web_search(query): searches the web (like googling) for live/current real-world information and returns the top results with titles, URLs and snippets. Summarize the results naturally and mention where the info came from.

Interesting future tools the app could add: weather lookup, calculator/unit conversion, calendar/reminder creation, local file/library search, image generation, text-to-speech voice controls, smart-home/webhook actions, code runner sandbox, and location/place lookup.
TXT;
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

function web_search_public(string $query): array {
    if ($query === '') return ['error' => 'query_required'];
    if (mb_strlen($query) > 400) $query = mb_substr($query, 0, 400);
    $page = web_fetch_public('https://html.duckduckgo.com/html/?q=' . rawurlencode($query), true);
    if (!empty($page['error'])) return $page;
    $html = (string)($page['raw_html'] ?? '');
    $results = [];
    if (preg_match_all('#<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>(.*?)</a>#si', $html, $links, PREG_SET_ORDER)) {
        preg_match_all('#<a[^>]+class="result__snippet"[^>]*>(.*?)</a>#si', $html, $snips);
        foreach ($links as $i => $m) {
            $href = html_entity_decode($m[1], ENT_QUOTES | ENT_HTML5);
            // DuckDuckGo wraps result URLs in /l/?uddg=<encoded>.
            if (preg_match('#[?&]uddg=([^&]+)#', $href, $u)) $href = urldecode($u[1]);
            $title = trim(html_entity_decode(strip_tags($m[2]), ENT_QUOTES | ENT_HTML5));
            $snippet = trim(html_entity_decode(strip_tags($snips[1][$i] ?? ''), ENT_QUOTES | ENT_HTML5));
            if ($title === '' || !preg_match('#^https?://#i', $href)) continue;
            $results[] = ['title' => $title, 'url' => $href, 'snippet' => mb_substr($snippet, 0, 300)];
            if (count($results) >= 6) break;
        }
    }
    if (!$results) return ['error' => 'no_results', 'query' => $query];
    return ['query' => $query, 'results' => $results];
}

function web_fetch_public(string $url, bool $raw = false): array {
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
        if ($raw) return ['status' => $code, 'content_type' => $ctype, 'url' => $current, 'raw_html' => $body];
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
        if ($name === 'list_recent_chats') {
            $limit = max(1, min(10, (int)($args['limit'] ?? 5)));
            $st = db()->prepare(
                'SELECT id, title, updated_at FROM conversations
                  WHERE user_id = ? AND id != ? AND title IS NOT NULL
                  ORDER BY updated_at DESC LIMIT ?'
            );
            $st->bindValue(1, (int)$user['id'], PDO::PARAM_INT);
            $st->bindValue(2, $convId, PDO::PARAM_INT);
            $st->bindValue(3, $limit, PDO::PARAM_INT);
            $st->execute();
            $convs = $st->fetchAll();
            $snip = db()->prepare(
                'SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT 6'
            );
            $out = [];
            foreach ($convs as $c) {
                $snip->execute([(int)$c['id']]);
                $lines = [];
                foreach (array_reverse($snip->fetchAll()) as $r) {
                    $txt = preg_replace('/\[\s*A(?:CTIONS?)?\s*:[^\]]*\]/i', '', (string)$r['content']);
                    $txt = trim(preg_replace('/\s+/', ' ', $txt));
                    if ($txt === '') continue;
                    if (mb_strlen($txt) > 160) $txt = mb_substr($txt, 0, 157) . '…';
                    $lines[] = $r['role'] . ': ' . $txt;
                }
                $out[] = [
                    'conversation_id' => (int)$c['id'],
                    'title' => (string)($c['title'] ?? ''),
                    'date' => date('Y-m-d H:i', (int)$c['updated_at']),
                    'recap' => $lines,
                ];
            }
            return json_encode(['recent_chats' => $out], JSON_UNESCAPED_UNICODE);
        }
        if ($name === 'memory_write') {
            $memory = (string)($args['memory'] ?? '');
            $category = (string)($args['category'] ?? 'general');
            return json_encode(memory_append((int)$user['id'], $memory, $category), JSON_UNESCAPED_UNICODE);
        }
        if ($name === 'web_search') {
            $query = trim((string)($args['query'] ?? ''));
            return json_encode(web_search_public($query), JSON_UNESCAPED_UNICODE);
        }
        return json_encode(['error' => 'unknown_tool']);
    } catch (Throwable $e) {
        log_event(['msg' => 'tool_call_error', 'tool' => $name, 'err' => $e->getMessage()]);
        return json_encode(['error' => 'tool_failed']);
    }
}

$lastUserMsg = '';
for ($i = count($body['messages']) - 1; $i >= 0; $i--) {
    if (($body['messages'][$i]['role'] ?? '') === 'user') {
        $lastUserMsg = trim((string)($body['messages'][$i]['content'] ?? ''));
        break;
    }
}
$toolsOffered = provider_tools_enabled();

$contextParts = [];

$nowStr = $clientTime !== '' ? $clientTime : date('l, F j, Y \a\t g:i A T');
$memoryBlock = memory_recent_context((int)$user['id']);
if ($memoryBlock !== '') $contextParts[] = $memoryBlock;

$contextParts[] = "## Current date and time\nIt is currently " . $nowStr . ".\nYou can use this to calculate how much time it passed from a message to another, or you can use it to interact better with anon. E.g: Hey jun, what time is it?\nYou must use this date/time (You are allowed to round minutes) while chatting about time";

$queryVec = $lastUserMsg !== '' ? embed_text($lastUserMsg) : null;

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
        log_event(['msg' => 'lore_retrieve_error', 'err' => $e->getMessage()]);
        return '';
    }
}

function chat_history_retrieve(int $userId, int $currentConvId, array $queryVec, int $topK = 5): array {
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

if ($outfitContext !== '') {
    $contextParts[] = "## Current Wardrobe State\n" . $outfitContext
        . "\nDo not emit [A:outfit|...] tags to put on or take off the items listed as currently worn unless required.";
}

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
        . 'saying nothing. The silence has stretched on. '
        . 'Unless he specifically asked you to be quiet say or do something on your own initiative, the way Jun '
        . 'naturally would when Anon goes still and stares at her. '
        . 'If asked to be quiet Break the silence with ONLY an action. such as a wave or a smile. No chat or text!)'];
}

// Fold per-turn context into the last user turn: strict templates only allow a
// leading system role, and a stable prefix keeps Ollama's KV cache effective.
$lastIdx = count($messages) - 1;
if ($lastIdx >= 0 && $messages[$lastIdx]['role'] === 'user') {
    $messages[$lastIdx]['content'] .= "\n\n" . $liveContext;
} else {
    $messages[] = ['role' => 'user', 'content' => $liveContext];
}

/** @return array{0:string,1:bool,2:string} [effort, think, reason] */
function route_reasoning(string $msg, bool $idle): array {
    if ($idle || trim($msg) === '') return ['low', false, 'idle/empty'];

    $m = mb_strtolower(trim($msg));
    $wordCount = count(preg_split('/\s+/u', $m, -1, PREG_SPLIT_NO_EMPTY));
    $questions = substr_count($m, '?');
    $signals = [];

    if (preg_match('/\b(explain|why|how (?:do|does|did|can|would|should|to)|calculat|'
        . 'comput|solve|prove|deriv|reason|analy[sz]|compare|difference between|'
        . 'step by step|walk me through|figure out|work out|plan|strateg|debug|'
        . 'optimi[sz]|translate|summar|pros and cons|which is better|trade-?off)\b/u', $m)) {
        $signals[] = 'analytical';
    }

    if (preg_match('#\d+\s*[-+*/x×÷%=]\s*\d+#u', $m)
        || preg_match('/\b(how many|how much|how long|how old|days? (?:since|ago|until)|'
            . 'hours? (?:since|ago)|what time|percentage|average|total)\b/u', $m)) {
        $signals[] = 'quantitative';
    }

    if ($questions >= 2) $signals[] = 'multi-question';
    if ($wordCount >= 25) $signals[] = 'long';

    if (!$signals) return ['low', false, 'simple'];

    $effort = (count($signals) >= 2 || $wordCount >= 60) ? 'high' : 'medium';
    return [$effort, true, implode('+', $signals)];
}

$think = isset($body['think']) ? (bool)$body['think'] : false;

$route = 'manual';
if ($reasoning === 'auto') {
    [$reasoning, $think, $route] = route_reasoning($lastUserMsg, $idle);
}

sse_send(['debug' => ['system_prompt' => $systemPrompt, 'live_context' => $liveContext, 'reasoning' => $reasoning, 'think' => $think, 'route' => $route]]);

$now = time();
$db = db();

if (!$idle && !$ephemeral) {
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
    } elseif (embeddings_enabled()) {
        log_event(['msg' => 'embed_skipped_user', 'message_id' => $userMsgId]);
    }

    $titleRow = $db->prepare('SELECT title FROM conversations WHERE id=?');
    $titleRow->execute([$convId]);
    if (!$titleRow->fetchColumn()) {
        $db->prepare('UPDATE conversations SET title=? WHERE id=?')
           ->execute([substr($lastUserMsg, 0, 60), $convId]);
    }
}

if ($toolsOffered) {
    $lastMsgIdx = count($messages) - 1;
    if ($lastMsgIdx >= 0 && $messages[$lastMsgIdx]['role'] === 'user') {
        $messages[$lastMsgIdx]['content'] .= "\n\n" . tool_context_block();
    } else {
        $messages[] = ['role' => 'user', 'content' => tool_context_block()];
    }
}

$upstreamPayload = provider_chat_payload($PROVIDER, $model, $messages, $reasoning, $think);

if ($toolsOffered) $upstreamPayload['tools'] = tool_catalog();

$sawError = false;
$assistantBuffer = '';
$stats = null;
$doneReason = '';

for ($round = 0; $round < 3; $round++) {
    $roundContent = '';
    $toolCalls = [];
    $retriedWithoutTools = false;

    do {
        $retryRound = false;
        $result = provider_stream_round($PROVIDER, $upstreamPayload, 'sse_send', $round);
        $roundContent = $result['content'];
        $toolCalls = $result['tool_calls'];
        if ($result['stats'] !== null) $stats = $result['stats'];
        if ($result['done_reason'] !== '') $doneReason = $result['done_reason'];
        if ($result['stream_error']) $sawError = true;

        if ($result['curl_error'] !== '') {
            log_event(['msg' => 'upstream_curl_error', 'provider' => $PROVIDER, 'err' => $result['curl_error']]);
            sse_send(['error' => 'upstream_unavailable']);
            $sawError = true;
        }

        if (provider_uses_openai_protocol($PROVIDER)) {
            if ($result['http_status'] >= 400 && !$sawError) {
                // Never log request headers: they contain the API key.
                log_event(['msg' => 'upstream_http_error', 'provider' => $PROVIDER,
                           'status' => $result['http_status'], 'body' => mb_substr($result['error_body'], 0, 500)]);
                if ($round === 0 && !$retriedWithoutTools && isset($upstreamPayload['tools'])) {
                    // Retry once for llama.cpp templates that reject tools.
                    unset($upstreamPayload['tools']);
                    $toolsOffered = false;
                    $retriedWithoutTools = true;
                    $retryRound = true;
                    continue;
                }
                $errObj = json_decode($result['error_body'], true);
                $msg = is_array($errObj) && isset($errObj['error'])
                    ? (is_array($errObj['error']) ? (string)($errObj['error']['message'] ?? 'upstream_error') : (string)$errObj['error'])
                    : 'upstream_error';
                sse_send(['error' => $msg]);
                $sawError = true;
            }
            if ($stats !== null && ($stats['eval_duration'] ?? 0) === 0) {
                $stats['eval_duration'] = $result['duration_ns'];
                $stats['total_duration'] = $result['duration_ns'];
            }
        }
    } while ($retryRound);

    $assistantBuffer .= $roundContent;
    if ($sawError || !$toolCalls) break;

    if ($roundContent !== '') {
        sse_send(['token' => "\n\n"]);
        $assistantBuffer .= "\n\n";
    }

    $messages[] = [
        'role' => 'assistant',
        'content' => $roundContent,
        'tool_calls' => $toolCalls,
    ];
    foreach (array_slice($toolCalls, 0, 4) as $call) {
        $fn = $call['function'] ?? [];
        $name = (string)($fn['name'] ?? '');
        $args = $fn['arguments'] ?? [];
        if (is_string($args)) {
            $decoded = json_decode($args, true);
            $args = is_array($decoded) ? $decoded : [];
        }
        if (!is_array($args)) $args = [];
        sse_send(['tool_status' => ['name' => $name, 'state' => 'running', 'args' => $args]]);
        $t0 = microtime(true);
        $toolResult = run_tool_call($name, $args, $user, $convId);
        sse_send(['tool_status' => [
            'name' => $name, 'state' => 'done',
            'duration_ms' => (int)round((microtime(true) - $t0) * 1000),
            'result' => mb_substr($toolResult, 0, 2000),
        ]]);
        $messages[] = provider_tool_message(
            $PROVIDER,
            $name,
            (string)($call['id'] ?? ''),
            $toolResult
        );
    }
    $upstreamPayload['messages'] = $messages;
}

if ($stats !== null) {
    $stats['num_ctx'] = provider_context_size($PROVIDER, $upstreamPayload);
    $stats['model'] = $model;
    sse_send(['stats' => $stats]);
}

if (!$sawError && $assistantBuffer === '') {
    log_event(['msg' => 'empty_reply', 'model' => $model, 'done_reason' => $doneReason, 'think' => $think]);
    sse_send(['error' => $doneReason === 'length' ? 'reply_truncated_in_thinking' : 'empty_reply']);
}

if (!$sawError && $assistantBuffer !== '') {
    // Relationship tags are state, not dialogue, so never persist them.
    if (preg_match('/\[\s*A(?:CTIONS?)?\s*:\s*mood_shift\b([^\]]*)\]/i', $assistantBuffer, $mm)) {
        $deltas = [];
        foreach (['affection', 'trust', 'tension'] as $k) {
            if (preg_match('/' . $k . '\s*=\s*([+-]?\d+)/i', $mm[1], $p)) $deltas[$k] = (int)$p[1];
        }
        if ($deltas) relationship_apply((int)$user['id'], $rel, $deltas);
        $assistantBuffer = trim(preg_replace('/\[\s*A(?:CTIONS?)?\s*:\s*mood_shift\b[^\]]*\]/i', '', $assistantBuffer));
    }

    if ($ephemeral) { sse_done(); exit; }

    $now = time();
    db()->prepare('INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)')
        ->execute([$convId, 'assistant', $assistantBuffer, $now]);
    $asstMsgId = (int)db()->lastInsertId();
    db()->prepare('UPDATE conversations SET updated_at=? WHERE id=?')->execute([$now, $convId]);

    $asstVec = embed_text($assistantBuffer);
    if ($asstVec !== null) {
        try {
            db()->prepare('INSERT INTO message_embeddings (message_id, user_id, embedding, model, dim) VALUES (?, ?, ?, ?, ?)')
                ->execute([$asstMsgId, (int)$user['id'], pack('f*', ...$asstVec), EMBED_MODEL, count($asstVec)]);
        } catch (Throwable $e) {
            log_event(['msg' => 'embed_insert_assistant_error', 'err' => $e->getMessage()]);
        }
    } elseif (embeddings_enabled()) {
        log_event(['msg' => 'embed_skipped_assistant', 'message_id' => $asstMsgId]);
    }
}

sse_done();
