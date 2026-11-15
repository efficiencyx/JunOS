<?php

// gain/loss in percent, gain = the moves that help her side (tension down counts)
const DIFFICULTY = [
    'normal'   => ['gain' => 100, 'loss' => 100, 'sour_moves' => 5, 'ladder' => [5, 10, 20, 30],
                   'block' => false, 'reset_after' => 86400, 'decay_every' => 0],
    'hard'     => ['gain' => 50, 'loss' => 150, 'sour_moves' => 4, 'ladder' => [60, 240, 1440],
                   'block' => false, 'reset_after' => 0, 'decay_every' => 14 * 86400],
    'hardcore' => ['gain' => 20, 'loss' => 200, 'sour_moves' => 3, 'ladder' => [240, 1440, 2880],
                   'block' => true, 'reset_after' => 0, 'decay_every' => 0],
];

function difficulty_strikes(array $cfg, int $strikes, int $lastBan, int $now): int {
    $clean = $now - $lastBan;
    if ($cfg['reset_after'] && $clean >= $cfg['reset_after']) return 0;
    if ($cfg['decay_every']) return max(0, $strikes - intdiv($clean, $cfg['decay_every']));
    return $strikes;
}

function difficulty_ban_minutes(array $cfg, int $strike): ?int {
    $ladder = $cfg['ladder'];
    if ($strike <= count($ladder)) return $ladder[$strike - 1];
    return $cfg['block'] ? null : $ladder[count($ladder) - 1];
}

// hundredths, not floats. five float 0.2s don't add up to 1 and the carry never pays out
function difficulty_scale(array $cfg, array $deltas, array $carry): array {
    $applied = [];
    foreach (['affection', 'trust', 'tension'] as $k) {
        if (!isset($deltas[$k])) continue;
        $d = max(-50, min(50, (int)$deltas[$k]));
        $helps = $k === 'tension' ? $d < 0 : $d > 0;
        $total = $d * ($helps ? $cfg['gain'] : $cfg['loss']) + (int)($carry[$k] ?? 0);
        $applied[$k] = intdiv($total, 100);
        $carry[$k] = $total - $applied[$k] * 100;
    }
    return [$applied, $carry];
}

function difficulty_level(int $userId): ?string {
    try {
        $st = db()->prepare('SELECT level FROM difficulty WHERE user_id=?');
        $st->execute([$userId]);
        $level = $st->fetchColumn();
        $st->closeCursor();
        return is_string($level) && isset(DIFFICULTY[$level]) ? $level : null;
    } catch (Throwable $e) {
        log_event(['msg' => 'difficulty_level_error', 'err' => $e->getMessage()]);
        return null;
    }
}

function difficulty_of(int $userId): array {
    return DIFFICULTY[difficulty_level($userId) ?? 'normal'];
}

function difficulty_pick(int $userId, string $level, bool $force = false): bool {
    if (!isset(DIFFICULTY[$level])) return false;
    $st = db()->prepare('INSERT INTO difficulty (user_id, level, picked_at) VALUES (?, ?, ?)
                         ON CONFLICT(user_id) DO ' . ($force ? 'UPDATE SET level=excluded.level' : 'NOTHING'));
    $st->execute([$userId, $level, time()]);
    return $st->rowCount() > 0;
}

function difficulty_deltas(int $userId, array $deltas, bool $commit = true): array {
    $level = difficulty_level($userId);
    if ($level === null || $level === 'normal') return $deltas;
    try {
        $st = db()->prepare('SELECT carry_affection, carry_trust, carry_tension FROM difficulty WHERE user_id=?');
        $st->execute([$userId]);
        $row = $st->fetch() ?: [];
        $st->closeCursor();
        $carry = [];
        foreach (['affection', 'trust', 'tension'] as $k) $carry[$k] = (int)($row["carry_$k"] ?? 0);
        [$applied, $carry] = difficulty_scale(DIFFICULTY[$level], $deltas, $carry);
        if ($commit) {
            db()->prepare('UPDATE difficulty SET carry_affection=?, carry_trust=?, carry_tension=? WHERE user_id=?')
                ->execute([$carry['affection'], $carry['trust'], $carry['tension'], $userId]);
        }
        return $applied;
    } catch (Throwable $e) {
        log_event(['msg' => 'difficulty_deltas_error', 'err' => $e->getMessage()]);
        return $deltas;
    }
}
