<?php
require_once __DIR__ . '/lib/bootstrap.php';
require_once __DIR__ . '/lib/mods.php';

$user = require_user();
$userId = (int)$user['id'];
$method = require_method('GET', 'PUT', 'DELETE');
$guid = (string)($_GET['guid'] ?? '');
if ($guid !== '' && !preg_match(MOD_GUID, $guid)) fail(400, 'invalid_guid');

if ($method === 'GET') {
    rate_limit('mods_get_' . $userId, 120, 60);
    if ($guid === '') json_out(['epoch' => mods_epoch($userId), 'mods' => mods_list($userId), 'state' => mods_state_get($userId)]);
    if (!is_file(mods_path($userId, $guid))) fail(404, 'mod_not_found');
    header('Content-Type: application/zip');
    header('Cache-Control: no-store');
    mods_stream($userId, $guid);
    exit;
}

rate_limit('mods_put_' . $userId, 240, 60);

if ($method === 'DELETE') {
    if ($guid === '') fail(400, 'invalid_guid');
    mods_delete($userId, $guid);
    json_out(['ok' => true]);
}

if (($_GET['action'] ?? '') === 'state') {
    json_out(['version' => mods_state_put($userId, read_json_body(MODS_STATE_MAX_BYTES))]);
}

if ($guid === '') fail(400, 'invalid_guid');
$part = (int)($_GET['part'] ?? -1);
$parts = (int)($_GET['parts'] ?? 0);
if ($parts < 1 || $parts > MOD_MAX_PARTS || $part < 0 || $part >= $parts) fail(400, 'invalid_part');
require_content_type('application/octet-stream');
$err = mods_put_part($userId, $guid, $part, $parts, read_body(MOD_PART_BYTES));
if ($err !== null) fail(['mods_full' => 413, 'part_out_of_order' => 409, 'mods_write_failed' => 500][$err] ?? 400, $err);
json_out(['ok' => true]);
