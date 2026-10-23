<?php

const CONSOLIDATION_MIN_MESSAGES = 2;

// the welcome pass runs AFTER the lock is released, see
// consolidation_write_welcome for why. and only on idle runs, a
// forced run means somebody is sitting right there. $resume is the
// watchdog restarting a wedged pass: same feed, no idle check.
function consolidation_run(int $userId, ?int $idleBefore = null, bool $forced = false, bool $resume = false): array {
    $welcomeLines = null;
    $result = consolidation_run_locked($userId, $idleBefore, $forced, $resume, $welcomeLines);
    if (!empty($result['ok']) && $idleBefore !== null && !$forced && $welcomeLines) {
        consolidation_write_welcome($userId, $welcomeLines, $idleBefore);
    }
    return $result;
}

function consolidation_run_locked(int $userId, ?int $idleBefore, bool $forced, bool $resume, ?array &$welcomeLines): array {
    $lockPath = consolidation_lock_path($userId);
    $startedAt = time();
    $lock = @fopen($lockPath, 'x');
    if ($lock === false && !consolidation_locked($userId)) $lock = @fopen($lockPath, 'x');
    if ($lock === false) return ['running' => true];
    fwrite($lock, json_encode(['expiry' => $startedAt + CONSOLIDATION_LOCK_TTL, 'started' => $startedAt, 'phase' => 'notes']));
    fclose($lock);
    @chmod($lockPath, 0600);

    try {
        $db = db();
        consolidation_repair_watermarks($db);
        if ($idleBefore !== null && !$forced && !$resume) {
            $activity = $db->prepare('SELECT last_activity, enabled FROM memory_consolidation WHERE user_id = ?');
            $activity->execute([$userId]);
            $state = $activity->fetch();
            // close it. an open cursor keeps sqlite's read snapshot
            // alive, then one activity touch from another connection
            // and the final upsert dies with 'database is locked',
            // busy_timeout or not.
            $activity->closeCursor();
            if (!$state || !(int)$state['enabled'] || (int)$state['last_activity'] > $idleBefore) {
                return ['skipped' => true];
            }
        }
        $pending = consolidation_pending_count($db, $userId);
        log_event(['msg' => 'memory_consolidation_started', 'user_id' => $userId, 'message_count' => $pending, 'forced' => $forced]);
        if ($pending < CONSOLIDATION_MIN_MESSAGES && !$forced && !$resume) {
            log_event(['msg' => 'memory_consolidation_skipped', 'user_id' => $userId, 'message_count' => $pending]);
            return ['skipped' => true];
        }

        if (!$resume || consolidation_feed_pass($userId) === '') consolidation_feed_reset($userId, (string)$startedAt);
        $out = consolidation_guided($userId, $startedAt);
        $noteCount = count(memory_list($userId));
        consolidation_record_result($userId, 'ok', $noteCount);
        consolidation_feed_emit($userId, ['type' => 'done', 'status' => 'ok', 'notes' => $noteCount]);
        $welcomeLines = $out['lines'];
        log_event([
            'msg' => 'memory_consolidation_complete',
            'user_id' => $userId,
            'note_count' => $noteCount,
            'calls' => $out['calls'],
            'changed' => $out['changed'],
            'seconds' => time() - $startedAt,
        ]);
        return ['ok' => true];
    } catch (Throwable $e) {
        $stopped = $e->getMessage() === 'consolidation_interrupted';
        log_event(['msg' => $stopped ? 'memory_consolidation_stopped' : 'memory_consolidation_error', 'user_id' => $userId, 'err' => $e->getMessage()]);
        try {
            consolidation_record_result($userId, $stopped ? 'stopped' : 'error', count(memory_list($userId)));
            consolidation_feed_emit($userId, ['type' => 'done', 'status' => $stopped ? 'stopped' : 'error']);
        } catch (Throwable $ignored) {}
        return $stopped ? ['stopped' => true] : ['ok' => false];
    } finally {
        $held = consolidation_lock_read($userId);
        if ($held !== null && $held['started'] === $startedAt) @unlink($lockPath);
    }
}
