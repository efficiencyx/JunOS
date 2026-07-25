<?php
require_once __DIR__ . '/_lib.php';

header('Content-Type: application/json');
rate_limit('consent', 30, 60);

$user = require_user();
$db = db();
$method = $_SERVER['REQUEST_METHOD'];

if ($method === 'GET') {
    $stmt = $db->prepare('SELECT granted, notice_version, decided_at, erasure_requested_at FROM telemetry_consent WHERE user_id=?');
    $stmt->execute([$user['id']]);
    $row = $stmt->fetch();
    $current = $row && $row['notice_version'] === TELEMETRY_NOTICE_VERSION;
    echo json_encode([
        'available' => telemetry_enabled(),
        'notice_version' => TELEMETRY_NOTICE_VERSION,
        'asked' => (bool)$current,
        'granted' => $current && (int)$row['granted'] === 1,
        'decided_at' => $row ? (int)$row['decided_at'] : null,
        'erasure_requested_at' => $row && $row['erasure_requested_at'] ? (int)$row['erasure_requested_at'] : null,
    ]);
    exit;
}

if ($method !== 'POST') fail(405, 'method_not_allowed');
require_content_type('application/json');

$body = json_decode(read_body(1024), true);
if (!is_array($body)) fail(400, 'invalid_request');

if (!empty($body['erase'])) {
    $now = time();
    $db->prepare(
        'INSERT INTO telemetry_consent (user_id, granted, notice_version, decided_at, erasure_requested_at)
         VALUES (?, 0, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET granted=0, erasure_requested_at=excluded.erasure_requested_at'
    )->execute([$user['id'], TELEMETRY_NOTICE_VERSION, $now, $now]);

    if (telemetry_enabled()) {
        if (function_exists('fastcgi_finish_request')) {
            echo json_encode(['ok' => true]);
            fastcgi_finish_request();
        }
        telemetry_send([
            'schema' => 1,
            'event' => 'erasure_request',
            'install_id' => env_str('TELEMETRY_INSTALL_ID'),
            'user_ref' => telemetry_user_ref((int)$user['id']),
            'ts' => $now,
        ]);
        exit;
    }
    echo json_encode(['ok' => true]);
    exit;
}

if (!array_key_exists('granted', $body) || !is_bool($body['granted'])) fail(400, 'invalid_request');

$db->prepare(
    'INSERT INTO telemetry_consent (user_id, granted, notice_version, decided_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET
       granted=excluded.granted, notice_version=excluded.notice_version, decided_at=excluded.decided_at'
)->execute([$user['id'], $body['granted'] ? 1 : 0, TELEMETRY_NOTICE_VERSION, time()]);

echo json_encode(['ok' => true, 'granted' => $body['granted']]);
