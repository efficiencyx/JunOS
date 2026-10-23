<?php

// messages.id is INTEGER PRIMARY KEY with NO AUTOINCREMENT, so
// SQLite hands out max(rowid)+1 and happily reuses ids a delete
// freed. drop the newest conversation and upto_id is suddenly
// above every row that's left, so `m.id > upto_id` starves
// consolidation for Ever. everything that survived sits under the
// old watermark, so it goes back to the highest surviving id.
function consolidation_repair_watermarks(PDO $db): void {
    $db->exec(
        'UPDATE memory_consolidation SET upto_id = (SELECT COALESCE(MAX(m.id), 0) FROM messages m
                                                    JOIN conversations c ON c.id = m.conversation_id
                                                    WHERE c.user_id = memory_consolidation.user_id)
         WHERE upto_id > (SELECT COALESCE(MAX(m.id), 0) FROM messages m
                          JOIN conversations c ON c.id = m.conversation_id
                          WHERE c.user_id = memory_consolidation.user_id)'
    );
}

// ONLY ever called for a run that actually reached the model. a
// poll we skipped must not stomp the outcome the client is still
// showing, and must not move last_run.
function consolidation_record_result(int $userId, string $status, int $noteCount = 0): void {
    db()->prepare(
        'INSERT INTO memory_consolidation (user_id, last_run, last_status, last_note_count) VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET last_run = excluded.last_run,
             last_status = excluded.last_status, last_note_count = excluded.last_note_count'
    )->execute([$userId, time(), $status, $noteCount]);
}

function consolidation_pending_count(PDO $db, int $userId): int {
    $stmt = $db->prepare(
        'SELECT COUNT(*) FROM messages m
         JOIN conversations c ON c.id = m.conversation_id
         LEFT JOIN memory_consolidation mc ON mc.user_id = c.user_id
         LEFT JOIN consolidation_chats cc ON cc.user_id = c.user_id AND cc.conversation_id = c.id
         WHERE c.user_id = ? AND m.id > MAX(COALESCE(mc.upto_id, 0), COALESCE(cc.upto_id, 0))'
    );
    $stmt->execute([$userId]);
    $count = (int)$stmt->fetchColumn();
    $stmt->closeCursor();
    return $count;
}
