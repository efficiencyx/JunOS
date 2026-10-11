<?php
require_once __DIR__ . '/lib/bootstrap.php';

header('Cache-Control: no-store');

$user = require_user();
rate_limit('achievements', 120, 60);
$userId = (int)$user['id'];

if (require_method('GET', 'POST') === 'GET') json_out(ach_list($userId, is_admin($user)));

$action = $_GET['action'] ?? '';
$body = read_json_body(4096);

if ($action === 'seen') {
    ach_mark_seen($userId, is_array($body['items'] ?? null) ? $body['items'] : []);
    json_out(['ok' => true]);
}

if ($action === 'bump') {
    $stat = (string)($body['stat'] ?? '');
    if (!in_array($stat, ACH_CLIENT_STATS, true)) fail(400, 'invalid_request');
    ach_add($userId, $stat);
    json_out(['ok' => true]);
}

if ($action === 'set') {
    if (!is_admin($user)) fail(403, 'forbidden');
    $value = $body['value'] ?? null;
    if ($value !== null && !is_int($value)) fail(400, 'invalid_request');
    if (!ach_set($userId, (string)($body['id'] ?? ''), $value)) fail(400, 'invalid_request');
    json_out(ach_list($userId, true));
}

fail(400, 'invalid_request');
