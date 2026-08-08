<?php
require_once __DIR__ . '/_lib.php';

header('Content-Type: application/json');
rate_limit('wardrobe', 60, 60);

$user = require_user();
$db = db();
$method = $_SERVER['REQUEST_METHOD'];

if ($method === 'GET') {
    $stmt = $db->prepare(
        'SELECT id, name, data, updated_at FROM wardrobe_presets
         WHERE user_id=? ORDER BY name COLLATE NOCASE'
    );
    $stmt->execute([$user['id']]);
    $out = [];
    foreach ($stmt->fetchAll() as $row) {
        $parsed = json_decode((string)$row['data'], true);
        $out[] = [
            'id' => (int)$row['id'],
            'name' => $row['name'],
            'updated_at' => (int)$row['updated_at'],
            'data' => is_array($parsed) ? $parsed : new stdClass(),
        ];
    }
    echo json_encode($out);
    exit;
}

if ($method === 'POST') {
    $req = json_decode(read_body(64 * 1024), true);
    if (!is_array($req)) fail(400, 'invalid_request');
    $name = trim((string)($req['name'] ?? ''));
    $data = $req['data'] ?? null;
    if ($name === '' || mb_strlen($name) > 60 || !is_array($data)) fail(400, 'invalid_request');

    $count = $db->prepare('SELECT COUNT(*) FROM wardrobe_presets WHERE user_id=? AND name<>?');
    $count->execute([$user['id'], $name]);
    if ((int)$count->fetchColumn() >= 50) fail(400, 'too_many_presets');

    $db->prepare(
        'INSERT INTO wardrobe_presets (user_id, name, data, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id, name) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at'
    )->execute([$user['id'], $name, json_encode($data, JSON_UNESCAPED_UNICODE), time()]);

    $id = $db->prepare('SELECT id FROM wardrobe_presets WHERE user_id=? AND name=?');
    $id->execute([$user['id'], $name]);
    echo json_encode(['id' => (int)$id->fetchColumn(), 'name' => $name]);
    exit;
}

if ($method === 'DELETE') {
    $id = (int)($_GET['id'] ?? 0);
    if (!$id) fail(400, 'invalid_request');
    $db->prepare('DELETE FROM wardrobe_presets WHERE id=? AND user_id=?')->execute([$id, $user['id']]);
    echo json_encode(['ok' => true]);
    exit;
}

fail(405, 'method_not_allowed');
