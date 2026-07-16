<?php
require_once __DIR__ . '/_lib.php';

header('Content-Type: application/json');
rate_limit('prefs', 60, 60);

$user = require_user();
$db = db();
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
    $parsed = json_decode(read_body(16 * 1024), true);
    if (!is_array($parsed)) fail(400, 'invalid_request');

    $canonical = json_encode($parsed, JSON_UNESCAPED_UNICODE);
    $db->prepare(
        'INSERT INTO preferences (user_id, data) VALUES (?, ?)
         ON CONFLICT(user_id) DO UPDATE SET data=excluded.data'
    )->execute([$user['id'], $canonical]);
    echo json_encode(['ok' => true]);
    exit;
}

fail(405, 'method_not_allowed');
