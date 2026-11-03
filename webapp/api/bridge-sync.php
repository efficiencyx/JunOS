<?php

// one shot per boot, start.sh / start.ps1 run it. same 404 guard as
// the worker, this lives under the web root.
if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }

require_once __DIR__ . '/lib/bootstrap.php';
require_once __DIR__ . '/lib/bridge/apply.php';
require_once __DIR__ . '/lib/bridge/write.php';

$opts = getopt('', ['dry-run', 'write', 'dir:', 'file:']);
$dry = isset($opts['dry-run']);
$out = fn(string $line) => fwrite(STDOUT, "bridge: $line\n");

if (!$dry && !bridge_enabled()) exit(0);

$dir = (string)($opts['file'] ?? $opts['dir'] ?? env_str('GAME_SAVE_DIR'));
if ($dir === '') { $out('no GAME_SAVE_DIR, skipped'); exit(0); }
$found = bridge_newest_save($dir);
$snap = $found && $found['vars'] ? bridge_snapshot($found['vars']) : null;
if ($snap === null) { $out('no readable save found'); exit(0); }
$out(sprintf('%s slot %s, sympathy %d, %d flags', basename($found['path']), $found['entry']['slot'], $snap['sympathy'], count($snap['flags'])));

$userId = bridge_boot_user();
if ($userId === null && !$dry) { $out('nobody paired yet, skipped'); exit(0); }

$report = bridge_sync($userId ?? 0, $snap, $dry || $userId === null);
$out(sprintf('affection %d -> %d%s, %d new events, outfit %s',
    $report['affection_before'], $report['affection'], $report['first'] ? ' (first bridge)' : '',
    count($report['events']), $report['outfit_from_game'] ? 'from the game' : 'kept'));
if ($dry) {
    foreach ($report['events'] as $e) $out(($e['note'] ? 'note    ' : 'journal ') . $e['text']);
    $unmapped = bridge_unmapped_flags($snap);
    if ($unmapped) $out('unmapped flags: ' . implode(', ', $unmapped));
    exit(0);
}
if (empty($report['queued'])) $out('events held back until the next sign-in');

if ($report['sympathy'] === $snap['sympathy']) exit(0);
// start scripts pass --write only when GAME_SAVE_WRITE=on and the game isn't running
if (!isset($opts['write'])) { $out("game should be at sympathy {$report['sympathy']}, save left alone"); exit(0); }
$res = bridge_write_sympathy($found['path'], $found['shape'], $found['index'], $report['sympathy']);
if (!empty($res['ok'])) {
    bridge_sync_settle($userId, $report['sympathy']);
    $out("save sympathy set to {$report['sympathy']}");
} else {
    $out('save NOT written: ' . $res['error']);
}
