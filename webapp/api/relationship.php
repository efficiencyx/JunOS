<?php
require_once __DIR__ . '/lib/bootstrap.php';

$user = require_user();
rate_limit('relationship', 60, 60);
$userId = (int)$user['id'];

if (require_method('GET', 'PUT') === 'GET') json_out(relationship_get($userId));

require_admin();
$body = read_json_body(1024);
$values = [];
foreach (['affection', 'trust', 'tension'] as $k) {
    if (!isset($body[$k]) || !is_numeric($body[$k])) fail(400, 'invalid_request');
    $values[$k] = (int)$body[$k];
}
relationship_set($userId, $values);
json_out(relationship_get($userId));
