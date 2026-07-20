<?php

// Lives under the web root so it ships with the rest of the api/ tree, but nginx
// will happily route a request here - and an HTTP hit would pin an fpm child in
// the loop below forever.
if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }

require_once __DIR__ . '/_consolidation.php';

const CONSOLIDATION_IDLE_SECONDS = 180;
const CONSOLIDATION_POLL_SECONDS = 15;
const CONSOLIDATION_RETRY_SECONDS = 600;

$retryAfter = [];

while (true) {
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
            $result = consolidation_run($userId, $now - CONSOLIDATION_IDLE_SECONDS);
            if (empty($result['ok']) && empty($result['running']) && empty($result['skipped'])) {
                $retryAfter[$userId] = $now + CONSOLIDATION_RETRY_SECONDS;
            } else {
                unset($retryAfter[$userId]);
            }
        }
    } catch (Throwable $e) {
        log_event(['msg' => 'memory_consolidation_worker_error', 'err' => $e->getMessage()]);
    }
    sleep(CONSOLIDATION_POLL_SECONDS);
}
