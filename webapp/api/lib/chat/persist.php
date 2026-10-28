<?php

function chat_save_user_message(int $convId, array $req, string $lastUserMsg): int {
    if ($req['idle'] || $req['ephemeral']) return 0;
    if ($req['regenerate']) {
        $last = chat_last_user_row($convId);
        if ($last) return $last;
    }
    // <audio> stays plaintext on purpose. conversations.php
    // set_audio_text finds the row by that literal and swaps the
    // transcript in, sealed. it can't match a ciphertext.
    $db = db();
    $db->prepare('INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)')
       ->execute([$convId, 'user', $req['audio'] !== '' ? '<audio>' : enc($lastUserMsg), time()]);
    return (int)$db->lastInsertId();
}

// regenerate asks again for a turn that's already stored, so no
// second copy of his message. only when his row is the newest one
function chat_last_user_row(int $convId): int {
    $st = db()->prepare('SELECT id, role FROM messages WHERE conversation_id=? ORDER BY id DESC LIMIT 1');
    $st->execute([$convId]);
    $row = $st->fetch();
    return $row && $row['role'] === 'user' ? (int)$row['id'] : 0;
}

function chat_save_reply(int $convId, string $reply, array $req, string $lastUserMsg): void {
    $now = time();
    db()->prepare('INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)')
        ->execute([$convId, 'assistant', enc($reply), $now]);
    db()->prepare('UPDATE conversations SET updated_at=? WHERE id=?')->execute([$now, $convId]);

    if (!$req['idle']) {
        $titleRow = db()->prepare('SELECT title FROM conversations WHERE id=?');
        $titleRow->execute([$convId]);
        $conversationTitle = dec($titleRow->fetchColumn() ?: null);
        $titleRow->closeCursor();
        // a spoken turn leaves $lastUserMsg empty, so there's nothing
        // to name the chat after. next typed turn handles it.
        if (!$conversationTitle && $lastUserMsg !== '') {
            $newTitle = generate_chat_title($lastUserMsg) ?: mb_substr($lastUserMsg, 0, 60);
            db()->prepare('UPDATE conversations SET title=? WHERE id=?')
                ->execute([enc($newTitle), $convId]);
        }
    }
}
