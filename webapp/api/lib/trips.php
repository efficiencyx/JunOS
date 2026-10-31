<?php

// going out is her call. the shop, karaoke and date pages bounce
// to index.html unless a trips row says she agreed (the tool in
// chat.php writes it, index.html clears it when you're home).
// FREE_ROAM=on turns the gate off and gives everyone the Force
// buttons, off means only an admin gets them.
function free_roam_enabled(): bool {
    return strtolower(env_str('FREE_ROAM', 'off')) === 'on';
}

// auto: 2 s on a card we know about (or a remote one), 5 on CPU.
// every frame is ~130 tokens she has to read
function watch_frame_every(): int {
    $v = strtolower(env_str('WATCH_FRAME_EVERY', 'auto'));
    if (ctype_digit($v)) return max(1, min(5, (int)$v));
    return (int)env_str('OMEGA_GPU_VRAM_MB', '0') > 0 || model_server_is_remote() ? 2 : 5;
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
