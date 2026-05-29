<?php
require_once __DIR__ . '/_lib.php';

header('Content-Type: application/json');
rate_limit('conversations', 60, 60);

$user = require_user();
$action = $_GET['action'] ?? '';
$method = $_SERVER['REQUEST_METHOD'];
$db = db();

switch ($action) {

    case 'list':
        if ($method !== 'GET') fail(405, 'method_not_allowed');
        $stmt = $db->prepare(
            'SELECT id, title, created_at, updated_at FROM conversations
             WHERE user_id=? ORDER BY updated_at DESC LIMIT 100'
        );
        $stmt->execute([$user['id']]);
        echo json_encode($stmt->fetchAll());
        break;

    case 'create':
        if ($method !== 'POST') fail(405, 'method_not_allowed');
        $now = time();
        $db->prepare(
            'INSERT INTO conversations (user_id, title, created_at, updated_at) VALUES (?, NULL, ?, ?)'
        )->execute([$user['id'], $now, $now]);
        echo json_encode(['id' => (int)$db->lastInsertId()]);
        break;

    case 'messages':
        if ($method !== 'GET') fail(405, 'method_not_allowed');
        $id = (int)($_GET['id'] ?? 0);
        if (!$id) fail(400, 'invalid_request');
        $own = $db->prepare('SELECT 1 FROM conversations WHERE id=? AND user_id=?');
        $own->execute([$id, $user['id']]);
        if (!$own->fetchColumn()) fail(404, 'not_found');
        $stmt = $db->prepare(
            'SELECT role, content, created_at FROM messages WHERE conversation_id=? ORDER BY id'
        );
        $stmt->execute([$id]);
        echo json_encode($stmt->fetchAll());
        break;

    case 'rename':
        if ($method !== 'POST') fail(405, 'method_not_allowed');
        $id = (int)($_GET['id'] ?? 0);
        if (!$id) fail(400, 'invalid_request');
        $body = json_decode(read_body(4 * 1024), true);
        $title = substr(trim((string)($body['title'] ?? '')), 0, 120);
        if ($title === '') fail(400, 'invalid_request');
        $stmt = $db->prepare('UPDATE conversations SET title=? WHERE id=? AND user_id=?');
        $stmt->execute([$title, $id, $user['id']]);
        if (!$stmt->rowCount()) fail(404, 'not_found');
        echo json_encode(['ok' => true]);
        break;

    case 'delete':
        if ($method !== 'DELETE') fail(405, 'method_not_allowed');
        $id = (int)($_GET['id'] ?? 0);
        if (!$id) fail(400, 'invalid_request');
        $stmt = $db->prepare('DELETE FROM conversations WHERE id=? AND user_id=?');
        $stmt->execute([$id, $user['id']]);
        if (!$stmt->rowCount()) fail(404, 'not_found');
        echo json_encode(['ok' => true]);
        break;

    default:
        fail(400, 'invalid_action');
}
