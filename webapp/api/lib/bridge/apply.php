<?php

require_once __DIR__ . '/../wardrobe.php';
require_once __DIR__ . '/parse.php';
require_once __DIR__ . '/events.php';

function bridge_enabled(): bool {
    return strtolower(env_str('GAME_BRIDGE', 'off')) === 'on';
}

function bridge_token_user(string $token): ?int {
    if (strlen($token) < 32) return null;
    $st = db()->prepare('SELECT user_id FROM bridge_tokens WHERE token_hash = ?');
    $st->execute([hash('sha256', $token)]);
    $id = $st->fetchColumn();
    return $id === false ? null : (int)$id;
}

function bridge_token_issue(int $userId): string {
    $token = bin2hex(random_bytes(32));
    db()->prepare('INSERT INTO bridge_tokens (user_id, token_hash, created_at) VALUES (?, ?, ?)
                   ON CONFLICT(user_id) DO UPDATE SET token_hash=excluded.token_hash, created_at=excluded.created_at')
        ->execute([$userId, hash('sha256', $token), time()]);
    return $token;
}

function bridge_token_revoke(int $userId): void {
    db()->prepare('DELETE FROM bridge_tokens WHERE user_id = ?')->execute([$userId]);
}

// the boot sync has no session, so it works for whoever paired last
function bridge_boot_user(): ?int {
    $id = db()->query('SELECT user_id FROM bridge_tokens ORDER BY created_at DESC LIMIT 1')->fetchColumn();
    return $id === false ? null : (int)$id;
}

// needs the data key, so only from a signed-in request
function bridge_keys_ensure(int $userId): void {
    if (crypt_key() === null) return;
    $st = db()->prepare('SELECT bridge_pub FROM users WHERE id = ?');
    $st->execute([$userId]);
    if ($st->fetchColumn()) return;
    $pair = sodium_crypto_box_keypair();
    db()->prepare('UPDATE users SET bridge_pub = ?, bridge_sec = ? WHERE id = ?')->execute([
        base64_encode(sodium_crypto_box_publickey($pair)),
        crypt_seal(sodium_crypto_box_secretkey($pair), crypt_key()),
        $userId,
    ]);
}

// false = no public key yet, the caller leaves the events unseen for the
// next sync. NEVER falls back to plaintext
function bridge_queue(int $userId, array $events): bool {
    if (!$events) return true;
    $st = db()->prepare('SELECT bridge_pub FROM users WHERE id = ?');
    $st->execute([$userId]);
    $pub = base64_decode((string)$st->fetchColumn(), true);
    if (!$pub || strlen($pub) !== SODIUM_CRYPTO_BOX_PUBLICKEYBYTES) return false;
    $sealed = base64_encode(sodium_crypto_box_seal(json_encode($events, JSON_UNESCAPED_UNICODE), $pub));
    db()->prepare('INSERT INTO bridge_inbox (user_id, sealed, at) VALUES (?, ?, ?)')->execute([$userId, $sealed, time()]);
    return true;
}

function bridge_inbox_drain(int $userId): int {
    if (crypt_key() === null) return 0;
    bridge_keys_ensure($userId);
    $st = db()->prepare('SELECT id, sealed FROM bridge_inbox WHERE user_id = ? ORDER BY id');
    $st->execute([$userId]);
    $rows = $st->fetchAll();
    if (!$rows) return 0;
    $u = db()->prepare('SELECT bridge_pub, bridge_sec FROM users WHERE id = ?');
    $u->execute([$userId]);
    $keys = $u->fetch();
    $sec = crypt_open((string)$keys['bridge_sec'], crypt_key());
    if ($sec === null) return 0;
    $pair = sodium_crypto_box_keypair_from_secretkey_and_publickey($sec, base64_decode((string)$keys['bridge_pub']));
    $done = 0;
    foreach ($rows as $row) {
        $plain = sodium_crypto_box_seal_open(base64_decode((string)$row['sealed']), $pair);
        $events = $plain === false ? [] : (json_decode($plain, true) ?: []);
        $lines = [];
        foreach ($events as $e) {
            if (!empty($e['note'])) memory_note_add($userId, 'events', (string)$e['text'], ['kind' => 'game']);
            $lines[] = (string)$e['text'];
        }
        // journal entries cap at JOURNAL_ENTRY_MAX, a first sync can be way longer
        $chunk = '';
        foreach ($lines as $line) {
            if ($chunk !== '' && mb_strlen($chunk . ' ' . $line) > JOURNAL_ENTRY_MAX) {
                memory_journal_append($userId, $chunk);
                $chunk = '';
            }
            $chunk = trim($chunk . ' ' . $line);
        }
        if ($chunk !== '') memory_journal_append($userId, $chunk);
        db()->prepare('DELETE FROM bridge_inbox WHERE id = ?')->execute([(int)$row['id']]);
        $done++;
    }
    sodium_memzero($sec);
    return $done;
}

function bridge_sync_row(int $userId): ?array {
    $st = db()->prepare('SELECT * FROM bridge_sync WHERE user_id = ?');
    $st->execute([$userId]);
    $row = $st->fetch();
    if (!$row) return null;
    $row['counters'] = json_decode((string)$row['counters'], true) ?: [];
    $row['outfit'] = json_decode((string)$row['outfit'], true) ?: [];
    return $row;
}

function bridge_wardrobe_at(int $userId): int {
    $st = db()->prepare('SELECT updated_at FROM wardrobe_state WHERE user_id = ?');
    $st->execute([$userId]);
    return (int)$st->fetchColumn();
}

// only the keys the game has a slot for move, whatever clashes comes off
function bridge_outfit_apply(int $userId, array $outfit): void {
    $state = wardrobe_state($userId) ?? wardrobe_default_state();
    foreach ($outfit as $key => $on) $state['items'][$key] = (bool)$on;
    foreach (WARDROBE_CONFLICTS as [$left, $right]) {
        if (!$state['items'][$left] || !$state['items'][$right]) continue;
        $state['items'][isset($outfit[$left]) ? $right : $left] = false;
    }
    $state['assets'] = array_values(array_filter($state['assets'] ?? [], fn($a) => wardrobe_asset_matches_state($a, $state)));
    wardrobe_save_state($userId, $state);
}

// JunOS has the last say: game play since the last sync moves her gauges
// as a delta, then the game gets her value back
function bridge_sync(int $userId, array $snap, bool $dry = false): array {
    $prev = bridge_sync_row($userId);
    $rel = relationship_get($userId);
    $sameRun = $prev !== null && $prev['timeline'] === $snap['timeline'] && $snap['ingame_time'] >= (int)$prev['ingame_time'];
    $report = ['first' => $prev === null, 'same_run' => $sameRun, 'affection_before' => $rel['affection']];

    if ($prev === null) {
        $rel['affection'] = bridge_affection_of($snap['sympathy']);
        if (!$dry) relationship_set($userId, $rel);
    } elseif ($sameRun) {
        $delta = bridge_affection_of($snap['sympathy']) - bridge_affection_of((int)$prev['sympathy']);
        if ($delta !== 0) {
            if (!$dry) relationship_apply($userId, $rel, ['affection' => $delta]);
            $rel['affection'] = max(0, min(100, $rel['affection'] + max(-50, min(50, $delta))));
        }
    }
    $report['affection'] = $rel['affection'];

    $wardrobeAt = bridge_wardrobe_at($userId);
    $look = json_encode($snap['look'], JSON_UNESCAPED_SLASHES);
    $gameChanged = $prev === null || $prev['outfit'] !== $snap['outfit'] || $prev['look'] !== $look;
    $junChanged = $prev !== null && $wardrobeAt > (int)$prev['wardrobe_at'];
    $report['outfit_from_game'] = $gameChanged && !$junChanged;
    if ($report['outfit_from_game'] && !$dry) {
        bridge_outfit_apply($userId, $snap['outfit']);
        $wardrobeAt = bridge_wardrobe_at($userId);
    }

    $events = bridge_events($sameRun || $prev === null ? $prev : null, $snap);
    $seen = db()->prepare('SELECT 1 FROM bridge_seen WHERE user_id = ? AND event_id = ?');
    $events = array_values(array_filter($events, function ($e) use ($seen, $userId) {
        $seen->execute([$userId, hash('sha256', $e['id'])]);
        return $seen->fetchColumn() === false;
    }));
    $report['events'] = $events;
    $report['sympathy'] = bridge_sympathy_for($rel['affection'], $snap['sympathy']);
    if ($dry) return $report;

    $report['queued'] = bridge_queue($userId, $events);
    if ($report['queued']) {
        $mark = db()->prepare('INSERT OR IGNORE INTO bridge_seen (user_id, event_id) VALUES (?, ?)');
        foreach ($events as $e) $mark->execute([$userId, hash('sha256', $e['id'])]);
    }
    db()->prepare(
        'INSERT INTO bridge_sync (user_id, timeline, sympathy, ingame_time, counters, outfit, look, look_pending, wardrobe_at, synced_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET timeline=excluded.timeline, sympathy=excluded.sympathy,
           ingame_time=excluded.ingame_time, counters=excluded.counters, outfit=excluded.outfit,
           look=excluded.look, look_pending=excluded.look_pending,
           wardrobe_at=excluded.wardrobe_at, synced_at=excluded.synced_at'
    )->execute([
        $userId, $snap['timeline'], $snap['sympathy'], $snap['ingame_time'],
        json_encode($snap['counters']), json_encode($snap['outfit']), $look,
        $report['outfit_from_game'] ? $look : (string)($prev['look_pending'] ?? ''), $wardrobeAt, time(),
    ]);
    return $report;
}

// the game has $sympathy now, the next delta counts from there
function bridge_sync_settle(int $userId, int $sympathy): void {
    db()->prepare('UPDATE bridge_sync SET sympathy = ? WHERE user_id = ?')->execute([$sympathy, $userId]);
}

// once, the browser saves it into the wardrobe and her prefs
function bridge_look_take(int $userId): ?array {
    $st = db()->prepare('SELECT look_pending FROM bridge_sync WHERE user_id = ?');
    $st->execute([$userId]);
    $look = json_decode((string)$st->fetchColumn(), true);
    if (!is_array($look)) return null;
    db()->prepare("UPDATE bridge_sync SET look_pending = '' WHERE user_id = ?")->execute([$userId]);
    return $look;
}

function bridge_outfit_for_game(int $userId): array {
    $items = (wardrobe_state($userId) ?? wardrobe_default_state())['items'];
    $out = [];
    foreach (BRIDGE_OUTFIT_KEYS as $key) $out[$key] = (bool)($items[$key] ?? false);
    return $out;
}

// a bridge bug must never cost him a login or a chat turn
function bridge_signed_in(int $userId): void {
    try {
        bridge_keys_ensure($userId);
        bridge_inbox_drain($userId);
    } catch (Throwable $e) {
        log_event(['msg' => 'bridge_drain_error', 'err' => $e->getMessage()]);
    }
}
