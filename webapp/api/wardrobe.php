<?php
require_once __DIR__ . '/lib/bootstrap.php';
require_once __DIR__ . '/lib/wardrobe.php';

$user = require_user();
rate_limit('wardrobe', 60, 60);
$db = db();
$method = require_method('GET', 'POST', 'DELETE');

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
    json_out($out);
}

if ($method === 'POST') {
    $req = read_json_body(64 * 1024);
    $name = trim((string)($req['name'] ?? ''));
    $data = $req['data'] ?? null;
    if ($name === '' || mb_strlen($name) > 60 || !is_array($data)) fail(400, 'invalid_request');
    $data = wardrobe_canonical_preset($data);

    $count = $db->prepare('SELECT COUNT(*) FROM wardrobe_presets WHERE user_id=? AND name<>?');
    $count->execute([$user['id'], $name]);
    if ((int)$count->fetchColumn() >= 50) fail(400, 'too_many_presets');

    $db->prepare(
        'INSERT INTO wardrobe_presets (user_id, name, data, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id, name) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at'
    )->execute([$user['id'], $name, json_encode($data, JSON_UNESCAPED_SLASHES), time()]);

    $id = $db->prepare('SELECT id FROM wardrobe_presets WHERE user_id=? AND name=?');
    $id->execute([$user['id'], $name]);
    json_out(['id' => (int)$id->fetchColumn(), 'name' => $name]);
}

$id = (int)($_GET['id'] ?? 0);
if (!$id) fail(400, 'invalid_request');
$db->prepare('DELETE FROM wardrobe_presets WHERE id=? AND user_id=?')->execute([$id, $user['id']]);
json_out(['ok' => true]);
