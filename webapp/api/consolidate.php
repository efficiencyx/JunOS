<?php

require_once __DIR__ . '/lib/bootstrap.php';
require_once __DIR__ . '/lib/chat/sse.php';
require_once __DIR__ . '/lib/consolidation/feed.php';
require_once __DIR__ . '/lib/consolidation/cabinet.php';
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

// php -S (windows, colab) serves one request at a time. holding
// the stream there freezes the app, so it answers and EventSource polls
if ($method === 'GET' && $action === 'stream') {
    rate_limit('consolidate_stream', 240, 60);
    $cursor = (string)($_SERVER['HTTP_LAST_EVENT_ID'] ?? $_GET['from'] ?? '');
    $until = time() + (PHP_SAPI === 'cli-server' ? 0 : 25);
    sse_open();
    echo "retry: 1000\n\n";
    @flush();
    do {
        [$events, $cursor] = consolidation_feed_read($userId, $cursor);
        foreach ($events as $event) {
            echo 'id: ' . $event['id'] . "\ndata: " . json_encode($event, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) . "\n\n";
        }
        if ($events) @flush();
        if (time() >= $until || (!$events && !consolidation_locked($userId))) break;
        usleep(300000);
    } while (!connection_aborted());
    exit;
}

if ($method === 'POST' && $action === 'interrupt') {
    rate_limit('consolidate_interrupt', 30, 60);
    db()->prepare('UPDATE memory_consolidation SET interrupt_at = ? WHERE user_id = ?')->execute([time(), $userId]);
    // he's back. without this last_activity still reads idle and the worker restarts her a second later
    consolidation_touch($userId);
    json_out(['ok' => true]);
}

if ($method === 'POST' && $action === 'game') {
    rate_limit('consolidate_game', 30, 600);
    json_out(cabinet_settle($userId, read_json_body(64 * 1024)));
}

// admin only, and queued for the worker: a guided pass outlives any fastcgi timeout
require_post();
if (!is_admin($user)) fail(403, 'forbidden');
rate_limit('consolidate', 6, 600);
db()->prepare(
    'INSERT INTO memory_consolidation (user_id, force_at) VALUES (?, ?)
     ON CONFLICT(user_id) DO UPDATE SET force_at = excluded.force_at'
)->execute([$userId, time()]);
key_push($userId, true);
json_out(['queued' => true]);
