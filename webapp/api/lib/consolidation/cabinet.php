<?php

// the filing game never writes a note, it only scores his drawers against hers

const CABINET_DRAWERS = [
    'likes' => 'preferences',
    'work' => 'work',
    'health' => 'health',
    'family' => 'family',
    'plans' => 'plans',
    'limits' => 'boundaries',
    'happened' => 'events',
    'shred' => null,
];
const CABINET_AGREED_PER_TRUST = 5;
const CABINET_TRUST_PER_PASS = 3;
const CABINET_TRUST_PER_DAY = 6;
const CABINET_MAX_PLAYS = 500;
// "waited" only counts if the pass he waited for really finished
const CABINET_WAIT_WINDOW = 300;

function cabinet_settle(int $userId, array $body): array {
    $plays = array_slice(is_array($body['plays'] ?? null) ? $body['plays'] : [], 0, CABINET_MAX_PLAYS);
    $where = [];
    foreach (memory_notes_load($userId) as $category => $data) {
        foreach ($data['notes'] as $note) $where[$note['id']] = $category;
    }

    $agreed = $total = $filed = $shredded = $streak = $best = 0;
    foreach ($plays as $play) {
        if (!is_array($play)) continue;
        $drawer = (string)($play['drawer'] ?? '');
        if (!array_key_exists($drawer, CABINET_DRAWERS)) continue;
        if (!empty($play['junk'])) {
            if ($drawer === 'shred') $shredded++;
            continue;
        }
        $category = $where[(string)($play['id'] ?? '')] ?? null;
        if ($category === null || !in_array($category, CABINET_DRAWERS, true)) continue;
        $total++;
        if ($drawer !== 'shred') $filed++;
        if (CABINET_DRAWERS[$drawer] === $category) {
            $agreed++;
            $best = max($best, ++$streak);
        } else {
            $streak = 0;
        }
    }

    ach_add($userId, 'cab_filed', $filed);
    ach_add($userId, 'cab_shredded', $shredded);
    if ($best > 0) ach_max($userId, 'cab_streak', $best);

    if (!empty($body['waited'])) {
        $stmt = db()->prepare('SELECT last_run, last_status FROM memory_consolidation WHERE user_id = ?');
        $stmt->execute([$userId]);
        $last = $stmt->fetch();
        $stmt->closeCursor();
        if ($last && $last['last_status'] === 'ok' && (int)$last['last_run'] >= time() - CABINET_WAIT_WINDOW) {
            ach_add($userId, 'cab_waited');
        }
    }

    $trust = min(CABINET_TRUST_PER_PASS, intdiv($agreed, CABINET_AGREED_PER_TRUST));
    if ($trust > 0) {
        $day = intdiv(ach_local_time((int)($body['tz'] ?? 0)), 86400);
        $stmt = db()->prepare('SELECT game_day, game_trust FROM memory_consolidation WHERE user_id = ?');
        $stmt->execute([$userId]);
        $row = $stmt->fetch() ?: ['game_day' => 0, 'game_trust' => 0];
        $stmt->closeCursor();
        $given = (int)$row['game_day'] === $day ? (int)$row['game_trust'] : 0;
        $trust = min($trust, CABINET_TRUST_PER_DAY - $given);
        if ($trust > 0) {
            db()->prepare('UPDATE memory_consolidation SET game_day = ?, game_trust = ? WHERE user_id = ?')
                ->execute([$day, $given + $trust, $userId]);
            relationship_apply($userId, relationship_get($userId), ['trust' => $trust]);
        }
    }

    return ['agreed' => $agreed, 'total' => $total];
}
