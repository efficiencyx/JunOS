<?php
require_once __DIR__ . '/_lib.php';

header('Content-Type: application/json');
rate_limit('conversations', 60, 60);

$user = require_user();
$action = $_GET['action'] ?? '';

function summarize_conversation_chunk(string $oldSummary, array $chunk): ?string {
    $lines = [];
    foreach ($chunk as $m) {
        $text = preg_replace('/\[\s*A(?:CTIONS?)?\s*:[^\]]*\]/i', '', (string)$m['content']);
        $text = trim(preg_replace('/\s+/', ' ', $text));
        if ($text === '') continue;
        $lines[] = ($m['role'] === 'assistant' ? 'Jun' : 'Anon') . ': ' . $text;
    }
    if (!$lines) return null;

    $sys = 'You maintain a running memory of an ongoing roleplay between Anon (the user) and Jun (his girlfriend, a character on the run). '
         . 'Rewrite the memory so it also covers the new lines below. Write a tight third-person summary that preserves concrete facts, decisions, '
         . 'promises, emotional beats, and anything Jun should remember later. Drop small talk. Keep it under 300 words. Output ONLY the updated summary, no preamble.';
    $usr = ($oldSummary !== '' ? "Current memory:\n" . $oldSummary . "\n\n" : '')
         . "New lines to fold in:\n" . implode("\n", $lines);

    return provider_complete_once(ai_provider(), default_chat_model(),
        [['role' => 'system', 'content' => $sys], ['role' => 'user', 'content' => $usr]], 512);
}
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

    case 'delete_last_assistant':
        if ($method !== 'POST') fail(405, 'method_not_allowed');
        $id = (int)($_GET['id'] ?? 0);
        if (!$id) fail(400, 'invalid_request');
        $own = $db->prepare('SELECT 1 FROM conversations WHERE id=? AND user_id=?');
        $own->execute([$id, $user['id']]);
        if (!$own->fetchColumn()) fail(404, 'not_found');
        $db->prepare(
            "DELETE FROM messages WHERE id = (
               SELECT id FROM messages WHERE conversation_id=? AND role='assistant'
               ORDER BY id DESC LIMIT 1)"
        )->execute([$id]);
        echo json_encode(['ok' => true]);
        break;

    case 'compact':
        if ($method !== 'POST') fail(405, 'method_not_allowed');
        $id = (int)($_GET['id'] ?? 0);
        if (!$id) fail(400, 'invalid_request');
        $row = $db->prepare('SELECT summary, summary_upto_id FROM conversations WHERE id=? AND user_id=?');
        $row->execute([$id, $user['id']]);
        $conv = $row->fetch();
        if (!$conv) fail(404, 'not_found');

        $uptoId = (int)$conv['summary_upto_id'];
        $oldSummary = trim((string)($conv['summary'] ?? ''));

        $tailStmt = $db->prepare('SELECT id, role, content FROM messages WHERE conversation_id=? AND id>? ORDER BY id');
        $tailStmt->execute([$id, $uptoId]);
        $tail = $tailStmt->fetchAll();

        $ctxTokens = default_num_ctx();
        $budgetChars = (int)($ctxTokens * 4 * 0.5);
        $targetChars = (int)($ctxTokens * 4 * 0.35);
        $keepTail = 6;

        $tailChars = 0;
        foreach ($tail as $m) $tailChars += strlen((string)$m['content']);
        if ($tailChars <= $budgetChars || count($tail) <= $keepTail) {
            echo json_encode(['compacted' => false]);
            break;
        }

        $chunk = [];
        $remaining = $tailChars;
        $lastFoldedId = $uptoId;
        $maxFold = count($tail) - $keepTail;
        for ($i = 0; $i < $maxFold && $remaining > $targetChars; $i++) {
            $chunk[] = $tail[$i];
            $remaining -= strlen((string)$tail[$i]['content']);
            $lastFoldedId = (int)$tail[$i]['id'];
        }
        if (!$chunk) { echo json_encode(['compacted' => false]); break; }

        $newSummary = summarize_conversation_chunk($oldSummary, $chunk);
        if ($newSummary === null) { echo json_encode(['compacted' => false, 'error' => 'summarize_failed']); break; }

        $db->prepare('UPDATE conversations SET summary=?, summary_upto_id=? WHERE id=? AND user_id=?')
           ->execute([$newSummary, $lastFoldedId, $id, $user['id']]);
        echo json_encode(['compacted' => true, 'upto_id' => $lastFoldedId]);
        break;

    default:
        fail(400, 'invalid_action');
}
