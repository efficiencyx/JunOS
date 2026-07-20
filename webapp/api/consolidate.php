<?php

require_once __DIR__ . '/_consolidation.php';

header('Content-Type: application/json');
$user = require_user();
$userId = (int)$user['id'];
$action = $_GET['action'] ?? '';

if ($_SERVER['REQUEST_METHOD'] === 'GET' && $action === 'status') {
    echo json_encode(['locked' => consolidation_locked($userId)]);
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
