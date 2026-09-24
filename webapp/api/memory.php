<?php
require_once __DIR__ . '/lib/bootstrap.php';

$user = require_user();
rate_limit('memory', 60, 60);
$userId = (int)$user['id'];
$method = require_method('GET', 'POST', 'DELETE');

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
        json_out([
            'categories' => $categories,
            'notes' => $notes,
            'journal' => ['entries' => journal_parse(memory_journal_read($userId))],
        ]);
    }

    if ($method === 'POST') {
        $body = read_json_body(8 * 1024);
        $res = memory_note_add($userId, (string)($body['category'] ?? 'general'), (string)($body['memory'] ?? ''));
        if (isset($res['error'])) fail(400, $res['error']);
        json_out($res);
    }

    require_admin();
    $body = read_json_body(8 * 1024);
    if (!empty($body['all'])) {
        $res = memory_wipe_user($userId);
        if (isset($res['error'])) fail(500, $res['error']);
        json_out(['ok' => true]);
    }

    if (!isset($body['id']) || !preg_match('/^[a-z0-9]{5}$/', (string)$body['id'])) {
        fail(400, 'invalid_request');
    }
    $res = memory_note_delete($userId, (string)$body['id']);
    if (($res['error'] ?? '') === 'memory_not_found') fail(404, 'memory_not_found');
    if (isset($res['error'])) fail(500, $res['error']);
    json_out(['ok' => true]);
} catch (RuntimeException $e) {
    log_event(['msg' => 'memory_api_error', 'err' => $e->getMessage()]);
    fail(500, 'memory_unavailable');
}
