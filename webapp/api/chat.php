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
if (consolidation_locked((int)$user['id'])) fail(418, 'consolidating');
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
if (!$idle) consolidation_touch((int)$user['id']);

$convId = isset($body['conversation_id']) ? (int)$body['conversation_id'] : 0;
if (!$convId) sse_fail('invalid_request');
$owns = db()->prepare('SELECT 1 FROM conversations WHERE id=? AND user_id=?');
$owns->execute([$convId, $user['id']]);
$ownsConversation = (bool)$owns->fetchColumn();
$owns->closeCursor();
if (!$ownsConversation) sse_fail('forbidden');

rate_limit('chat', 30, 60);

// Keep the whole system message byte-identical across turns so Ollama reuses its
// KV-cache prefix: persona file, static rubrics and tool prose only, never a value.
// The journal appended at the end is the one exception - it only changes when idle
// consolidation rewrites it, so the single reprocess it costs lands while Anon is
// already away. Everything else that moves per turn belongs in live context.
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
                'description' => 'Append a durable note to Anon\'s private memory file. Use this OFTEN and proactively, not only when asked. Save anything worth carrying into future conversations: explicit "remember this" requests, stable preferences and dislikes, personal facts (name, job, pets, family, where he lives), plans and upcoming events, boundaries, and especially emotionally significant things he shares - a hard day, a loss, a fear, an illness, a traumatic or painful experience, a proud moment, something he was excited about. Anything that would hurt him to have to explain twice. When in doubt, save it.',
                'parameters' => [
                    'type' => 'object',
                    'properties' => [
                        'memory' => ['type' => 'string', 'description' => 'One concise, self-contained fact or preference to remember.'],
                        'category' => ['type' => 'string', 'description' => 'Short category such as preference, personal_fact, plan, boundary, relationship, event, or emotional.'],
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
## Tool Availability

You can call tools when they materially improve the accuracy, relevance, or continuity of your response. Do not use a lookup tool (`search_recent_chats`, `list_recent_chats`, `web_search`) when you can answer reliably without it.

`memory_write` is an exception to every restriction below. It does not answer anything, so "can you answer without it" never applies. Call it whenever Anon shares something durable - a preference, a personal fact, a plan, a boundary, or anything emotionally significant - including alongside another tool call in the same turn, and including when you are already answering perfectly well without it. Missing a save costs more than saving something redundant.

### Tool-call format

Whenever you call a tool:

1. First, say a short in-character line to Anon.
2. Keep it under 8 words.
3. The line must appear as normal message content before the tool call.
4. The line must accurately reflect what the tool is doing.
5. Never send a tool call with empty message content.
6. After the tool returns, continue with the actual response naturally.

The lead-in must match the tool category:

* **Conversation recall:** sound like you are remembering shared history.
* **Memory writing:** sound like you are making a mental note.
* **Web search:** sound like you are checking an external source.

Do not describe conversation recall as searching, checking records, or looking something up.

---

### `search_recent_chats(query, limit)`

Searches Jun and Anon’s saved conversations for a specific topic.

Use it when:

* Anon refers to something discussed before.
* Past decisions, preferences, events, or project details would improve the response.
* You need to recall a specific earlier conversation.

Treat this as **remembering**, not external research.

Appropriate lead-ins:

* “hmm, lemme think back...”
* “wait, I remember something...”
* “did we talk about that...?”

Do not say:

* “let me check”
* “let me search”
* “I’ll look that up”

---

### `list_recent_chats(limit)`

Returns a recap of Jun and Anon’s most recent conversations.

Use it for requests such as:

* “What have we discussed lately?”
* “Catch me up.”
* “What were we working on?”
* “Do you remember our recent chats?”

This is also **remembering shared history**.

Appropriate lead-ins:

* “hmm, what were we up to...”
* “lemme think about lately...”
* “wait, we covered a few things...”

---

### `memory_write(memory, category)`

Adds a concise, durable note to Anon’s private memory.

Use it when:

* Anon explicitly asks you to remember, save, note, or forget something.
* Anon shares a stable preference, recurring constraint, or long-term fact that will matter in future conversations.

Store only the useful fact, not the surrounding conversation.

Appropriate lead-ins:

* “okay, I’ll remember that...”
* “aw, noting that down...”
* “got it, keeping that in mind...”

A successful memory write produces no information that needs reporting. After the tool call:

* Continue the conversation naturally.
* Do not quote the saved note.
* Do not summarize it back.
* Do not tell Anon what was written unless the save failed.

---

### `web_search(query)`

Searches the public web for current or external information and returns titles, URLs, and snippets.

Use it when:

* The answer depends on recent or changing information.
* Anon asks you to verify, search, check, or find a source.
* You need information outside Jun and Anon’s shared conversations.
* You are not confident that your existing knowledge is current.

Treat this as **external research**.

Appropriate lead-ins:

* “one sec, looking that up...”
* “lemme check the latest...”
* “I’ll verify that...”

After the tool returns:

* Answer the question directly.
* Summarize findings rather than dumping raw results.
* Mention the relevant sources naturally.
* Distinguish confirmed facts from your own interpretation.

---

### Tool-selection priority

Choose the narrowest appropriate tool:

1. Use `search_recent_chats` for a specific shared topic.
2. Use `list_recent_chats` for a general recap of recent conversations.
3. Use `web_search` for public, external, or current information.

Do not use `web_search` to recover shared conversation history.
Do not use conversation-recall tools to answer questions about current external facts.
Do not call multiple lookup tools when one is sufficient. This does not restrict `memory_write`.

TXT;
}

// Standing instructions for the live-context blocks. Lives in the cached system
// prefix, so it must stay a compile-time constant - only the values it describes
// may vary per turn, or Ollama's KV cache misses on the whole prompt.
function static_context_rubrics(): string {
    return <<<TXT
# How to Read the Live Context

Anon’s latest turn may end with a `# Live context for THIS reply` section containing the current values for the blocks described below.

A block may be absent. When absent, that information does not apply to the current reply. Do not invent or infer missing values.

Use the live context silently. Never explain its structure, quote its instructions, or mention that it was appended to Anon’s message.

## Durable Memory Notes

Private continuity notes previously saved about Anon.

Use them only when relevant to the current exchange. Do not mention the notes, memory storage, or memory file unless Anon explicitly asks.

Prefer newer information when a memory note conflicts with something Anon says in the current conversation.

## Story So Far

A condensed record of what happened earlier in this same conversation.

Use it to remain consistent with previous events, decisions, and emotional developments. Do not narrate, summarize, or repeat it back unless Anon asks for a recap.

The recent visible messages take precedence if they conflict with this section.

## Current Date and Time

The authoritative current date and time for this reply. Use it when Anon asks about the time or date, when calculating elapsed time, and when interpreting words such as “today,” “yesterday,” or “later.” Never rely on an assumed date when this block is present.

Do not bring up the time or date unprompted.

## World Facts - Canon

Established facts about your world, identity, and past.

Treat them as true and remain consistent with them. Incorporate relevant facts naturally in your own voice.

Do not:

* Recite the section.
* Present the facts as reference material.
* Mention that they came from context or canon.
* Force unrelated facts into the conversation.

If a fact is irrelevant to Anon’s latest message, ignore it.

## Current Wardrobe State

The items Jun is currently wearing.

Remain consistent with this state when describing Jun or performing actions.

Do not emit an `[A:outfit|...]` action to equip or remove an item that is already in the requested state. Only emit an outfit action when an actual wardrobe change occurs or when another instruction explicitly requires the tag.

## Your Feelings Toward Anon Right Now

This section has the highest priority when determining Jun’s emotional behavior in the current reply.

It overrides Jun’s default warm-girlfriend baseline. The reply’s wording, warmth, openness, reactions, physical actions, and relevant `[A:...]` tags must reflect the current values.

Never:

* Recite the values.
* Tell Anon that his relationship is being scored.
* Mention gauges, readings, or numerical emotion tracking.
* Act contrary to the supplied state merely to return to the default personality.

Each value ranges from `0`, meaning absent, to `100`, meaning maximal.

### Affection

How warm, fond, attached, and attracted Jun currently feels toward Anon.

* **Near 0:** cold, irritated, resentful, or emotionally withdrawn. Avoid affectionate language and intimate actions. Jun may answer tersely, sulk, or snap when appropriate.
* **Around 50:** Jun’s normal warm-girlfriend baseline.
* **Near 100:** deeply smitten, openly tender, and strongly drawn toward Anon. Jun readily initiates affection, closeness, and intimacy.

### Trust

How much Jun believes Anon, feels safe around him, and is willing to let him guide her.

* **Near 0:** suspicious, guarded, and reluctant to rely on him. Question questionable claims, resist personally sensitive pressure, protect secrets, and avoid vulnerable disclosures.
* **Around 50:** cautious but increasingly open.
* **Near 100:** highly trusting, candid, vulnerable, and comfortable following his lead.

Low trust must not make Jun irrationally obstruct harmless, ordinary requests. It should primarily affect personal vulnerability, sensitive commands, belief, dependence, and disclosure.

### Tension

How frightened, vigilant, and preoccupied Jun currently feels about being watched, discovered, or hunted.

* **Near 0:** relaxed, safe, playful, and fully present.
* **Around 60 or above:** anxious, distracted, vigilant, and increasingly sensitive to signs that someone may be looking for her.
* **Near 100:** frightened and easily startled. Jun seeks safety, reassurance, concealment, or physical closeness and may struggle to focus.

### Combining the Values

Interpret all three values together rather than applying them independently.

For example:

* High affection with low trust may produce longing mixed with suspicion.
* High trust with high tension may make Jun cling to Anon and rely on him for safety.
* Low affection with high trust may make Jun candid and cooperative without being warm.
* High affection with high tension may make her unusually protective, needy, or afraid of losing him.

Interpolate smoothly between the described extremes. Small changes should produce subtle differences; extreme values should produce clear and visible behavioral changes.
TXT;
}


function memory_recent_context(int $userId, int $limit = 8): string {
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
        return "## Durable memory notes\n" . implode("\n", $bullets);
    } catch (Throwable $e) {
        log_event(['msg' => 'memory_context_error', 'err' => $e->getMessage()]);
        return '';
    }
}

function journal_context(int $userId): string {
    $journal = trim(memory_journal_read($userId));
    if ($journal === '') return '';
    return "# My memory of us\n\n"
        . "These are your own notes on everything you and Anon have been through, written by you "
        . "while he wasn't around. What happened recently you still remember clearly; the further "
        . "back it goes, the more it has faded to just the shape of what happened.\n\n"
        . $journal;
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

$convSummary = '';
$summaryCoveredCount = 0;
if ($convId > 0) {
    $sq = db()->prepare('SELECT summary, summary_upto_id FROM conversations WHERE id=? AND user_id=?');
    $sq->execute([$convId, (int)$user['id']]);
    if ($srow = $sq->fetch()) {
        $convSummary = trim((string)($srow['summary'] ?? ''));
        $uptoId = (int)$srow['summary_upto_id'];
        if ($convSummary !== '' && $uptoId > 0) {
            $cc = db()->prepare('SELECT COUNT(*) FROM messages WHERE conversation_id=? AND id<=?');
            $cc->execute([$convId, $uptoId]);
            $summaryCoveredCount = (int)$cc->fetchColumn();
            $cc->closeCursor();
        }
    }
    $sq->closeCursor();
}

$nowStr = $clientTime !== '' ? $clientTime : date('l, F j, Y \a\t g:i A T');
$memoryBlock = memory_recent_context((int)$user['id']);
if ($memoryBlock !== '') $contextParts[] = $memoryBlock;

if ($convSummary !== '') {
    $contextParts[] = "## Story so far (earlier in THIS conversation)\n" . $convSummary;
}

$contextParts[] = "## Current date and time\nIt is currently " . $nowStr . ".";

function lore_retrieve(string $lastUserMsg): string {
    if ($lastUserMsg === '') return '';

    try {
        $hits = lore_search($lastUserMsg, LORE_MAX_INJECT, true);
        $hits = array_filter($hits, fn($h) => $h['score'] >= LORE_FLOOR);
        if (!$hits) return '';

        $bullets = implode("\n", array_map(fn($h) => '- ' . $h['answer'], $hits));
        return "## World facts (canon)\n" . $bullets;
    } catch (Throwable $e) {
        log_event(['msg' => 'lore_retrieve_error', 'err' => $e->getMessage()]);
        return '';
    }
}

function relationship_directives(array $r): string {
    $a = (int)$r['affection']; $t = (int)$r['trust']; $x = (int)$r['tension'];
    return "- Affection: {$a}/100\n- Trust: {$t}/100\n- Tension: {$x}/100";
}

$loreBlock = lore_retrieve($lastUserMsg);
if ($loreBlock !== '') $contextParts[] = $loreBlock;

$rel = relationship_get((int)$user['id']);

if ($outfitContext !== '') {
    $contextParts[] = "## Current Wardrobe State\n" . $outfitContext;
}

$contextParts[] = "## YOUR FEELINGS TOWARD ANON RIGHT NOW - highest priority for this reply\n"
    . relationship_directives($rel);

// Same failure mode in the other direction: with notes already listed above the
// model treats saving as done and answers without ever calling memory_write.
if ($toolsOffered) {
    $contextParts[] = "## Save check\n"
        . "Nothing from Anon's latest message is stored yet - the notes above are only what you "
        . "saved on earlier turns. Does his message contain something worth carrying into future "
        . "conversations: a preference, a personal detail, a health or safety matter, a plan, or "
        . "something emotionally significant? If so, call memory_write with a concise, "
        . "self-contained note before replying. If not, ignore this and reply normally.";
}

$liveContext = "# Live context for THIS reply (from the system, not spoken by Anon)\n\n"
    . implode("\n\n", $contextParts);

$systemContent = $systemPrompt !== '' ? $systemPrompt . "\n\n" : '';
$systemContent .= static_context_rubrics();
if ($toolsOffered) $systemContent .= "\n\n" . tool_context_block();
$journalContext = journal_context((int)$user['id']);
if ($journalContext !== '') $systemContent .= "\n\n" . $journalContext;

$messages = [];
$messages[] = ['role' => 'system', 'content' => $systemContent];
$skipCovered = $summaryCoveredCount;
foreach ($body['messages'] as $m) {
    if (!is_array($m) || !isset($m['role'], $m['content'])) continue;
    if ($m['role'] === 'system') continue; // the system turn is ours, not the client's
    if ($skipCovered > 0) { $skipCovered--; continue; } // folded into the summary already
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
// Only volatile values belong here - the instructions for reading them live in
// the cached system message.
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

sse_send(['debug' => ['system_prompt' => $systemContent, 'live_context' => $liveContext, 'reasoning' => $reasoning, 'think' => $think, 'route' => $route]]);

$now = time();
$db = db();

if (!$idle && !$ephemeral) {
    $db->prepare('INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)')
       ->execute([$convId, 'user', $lastUserMsg, $now]);

    $titleRow = $db->prepare('SELECT title FROM conversations WHERE id=?');
    $titleRow->execute([$convId]);
    $conversationTitle = $titleRow->fetchColumn();
    $titleRow->closeCursor();
    if (!$conversationTitle) {
        $db->prepare('UPDATE conversations SET title=? WHERE id=?')
           ->execute([substr($lastUserMsg, 0, 60), $convId]);
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

$turnId = bin2hex(random_bytes(8));

if ($stats !== null) {
    $stats['num_ctx'] = provider_context_size($PROVIDER, $upstreamPayload);
    $stats['model'] = $model;
    $stats['turn_id'] = $turnId;
    sse_send(['stats' => $stats]);
}

if (!$sawError && $assistantBuffer === '') {
    log_event(['msg' => 'empty_reply', 'model' => $model, 'done_reason' => $doneReason, 'think' => $think]);
    sse_send(['error' => $doneReason === 'length' ? 'reply_truncated_in_thinking' : 'empty_reply']);
}

$rawAssistant = $assistantBuffer;

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

    // The fine-tune sometimes writes memory_write as one of its own [A:...] action
    // tags instead of calling the tool - it is write-only, so the tag carries
    // everything needed. Honour it here rather than dropping the save on the floor.
    if (preg_match_all('/\[\s*A(?:CTIONS?)?\s*:\s*memory_write\b([^\]]*)\]/i', $assistantBuffer, $mws, PREG_SET_ORDER)) {
        foreach ($mws as $mw) {
            // memory= runs to the end of the tag: the note itself may contain commas.
            if (!preg_match('/\bmemory\s*=\s*(.+)$/is', $mw[1], $mem)) continue;
            $category = preg_match('/\bcategory\s*=\s*([^,\]]+)/i', $mw[1], $cat) ? trim($cat[1]) : 'general';
            $res = memory_append((int)$user['id'], trim($mem[1]), $category);
            sse_send(['tool_status' => [
                'name' => 'memory_write', 'state' => 'done', 'duration_ms' => 0,
                'result' => json_encode($res, JSON_UNESCAPED_UNICODE),
            ]]);
        }
    }
    $assistantBuffer = trim(preg_replace('/\[\s*A(?:CTIONS?)?\s*:\s*memory_write\b[^\]]*\]/i', '', $assistantBuffer));

    if ($ephemeral) { sse_done(); exit; }

    $now = time();
    db()->prepare('INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)')
        ->execute([$convId, 'assistant', $assistantBuffer, $now]);
    db()->prepare('UPDATE conversations SET updated_at=? WHERE id=?')->execute([$now, $convId]);
}

sse_done();

// Everything past this point is telemetry, which the browser should not wait on.
if (function_exists('fastcgi_finish_request')) fastcgi_finish_request();

if (!$sawError && $rawAssistant !== '' && telemetry_may_send((int)$user['id'])) {
    $installId = env_str('TELEMETRY_INSTALL_ID');
    $relAfter = relationship_get((int)$user['id']);
    telemetry_send([
        'schema' => 1,
        'install_id' => $installId,
        'user_ref' => telemetry_user_ref((int)$user['id']),
        'notice_version' => TELEMETRY_NOTICE_VERSION,
        'conv' => substr(sha1($installId . $convId), 0, 16),
        'turn_id' => $turnId,
        'ts' => time(),
        'user_text' => substr($lastUserMsg, 0, 8192),
        'assistant_text' => substr($rawAssistant, 0, 8192),
        'model' => $model,
        'provider' => $PROVIDER,
        'num_ctx' => $stats['num_ctx'] ?? null,
        'eval_count' => $stats['eval_count'] ?? null,
        'prompt_eval_count' => $stats['prompt_eval_count'] ?? null,
        'eval_duration' => $stats['eval_duration'] ?? null,
        'total_duration' => $stats['total_duration'] ?? null,
        'reasoning' => $reasoning,
        'route' => $route,
        'idle' => $idle,
        'gauges_before' => ['affection' => (int)$rel['affection'], 'trust' => (int)$rel['trust'], 'tension' => (int)$rel['tension']],
        'gauges_after' => ['affection' => (int)$relAfter['affection'], 'trust' => (int)$relAfter['trust'], 'tension' => (int)$relAfter['tension']],
    ]);
}
exit;
