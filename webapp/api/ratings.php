<?php
require_once __DIR__ . '/lib/bootstrap.php';

header('Cache-Control: no-store');

$action = $_GET['action'] ?? '';
// get is for every account so the client can ask before it knows the role, non-admins have no rows
$user = $action === 'get' ? require_user() : require_admin();
rate_limit('ratings', 120, 60);
$userId = (int)$user['id'];
$db = db();

const RATING_CONTEXT_TURNS = 40;

if ($action === 'rate') {
    require_method('POST');
    $body = read_json_body(4096);
    $convId = (int)($body['conversation_id'] ?? 0);
    $rating = $body['rating'] ?? null;
    if (!$convId || !in_array($rating, [-1, 0, 1], true)) fail(400, 'invalid_request');
    if (!conversation_owned($convId, $userId)) fail(404, 'not_found');

    $st = $db->prepare("SELECT id, content FROM messages WHERE conversation_id=? AND role='assistant' ORDER BY id DESC LIMIT 1");
    $st->execute([$convId]);
    $reply = $st->fetch();
    if (!$reply) fail(404, 'not_found');
    $msgId = (int)$reply['id'];

    if ($rating === 0) {
        $db->prepare('DELETE FROM reply_ratings WHERE user_id=? AND message_id=?')->execute([$userId, $msgId]);
        json_out(['ok' => true]);
    }

    $st = $db->prepare('SELECT role, content FROM messages WHERE conversation_id=? AND id<? ORDER BY id DESC LIMIT ' . RATING_CONTEXT_TURNS);
    $st->execute([$convId, $msgId]);
    $context = array_reverse(array_map(
        fn($m) => ['role' => $m['role'], 'content' => dec($m['content'])],
        $st->fetchAll()
    ));
    $model = substr(trim((string)($body['model'] ?? '')), 0, 200);

    $db->prepare('DELETE FROM reply_ratings WHERE user_id=? AND message_id=?')->execute([$userId, $msgId]);
    $db->prepare('INSERT INTO reply_ratings (user_id, conversation_id, message_id, rating, model, context, reply, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
       ->execute([$userId, $convId, $msgId, $rating, $model !== '' ? $model : null,
                  enc(json_encode($context, JSON_UNESCAPED_UNICODE)), enc(dec($reply['content'])), time()]);
    json_out(['ok' => true]);
}

if ($action === 'get') {
    require_method('GET');
    $convId = (int)($_GET['conversation_id'] ?? 0);
    if (!$convId || !conversation_owned($convId, $userId)) fail(404, 'not_found');
    $st = $db->prepare("SELECT r.rating FROM reply_ratings r
        JOIN messages m ON m.id = r.message_id
        WHERE r.user_id=? AND m.id = (SELECT MAX(id) FROM messages WHERE conversation_id=? AND role='assistant')");
    $st->execute([$userId, $convId]);
    json_out(['rating' => (int)($st->fetchColumn() ?: 0)]);
}

if ($action === 'export') {
    require_method('GET');
    $st = $db->prepare('SELECT conversation_id, rating, model, context, reply, at FROM reply_ratings WHERE user_id=? ORDER BY id');
    $st->execute([$userId]);
    header('Content-Type: application/x-ndjson; charset=utf-8');
    header('Content-Disposition: attachment; filename="jun-ratings-' . date('Y-m-d') . '.jsonl"');
    foreach ($st as $row) {
        echo json_encode([
            'conversation_id' => (int)$row['conversation_id'],
            'rating' => (int)$row['rating'],
            'model' => $row['model'],
            'at' => (int)$row['at'],
            'messages' => json_decode(dec($row['context']), true) ?: [],
            'reply' => dec($row['reply']),
        ], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES), "\n";
    }
    exit;
}

fail(400, 'invalid_request');
