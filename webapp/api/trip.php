<?php
require_once __DIR__ . '/_lib.php';

header('Content-Type: application/json');
rate_limit('trip', 30, 60);

$user = require_user();
$userId = (int)$user['id'];
$canForce = ($user['role'] ?? '') === 'admin' || free_roam_enabled();

if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    $trip = trip_get($userId) ?? ['where' => '', 'since' => 0, 'conversation_id' => 0];
    $trip['gated'] = !free_roam_enabled();
    $trip['can_force'] = $canForce;
    echo json_encode($trip);
    exit;
}

require_post();
$action = $_GET['action'] ?? '';
$body = [];
if (($_SERVER['CONTENT_LENGTH'] ?? 0) > 0) {
    require_content_type('application/json');
    $body = json_decode(read_body(2048), true);
    if (!is_array($body)) fail(400, 'invalid_request');
}

if ($action === 'go') {
    if (!$canForce) fail(403, 'forbidden');
    $where = (string)($body['where'] ?? '');
    if (!in_array($where, ['shop', 'karaoke', 'date'], true)) fail(400, 'invalid_request');
    trip_set($userId, $where, (int)($body['conversation_id'] ?? 0));
    echo json_encode(['ok' => true]);
    exit;
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
        if ($me !== '' && $her !== '') $note .= ' He ordered ' . $me . ' for himself and ' . $her . ' for me.';
        try { memory_note_add($userId, 'events', $note); } catch (Throwable $e) {
            log_event(['msg' => 'trip_note_error', 'err' => $e->getMessage()]);
        }
    }
    trip_clear($userId);
    echo json_encode(['ok' => true]);
    exit;
}

fail(400, 'invalid_request');
