<?php

require_once __DIR__ . '/lib/bootstrap.php';
require_once __DIR__ . '/lib/consolidation/engine.php';
require_once __DIR__ . '/lib/consolidation/passes.php';
require_once __DIR__ . '/lib/consolidation/welcome.php';

$user = require_user();
$userId = (int)$user['id'];
$action = $_GET['action'] ?? '';
$method = require_method('GET', 'POST');

if ($method === 'GET' && $action === 'status') {
    $status = consolidation_status($userId);
    $stmt = db()->prepare('SELECT last_run, last_status, last_note_count FROM memory_consolidation WHERE user_id = ?');
    $stmt->execute([$userId]);
    $row = $stmt->fetch();
    if ($row && (int)$row['last_run'] > 0 && (string)$row['last_status'] !== '') {
        $status['last'] = [
            'at'     => (int)$row['last_run'],
            'status' => (string)$row['last_status'],
            'notes'  => (int)$row['last_note_count'],
        ];
    }
    $ban = ban_active($userId);
    if ($ban !== null) $status['ban'] = ['until' => $ban['until'], 'reason' => $ban['reason']];
    json_out($status);
}

// has to be read BEFORE the client reports activity for this
// session, or the absence it's measuring already got written
// over with "just now".
if ($method === 'GET' && $action === 'welcome') {
    if (!is_admin($user)) {
        foreach (['preview', 'away', 'tier'] as $param) {
            if (isset($_GET[$param])) fail(403, 'forbidden');
        }
    }
    $preview = isset($_GET['preview']) ? [
        'away' => max(0, (int)($_GET['away'] ?? 0)),
        'tier' => trim((string)($_GET['tier'] ?? '')),
    ] : null;
    $hour = isset($_GET['hour']) && $_GET['hour'] !== '' ? (int)$_GET['hour'] : null;
    if ($hour !== null && ($hour < 0 || $hour > 23)) $hour = null;
    json_out(welcome_payload($userId, $preview, $hour));
}

if ($method === 'POST' && $action === 'activity') {
    rate_limit('consolidate_activity', 120, 60);
    consolidation_touch($userId, ($_GET['enabled'] ?? '1') !== '0');
    json_out(['ok' => true]);
}

require_post();
rate_limit('consolidate', 6, 600);
json_out(consolidation_run($userId));
