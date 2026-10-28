<?php
require_once __DIR__ . '/lib/bootstrap.php';
require_once __DIR__ . '/lib/memory_request.php';

$user = require_user();
rate_limit('memory', 60, 60);
$userId = (int)$user['id'];
$method = require_method('GET', 'POST', 'PUT', 'DELETE');

try {
    if ($method === 'GET') {
        $categories = [];
        $notes = [];
        $titles = [];
        $st = db()->prepare('SELECT id, title FROM conversations WHERE user_id=?');
        $st->execute([$userId]);
        foreach ($st->fetchAll() as $row) $titles[(int)$row['id']] = (string)dec($row['title'] ?? null);
        $withTitle = function (?array $ref) use ($titles): ?array {
            if (!$ref || !isset($ref['conv'])) return $ref;
            $ref['chat'] = isset($titles[$ref['conv']]) ? ['title' => $titles[$ref['conv']] ?: null] : null;
            return $ref;
        };
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
                    'source' => $withTitle($note['source']),
                    'revisions' => array_map($withTitle, $note['revisions']),
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

    if ($method === 'POST' && ($_GET['action'] ?? '') === 'request') {
        rate_limit('memory_request', 10, 3600);
        json_out(memory_request_handle($userId, read_json_body(4 * 1024)));
    }

    if ($method === 'POST') {
        $body = read_json_body(8 * 1024);
        $kind = ($body['source'] ?? '') === 'karaoke' ? 'karaoke' : 'manual';
        $res = memory_note_add($userId, (string)($body['category'] ?? 'general'), (string)($body['memory'] ?? ''), ['kind' => $kind]);
        if (isset($res['error'])) fail(400, $res['error']);
        json_out($res);
    }

    require_admin();
    $body = read_json_body(8 * 1024);
    if (isset($body['journal'])) {
        $date = (string)$body['journal'];
        if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $date)) fail(400, 'invalid_request');
        $res = $method === 'PUT'
            ? memory_journal_upsert($userId, $date, (string)($body['memory'] ?? ''))
            : memory_journal_delete($userId, $date);
        $err = $res['error'] ?? '';
        if ($err === 'journal_not_found') fail(404, $err);
        if ($err !== '') fail(str_starts_with($err, 'journal_') ? 400 : 500, $err);
        json_out(['ok' => true]);
    }
    if ($method === 'PUT') {
        if (!preg_match('/^[a-z0-9]{5}$/', (string)($body['id'] ?? ''))) fail(400, 'invalid_request');
        $res = memory_note_edit($userId, (string)$body['id'], (string)($body['memory'] ?? ''), ['kind' => 'manual']);
        if (($res['error'] ?? '') === 'memory_not_found') fail(404, 'memory_not_found');
        if (isset($res['error'])) fail(400, $res['error']);
        json_out(['ok' => true]);
    }
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
