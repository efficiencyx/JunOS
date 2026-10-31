<?php

// collectibles. nothing unlocks anything, they just sit in the
// panel looking shiny. every hook that feeds them goes through
// ach_add/ach_max/ach_min and those swallow their own errors. a
// broken counter must NEVER cost Anon a reply.
//
// tiers are bronze, silver, gold, diamond in that order. 'low'
// stats count down, lower value = higher tier (tension low point).
// hidden ones come out as ??? until the first tier lands.
const ACH_TIERS = ['bronze', 'silver', 'gold', 'diamond'];

// one catalog for both sides. the phone app bundles this file
// (android/app/build.gradle.kts) and reads the same rows
function ach_catalog(): array {
    static $catalog = null;
    return $catalog ??= json_decode((string)file_get_contents(__DIR__ . '/achievements.json'), true) ?: [];
}

// the only stats the browser may bump itself. the blackjack table
// runs entirely client side so there's nobody else to ask
const ACH_CLIENT_STATS = ['bj_won', 'bj_lost', 'bj_natural', 'bj_bust'];

function ach_upsert(int $userId, string $stat, int $value, string $merge): void {
    try {
        db()->prepare(
            'INSERT INTO achievement_stats (user_id, stat, value, updated_at) VALUES (?, ?, ?, ?)
             ON CONFLICT(user_id, stat) DO UPDATE SET value=' . $merge . ', updated_at=excluded.updated_at'
        )->execute([$userId, $stat, $value, time()]);
    } catch (Throwable $e) {
        log_event(['msg' => 'achievement_error', 'stat' => $stat, 'err' => $e->getMessage()]);
    }
}

function ach_add(int $userId, string $stat, int $by = 1): void {
    if ($by > 0) ach_upsert($userId, $stat, $by, 'value + excluded.value');
}

function ach_max(int $userId, string $stat, int $value): void {
    ach_upsert($userId, $stat, $value, 'MAX(value, excluded.value)');
}

function ach_min(int $userId, string $stat, int $value): void {
    ach_upsert($userId, $stat, $value, 'MIN(value, excluded.value)');
}

function ach_stats(int $userId): array {
    $st = db()->prepare('SELECT stat, value FROM achievement_stats WHERE user_id=?');
    $st->execute([$userId]);
    return array_map('intval', $st->fetchAll(PDO::FETCH_KEY_PAIR));
}

// minutes east of UTC, from the browser. the server clock has no
// idea what "3 am" means for Anon
function ach_local_time(int $tzMinutes): int {
    return time() + max(-840, min(840, $tzMinutes)) * 60;
}

// day count and streak. day_last is a compare-and-swap on purpose,
// two messages landing at once on a new day would otherwise both
// count it. whoever moves day_last gets to bump, the other one
// sees rowCount 0 and walks away.
function ach_touch_day(int $userId, int $day): void {
    try {
        $db = db();
        $st = $db->prepare("SELECT value FROM achievement_stats WHERE user_id=? AND stat='day_last'");
        $st->execute([$userId]);
        $last = $st->fetchColumn();
        $st->closeCursor();
        if ($last === false) {
            $claim = $db->prepare("INSERT OR IGNORE INTO achievement_stats (user_id, stat, value, updated_at) VALUES (?, 'day_last', ?, ?)");
            $claim->execute([$userId, $day, time()]);
        } else {
            // a day that went BACKWARDS is a timezone hop, not a new day
            if ((int)$last >= $day) return;
            $claim = $db->prepare("UPDATE achievement_stats SET value=?, updated_at=? WHERE user_id=? AND stat='day_last' AND value=?");
            $claim->execute([$day, time(), $userId, (int)$last]);
        }
        if ($claim->rowCount() === 0) return;

        ach_add($userId, 'days');
        $cur = 1;
        if ($last !== false && (int)$last === $day - 1) {
            $st = $db->prepare("SELECT value FROM achievement_stats WHERE user_id=? AND stat='streak_cur'");
            $st->execute([$userId]);
            $cur = (int)$st->fetchColumn() + 1;
            $st->closeCursor();
        }
        ach_upsert($userId, 'streak_cur', $cur, 'excluded.value');
        ach_max($userId, 'streak', $cur);
    } catch (Throwable $e) {
        log_event(['msg' => 'achievement_error', 'stat' => 'day_last', 'err' => $e->getMessage()]);
    }
}

function ach_on_user_message(int $userId, array $req, string $text): void {
    $now = ach_local_time($req['tz']);
    ach_add($userId, 'messages');
    ach_touch_day($userId, intdiv($now, 86400));
    $hour = intdiv($now % 86400, 3600);
    if ($hour >= 2 && $hour < 5) ach_add($userId, 'night');
    if ($req['audio'] !== '' || !empty($req['body']['voice'])) {
        ach_add($userId, 'voice');
        return;
    }
    $len = mb_strlen(trim($text));
    ach_max($userId, 'longest', $len);
    if ($len >= 1 && $len <= 3) ach_add($userId, 'short');
}

// $before and $after both already clamped to 0-100, so a +30 that
// hit the ceiling at 95 counts as 5 moved. not 30
function ach_on_relationship(int $userId, array $before, array $after): void {
    ach_max($userId, 'affection_peak', $after['affection']);
    ach_max($userId, 'trust_peak', $after['trust']);
    ach_max($userId, 'tension_peak', $after['tension']);
    ach_min($userId, 'tension_low', $after['tension']);
    $moved = 0;
    foreach (['affection', 'trust', 'tension'] as $k) $moved += abs($after[$k] - $before[$k]);
    ach_add($userId, 'gauge_moved', $moved);
}

// items + variants only. assets and key order move on saves that
// change nothing she has on
function ach_worn_changed(?array $before, ?array $after): bool {
    if ($before === null || $after === null) return false;
    $worn = fn(array $s) => json_encode([$s['items'] ?? [], $s['variants'] ?? []]);
    return $worn($before) !== $worn($after);
}

function ach_tier(array $a, ?int $value): int {
    if ($value === null) return 0;
    $tier = 0;
    foreach ($a['tiers'] as $i => $need) {
        if (!empty($a['low']) ? $value <= $need : $value >= $need) $tier = $i + 1;
    }
    return $tier;
}

function ach_list(int $userId, bool $reveal = false): array {
    $stats = ach_stats($userId);
    $st = db()->prepare('SELECT ach, tier FROM achievement_seen WHERE user_id=?');
    $st->execute([$userId]);
    $seen = array_map('intval', $st->fetchAll(PDO::FETCH_KEY_PAIR));

    $list = [];
    $fresh = [];
    foreach (ach_catalog() as $a) {
        $value = $stats[$a['stat']] ?? null;
        $tier = ach_tier($a, $value);
        $secret = !empty($a['hidden']) && $tier === 0;
        // the dev account sees through the ??? or it couldn't move
        // the counter of something it can't even name
        $redact = $secret && !$reveal;
        $list[] = [
            'id' => $a['id'],
            'group' => $a['group'],
            'name' => $redact ? null : $a['name'],
            'desc' => $redact ? null : $a['desc'],
            'secret' => $secret,
            'low' => !empty($a['low']),
            'tiers' => $redact ? null : $a['tiers'],
            'value' => $redact ? null : $value,
            'tier' => $tier,
        ];
        if ($tier > ($seen[$a['id']] ?? 0)) $fresh[] = ['id' => $a['id'], 'name' => $a['name'], 'tier' => $tier];
    }
    return ['tier_names' => ACH_TIERS, 'list' => $list, 'fresh' => $fresh, 'dev' => $reveal];
}

// dev override. null wipes the counter. seen drops with the value
// so pushing it back up toasts the tier again, which is the whole
// point of testing it
function ach_set(int $userId, string $id, ?int $value): bool {
    $a = null;
    foreach (ach_catalog() as $c) if ($c['id'] === $id) $a = $c;
    if ($a === null) return false;
    $db = db();
    if ($value === null) {
        $db->prepare('DELETE FROM achievement_stats WHERE user_id=? AND stat=?')->execute([$userId, $a['stat']]);
    } else {
        ach_upsert($userId, $a['stat'], max(0, $value), 'excluded.value');
    }
    $db->prepare('UPDATE achievement_seen SET tier=MIN(tier, ?) WHERE user_id=? AND ach=?')
       ->execute([ach_tier($a, $value === null ? null : max(0, $value)), $userId, $id]);
    return true;
}

function ach_mark_seen(int $userId, array $items): void {
    $known = array_column(ach_catalog(), 'id');
    $st = db()->prepare(
        'INSERT INTO achievement_seen (user_id, ach, tier) VALUES (?, ?, ?)
         ON CONFLICT(user_id, ach) DO UPDATE SET tier=MAX(tier, excluded.tier)'
    );
    foreach (array_slice($items, 0, count($known)) as $item) {
        if (!is_array($item) || !in_array($item['id'] ?? null, $known, true)) continue;
        $st->execute([$userId, $item['id'], max(0, min(count(ACH_TIERS), (int)($item['tier'] ?? 0)))]);
    }
}
