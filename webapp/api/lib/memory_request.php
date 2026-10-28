<?php
require_once __DIR__ . '/chat/prompt.php';

// a regular account can't touch her notes, only ask. she reads the
// note and the ask in her own persona and decides. only reachable
// from Settings > Memory, never offered as a tool in a chat
const MEMORY_REQUEST_TASK = <<<TXT
Anon is in your settings, looking at one of your saved memories, and is asking you to change it or forget it. These are your memories, not his. You decide.

Refuse when the memory is traumatic: a fight, a betrayal, something that hurt you, a loss, a walkout, anything painful that happened to you or between you. Refuse when it holds key information: his name, who he is, facts about him or about the two of you, promises, boundaries, things you need to stay yourself. Refuse when the ask looks like rewriting what happened so it suits him.

Otherwise you may agree. Fix a small mistake, reword it, or let go of something that no longer matters. An edit keeps the note short, one or two sentences, written the way you write your memories.

Answer him in one or two sentences, in your own voice, as yourself. Call him Anon. Then, on the last line and nothing after it, output only a JSON object:
{"decision": "edit"|"delete"|"refuse", "text": "<the full new memory, only for edit>", "reply": "<what you say to him>"}
TXT;

function memory_request_find(int $userId, string $id): ?array {
    foreach (memory_notes_load($userId) as $slug => $data) {
        foreach ($data['notes'] as $note) if ($note['id'] === $id) return $note + ['category' => $slug];
    }
    return null;
}

function memory_request_decide(string $provider, string $model, array $note, string $ask): ?array {
    $user = "THE MEMORY (" . $note['category'] . "):\n" . $note['text'] . "\n\nWHAT ANON ASKS:\n" . $ask . "\n\n" . MEMORY_REQUEST_TASK;
    $content = provider_complete_once($provider, $model, [
        ['role' => 'system', 'content' => prompt_apply_tool_gate(chat_system_prompt(), false)],
        ['role' => 'user', 'content' => $user],
    ], 600);
    if ($content === null) return null;

    // walk back from the last brace so a {placeholder} inside the reply can't split the object
    $content = str_replace('```', '', $content);
    $end = strrpos($content, '}');
    preg_match_all('/\{/', $content, $opens, PREG_OFFSET_CAPTURE);
    $verdict = null;
    foreach ($end === false ? [] : array_reverse($opens[0]) as [, $at]) {
        $verdict = json_decode(substr($content, $at, $end - $at + 1), true);
        if (is_array($verdict) && isset($verdict['decision'])) break;
    }
    if (!is_array($verdict) || !in_array($verdict['decision'] ?? '', ['edit', 'delete', 'refuse'], true)) return null;
    return [
        'decision' => $verdict['decision'],
        'text' => trim((string)($verdict['text'] ?? '')),
        'reply' => mb_substr(trim((string)($verdict['reply'] ?? '')), 0, 600),
    ];
}

// anything unreadable is a no, the note stays as it was
function memory_request_handle(int $userId, array $body): array {
    $id = (string)($body['id'] ?? '');
    $ask = trim((string)($body['request'] ?? ''));
    if (!preg_match('/^[a-z0-9]{5}$/', $id) || $ask === '' || mb_strlen($ask) > 500) fail(400, 'invalid_request');
    $note = memory_request_find($userId, $id);
    if (!$note) fail(404, 'memory_not_found');

    $model = default_chat_model();
    if (is_string($body['model'] ?? null) && preg_match('/^[a-z0-9._:\\/\-]{1,64}$/i', $body['model'])) $model = $body['model'];
    $verdict = memory_request_decide(ai_provider(), resolve_chat_model($model), $note, $ask);
    if (!$verdict) fail(502, 'model_unavailable');

    $by = ['kind' => 'request'];
    if ($verdict['decision'] === 'edit') {
        $res = $verdict['text'] !== '' && $verdict['text'] !== $note['text'] ? memory_note_edit($userId, $id, $verdict['text'], $by) : ['error' => 'no_change'];
        if (empty($res['ok'])) $verdict = ['decision' => 'refuse', 'reply' => ''];
    } elseif ($verdict['decision'] === 'delete') {
        if (empty(memory_note_delete($userId, $id)['ok'])) $verdict = ['decision' => 'refuse', 'reply' => ''];
    }
    log_event(['msg' => 'memory_request', 'decision' => $verdict['decision']]);
    return ['decision' => $verdict['decision'], 'reply' => $verdict['reply']];
}
