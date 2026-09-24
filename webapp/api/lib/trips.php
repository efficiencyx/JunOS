<?php

// going out is her call. the shop, karaoke and date pages bounce
// to index.html unless a trips row says she agreed (the tool in
// chat.php writes it, index.html clears it when you're home).
// FREE_ROAM=on turns the gate off and gives everyone the Force
// buttons, off means only an admin gets them.
function free_roam_enabled(): bool {
    return strtolower(env_str('FREE_ROAM', 'off')) === 'on';
}

function trip_get(int $userId): ?array {
    $st = db()->prepare('SELECT destination, since, conversation_id FROM trips WHERE user_id=?');
    $st->execute([$userId]);
    $row = $st->fetch();
    $st->closeCursor();
    if (!$row) return null;
    return ['where' => (string)$row['destination'], 'since' => (int)$row['since'], 'conversation_id' => (int)$row['conversation_id']];
}

function trip_set(int $userId, string $where, int $convId): void {
    db()->prepare('INSERT OR REPLACE INTO trips (user_id, destination, since, conversation_id) VALUES (?, ?, ?, ?)')
        ->execute([$userId, $where, time(), $convId]);
}

function trip_clear(int $userId): void {
    db()->prepare('DELETE FROM trips WHERE user_id=?')->execute([$userId]);
}
