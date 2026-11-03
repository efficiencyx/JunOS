<?php

require_once __DIR__ . '/lib/bootstrap.php';
require_once __DIR__ . '/lib/bridge/apply.php';

$user = require_user();
$userId = (int)$user['id'];

if (require_method('GET', 'POST', 'DELETE') === 'GET') {
    $st = db()->prepare('SELECT created_at FROM bridge_tokens WHERE user_id = ?');
    $st->execute([$userId]);
    $sync = bridge_sync_row($userId);
    json_out([
        'enabled' => bridge_enabled(),
        'paired_at' => (int)$st->fetchColumn() ?: null,
        'synced_at' => $sync ? (int)$sync['synced_at'] : null,
    ]);
}
if (!bridge_enabled()) fail(404, 'not_found');
if ($_SERVER['REQUEST_METHOD'] === 'DELETE') {
    bridge_token_revoke($userId);
    json_out(['ok' => true]);
}
rate_limit('bridge_pair_' . $userId, 5, 60);
bridge_keys_ensure($userId);
json_out(['token' => bridge_token_issue($userId)]);
