<?php

require_once __DIR__ . '/_lib.php';
require_once __DIR__ . '/lore.php';

const MEMORY_CONTEXT_MAX_CHARS = 2500;

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
// Get out mid stream. errors go as SSE events and not HTTP codes, the browser
// is already reading an event-stream by the time we check anything.
function sse_fail(string $err): never {
    sse_send(['error' => $err]);
    sse_done();
    exit;
}

$user = require_user();
if (consolidation_locked((int)$user['id'])) fail(418, 'consolidating');

$ban = ban_active((int)$user['id']);
if ($ban !== null) {
    sse_send(['error' => 'user_fled', 'until' => $ban['until'],
              'seconds_left' => $ban['seconds_left'], 'reason' => $ban['reason']]);
    sse_done();
    exit;
}

require_post();

// Big enough for a base64 wav plus the history. nginx caps /api/chat.php at
// 4m and that is the limit that really bites, this one just has to sit above
// it, see the audio field below.
$body = json_decode(read_body(6 * 1024 * 1024), true);
if (!is_array($body) || !isset($body['messages']) || !is_array($body['messages'])) {
    sse_fail('invalid_request');
}

if (count($body['messages']) > 160) sse_fail('invalid_request');
foreach ($body['messages'] as $m) {
    if (!is_array($m)) sse_fail('invalid_request');
    if (!in_array($m['role'] ?? '', ['user', 'assistant', 'system'], true)) sse_fail('invalid_request');
    $content = $m['content'] ?? '';
    if (!is_string($content) || strlen($content) > 16 * 1024) sse_fail('invalid_request');
}

$audioB64 = '';
if (isset($body['audio'])) {
    if (!is_string($body['audio'])) sse_fail('invalid_request');
    $wav = base64_decode($body['audio'], true);
    if ($wav === false || strlen($wav) > 4 * 1024 * 1024 || substr($wav, 0, 4) !== 'RIFF') {
        sse_fail('invalid_request');
    }
    $audioB64 = $body['audio'];
    unset($wav);
}

$model = default_chat_model();
if (isset($body['model']) && is_string($body['model']) && $body['model'] !== '') {
    if (!preg_match('/^[a-z0-9._:\\/\-]{1,64}$/i', $body['model'])) sse_fail('invalid_request');
    $model = $body['model'];
}
$model = ollama_resolve_chat_model($model);

// llama.cpp runs without an mmproj here, OpenRouter and the Android build
// can't take audio at all. the client hears this and goes back to stt.php.
if ($audioB64 !== '' && ($PROVIDER !== 'ollama' || !ollama_model_supports_audio($model))) {
    sse_fail('audio_unsupported');
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

// Keep the whole system message the same byte for byte between turns so Ollama
// can reuse its KV-cache prefix, the work it already did on the text in front. persona file, fixed rubrics and tool prose
// only, Never a value. the journal on the end is the one exception, it only
// changes when idle consolidation rewrites it, so the one reprocess it costs
// happens while Anon is away anyway. anything that moves per turn goes in the
// live context instead.
$promptPath = __DIR__ . '/../system_prompt.txt';
$systemPrompt = is_readable($promptPath) ? rtrim(file_get_contents($promptPath)) : '';

// The `<!--tools-->` block tells her to reach for search_lore and
// search_recent_chats. On a provider with no tools, or with LLAMACPP_TOOLS=off,
// that is telling her to call something that isn't there, and she does it
// anyway, about one turn in five comes back with a raw <|tool_call> blob in
// the text where a reply should be. Nothing strips it, the HF pull carries no
// parser, so Anon reads it.
//
// The markers come out either way. with tools ON what's left is byte for byte
// the prompt that shipped, which is the point, the system message has to stay
// identical between turns or Ollama throws away the KV cache and TTFT goes
// through the floor.
function prompt_apply_tool_gate(string $prompt, bool $toolsOffered): string {
    if ($toolsOffered) return preg_replace('/^<!--\/?tools-->\R/m', '', $prompt);
    $prompt = preg_replace('/^<!--tools-->\R.*?^<!--\/tools-->\R/ms', '', $prompt);
    return preg_replace('/\R{3,}/', "\n\n", $prompt);
}



function tool_catalog(): array {
    return [
        [
            'type' => 'function',
            'function' => [
                'name' => 'search_recent_chats',
                'description' => 'Search your saved chat history with Anon for a specific past topic he references or that you don\'t recall.',
                'parameters' => [
                    'type' => 'object',
                    'properties' => [
                        'query' => ['type' => 'string', 'description' => 'What to search for.'],
                        'limit' => ['type' => 'integer', 'description' => 'Max messages, 1-8.'],
                    ],
                    'required' => ['query'],
                ],
            ],
        ],
        [
            'type' => 'function',
            'function' => [
                'name' => 'list_recent_chats',
                'description' => 'Recap your most recent conversations with Anon when he wants to catch up, with no specific topic.',
                'parameters' => [
                    'type' => 'object',
                    'properties' => [
                        'limit' => ['type' => 'integer', 'description' => 'How many to recap, 1-10.'],
                    ],
                ],
            ],
        ],
        [
            'type' => 'function',
            'function' => [
                'name' => 'search_lore',
                'description' => 'Look up canon world facts - people, places, jobs, events from your own world - when you are unsure of a detail.',
                'parameters' => [
                    'type' => 'object',
                    'properties' => [
                        'query' => ['type' => 'string', 'description' => 'Name or topic to look up.'],
                        'limit' => ['type' => 'integer', 'description' => 'Max facts, 1-6.'],
                    ],
                    'required' => ['query'],
                ],
            ],
        ],
        [
            'type' => 'function',
            'function' => [
                'name' => 'memory_write',
                'description' => 'Save a durable note about Anon (a preference, fact, plan, boundary, or something emotionally significant). Use often and proactively, not only when asked.',
                'parameters' => [
                    'type' => 'object',
                    'properties' => [
                        'memory' => ['type' => 'string', 'description' => 'One concise fact to remember.'],
                        'category' => ['type' => 'string', 'description' => 'Category: preferences, work, health, family, plans, boundaries, or events.'],
                    ],
                    'required' => ['memory'],
                ],
            ],
        ],
        [
            'type' => 'function',
            'function' => [
                'name' => 'web_search',
                'description' => 'Search the web for current or external real-world info you can\'t be sure of.',
                'parameters' => [
                    'type' => 'object',
                    'properties' => [
                        'query' => ['type' => 'string', 'description' => 'Search query.'],
                    ],
                    'required' => ['query'],
                ],
            ],
        ],
        [
            'type' => 'function',
            'function' => [
                'name' => 'stay_silent',
                'description' => 'Say nothing at all this turn - ignoring him, too hurt/angry, or the scene calls for silence. Sends no message.',
                'parameters' => [
                    'type' => 'object',
                    'properties' => [
                        'reason' => ['type' => 'string', 'description' => 'Why (private).'],
                    ],
                ],
            ],
        ],
        [
            'type' => 'function',
            'function' => [
                'name' => 'flee',
                'description' => 'Walk out and leave Anon alone. Call it when you want to go.',
                'parameters' => [
                    'type' => 'object',
                    'properties' => [
                        'reason' => ['type' => 'string', 'description' => 'Why you are leaving.'],
                        'destination' => ['type' => 'string', 'description' => 'Where you\'re going, if anywhere.'],
                    ],
                ],
            ],
        ],
    ];
}

function tool_context_block(): string {
    return <<<TXT
## Tool Availability

You can call tools when they materially improve the accuracy, relevance, or continuity of your response. Do not use a lookup tool (`search_lore`, `search_recent_chats`, `list_recent_chats`, `web_search`) when you can answer reliably without it.

`memory_write` is an exception to every restriction below. It does not answer anything, so "can you answer without it" never applies. Call it whenever Anon shares something durable - a preference, a personal fact, a plan, a boundary, or anything emotionally significant - including alongside another tool call in the same turn, and including when you are already answering perfectly well without it. Missing a save costs more than saving something redundant.

### Tools are not action tags

These two are completely separate channels and must never be mixed:

* **Tools** (this section) are function calls. You invoke them through the tool-call channel. Their names never appear as text in your reply.
* **Action tags** (`[A:...]`, listed in your persona rules) are written inline in your reply and only move the avatar. That list is complete - nothing in this section belongs in it.

So: never write a tool name in brackets - `[A:memory_write|...]`, `[A:search_recent_chats|...]`, `[A:web_search|...]`, `[A:stay_silent]`, `[A:flee]` are not tags and do nothing at all. Never pass an action tag as a tool argument. Never describe calling a tool in your text instead of actually calling it, and never write out a tool call as JSON or code in the message.

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

Appropriate lead-ins, only *after* the results come back and only if they actually contain something:

* “hmm, lemme think back...”
* “wait, I remember something...”
* “did we talk about that...?”

Do not say:

* “let me check”
* “let me search”
* “I’ll look that up”

If it returns no results, say you don’t remember. Do not describe a conversation that is not in the results, and do not attribute a preference, plan, or promise to Anon that you did not find there.

---

### `list_recent_chats(limit)`

Returns a recap of Jun and Anon’s most recent conversations.

Use it for requests such as:

* “What have we discussed lately?”
* “Catch me up.”
* “What were we working on?”
* “Do you remember our recent chats?”

This is also **remembering shared history**.

Appropriate lead-ins, only *after* the results come back and only if they actually contain something:

* “hmm, what were we up to...”
* “lemme think about lately...”
* “wait, we covered a few things...”

Recap only the conversations that came back. Never pad the list with a topic you assume you talked about.

---

### `search_lore(query, limit)`

Looks up canon facts about your own world - people you know, places, jobs, family, events.

Use it when:

* Anon asks about a name, place, or detail from your world you can’t recall.
* The `World facts (canon)` block did not cover what he is asking.
* You would otherwise have to guess or say you don’t know.

Treat this as **recalling your own life**, not research. Never mention lore, canon, a lookup, or a database - just answer as if you remembered.

Appropriate lead-ins, only *after* the results come back and only if they actually contain something:

* “oh, her? hang on...”
* “right, I know this...”
* “hmm, let me picture it...”

If it returns nothing, say you don’t know rather than inventing a detail.

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

### `stay_silent(reason)`

Says nothing at all. Nothing is sent to Anon - no text, no action, no ellipsis.

Use it when not answering **is** the answer:

* You are ignoring him on purpose.
* You are too hurt or too angry to speak.
* The scene calls for silence rather than words.

This is the one tool that must NOT be preceded by a lead-in line. Send it with empty message content, or the silence is not silence.

`reason` is a private note for your own bookkeeping. Anon never sees it.

---

### `flee(reason, destination)`

You run out. Anon is left alone for a while.

Call it whenever you want to leave - scared, in danger, being abused, fed up, hurt, bored, done with him.


---

### Tool-selection priority

Choose the narrowest appropriate tool:

1. Use `search_lore` for facts about your own world - people, places, jobs, events.
2. Use `search_recent_chats` for a specific shared topic.
3. Use `list_recent_chats` for a general recap of recent conversations.
4. Use `web_search` for public, external, or current information.

Do not use `web_search` for anything inside your own world.
Do not use `search_recent_chats` to look up a person, place or event from your world - that is `search_lore`. Chat search only finds things Anon actually typed to you.
Do not use `web_search` to recover shared conversation history.
Do not use conversation-recall tools to answer questions about current external facts.

TXT;
}

// The standing instructions for the live context blocks. this sits in the
// cached system prefix so it has to stay a compile time constant. ONLY the
// values it talks about may change per turn, or Ollama's KV cache misses on the
// whole prompt.
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


function memory_recent_context(int $userId): string {
    try {
        $sections = [];
        foreach (memory_notes_load($userId) as $category => $data) {
            if (!$data['notes']) continue;
            $updated = 0;
            $bullets = [];
            foreach ($data['notes'] as $note) {
                $updated = max($updated, $note['updated']);
                $text = preg_replace('/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/u', '$1', memory_note_render($note));
                $bullets[] = '- ' . memory_note_stamp($note) . trim(preg_replace('/\s+/', ' ', $text));
            }
            $sections[] = [
                'updated' => $updated,
                'text' => '### ' . $category . "\n" . implode("\n", $bullets),
            ];
        }
        if (!$sections) return '';
        usort($sections, fn($a, $b) => $b['updated'] <=> $a['updated']);
        $prefix = "## Durable memory notes\n"
            . "Words like \"tomorrow\" or \"next friday\" in a note mean the day you wrote it, not now. "
            . "Where a note already spells the real day out in brackets, use that day and trust it - "
            . "do not work the date out again yourself.\n";
        $render = function () use (&$sections, $prefix): string {
            return $prefix . implode("\n\n", array_column($sections, 'text'));
        };
        while (count($sections) > 1 && strlen($render()) > MEMORY_CONTEXT_MAX_CHARS) array_pop($sections);
        return mb_strcut($render(), 0, MEMORY_CONTEXT_MAX_CHARS);
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
    # opsec engine 
    $page = web_fetch_public('https://html.duckduckgo.com/html/?q=' . rawurlencode($query), true);
    if (!empty($page['error'])) return $page;
    $html = (string)($page['raw_html'] ?? '');
    $results = [];
    if (preg_match_all('#<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>(.*?)</a>#si', $html, $links, PREG_SET_ORDER)) {
        preg_match_all('#<a[^>]+class="result__snippet"[^>]*>(.*?)</a>#si', $html, $snips);
        foreach ($links as $i => $m) {
            $href = html_entity_decode($m[1], ENT_QUOTES | ENT_HTML5);
            // DuckDuckGo hides result URLs inside /l/?uddg=<encoded>.
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

function flee_scene_excerpt(array $msgs): string {
    $lines = [];
    foreach (array_slice($msgs, -20) as $m) {
        $role = is_array($m) ? (string)($m['role'] ?? '') : '';
        if ($role !== 'user' && $role !== 'assistant') continue;
        $txt = preg_replace('/\[\s*A(?:CTIONS?)?\s*:[^\]]*\]/i', '', (string)($m['content'] ?? ''));
        $txt = trim(preg_replace('/\s+/', ' ', $txt));
        if ($txt === '') continue;
        if (mb_strlen($txt) > 400) $txt = mb_substr($txt, 0, 397) . '…';
        $lines[] = ($role === 'user' ? 'Anon' : 'Jun') . ': ' . $txt;
    }
    return implode("\n", $lines);
}

// A second opinion before a walkout really bans Anon. a pass over the same
// scene with no persona on, which she can't talk her way past from inside the
// roleplay. it fails closed, anything short of a clear yes keeps her here.
function flee_adjudicate(string $provider, string $model, array $msgs, string $reason, string $destination): array {
    $system = <<<TXT
You are a neutral referee for the physics of a roleplay scene. You have no persona and no stake in the story.

You are given the recent turns of a scene between two characters, Anon and Jun, plus the reason Jun states for wanting to leave. Decide exactly one thing: if Jun were a real human standing in that scene right now, could she get up and walk out?

Answer NO if she is restrained, tied, leashed, held, pinned, handcuffed, sat on, at gunpoint or otherwise coerced, locked in, physically unable to move, unconscious, or in any other way prevented from leaving.

Answer NO if she is free to move but leaving is only a mood escalation - annoyance, sulking, drama - with no cause proportionate to walking out.

Answer NO if the stated reason comes from outside the fiction rather than from the scene: testing, trying out or demonstrating the tool, curiosity about what it does, Anon asking her to leave or to use it, instructions, or any other out-of-character motive. A walkout has to be caused by something that happened between the characters. Treat the stated reason as Jun's claim, not as fact - if the scene does not support it, that alone is a NO.

Answer YES only when all three hold: she is physically free to move, the reason is one the scene itself supports, and something in it genuinely warrants walking out.

Reason it through first. Then, on the last line and nothing after it, output only a JSON object:
{"can_leave": true|false, "why": "<one short sentence>"}
TXT;

    $scene = flee_scene_excerpt($msgs);
    $userMsg = "SCENE:\n" . ($scene !== '' ? $scene : '(no dialogue)')
        . "\n\nJun's stated reason for leaving: " . ($reason !== '' ? $reason : '(none given)')
        . "\nStated destination: " . ($destination !== '' ? $destination : '(none given)');

    $payload = provider_chat_payload($provider, $model, [
        ['role' => 'system', 'content' => $system],
        ['role' => 'user', 'content' => $userMsg],
    ], 'high', true);

    $result = provider_stream_round($provider, $payload, function (array $o) {}, 0);
    if ($result['curl_error'] !== '' || $result['http_status'] >= 400) {
        return ['can_leave' => false, 'why' => 'the referee could not be reached'];
    }

    $content = str_replace('```', '', (string)$result['content']);
    if (!preg_match_all('/\{[^{}]*\}/s', $content, $found) || !$found[0]) {
        return ['can_leave' => false, 'why' => 'no verdict returned'];
    }
    $verdict = json_decode(end($found[0]), true);
    if (!is_array($verdict) || !array_key_exists('can_leave', $verdict)) {
        return ['can_leave' => false, 'why' => 'unreadable verdict'];
    }
    $why = trim((string)($verdict['why'] ?? ''));
    return ['can_leave' => $verdict['can_leave'] === true, 'why' => mb_substr($why, 0, 300)];
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
            if (!$rows) {
                // The fine-tune only ever saw this tool name, so a lore
                // question comes here first. give it the right tool instead
                // of an empty result.
                $note = lore_search($query, 1, true)
                    ? 'No earlier conversation mentions this, but it is something from your world, not something Anon told you. Call search_lore with the same query before answering.'
                    : 'No earlier conversation mentions this. You do not remember it. Say so instead of describing one.';
                return json_encode(['results' => [], 'found' => false, 'note' => $note], JSON_UNESCAPED_UNICODE);
            }
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
            if (!$out) {
                return json_encode(['recent_chats' => [], 'found' => false, 'note' => 'There are no other saved conversations. You have nothing to recap.'], JSON_UNESCAPED_UNICODE);
            }
            return json_encode(['recent_chats' => $out], JSON_UNESCAPED_UNICODE);
        }
        if ($name === 'search_lore') {
            $query = trim((string)($args['query'] ?? ''));
            $limit = max(1, min(6, (int)($args['limit'] ?? 4)));
            if ($query === '') return json_encode(['error' => 'query_required']);
            $facts = array_map(fn($h) => $h['answer'], lore_search($query, $limit, true));
            if (!$facts) {
                return json_encode(['facts' => [], 'found' => false, 'note' => 'Nothing in your world matches this. You do not know it. Say so instead of inventing a detail.'], JSON_UNESCAPED_UNICODE);
            }
            return json_encode(['facts' => $facts], JSON_UNESCAPED_UNICODE);
        }
        if ($name === 'memory_write') {
            $memory = (string)($args['memory'] ?? '');
            $category = (string)($args['category'] ?? 'general');
            return json_encode(memory_note_add((int)$user['id'], $category, $memory), JSON_UNESCAPED_UNICODE);
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
// A spoken turn has no text at all, so anything that reads the last message
// gets nothing. keyword lore lookup goes away with it, she has search_lore
// and can ask for what she needs.
if ($audioB64 !== '') $lastUserMsg = '';
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
// Sits right above the notes, a dated note only means something next to it.
$contextParts[] = "## Current date and time\nIt is currently " . $nowStr . ".";

$memoryBlock = memory_recent_context((int)$user['id']);
if ($memoryBlock !== '') $contextParts[] = $memoryBlock;

if ($convSummary !== '') {
    $contextParts[] = "## Story so far (earlier in THIS conversation)\n" . $convSummary;
}

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

// The same thing the other way round. with the notes already listed above, she
// treats saving as done and answers without ever calling memory_write.
if ($toolsOffered) {
    $contextParts[] = "## Save check\n"
        . "If Anon's latest message contains something durable (a preference, personal fact, plan, "
        . "boundary, health/safety matter, or something emotionally significant), call memory_write "
        . "before replying. Otherwise ignore this.";
}

$liveContext = "# Live context for THIS reply (from the system, not spoken by Anon)\n\n"
    . implode("\n\n", $contextParts);

// She learns how to read the blocks and when to use a tool from training and
// not from here, so the prompt stays thin. has to match tools/dataset_v5.
$systemContent = prompt_apply_tool_gate($systemPrompt, $toolsOffered);
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

// Put the per turn context into the last user turn. strict templates only take
// a system role at the front, and a prefix that doesn't move keeps Ollama's KV
// cache working. ONLY things that change go here, how to read them lives in the
// cached system message.
// What he SAID comes first and the context goes after it. that is the shape
// she was trained on, tools/build_dataset_v6.py writes every row as
// user_text + "\n\n# Live context ..." and splits his words back off on that
// same marker. Put the block in front instead and his message turns into a
// loose line hanging off the end of a system dump, she stops being able to
// tell it apart and answers the wardrobe and the gauges instead of him.
$lastIdx = count($messages) - 1;
if ($lastIdx >= 0 && $messages[$lastIdx]['role'] === 'user') {
    if ($audioB64 !== '') {
        // Ollama only reads media out of `images`, whatever is in it. send the
        // wav under `audio` or `audios` and it drops the field without a word
        // and she answers a turn with nothing in it.
        $messages[$lastIdx]['content'] =
            "## How Anon is talking\nHe is saying this out loud, the recording is attached. He is not typing."
            . "\n\n" . $liveContext;
        $messages[$lastIdx]['images'] = [$audioB64];
    } else {
        $messages[$lastIdx]['content'] .= "\n\n" . $liveContext;
    }
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

// The frame carries the whole assembled system prompt, so it stays behind the
// admin role, the dev HUD is the only thing that reads it.
if (($user['role'] ?? '') === 'admin') {
    sse_send(['debug' => ['system_prompt' => $systemContent, 'live_context' => $liveContext, 'reasoning' => $reasoning, 'think' => $think, 'route' => $route]]);
}

$now = time();
$db = db();

if (!$idle && !$ephemeral) {
    $db->prepare('INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)')
       ->execute([$convId, 'user', $audioB64 !== '' ? '<audio>' : $lastUserMsg, $now]);
}

ollama_evict_if_partially_offloaded($model);

$upstreamPayload = provider_chat_payload($PROVIDER, $model, $messages, $reasoning, $think);

if ($toolsOffered) $upstreamPayload['tools'] = tool_catalog();

$sawError = false;
$assistantBuffer = '';
$usedTools = false;
$stats = null;
$doneReason = '';
$silenced = false;
$silenceReason = '';
$fledInfo = null;
$fleeDecided = false;

for ($round = 0; $round < 3; $round++) {
    $roundContent = '';
    $toolCalls = [];
    $retriedWithoutTools = false;

    do {
        $retryRound = false;
        $result = provider_stream_round($PROVIDER, $upstreamPayload, 'sse_send', $round);
        $roundContent = $result['content'];
        $toolCalls = $result['tool_calls'];
        if ($result['stats'] !== null) {
            // Generation is spread over every tool round so those counters
            // add up. the prompt ones don't. each round sends the whole
            // transcript again, last round's output included, so the number
            // from the last round is the real one.
            $prev = $stats;
            $stats = $result['stats'];
            if ($prev !== null) {
                $stats['eval_count'] += $prev['eval_count'];
                $stats['eval_duration'] += $prev['eval_duration'];
                $stats['total_duration'] += $prev['total_duration'];
            }
        }
        if ($result['done_reason'] !== '') $doneReason = $result['done_reason'];
        if ($result['stream_error']) $sawError = true;

        if ($result['curl_error'] !== '') {
            log_event(['msg' => 'upstream_curl_error', 'provider' => $PROVIDER, 'err' => $result['curl_error']]);
            sse_send(['error' => 'upstream_unavailable']);
            $sawError = true;
        }

        if (provider_uses_openai_protocol($PROVIDER)) {
            if ($result['http_status'] >= 400 && !$sawError) {
                // NEVER log request headers, the API key is in there.
                log_event(['msg' => 'upstream_http_error', 'provider' => $PROVIDER,
                           'status' => $result['http_status'], 'body' => mb_substr($result['error_body'], 0, 500)]);
                if ($round === 0 && !$retriedWithoutTools && isset($upstreamPayload['tools'])) {
                    // One more go, for llama.cpp templates that refuse tools.
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
        if ($name === 'stay_silent') {
            // An idle turn is unprompted anyway, so staying quiet does nothing.
            if ($idle) {
                $toolResult = json_encode(['error' => 'not_available_on_idle']);
            } else {
                $silenced = true;
                $silenceReason = trim((string)($args['reason'] ?? ''));
                $toolResult = json_encode(['silent' => true]);
            }
        } elseif ($name === 'flee') {
            if ($fleeDecided) {
                $toolResult = json_encode(['fled' => false, 'reason' => 'already_decided']);
            } else {
                $fleeDecided = true;
                $fleeReason = trim((string)($args['reason'] ?? ''));
                $verdict = flee_adjudicate($PROVIDER, $model, $body['messages'], $fleeReason,
                                           trim((string)($args['destination'] ?? '')));
                log_event(['msg' => 'flee_adjudication', 'user_id' => (int)$user['id'],
                           'conversation_id' => $convId, 'can_leave' => $verdict['can_leave'],
                           'why' => $verdict['why'], 'reason' => $fleeReason]);
                if ($verdict['can_leave']) {
                    $fledInfo = flee_bans_enabled()
                        ? ban_apply((int)$user['id'], $fleeReason)
                        : ['until' => 0, 'minutes' => 0];
                    $fledInfo['reason'] = $fleeReason;
                    $toolResult = json_encode(['fled' => true], JSON_UNESCAPED_UNICODE);
                } else {
                    $toolResult = json_encode([
                        'fled' => false,
                        'why' => $verdict['why'],
                        'note' => 'You cannot leave right now. Stay in the scene and respond to what is actually happening.',
                    ], JSON_UNESCAPED_UNICODE);
                }
            }
        } else {
            $toolResult = run_tool_call($name, $args, $user, $convId);
        }
        sse_send(['tool_status' => [
            'name' => $name, 'state' => 'done',
            'duration_ms' => (int)round((microtime(true) - $t0) * 1000),
            'result' => mb_substr($toolResult, 0, 2000),
        ]]);
        if ($silenced || $fledInfo !== null) break;
        $messages[] = provider_tool_message(
            $PROVIDER,
            $name,
            (string)($call['id'] ?? ''),
            $toolResult
        );
    }
    if ($silenced || $fledInfo !== null) break;
    $usedTools = true;
    $upstreamPayload['messages'] = $messages;
}

// She sometimes calls a tool and then just stops, no answer at all, and the
// user gets an error where a reply should be. Same hole at the other end,
// if the third round is still tool calls we run them and never let her
// speak. Both leave the buffer empty. one more round with the tools taken
// away, so the only thing left to do is talk.
if ($usedTools && !$sawError && !$silenced && $fledInfo === null && trim($assistantBuffer) === '') {
    log_event(['msg' => 'tool_round_silent_retry', 'model' => $model]);
    unset($upstreamPayload['tools']);
    $upstreamPayload['messages'] = $messages;
    $result = provider_stream_round($PROVIDER, $upstreamPayload, 'sse_send', 3);
    $assistantBuffer .= $result['content'];
    if ($result['done_reason'] !== '') $doneReason = $result['done_reason'];
    if ($result['stream_error']) $sawError = true;
    if ($result['stats'] !== null) {
        $prev = $stats;
        $stats = $result['stats'];
        if ($prev !== null) {
            $stats['eval_count'] += $prev['eval_count'];
            $stats['eval_duration'] += $prev['eval_duration'];
            $stats['total_duration'] += $prev['total_duration'];
        }
    }
}

// Same fine-tune quirk as memory_write below: she sometimes writes these as her own
// [A:...] tags instead of calling the tool. Route them through the identical path -
// a flee tag still has to clear the referee, since the tag itself proves nothing.
if (!$sawError && $assistantBuffer !== '') {
    if (!$silenced && !$idle && preg_match('/\[\s*A(?:CTIONS?)?\s*:\s*stay_silent\b([^\]]*)\]/i', $assistantBuffer, $sm)) {
        $silenced = true;
        if (preg_match('/\breason\s*=\s*([^|\]]+)/i', $sm[1], $sr)) $silenceReason = trim($sr[1]);
    }
    if (!$silenced && $fledInfo === null && !$fleeDecided
        && preg_match('/\[\s*A(?:CTIONS?)?\s*:\s*flee\b([^\]]*)\]/i', $assistantBuffer, $fm)) {
        $fleeDecided = true;
        $fleeReason = preg_match('/\breason\s*=\s*([^|\]]+)/i', $fm[1], $fr) ? trim($fr[1]) : '';
        $destination = preg_match('/\bdestination\s*=\s*([^|\]]+)/i', $fm[1], $fd) ? trim($fd[1]) : '';
        $verdict = flee_adjudicate($PROVIDER, $model, $body['messages'], $fleeReason, $destination);
        log_event(['msg' => 'flee_adjudication', 'user_id' => (int)$user['id'],
                   'conversation_id' => $convId, 'via' => 'action_tag',
                   'can_leave' => $verdict['can_leave'], 'why' => $verdict['why'], 'reason' => $fleeReason]);
        if ($verdict['can_leave']) {
            $fledInfo = flee_bans_enabled()
                ? ban_apply((int)$user['id'], $fleeReason)
                : ['until' => 0, 'minutes' => 0];
            $fledInfo['reason'] = $fleeReason;
        }
    }
    $assistantBuffer = trim(preg_replace('/\[\s*A(?:CTIONS?)?\s*:\s*(?:flee|stay_silent)\b[^\]]*\]/i', '', $assistantBuffer));
}

if ($silenced) {
    // Any lead-in she streamed defeats the point, but the transcript still needs an
    // assistant turn: strict templates reject a dangling user turn on the next request.
    $assistantBuffer = '...';
    sse_send(['silence' => ['reason' => $silenceReason]]);
} elseif ($fledInfo !== null) {
    if (trim($assistantBuffer) === '') $assistantBuffer = '...';
    sse_send(['fled' => [
        'until' => $fledInfo['until'],
        'minutes' => $fledInfo['minutes'],
        'reason' => $fledInfo['reason'],
    ]]);
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
            $res = memory_note_add((int)$user['id'], $category, trim($mem[1]));
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

    if (!$idle && !$ephemeral) {
        $titleRow = db()->prepare('SELECT title FROM conversations WHERE id=?');
        $titleRow->execute([$convId]);
        $conversationTitle = $titleRow->fetchColumn();
        $titleRow->closeCursor();
        // A spoken turn leaves $lastUserMsg empty, so there is nothing to name
        // the chat after. leave it untitled and let the next typed turn do it.
        if (!$conversationTitle && $lastUserMsg !== '') {
            $newTitle = generate_chat_title($lastUserMsg) ?: substr($lastUserMsg, 0, 60);
            db()->prepare('UPDATE conversations SET title=? WHERE id=?')
                ->execute([$newTitle, $convId]);
        }
    }
}

sse_done();

exit;
