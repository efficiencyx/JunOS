<?php

require_once __DIR__ . '/_consolidation.php';

header('Content-Type: application/json');
$user = require_user();
$userId = (int)$user['id'];
$action = $_GET['action'] ?? '';

if ($_SERVER['REQUEST_METHOD'] === 'GET' && $action === 'status') {
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
    echo json_encode($status);
    exit;
}

// Has to be read BEFORE the client reports activity for this session, or the
// absence it is measuring is already written over with "just now".
if ($_SERVER['REQUEST_METHOD'] === 'GET' && $action === 'welcome') {
    $preview = isset($_GET['preview']) ? [
        'away' => max(0, (int)($_GET['away'] ?? 0)),
        'tier' => trim((string)($_GET['tier'] ?? '')),
    ] : null;
    $hour = isset($_GET['hour']) && $_GET['hour'] !== '' ? (int)$_GET['hour'] : null;
    if ($hour !== null && ($hour < 0 || $hour > 23)) $hour = null;
    echo json_encode(welcome_payload($userId, $preview, $hour));
    exit;
}

if ($_SERVER['REQUEST_METHOD'] === 'POST' && $action === 'activity') {
    rate_limit('consolidate_activity', 120, 60);
    consolidation_touch($userId, ($_GET['enabled'] ?? '1') !== '0');
    echo json_encode(['ok' => true]);
    exit;
}

require_post();
rate_limit('consolidate', 6, 600);
echo json_encode(consolidation_run($userId));
