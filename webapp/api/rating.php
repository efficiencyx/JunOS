<?php
require_once __DIR__ . '/_lib.php';

header('Content-Type: application/json');
rate_limit('rating', 60, 60);

require_user();
require_post();
require_content_type('application/json');

$body = json_decode(read_body(4 * 1024), true);
$turnId = (string)($body['turn_id'] ?? '');
$rating = (int)($body['rating'] ?? 0);
if (!preg_match('/^[0-9a-f]{16}$/', $turnId) || !in_array($rating, [1, -1], true)) {
    fail(400, 'invalid_request');
}

if (telemetry_enabled()) {
    telemetry_send([
        'schema' => 1,
        'event' => 'rating',
        'install_id' => env_str('TELEMETRY_INSTALL_ID'),
        'turn_id' => $turnId,
        'rating' => $rating,
        'ts' => time(),
    ]);
}

echo json_encode(['ok' => true]);
