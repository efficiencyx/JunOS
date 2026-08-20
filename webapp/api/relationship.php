<?php
require_once __DIR__ . '/_lib.php';

header('Content-Type: application/json');
rate_limit('relationship', 60, 60);

$user = require_user();
$method = $_SERVER['REQUEST_METHOD'];

if ($method === 'GET') {
    echo json_encode(relationship_get((int)$user['id']));
    exit;
}

if ($method === 'PUT') {
    if (($user['role'] ?? '') !== 'admin') fail(403, 'forbidden');
    require_content_type('application/json');
    $body = json_decode(read_body(1024), true);
    if (!is_array($body)) fail(400, 'invalid_request');

    $values = [];
    foreach (['affection', 'trust', 'tension'] as $k) {
        if (!isset($body[$k]) || !is_numeric($body[$k])) fail(400, 'invalid_request');
        $values[$k] = (int)$body[$k];
    }
    relationship_set((int)$user['id'], $values);
    echo json_encode(relationship_get((int)$user['id']));
    exit;
}

fail(405, 'method_not_allowed');
