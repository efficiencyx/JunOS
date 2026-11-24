<?php

// one sealed json line per event (his notes are in it). the plain "#pass <id>"
// header makes a reader holding last pass's offset start over, not land mid-pass

const CONSOLIDATION_FEEDS_KEPT = 2;

// $back 1 and 2 are the passes before this one, kept for the dev terminal
function consolidation_feed_path(int $userId, int $back = 0): string {
    return dirname(consolidation_lock_path($userId)) . '/user-' . $userId . '.feed' . ($back > 0 ? '.' . $back : '');
}

function consolidation_feed_reset(int $userId, string $passId): void {
    for ($i = CONSOLIDATION_FEEDS_KEPT; $i > 0; $i--) {
        $from = consolidation_feed_path($userId, $i - 1);
        if (is_file($from)) @rename($from, consolidation_feed_path($userId, $i));
    }
    $path = consolidation_feed_path($userId);
    @file_put_contents($path, '#pass ' . $passId . "\n", LOCK_EX);
    @chmod($path, 0600);
}

function consolidation_feed_emit(int $userId, array $event): void {
    $event['at'] = time();
    $json = json_encode($event, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
    @file_put_contents(consolidation_feed_path($userId), enc($json) . "\n", FILE_APPEND | LOCK_EX);
}

function consolidation_feed_pass(int $userId, int $back = 0): string {
    $fh = @fopen(consolidation_feed_path($userId, $back), 'r');
    if ($fh === false) return '';
    $head = (string)fgets($fh, 64);
    fclose($fh);
    return preg_match('/^#pass (\S+)/', $head, $m) ? $m[1] : '';
}

// $cursor is the "pass:offset" of the last event the reader got
function consolidation_feed_read(int $userId, string $cursor, int $back = 0): array {
    $path = consolidation_feed_path($userId, $back);
    $pass = consolidation_feed_pass($userId, $back);
    if ($pass === '') return [[], $cursor];
    [$seenPass, $offset] = array_pad(explode(':', $cursor, 2), 2, '0');
    $offset = $seenPass === $pass ? (int)$offset : 0;

    $fh = @fopen($path, 'r');
    if ($fh === false) return [[], $cursor];
    $header = strlen((string)fgets($fh));
    if ($offset < $header) $offset = $header;
    fseek($fh, $offset);
    $events = [];
    while (($line = fgets($fh)) !== false) {
        // a line still being written has no newline yet, leave it for the next read
        if (!str_ends_with($line, "\n")) break;
        $offset += strlen($line);
        try {
            $event = json_decode((string)dec(rtrim($line, "\n")), true);
        } catch (Throwable $e) {
            continue;
        }
        if (!is_array($event)) continue;
        // NOT 'id'. a note event's id is the note's, the game files cards by it
        $event['cursor'] = $pass . ':' . $offset;
        $events[] = $event;
    }
    fclose($fh);
    return [$events, $pass . ':' . $offset];
}
