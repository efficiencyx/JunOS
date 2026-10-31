<?php

function consolidation_lock_path(int $userId): string {
    $dir = state_dir() . '/consolidating';
    if (!is_dir($dir)) @mkdir($dir, 0700, true);
    return $dir . '/user-' . $userId . '.lock';
}

// older builds wrote just an expiry timestamp here. that still
// comes back as an int, so a lock file one of them left behind
// reads as an expiry with no phase, instead of a broken lock
// nobody can ever clear.
function consolidation_lock_read(int $userId): ?array {
    $raw = @file_get_contents(consolidation_lock_path($userId));
    if ($raw === false) return null;
    $data = json_decode(trim($raw), true);
    if (is_int($data)) $data = ['expiry' => $data];
    if (!is_array($data) || !isset($data['expiry'])) return null;
    return [
        'expiry'      => (int)$data['expiry'],
        'started'     => (int)($data['started'] ?? 0),
        'phase'       => (string)($data['phase'] ?? ''),
        'progress'    => is_array($data['progress'] ?? null) ? $data['progress'] : null,
        'quiet_until' => (int)($data['quiet_until'] ?? 0),
    ];
}

const CONSOLIDATION_LOCK_TTL = 600;

// rolling expiry, a healthy pass on a CPU box runs way past ten minutes
function consolidation_lock_update(int $userId, array $fields): void {
    $lock = consolidation_lock_read($userId) ?? ['started' => time()];
    $lock = array_merge($lock, $fields, ['expiry' => time() + CONSOLIDATION_LOCK_TTL]);
    @file_put_contents(consolidation_lock_path($userId), json_encode($lock, JSON_UNESCAPED_UNICODE), LOCK_EX);
}

function consolidation_locked(int $userId): bool {
    $path = consolidation_lock_path($userId);
    if (!is_file($path)) return false;
    $lock = consolidation_lock_read($userId);
    // we clear a lock we can't even read, otherwise one half written
    // file blocks every later run forever. consolidation_run only
    // tries fopen(x) again once this comes back false.
    if ($lock !== null && $lock['expiry'] > time()) return true;
    @unlink($path);
    return false;
}

function consolidation_status(int $userId): array {
    if (!consolidation_locked($userId)) return ['locked' => false];
    $lock = consolidation_lock_read($userId);
    if ($lock === null) return ['locked' => false];
    $status = [
        'locked'  => true,
        'phase'   => $lock['phase'],
        'elapsed' => $lock['started'] > 0 ? max(0, time() - $lock['started']) : 0,
    ];
    if ($lock['progress']) $status['progress'] = $lock['progress'];
    return $status;
}

function consolidation_touch(int $userId, ?bool $enabled = null): void {
    key_push($userId);
    if ($enabled === null) {
        db()->prepare(
            'INSERT INTO memory_consolidation (user_id, last_activity) VALUES (?, ?)
             ON CONFLICT(user_id) DO UPDATE SET last_activity = CASE WHEN enabled = 1 THEN excluded.last_activity ELSE last_activity END'
        )->execute([$userId, time()]);
        return;
    }
    db()->prepare(
        'INSERT INTO memory_consolidation (user_id, last_activity, enabled) VALUES (?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET last_activity = excluded.last_activity, enabled = excluded.enabled'
    )->execute([$userId, $enabled ? time() : 0, $enabled ? 1 : 0]);
}

// her texts for every milestone of the absence, written by the
// idle pass before any of them were "sent". the queue empties when
// a welcome actually shows, a refresh two minutes later must not
// replay the same thread.
const WELCOME_MAX_CHARS = 240;

// $tiers is tier name => list of texts, already capped per tier by
// welcome.php. the old shape was one flat list and some of those
// are still sitting in the table, read() turns them into 'missed'.
function welcome_queue_set(int $userId, array $tiers): void {
    $clean = [];
    foreach ($tiers as $tier => $texts) {
        $kept = [];
        foreach ((array)$texts as $text) {
            if (!is_string($text)) continue;
            $text = trim(preg_replace('/\s+/', ' ', $text));
            if ($text !== '') $kept[] = mb_substr($text, 0, WELCOME_MAX_CHARS);
        }
        if ($kept) $clean[(string)$tier] = $kept;
    }
    if (!$clean) return;
    $json = json_encode(['v' => 2, 'tiers' => $clean], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    db()->prepare(
        'INSERT INTO welcome_queue (user_id, messages, generated_at) VALUES (?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET messages = excluded.messages, generated_at = excluded.generated_at'
    )->execute([$userId, enc($json), time()]);
}

function welcome_queue_read(int $userId, bool $drain = true): array {
    try {
        $stmt = db()->prepare('SELECT messages FROM welcome_queue WHERE user_id = ?');
        $stmt->execute([$userId]);
        $raw = $stmt->fetchColumn();
        if ($raw === false) return [];
        if ($drain) db()->prepare('DELETE FROM welcome_queue WHERE user_id = ?')->execute([$userId]);
        $decoded = json_decode((string)dec((string)$raw), true);
        if (!is_array($decoded)) return [];
        $tiers = ($decoded['v'] ?? null) === 2 ? (array)($decoded['tiers'] ?? []) : ['missed' => $decoded];
        $out = [];
        foreach ($tiers as $tier => $texts) {
            $kept = array_values(array_filter((array)$texts, fn($m) => is_string($m) && trim($m) !== ''));
            if ($kept) $out[(string)$tier] = $kept;
        }
        return $out;
    } catch (Throwable $e) {
        log_event(['msg' => 'welcome_queue_read_error', 'user_id' => $userId, 'err' => $e->getMessage()]);
        return [];
    }
}

const PLANNED_MAX_WAITING = 3;

function planned_when(int $hours): string {
    if ($hours === 1) return 'in an hour';
    if ($hours < 24) return "in $hours hours";
    $days = intdiv($hours, 24);
    $rest = $hours % 24;
    $when = 'in ' . ($days === 1 ? 'a day' : "$days days");
    if ($rest) $when .= ' and ' . ($rest === 1 ? 'an hour' : "$rest hours");
    return $when;
}

// one statement so two racing calls can't both be the third. the cap is
// inlined ON PURPOSE, bound it goes in as TEXT and sqlite says any int < any text
function planned_add(int $userId, string $text, int $afterHours): array {
    $text = mb_substr(trim(preg_replace('/\s+/', ' ', $text)), 0, WELCOME_MAX_CHARS);
    if ($text === '') return ['error' => 'message_required'];
    $hours = max(1, min(72, $afterHours));
    $now = time();
    $st = db()->prepare(
        'INSERT INTO planned_messages (user_id, text, due_at, created_at)
         SELECT ?, ?, ?, ? WHERE (SELECT COUNT(*) FROM planned_messages WHERE user_id = ? AND delivered_at IS NULL) < ' . PLANNED_MAX_WAITING
    );
    $st->execute([$userId, enc($text), $now + $hours * 3600, $now, $userId]);
    if ($st->rowCount() === 0) {
        return [
            'planned' => false,
            'note' => 'You already have ' . PLANNED_MAX_WAITING . ' texts waiting to go out to Anon. This one was not planned.',
        ];
    }
    return ['planned' => true, 'sends' => planned_when($hours)];
}

function planned_waiting(int $userId, ?int $dueBy = null): array {
    $st = db()->prepare(
        'SELECT id, text, due_at FROM planned_messages
          WHERE user_id = ? AND delivered_at IS NULL AND due_at <= ? ORDER BY due_at, id'
    );
    $st->execute([$userId, $dueBy ?? PHP_INT_MAX]);
    $out = [];
    foreach ($st->fetchAll() as $row) {
        $text = (string)dec((string)$row['text']);
        if ($text !== '') $out[] = ['id' => (int)$row['id'], 'at' => (int)$row['due_at'], 'text' => $text];
    }
    return $out;
}

function planned_mark_delivered(int $userId, array $ids): void {
    if (!$ids) return;
    $marks = implode(',', array_fill(0, count($ids), '?'));
    db()->prepare("UPDATE planned_messages SET delivered_at = ? WHERE user_id = ? AND id IN ($marks)")
        ->execute([time(), $userId, ...array_map('intval', $ids)]);
}
