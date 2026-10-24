<?php
require_once __DIR__ . '/lib/bootstrap.php';

$user = require_user();
rate_limit('conversations', 60, 60);
$userId = (int)$user['id'];
$action = $_GET['action'] ?? '';

function summarize_conversation_chunk(string $oldSummary, array $chunk): ?string {
    $lines = [];
    foreach ($chunk as $m) {
        $text = spoken_text((string)$m['content']);
        if ($text === '') continue;
        $lines[] = speaker_name($m['role']) . ': ' . $text;
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

// every action but list/search/create is about one conversation, ?id=
function conversation_id(): int {
    $id = (int)($_GET['id'] ?? 0);
    if (!$id) fail(400, 'invalid_request');
    return $id;
}

function require_owned(int $id, int $userId): void {
    if (!conversation_owned($id, $userId)) fail(404, 'not_found');
}

$db = db();

switch ($action) {

    case 'list':
        require_method('GET');
        $before = (int)($_GET['before'] ?? 0);
        $sql = 'SELECT id, title, created_at, updated_at FROM conversations WHERE user_id=?';
        $args = [$userId];
        if ($before > 0) {
            $sql .= ' AND (updated_at < ? OR (updated_at = ? AND id < ?))';
            array_push($args, $before, $before, (int)($_GET['before_id'] ?? 0));
        }
        $stmt = $db->prepare($sql . ' ORDER BY updated_at DESC, id DESC LIMIT 100');
        $stmt->execute($args);
        $rows = $stmt->fetchAll();
        foreach ($rows as &$row) $row['title'] = dec($row['title']);
        unset($row);
        json_out($rows);

    case 'search':
        require_method('GET');
        $query = trim(preg_replace('/\s+/u', ' ', mb_substr((string)($_GET['q'] ?? ''), 0, 120)));
        if (mb_strlen($query) < 2) json_out([]);
        preg_match_all('/[\p{L}\p{N}]{2,}/u', $query, $m);
        $terms = array_values(array_unique(array_map('mb_strtolower', $m[0])));
        $convs = $db->prepare('SELECT id, title, updated_at FROM conversations WHERE user_id=?');
        $convs->execute([$userId]);
        $hits = [];
        $titles = [];
        foreach ($convs->fetchAll() as $c) {
            $title = (string)dec($c['title'] ?? null);
            $titles[(int)$c['id']] = [$title, (int)$c['updated_at']];
            if ($title !== '' && recall_match($title, $query, $terms) !== null) $hits[(int)$c['id']] = '';
        }
        // ciphertext, so no LIKE. same walk as search_recent_chats
        $st = $db->prepare(
            "SELECT m.conversation_id, m.content FROM messages m JOIN conversations c ON c.id = m.conversation_id
              WHERE c.user_id = ? AND m.role IN ('user', 'assistant') ORDER BY m.id DESC"
        );
        $st->execute([$userId]);
        $found = 0;
        while ($found < 50 && ($r = $st->fetch())) {
            $cid = (int)$r['conversation_id'];
            if (($hits[$cid] ?? '') !== '') continue;
            $text = spoken_text((string)dec($r['content']));
            if ($text === '' || $text === '<audio>') continue;
            $at = recall_match($text, $query, $terms);
            if ($at === null) continue;
            $hits[$cid] = recall_excerpt($text, $at, 140);
            $found++;
        }
        $st->closeCursor();
        $out = [];
        foreach ($hits as $cid => $snippet) {
            [$title, $updated] = $titles[$cid];
            $out[] = ['id' => $cid, 'title' => $title !== '' ? $title : null, 'updated_at' => $updated, 'snippet' => $snippet];
        }
        usort($out, fn($a, $b) => $b['updated_at'] <=> $a['updated_at']);
        json_out(array_slice($out, 0, 50));

    case 'create':
        require_method('POST');
        $now = time();
        $db->prepare(
            'INSERT INTO conversations (user_id, title, created_at, updated_at) VALUES (?, NULL, ?, ?)'
        )->execute([$userId, $now, $now]);
        $id = (int)$db->lastInsertId();
        ach_add($userId, 'chats');
        json_out(['id' => $id]);

    case 'messages':
        require_method('GET');
        $id = conversation_id();
        require_owned($id, $userId);
        $stmt = $db->prepare(
            'SELECT id, role, content, created_at FROM messages WHERE conversation_id=? ORDER BY id'
        );
        $stmt->execute([$id]);
        $rows = $stmt->fetchAll();
        foreach ($rows as &$row) $row['content'] = dec($row['content']);
        unset($row);
        json_out($rows);

    case 'rename':
        require_method('POST');
        $id = conversation_id();
        $body = read_json_body(4 * 1024);
        $title = mb_substr(trim((string)($body['title'] ?? '')), 0, 120);
        if ($title === '') fail(400, 'invalid_request');
        $stmt = $db->prepare('UPDATE conversations SET title=? WHERE id=? AND user_id=?');
        $stmt->execute([enc($title), $id, $userId]);
        if (!$stmt->rowCount()) fail(404, 'not_found');
        json_out(['ok' => true]);

    case 'delete':
        require_method('DELETE');
        $id = conversation_id();
        $stmt = $db->prepare('DELETE FROM conversations WHERE id=? AND user_id=?');
        $stmt->execute([$id, $userId]);
        if (!$stmt->rowCount()) fail(404, 'not_found');
        json_out(['ok' => true]);

    case 'set_audio_text':
        require_method('POST');
        $id = conversation_id();
        $body = read_json_body(16 * 1024);
        $text = trim((string)($body['text'] ?? ''));
        if ($text === '') fail(400, 'invalid_request');
        require_owned($id, $userId);
        // ponytail: newest <audio> row. wrong row only if whisper takes
        // longer than a whole voice turn (speak again + 700ms silence),
        // upgrade is chat.php sending the inserted id and matching on it
        $stmt = $db->prepare(
            "UPDATE messages SET content=? WHERE id = (
               SELECT id FROM messages WHERE conversation_id=? AND role='user' AND content='<audio>'
               ORDER BY id DESC LIMIT 1)"
        );
        $stmt->execute([enc($text), $id]);
        if (!$stmt->rowCount()) fail(404, 'not_found');
        json_out(['ok' => true]);

    case 'delete_last_assistant':
        require_method('POST');
        $id = conversation_id();
        require_owned($id, $userId);
        $db->prepare(
            "DELETE FROM messages WHERE id = (
               SELECT id FROM messages WHERE conversation_id=? AND role='assistant'
               ORDER BY id DESC LIMIT 1)"
        )->execute([$id]);
        json_out(['ok' => true]);

    case 'compact':
        require_method('POST');
        $id = conversation_id();
        $row = $db->prepare('SELECT summary, summary_upto_id FROM conversations WHERE id=? AND user_id=?');
        $row->execute([$id, $userId]);
        $conv = $row->fetch();
        if (!$conv) fail(404, 'not_found');

        $uptoId = (int)$conv['summary_upto_id'];
        $oldSummary = trim((string)dec($conv['summary'] ?? null));

        $tailStmt = $db->prepare('SELECT id, role, content FROM messages WHERE conversation_id=? AND id>? ORDER BY id');
        $tailStmt->execute([$id, $uptoId]);
        $tail = $tailStmt->fetchAll();
        foreach ($tail as &$m) $m['content'] = dec($m['content']);
        unset($m);

        $ctxTokens = default_num_ctx();
        $budgetChars = (int)($ctxTokens * 4 * 0.5);
        $targetChars = (int)($ctxTokens * 4 * 0.35);
        $keepTail = 6;

        $tailChars = 0;
        foreach ($tail as $m) $tailChars += strlen((string)$m['content']);
        if ($tailChars <= $budgetChars || count($tail) <= $keepTail) json_out(['compacted' => false]);

        $chunk = [];
        $remaining = $tailChars;
        $lastFoldedId = $uptoId;
        $maxFold = count($tail) - $keepTail;
        for ($i = 0; $i < $maxFold && $remaining > $targetChars; $i++) {
            $chunk[] = $tail[$i];
            $remaining -= strlen((string)$tail[$i]['content']);
            $lastFoldedId = (int)$tail[$i]['id'];
        }
        if (!$chunk) json_out(['compacted' => false]);

        $newSummary = summarize_conversation_chunk($oldSummary, $chunk);
        if ($newSummary === null) json_out(['compacted' => false, 'error' => 'summarize_failed']);

        $db->prepare('UPDATE conversations SET summary=?, summary_upto_id=? WHERE id=? AND user_id=?')
           ->execute([enc($newSummary), $lastFoldedId, $id, $userId]);
        json_out(['compacted' => true, 'upto_id' => $lastFoldedId]);

    default:
        fail(400, 'invalid_action');
}
