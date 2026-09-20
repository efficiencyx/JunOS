<?php

// Sits under the web root so it ships with the rest of the api/
// tree, but nginx is happy to send a request here, and one HTTP
// hit would hold an fpm child in the loop below for Ever.
if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }

require_once __DIR__ . '/_consolidation.php';

const CONSOLIDATION_IDLE_SECONDS = 180;
const CONSOLIDATION_POLL_SECONDS = 15;
const CONSOLIDATION_RETRY_SECONDS = 600;

// rows are sealed under each user's key and this process has no
// cookie, so php-fpm pushes the key here on every activity touch
// (key_push in _lib.php). it lives in $keys until that user's
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

while (true) {
    $read = [$server];
    $write = $except = null;
    if (@stream_select($read, $write, $except, max(0, $nextPoll - time())) > 0) {
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
            }
        }
        if (time() < $nextPoll) continue;
    }
    $nextPoll = time() + CONSOLIDATION_POLL_SECONDS;

    try {
        $now = time();
        consolidation_repair_watermarks(db());
        $stmt = db()->prepare(
            'SELECT mc.user_id
             FROM memory_consolidation mc
             WHERE mc.enabled = 1 AND mc.last_activity > 0 AND mc.last_activity <= ?
               AND (SELECT COUNT(*) FROM messages m JOIN conversations c ON c.id = m.conversation_id
                    WHERE c.user_id = mc.user_id AND m.id > mc.upto_id) >= ?'
        );
        $stmt->bindValue(1, $now - CONSOLIDATION_IDLE_SECONDS, PDO::PARAM_INT);
        $stmt->bindValue(2, CONSOLIDATION_MIN_MESSAGES, PDO::PARAM_INT);
        $stmt->execute();
        foreach ($stmt->fetchAll(PDO::FETCH_COLUMN) as $id) {
            $userId = (int)$id;
            if (($retryAfter[$userId] ?? 0) > $now) continue;
            if (!isset($keys[$userId])) continue;
            crypt_bind($keys[$userId]);
            try {
                $result = consolidation_run($userId, $now - CONSOLIDATION_IDLE_SECONDS);
            } finally {
                crypt_bind(null);
            }
            if (empty($result['ok']) && empty($result['running']) && empty($result['skipped'])) {
                $retryAfter[$userId] = $now + CONSOLIDATION_RETRY_SECONDS;
            } else {
                unset($retryAfter[$userId]);
            }
            if (!empty($result['ok'])) {
                sodium_memzero($keys[$userId]);
                unset($keys[$userId]);
            }
        }
    } catch (Throwable $e) {
        log_event(['msg' => 'memory_consolidation_worker_error', 'err' => $e->getMessage()]);
    }
}
