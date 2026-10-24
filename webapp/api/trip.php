<?php
require_once __DIR__ . '/lib/bootstrap.php';
require_once __DIR__ . '/lib/consolidation/guided.php';

// the table talk was ephemeral. this call is all that survives of it
function date_recap(array $table, string $meal, string $venue): array {
    $lines = [];
    $anonSpoke = false;
    foreach (array_slice($table, -40) as $row) {
        if (!is_array($row)) continue;
        $text = trim(preg_replace('/\s+/', ' ', mb_substr((string)($row['text'] ?? ''), 0, 400)));
        if ($text === '') continue;
        $role = ($row['role'] ?? '') === 'assistant' ? 'assistant' : 'user';
        $anonSpoke = $anonSpoke || $role === 'user';
        $lines[] = speaker_name($role) . ': ' . str_replace(['{f_playerName}', '{f_botName}'], ['Anon', 'Jun'], $text);
    }
    $none = ['moments' => [], 'plans' => []];
    if (!$anonSpoke) return $none;
    $where = $venue !== '' ? " at {$venue}" : '';
    $sys = CONSOLIDATION_VOICE . <<<PROMPT


Anon and I just had {$meal}{$where}. Below is what we said at the table. I write down what I want to keep from it, nothing else of it stays with me.

"moments": at most 2. Something that actually happened at this table that I'd want to bring up again: a joke that landed, something he told me about himself, a fight, something I found out. One sentence each, with the concrete detail (the name, the place, what he actually said). Not what we ordered, that's already written down.
"plans": at most 2. Something one of us promised, or we agreed to do later, that hasn't happened yet. One sentence each, with the when if we said one.

Small talk is nothing. Only what's in these lines, never a guess. An empty list is fine.

I answer with a JSON object {"moments": [...], "plans": [...]} and nothing else.
PROMPT;
    $content = provider_complete_once(ai_provider(), default_chat_model(),
        [['role' => 'system', 'content' => $sys], ['role' => 'user', 'content' => implode("\n", $lines)]], 400, false);
    if ($content === null) return $none;
    $json = trim($content);
    if (preg_match('/```(?:json)?\s*(.*?)\s*```/is', $json, $m)) $json = trim($m[1]);
    $start = strpos($json, '{');
    $end = strrpos($json, '}');
    $decoded = $start !== false && $end > $start ? json_decode(substr($json, $start, $end - $start + 1), true) : null;
    if (!is_array($decoded)) return $none;
    foreach ($none as $key => $_) {
        $items = is_array($decoded[$key] ?? null) ? $decoded[$key] : [];
        $items = array_map(fn($t) => is_string($t) ? trim(preg_replace('/\s+/', ' ', mb_substr($t, 0, 240))) : '', $items);
        $none[$key] = array_slice(array_values(array_filter($items, fn($t) => $t !== '')), 0, 2);
    }
    return $none;
}

$user = require_user();
rate_limit('trip', 30, 60);
$userId = (int)$user['id'];
$canForce = is_admin($user) || free_roam_enabled();

if (require_method('GET', 'POST') === 'GET') {
    $trip = trip_get($userId) ?? ['where' => '', 'since' => 0, 'conversation_id' => 0];
    $trip['gated'] = !free_roam_enabled();
    $trip['can_force'] = $canForce;
    json_out($trip);
}

$action = $_GET['action'] ?? '';
$body = ($_SERVER['CONTENT_LENGTH'] ?? 0) > 0 ? read_json_body(48 * 1024) : [];

if ($action === 'go') {
    if (!$canForce) fail(403, 'forbidden');
    $where = (string)($body['where'] ?? '');
    if (!in_array($where, ['shop', 'karaoke', 'date'], true)) fail(400, 'invalid_request');
    trip_set($userId, $where, (int)($body['conversation_id'] ?? 0));
    json_out(['ok' => true]);
}

if ($action === 'home') {
    $trip = trip_get($userId);
    $recap = null;
    // the date page only ever sends ephemeral turns, so without
    // this note she comes home with no idea she was ever out
    if ($trip && $trip['where'] === 'date') {
        $meal = in_array($body['meal'] ?? '', ['lunch', 'dinner'], true) ? $body['meal'] : 'a meal';
        $venue = trim(mb_substr((string)($body['venue'] ?? ''), 0, 60));
        $recap = date_recap(is_array($body['table'] ?? null) ? $body['table'] : [], $meal, $venue);
        $note = 'Went out for ' . $meal . ($venue !== '' ? ' at ' . $venue : '') . ' with Anon.';
        $dishes = is_array($body['dishes'] ?? null) ? $body['dishes'] : [];
        $me = trim(mb_substr((string)($dishes['me'] ?? ''), 0, 80));
        $her = trim(mb_substr((string)($dishes['her'] ?? ''), 0, 80));
        if ($me !== '' && $her !== '') $note .= ' He had ' . $me . ', I picked ' . $her . ' for myself.';
        if ($recap['moments']) $note .= ' ' . implode(' ', $recap['moments']);
        try {
            $source = ['kind' => 'date', 'conv' => $trip['conversation_id']];
            memory_note_add($userId, 'events', $note, $source);
            foreach ($recap['plans'] as $plan) memory_note_add($userId, 'plans', $plan, $source);
        } catch (Throwable $e) {
            log_event(['msg' => 'trip_note_error', 'err' => $e->getMessage()]);
        }
        ach_add($userId, 'dates');
    }
    if ($trip && $trip['where'] === 'shop') ach_add($userId, 'shops');
    trip_clear($userId);
    json_out($recap ? ['ok' => true, 'recap' => $recap] : ['ok' => true]);
}

fail(400, 'invalid_request');
