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
    echo json_encode($status);
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
