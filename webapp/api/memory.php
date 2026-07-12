<?php
// Durable memory notes (the file memory_write appends to from chat).
// GET returns all entries; POST {memory, category?} adds one;
// DELETE {id, created_at} removes one entry, DELETE {all:true} wipes the file.
// `id` is the entry's line index as returned by GET; created_at is re-checked
// so a stale list can't delete the wrong line.
require_once __DIR__ . '/_lib.php';

header('Content-Type: application/json');
rate_limit('memory', 60, 60);

$user = require_user();
$userId = (int)$user['id'];
$method = $_SERVER['REQUEST_METHOD'];

try {
    if ($method === 'GET') {
        echo json_encode(['memories' => memory_list($userId)], JSON_UNESCAPED_UNICODE);
        exit;
    }

    if ($method === 'POST') {
        require_content_type('application/json');
        $body = json_decode(read_body(8 * 1024), true);
        if (!is_array($body)) fail(400, 'invalid_request');
        $res = memory_append($userId, (string)($body['memory'] ?? ''), (string)($body['category'] ?? 'general'));
        if (isset($res['error'])) fail(400, $res['error']);
        echo json_encode($res, JSON_UNESCAPED_UNICODE);
        exit;
    }

    if ($method === 'DELETE') {
        $body = json_decode(read_body(8 * 1024), true);
        if (!is_array($body)) fail(400, 'invalid_request');
        $path = memory_file_path($userId);

        if (!empty($body['all'])) {
            if (is_file($path)) @unlink($path);
            echo json_encode(['ok' => true]);
            exit;
        }

        if (!isset($body['id'], $body['created_at'])) fail(400, 'invalid_request');
        $id = (int)$body['id'];
        $createdAt = (int)$body['created_at'];

        $fp = is_file($path) ? fopen($path, 'c+b') : false;
        if ($fp === false) fail(404, 'memory_not_found');
        flock($fp, LOCK_EX);
        $lines = [];
        while (($line = fgets($fp)) !== false) {
            if (trim($line) !== '') $lines[] = rtrim($line, "\n");
        }
        $obj = isset($lines[$id]) ? json_decode($lines[$id], true) : null;
        if (!is_array($obj) || (int)($obj['created_at'] ?? -1) !== $createdAt) {
            flock($fp, LOCK_UN);
            fclose($fp);
            fail(409, 'memory_mismatch');
        }
        array_splice($lines, $id, 1);
        ftruncate($fp, 0);
        rewind($fp);
        if ($lines) fwrite($fp, implode("\n", $lines) . "\n");
        flock($fp, LOCK_UN);
        fclose($fp);
        echo json_encode(['ok' => true]);
        exit;
    }

    fail(405, 'method_not_allowed');
} catch (RuntimeException $e) {
    log_event(['msg' => 'memory_api_error', 'err' => $e->getMessage()]);
    fail(500, 'memory_unavailable');
}
