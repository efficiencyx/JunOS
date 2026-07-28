<?php
require_once __DIR__ . '/_lib.php';

header('Content-Type: application/json');
rate_limit('memory', 60, 60);

$user = require_user();
$userId = (int)$user['id'];
$method = $_SERVER['REQUEST_METHOD'];

try {
    if ($method === 'GET') {
        $categories = [];
        $notes = [];
        foreach (memory_notes_load($userId) as $slug => $data) {
            $updated = 0;
            foreach ($data['notes'] as $note) {
                $updated = max($updated, $note['updated']);
                $notes[] = [
                    'id' => $note['id'],
                    'category' => $slug,
                    'text' => $note['text'],
                    'links' => $note['links'],
                    'created' => $note['created'],
                ];
            }
            $categories[] = [
                'slug' => $slug,
                'count' => count($data['notes']),
                'updated' => $updated,
            ];
        }
        echo json_encode([
            'categories' => $categories,
            'notes' => $notes,
            'journal' => ['entries' => journal_parse(memory_journal_read($userId))],
        ], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        exit;
    }

    if ($method === 'POST') {
        require_content_type('application/json');
        $body = json_decode(read_body(8 * 1024), true);
        if (!is_array($body)) fail(400, 'invalid_request');
        $res = memory_note_add($userId, (string)($body['category'] ?? 'general'), (string)($body['memory'] ?? ''));
        if (isset($res['error'])) fail(400, $res['error']);
        echo json_encode($res, JSON_UNESCAPED_UNICODE);
        exit;
    }

    if ($method === 'DELETE') {
        $body = json_decode(read_body(8 * 1024), true);
        if (!is_array($body)) fail(400, 'invalid_request');
        if (!empty($body['all'])) {
            $res = memory_with_user_lock($userId, function () use ($userId): array {
                memory_migrate_legacy($userId);
                $dir = memory_dir() . '/user-' . $userId;
                if (is_dir($dir)) {
                    foreach (new DirectoryIterator($dir) as $item) {
                        if ($item->isDot()) continue;
                        if ((!$item->isFile() && !$item->isLink()) || !@unlink($item->getPathname())) {
                            return ['error' => 'memory_delete_failed'];
                        }
                    }
                    if (!@rmdir($dir)) return ['error' => 'memory_delete_failed'];
                }
                $legacy = [
                    memory_file_path($userId),
                    memory_dir() . '/user-' . $userId . '.journal.md',
                ];
                foreach ($legacy as $path) {
                    if (is_file($path) && !@unlink($path)) return ['error' => 'memory_delete_failed'];
                    if (is_file($path . '.migrated') && !@unlink($path . '.migrated')) {
                        return ['error' => 'memory_delete_failed'];
                    }
                }
                return ['ok' => true];
            });
            if (isset($res['error'])) fail(500, $res['error']);
            echo json_encode(['ok' => true]);
            exit;
        }

        if (!isset($body['id']) || !preg_match('/^[a-z0-9]{5}$/', (string)$body['id'])) {
            fail(400, 'invalid_request');
        }
        $res = memory_note_delete($userId, (string)$body['id']);
        if (($res['error'] ?? '') === 'memory_not_found') fail(404, 'memory_not_found');
        if (isset($res['error'])) fail(500, $res['error']);
        echo json_encode(['ok' => true]);
        exit;
    }

    fail(405, 'method_not_allowed');
} catch (RuntimeException $e) {
    log_event(['msg' => 'memory_api_error', 'err' => $e->getMessage()]);
    fail(500, 'memory_unavailable');
}
