<?php
// Per-user preferences. GET returns the stored JSON object (or {}),
// PUT replaces it. Body is opaque JSON capped at 16 KB so the frontend can
// add new keys (theme, default model, reasoning level, …) without touching
// the schema.
require_once __DIR__ . '/_lib.php';

header('Content-Type: application/json');
omega_rate_limit('prefs', 60, 60);

$user   = omega_require_user();
$db     = omega_db();
$method = $_SERVER['REQUEST_METHOD'];

if ($method === 'GET') {
    $stmt = $db->prepare('SELECT data FROM preferences WHERE user_id=?');
    $stmt->execute([$user['id']]);
    $row = $stmt->fetch();
    if (!$row) { echo '{}'; exit; }
    $parsed = json_decode((string)$row['data'], true);
    echo json_encode(is_array($parsed) ? $parsed : new stdClass());
    exit;
}

if ($method === 'PUT') {
    $raw = omega_read_body(16 * 1024);
    $parsed = json_decode($raw, true);
    if (!is_array($parsed)) {
        omega_json_error(400, 'invalid_request');
    }
    // Re-encode to canonicalise & strip any non-UTF-8 garbage.
    $canonical = json_encode($parsed, JSON_UNESCAPED_UNICODE);
    $db->prepare(
        'INSERT INTO preferences (user_id, data) VALUES (?, ?)
         ON CONFLICT(user_id) DO UPDATE SET data=excluded.data'
    )->execute([$user['id'], $canonical]);
    echo json_encode(['ok' => true]);
    exit;
}

omega_json_error(405, 'method_not_allowed');
