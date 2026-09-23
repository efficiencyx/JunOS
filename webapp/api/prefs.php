<?php
require_once __DIR__ . '/lib/bootstrap.php';

$user = require_user();
rate_limit('prefs', 60, 60);
$db = db();
$method = require_method('GET', 'PUT');

if ($method === 'GET') {
    $stmt = $db->prepare('SELECT data FROM preferences WHERE user_id=?');
    $stmt->execute([$user['id']]);
    $row = $stmt->fetch();
    $parsed = $row ? json_decode((string)dec($row['data']), true) : null;
    json_out(is_array($parsed) ? $parsed : new stdClass());
}

$parsed = read_json_body(16 * 1024);
$canonical = json_encode($parsed, JSON_UNESCAPED_UNICODE);
$db->prepare(
    'INSERT INTO preferences (user_id, data) VALUES (?, ?)
     ON CONFLICT(user_id) DO UPDATE SET data=excluded.data'
)->execute([$user['id'], enc($canonical)]);
json_out(['ok' => true]);
