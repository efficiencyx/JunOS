<?php

// the lockout we slap on when Jun walks out of a conversation
// with the flee tool. ONLY chat.php cares about it, history and
// settings still work fine while she's gone.
function flee_bans_enabled(): bool {
    return strtolower(env_str('FLEE_BANS', 'on')) !== 'off';
}

function ban_active(int $userId): ?array {
    if (!flee_bans_enabled()) return null;
    try {
        $st = db()->prepare('SELECT until, reason FROM user_bans WHERE user_id=?');
        $st->execute([$userId]);
        $row = $st->fetch();
        $st->closeCursor();
        if (!$row) return null;
        $until = (int)$row['until'];
        if ($until <= time()) return null;
        // a reason that won't open costs the reason, NOT the ban.
        // let dec throw up to the catch below and she's back early.
        try { $reason = (string)dec($row['reason']); } catch (Throwable $e) { $reason = ''; }
        return ['until' => $until, 'reason' => $reason, 'seconds_left' => $until - time()];
    } catch (Throwable $e) {
        log_event(['msg' => 'ban_active_error', 'err' => $e->getMessage()]);
        return null;
    }
}

function ban_apply(int $userId, string $reason): array {
    $now = time();
    $strikes = 0;
    try {
        $st = db()->prepare('SELECT strikes, last_ban FROM user_bans WHERE user_id=?');
        $st->execute([$userId]);
        $row = $st->fetch();
        $st->closeCursor();
        // one day without walking out and the escalation resets
        if ($row && $now - (int)$row['last_ban'] < 86400) $strikes = (int)$row['strikes'];
        $strikes++;
        $minutes = (int)min(30, 5 * (2 ** ($strikes - 1)));
        $until = $now + $minutes * 60;
        $reason = mb_substr(trim($reason), 0, 300);
        db()->prepare(
            'INSERT INTO user_bans (user_id, until, strikes, last_ban, reason) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(user_id) DO UPDATE SET until=excluded.until, strikes=excluded.strikes,
                                                last_ban=excluded.last_ban, reason=excluded.reason'
        )->execute([$userId, $until, $strikes, $now, crypt_key() !== null ? enc($reason) : null]);
        return ['until' => $until, 'minutes' => $minutes];
    } catch (Throwable $e) {
        log_event(['msg' => 'ban_apply_error', 'err' => $e->getMessage()]);
        return ['until' => $now + 300, 'minutes' => 5];
    }
}

// hidden relationship state per user,
// migrations/002_relationship.sql explains the model. chat.php
// turns these scores into directives for how she behaves, and her
// [A:mood_shift|...] tag is what moves them.
const RELATIONSHIP_DEFAULTS = ['affection' => 60, 'trust' => 50, 'tension' => 20];

function relationship_get(int $userId): array {
    try {
        $st = db()->prepare('SELECT affection, trust, tension FROM relationship WHERE user_id=?');
        $st->execute([$userId]);
        $row = $st->fetch();
        if ($row) {
            return [
                'affection' => (int)$row['affection'],
                'trust' => (int)$row['trust'],
                'tension' => (int)$row['tension'],
            ];
        }
    } catch (Throwable $e) {
        log_event(['msg' => 'relationship_get_error', 'err' => $e->getMessage()]);
    }
    // she starts mildly positive. she's already his girlfriend after
    // all
    return RELATIONSHIP_DEFAULTS;
}

function relationship_set(int $userId, array $values): void {
    $clamp = fn($n) => max(0, min(100, (int)$n));
    try {
        $before = relationship_get($userId);
        db()->prepare(
            'INSERT INTO relationship (user_id, affection, trust, tension, updated_at) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(user_id) DO UPDATE SET affection=excluded.affection, trust=excluded.trust, tension=excluded.tension, updated_at=excluded.updated_at'
        )->execute([
            $userId,
            $clamp($values['affection'] ?? RELATIONSHIP_DEFAULTS['affection']),
            $clamp($values['trust'] ?? RELATIONSHIP_DEFAULTS['trust']),
            $clamp($values['tension'] ?? RELATIONSHIP_DEFAULTS['tension']),
            time(),
        ]);
        $after = relationship_get($userId);
        if ($after !== $before) relationship_history_add($userId, $after);
    } catch (Throwable $e) {
        log_event(['msg' => 'relationship_set_error', 'err' => $e->getMessage()]);
    }
}

const RELATIONSHIP_HISTORY_KEEP = 2000;

// $event is null for a plain gauge change, 'outing:<where>' or 'walkout'
function relationship_history_add(int $userId, ?array $gauges = null, ?string $event = null): void {
    try {
        $g = $gauges ?? relationship_get($userId);
        db()->prepare('INSERT INTO relationship_history (user_id, affection, trust, tension, event, at) VALUES (?, ?, ?, ?, ?, ?)')
            ->execute([$userId, $g['affection'], $g['trust'], $g['tension'], $event, time()]);
        db()->prepare('DELETE FROM relationship_history WHERE user_id=? AND id <=
                       (SELECT id FROM relationship_history WHERE user_id=? ORDER BY id DESC LIMIT 1 OFFSET ' . RELATIONSHIP_HISTORY_KEEP . ')')
            ->execute([$userId, $userId]);
    } catch (Throwable $e) {
        log_event(['msg' => 'relationship_history_add_error', 'err' => $e->getMessage()]);
    }
}

function relationship_history(int $userId): array {
    $st = db()->prepare('SELECT affection, trust, tension, event, at FROM relationship_history WHERE user_id=? ORDER BY at, id');
    $st->execute([$userId]);
    return array_map(fn($r) => [
        'at' => (int)$r['at'], 'affection' => (int)$r['affection'], 'trust' => (int)$r['trust'],
        'tension' => (int)$r['tension'], 'event' => $r['event'],
    ], $st->fetchAll());
}

// stack this turn's deltas onto $cur and save. capped at +/-50 a
// turn. normal turns move 0-5, but the prompt lets Jun swing
// 30-50 on the big ones (sold, cheated on, abandoned) so the cap
// has to leave room for that and still stop the model inventing
// drama.
function relationship_apply(int $userId, array $cur, array $deltas): void {
    $clampDelta = fn($d) => max(-50, min(50, (int)$d));
    $next = [];
    foreach (['affection', 'trust', 'tension'] as $k) {
        $next[$k] = max(0, min(100, $cur[$k] + $clampDelta($deltas[$k] ?? 0)));
    }
    relationship_set($userId, $next);
    mood_log_add($userId, $deltas);
    ach_on_relationship($userId, $cur, $next);
}

// the last 3 mood shifts, and how many of the 9 gauge moves in them
// went the wrong way (tension up, trust down, affection down).
// 5 of 9 is the point where we tell her leaving is on the table.
// the 30 min window is so an old fight doesn't nag her on the next
// visit.
const MOOD_SOUR_TURNS = 3;
const MOOD_SOUR_MOVES = 5;
const MOOD_SOUR_WINDOW = 1800;

function mood_log_add(int $userId, array $deltas): void {
    try {
        $d = fn($k) => max(-50, min(50, (int)($deltas[$k] ?? 0)));
        db()->prepare('INSERT INTO mood_log (user_id, affection, trust, tension, at) VALUES (?, ?, ?, ?, ?)')
            ->execute([$userId, $d('affection'), $d('trust'), $d('tension'), time()]);
        db()->prepare('DELETE FROM mood_log WHERE user_id=? AND id NOT IN
                       (SELECT id FROM mood_log WHERE user_id=? ORDER BY id DESC LIMIT 10)')
            ->execute([$userId, $userId]);
    } catch (Throwable $e) {
        log_event(['msg' => 'mood_log_add_error', 'err' => $e->getMessage()]);
    }
}

function mood_log_clear(int $userId): void {
    try {
        db()->prepare('DELETE FROM mood_log WHERE user_id=?')->execute([$userId]);
    } catch (Throwable $e) {
        log_event(['msg' => 'mood_log_clear_error', 'err' => $e->getMessage()]);
    }
}

function mood_is_souring(int $userId): bool {
    try {
        $st = db()->prepare('SELECT affection, trust, tension, at FROM mood_log WHERE user_id=? ORDER BY id DESC LIMIT ' . MOOD_SOUR_TURNS);
        $st->execute([$userId]);
        $rows = $st->fetchAll();
        $st->closeCursor();
        if (count($rows) < MOOD_SOUR_TURNS || time() - (int)$rows[count($rows) - 1]['at'] > MOOD_SOUR_WINDOW) return false;
        $bad = 0;
        foreach ($rows as $r) {
            $bad += ((int)$r['tension'] > 0) + ((int)$r['trust'] < 0) + ((int)$r['affection'] < 0);
        }
        return $bad >= MOOD_SOUR_MOVES;
    } catch (Throwable $e) {
        log_event(['msg' => 'mood_is_souring_error', 'err' => $e->getMessage()]);
        return false;
    }
}
