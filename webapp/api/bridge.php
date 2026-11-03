<?php

// bearer token, no cookie, nothing for the origin check to guard
const OMEGA_TOKEN_AUTH = true;

require_once __DIR__ . '/lib/bootstrap.php';
require_once __DIR__ . '/lib/bridge/apply.php';

if (!bridge_enabled()) fail(404, 'not_found');
rate_limit('bridge', 60, 60);
require_method('POST');
require_content_type('application/json');

$auth = $_SERVER['HTTP_AUTHORIZATION'] ?? '';
$userId = str_starts_with($auth, 'Bearer ') ? bridge_token_user(trim(substr($auth, 7))) : null;
if ($userId === null) {
    log_event(['msg' => 'bridge_unauthorized']);
    fail(401, 'unauthorized');
}

// savedata is JsonUtility.ToJson(GameVariables), the same string a save holds
$body = read_json_body(2 * 1024 * 1024);
$vars = is_string($body['savedata'] ?? null) ? json_decode($body['savedata'], true) : null;
$snap = is_array($vars) ? bridge_snapshot($vars) : null;
if ($snap === null) fail(400, 'invalid_request');

$report = bridge_sync($userId, $snap);
bridge_sync_settle($userId, $report['sympathy']);
json_out([
    'sympathy' => $report['sympathy'],
    'outfit' => bridge_outfit_for_game($userId),
    'events' => count($report['events']),
]);
