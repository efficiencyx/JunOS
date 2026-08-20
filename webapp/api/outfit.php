<?php
require_once __DIR__ . '/_lib.php';
require_once __DIR__ . '/_wardrobe.php';

header('Content-Type: application/json');
$user = require_user();
$userId = (int)$user['id'];

if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    $state = wardrobe_state($userId);
    echo json_encode(['initialized' => $state !== null, 'state' => $state ?? wardrobe_default_state()]);
    exit;
}
if ($_SERVER['REQUEST_METHOD'] === 'PUT') {
    require_content_type('application/json');
    rate_limit('outfit_change_' . $userId, 2, 1);
    $body = json_decode(read_body(32 * 1024), true);
    if (!is_array($body)) fail(400, 'invalid_request');
    $state = wardrobe_canonical_state($body);
    wardrobe_save_state($userId, $state);
    echo json_encode(['state' => $state]);
    exit;
}
fail(405, 'method_not_allowed');
