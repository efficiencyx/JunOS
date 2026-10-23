<?php

// Sits under the web root so it ships with the rest of the api/
// tree, but nginx is happy to send a request here, and one HTTP
// hit would hold an fpm child in the loop below for Ever.
if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }

require_once __DIR__ . '/lib/bootstrap.php';
require_once __DIR__ . '/lib/consolidation/engine.php';
require_once __DIR__ . '/lib/consolidation/feed.php';
require_once __DIR__ . '/lib/consolidation/ask.php';
require_once __DIR__ . '/lib/consolidation/guided.php';
require_once __DIR__ . '/lib/consolidation/passes.php';
require_once __DIR__ . '/lib/consolidation/welcome.php';

const CONSOLIDATION_IDLE_SECONDS = 180;
const CONSOLIDATION_POLL_SECONDS = 15;
const CONSOLIDATION_RETRY_SECONDS = 600;
const CONSOLIDATION_MAX_RESTARTS = 3;
const CHILD_OK = 0;
const CHILD_ERROR = 1;
const CHILD_IDLE = 3;
const CHILD_STOPPED = 4;

// child mode: one pass for one user, the key comes in on stdin
if (($argv[1] ?? '') === '--run') {
    $dek = base64_decode(trim((string)fgets(STDIN)), true);
    if ($dek === false || strlen($dek) !== SODIUM_CRYPTO_SECRETBOX_KEYBYTES) exit(CHILD_ERROR);
    crypt_bind($dek);
    $idleBefore = ($argv[3] ?? '') === '' ? null : (int)$argv[3];
    $result = consolidation_run((int)$argv[2], $idleBefore, ($argv[4] ?? '0') === '1', ($argv[5] ?? '0') === '1');
    if (!empty($result['ok'])) exit(CHILD_OK);
    if (!empty($result['stopped'])) exit(CHILD_STOPPED);
    exit(!empty($result['skipped']) || !empty($result['running']) ? CHILD_IDLE : CHILD_ERROR);
}

function stall_seconds(): int {
    return max(10, (int)env_str('CONSOLIDATION_STALL_SECONDS', '30'));
}

function child_start(int $userId, string $dek, ?int $idleBefore, bool $forced, bool $resume): ?array {
    $proc = proc_open(
        [PHP_BINARY, __FILE__, '--run', (string)$userId, $idleBefore === null ? '' : (string)$idleBefore, $forced ? '1' : '0', $resume ? '1' : '0'],
        [0 => ['pipe', 'r'], 1 => STDOUT, 2 => STDERR],
        $pipes
    );
    if (!is_resource($proc)) {
        log_event(['msg' => 'memory_consolidation_spawn_failed', 'user_id' => $userId]);
        return null;
    }
    fwrite($pipes[0], base64_encode($dek) . "\n");
    fclose($pipes[0]);
    return ['proc' => $proc, 'user' => $userId, 'idle' => $idleBefore, 'forced' => $forced, 'since' => time(), 'started' => time()];
}

function feed_as(int $userId, string $dek, array $event): void {
    crypt_bind($dek);
    try {
        consolidation_feed_emit($userId, $event);
    } finally {
        crypt_bind(null);
    }
}

function child_kill(array $child): void {
    proc_terminate($child['proc'], 9);
    proc_close($child['proc']);
    @unlink(consolidation_lock_path($child['user']));
}

// null while it's still going, else how it ended
function child_check(array &$child, array $keys): ?int {
    $userId = $child['user'];
    $status = proc_get_status($child['proc']);
    if (!$status['running']) {
        proc_close($child['proc']);
        return $status['exitcode'] >= 0 ? $status['exitcode'] : CHILD_ERROR;
    }

    $stmt = db()->prepare('SELECT interrupt_at FROM memory_consolidation WHERE user_id = ?');
    $stmt->execute([$userId]);
    $interruptAt = (int)$stmt->fetchColumn();
    $stmt->closeCursor();
    if ($interruptAt >= $child['started']) {
        child_kill($child);
        consolidation_record_result($userId, 'stopped');
        if (isset($keys[$userId])) feed_as($userId, $keys[$userId], ['type' => 'done', 'status' => 'stopped']);
        log_event(['msg' => 'memory_consolidation_stopped', 'user_id' => $userId]);
        return CHILD_STOPPED;
    }

    // quiet_until covers her reading a long prompt, a CPU box sits silent for minutes there
    clearstatcache();
    $lock = consolidation_lock_read($userId);
    $lastSign = max((int)@filemtime(consolidation_feed_path($userId)), $lock['quiet_until'] ?? 0, $child['since']);
    if (time() - $lastSign <= stall_seconds()) return null;

    child_kill($child);
    $child['restarts'] = ($child['restarts'] ?? 0) + 1;
    log_event(['msg' => 'memory_consolidation_stalled', 'user_id' => $userId, 'restart' => $child['restarts']]);
    if ($child['restarts'] > CONSOLIDATION_MAX_RESTARTS || !isset($keys[$userId])) {
        consolidation_record_result($userId, 'error');
        if (isset($keys[$userId])) feed_as($userId, $keys[$userId], ['type' => 'done', 'status' => 'error']);
        return CHILD_ERROR;
    }
    feed_as($userId, $keys[$userId], ['type' => 'stall', 'restart' => $child['restarts']]);
    $next = child_start($userId, $keys[$userId], $child['idle'], $child['forced'], true);
    if ($next === null) return CHILD_ERROR;
    $child = $next + ['restarts' => $child['restarts'], 'started' => $child['started']];
    return null;
}

// a developer's "run now" goes first, then anyone idle with enough new messages
function next_candidate(array $keys, array $retryAfter): ?array {
    $now = time();
    $db = db();
    consolidation_repair_watermarks($db);
    $stmt = $db->prepare(
        'SELECT user_id, force_at FROM memory_consolidation
         WHERE force_at > 0 OR (enabled = 1 AND last_activity > 0 AND last_activity <= ?)
         ORDER BY force_at DESC'
    );
    $stmt->execute([$now - CONSOLIDATION_IDLE_SECONDS]);
    $rows = $stmt->fetchAll();
    foreach ($rows as $row) {
        $userId = (int)$row['user_id'];
        if (!isset($keys[$userId])) continue;
        if ((int)$row['force_at'] > 0) {
            $db->prepare('UPDATE memory_consolidation SET force_at = 0 WHERE user_id = ?')->execute([$userId]);
            return ['user' => $userId, 'idle' => null, 'forced' => true];
        }
        if (($retryAfter[$userId] ?? 0) > $now) continue;
        if (consolidation_pending_count($db, $userId) < CONSOLIDATION_MIN_MESSAGES) continue;
        return ['user' => $userId, 'idle' => $now - CONSOLIDATION_IDLE_SECONDS, 'forced' => false];
    }
    return null;
}

// rows are sealed under each user's key and this process has no
// cookie, so php-fpm pushes the key here on every activity touch
// (key_push in lib/crypto.php). it lives in $keys until that user's
// run comes back ok, then it's zeroed. a user with no key yet is
// skipped, not failed, the next touch brings it.
$server = stream_socket_server('tcp://127.0.0.1:' . key_push_port(), $errno, $errstr);
if ($server === false) {
    log_event(['msg' => 'memory_consolidation_worker_no_port', 'port' => key_push_port(), 'err' => $errstr]);
    exit(1);
}

$keys = [];
$retryAfter = [];
$nextPoll = time();
$child = null;

while (true) {
    $read = [$server];
    $write = $except = null;
    $wait = $child ? 1 : max(0, $nextPoll - time());
    if (@stream_select($read, $write, $except, $wait) > 0) {
        $conn = @stream_socket_accept($server, 0);
        if ($conn !== false) {
            stream_set_timeout($conn, 1);
            $msg = json_decode((string)fgets($conn, 512), true);
            fclose($conn);
            $dek = is_array($msg) ? base64_decode((string)($msg['dek'] ?? ''), true) : false;
            $userId = is_array($msg) ? (int)($msg['user_id'] ?? 0) : 0;
            if ($userId > 0 && $dek !== false && strlen($dek) === SODIUM_CRYPTO_SECRETBOX_KEYBYTES) {
                if (isset($keys[$userId])) sodium_memzero($keys[$userId]);
                $keys[$userId] = $dek;
                if (!empty($msg['wake'])) $nextPoll = time();
            }
        }
    }

    try {
        if ($child) {
            $ended = child_check($child, $keys);
            if ($ended === null) continue;
            $userId = $child['user'];
            $child = null;
            if ($ended === CHILD_ERROR) {
                $retryAfter[$userId] = time() + CONSOLIDATION_RETRY_SECONDS;
            } else {
                unset($retryAfter[$userId]);
            }
            if ($ended === CHILD_OK && isset($keys[$userId])) {
                sodium_memzero($keys[$userId]);
                unset($keys[$userId]);
            }
            $nextPoll = time();
            continue;
        }
        if (time() < $nextPoll) continue;
        $nextPoll = time() + CONSOLIDATION_POLL_SECONDS;
        $next = next_candidate($keys, $retryAfter);
        if ($next) $child = child_start($next['user'], $keys[$next['user']], $next['idle'], $next['forced'], false);
    } catch (Throwable $e) {
        log_event(['msg' => 'memory_consolidation_worker_error', 'err' => $e->getMessage()]);
    }
}
