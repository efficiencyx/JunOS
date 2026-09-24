<?php

// sliding window per bucket per IP, the hit timestamps sit in a
// flat file. no writable dir = 503, same as db() in db.php, and
// somebody fixes the state dir. letting the request through
// instead would turn "state dir is read only" into "login has
// no brute force lockout".
function rate_limit(string $bucket, int $maxPerWindow, int $windowSec): void {
    $key = sha1($bucket . '|' . client_ip());

    $dir = state_dir() . '/rl';
    if (!is_dir($dir)) @mkdir($dir, 0700, true);
    $fp = (is_dir($dir) && is_writable($dir)) ? fopen($dir . '/' . $key . '.json', 'c+') : false;
    if ($fp === false) {
        log_event(['msg' => 'rate_limit_storage_unavailable', 'dir' => $dir]);
        fail(503, 'state_unavailable');
    }
    $now = time();
    flock($fp, LOCK_EX);

    $data = ['hits' => []];
    $raw = stream_get_contents($fp);
    if ($raw) {
        $parsed = json_decode($raw, true);
        if (is_array($parsed)) $data = $parsed;
    }

    $cutoff = $now - $windowSec;
    $data['hits'] = array_values(array_filter($data['hits'], fn($t) => $t > $cutoff));

    if (count($data['hits']) >= $maxPerWindow) {
        flock($fp, LOCK_UN);
        fclose($fp);
        $retryAfter = max(1, (min($data['hits']) + $windowSec) - $now);
        header('Retry-After: ' . $retryAfter);
        log_event(['msg' => 'rate_limit_exceeded', 'bucket' => $bucket, 'limit' => $maxPerWindow]);
        fail(429, 'rate_limit_exceeded', ['retry_after' => $retryAfter]);
    }

    $data['hits'][] = $now;
    ftruncate($fp, 0);
    rewind($fp);
    fwrite($fp, json_encode($data));
    flock($fp, LOCK_UN);
    fclose($fp);
}
