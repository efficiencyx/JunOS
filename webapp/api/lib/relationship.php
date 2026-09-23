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
        return ['until' => $until, 'reason' => (string)($row['reason'] ?? ''), 'seconds_left' => $until - time()];
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
        db()->prepare(
            'INSERT INTO user_bans (user_id, until, strikes, last_ban, reason) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(user_id) DO UPDATE SET until=excluded.until, strikes=excluded.strikes,
                                                last_ban=excluded.last_ban, reason=excluded.reason'
        )->execute([$userId, $until, $strikes, $now, mb_substr(trim($reason), 0, 300)]);
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
    } catch (Throwable $e) {
        log_event(['msg' => 'relationship_set_error', 'err' => $e->getMessage()]);
    }
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
        $next[$k] = $cur[$k] + $clampDelta($deltas[$k] ?? 0);
    }
    relationship_set($userId, $next);
}
