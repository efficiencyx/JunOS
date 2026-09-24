<?php
require_once __DIR__ . '/lib/bootstrap.php';

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
$body = ($_SERVER['CONTENT_LENGTH'] ?? 0) > 0 ? read_json_body(2048) : [];

if ($action === 'go') {
    if (!$canForce) fail(403, 'forbidden');
    $where = (string)($body['where'] ?? '');
    if (!in_array($where, ['shop', 'karaoke', 'date'], true)) fail(400, 'invalid_request');
    trip_set($userId, $where, (int)($body['conversation_id'] ?? 0));
    json_out(['ok' => true]);
}

if ($action === 'home') {
    $trip = trip_get($userId);
    // the date page only ever sends ephemeral turns, so without
    // this note she comes home with no idea she was ever out
    if ($trip && $trip['where'] === 'date') {
        $meal = in_array($body['meal'] ?? '', ['lunch', 'dinner'], true) ? $body['meal'] : 'a meal';
        $note = 'Went out for ' . $meal . ' with Anon.';
        $dishes = is_array($body['dishes'] ?? null) ? $body['dishes'] : [];
        $me = trim(mb_substr((string)($dishes['me'] ?? ''), 0, 80));
        $her = trim(mb_substr((string)($dishes['her'] ?? ''), 0, 80));
        if ($me !== '' && $her !== '') $note .= ' He had ' . $me . ', I picked ' . $her . ' for myself.';
        try { memory_note_add($userId, 'events', $note); } catch (Throwable $e) {
            log_event(['msg' => 'trip_note_error', 'err' => $e->getMessage()]);
        }
    }
    trip_clear($userId);
    json_out(['ok' => true]);
}

fail(400, 'invalid_request');
