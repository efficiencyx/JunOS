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
        'expiry'  => (int)$data['expiry'],
        'started' => (int)($data['started'] ?? 0),
        'phase'   => (string)($data['phase'] ?? ''),
    ];
}

function consolidation_lock_write(int $userId, int $expiry, int $started, string $phase): void {
    @file_put_contents(
        consolidation_lock_path($userId),
        json_encode(['expiry' => $expiry, 'started' => $started, 'phase' => $phase]),
        LOCK_EX
    );
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
    return [
        'locked'  => true,
        'phase'   => $lock['phase'],
        'elapsed' => $lock['started'] > 0 ? max(0, time() - $lock['started']) : 0,
    ];
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

// lines consolidation decided Jun wants to say next time Anon
// turns up. the queue empties WHEN you read it, a refresh two
// minutes later must not replay the same thing.
const WELCOME_MAX_MESSAGES = 3;

const WELCOME_MAX_CHARS = 240;

function welcome_queue_set(int $userId, array $messages): void {
    $clean = [];
    foreach ($messages as $message) {
        if (!is_string($message)) continue;
        $text = trim(preg_replace('/\s+/', ' ', $message));
        if ($text === '') continue;
        $clean[] = mb_substr($text, 0, WELCOME_MAX_CHARS);
        if (count($clean) >= WELCOME_MAX_MESSAGES) break;
    }
    if (!$clean) return;
    db()->prepare(
        'INSERT INTO welcome_queue (user_id, messages, generated_at) VALUES (?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET messages = excluded.messages, generated_at = excluded.generated_at'
    )->execute([$userId, enc(json_encode($clean, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES)), time()]);
}

function welcome_queue_read(int $userId, bool $drain = true): array {
    try {
        $stmt = db()->prepare('SELECT messages FROM welcome_queue WHERE user_id = ?');
        $stmt->execute([$userId]);
        $raw = $stmt->fetchColumn();
        if ($raw === false) return [];
        if ($drain) db()->prepare('DELETE FROM welcome_queue WHERE user_id = ?')->execute([$userId]);
        $messages = json_decode((string)dec((string)$raw), true);
        if (!is_array($messages)) return [];
        return array_values(array_filter($messages, fn($m) => is_string($m) && trim($m) !== ''));
    } catch (Throwable $e) {
        log_event(['msg' => 'welcome_queue_read_error', 'user_id' => $userId, 'err' => $e->getMessage()]);
        return [];
    }
}
