<?php

// patches the digits of ONE _sympathy in place. no json_encode round trip,
// php turns 75.0 into 75 and {} into []. any doubt = no write

const BRIDGE_BACKUPS_KEPT = 10;

function bridge_backup_dir(): string {
    return state_dir() . '/bridge-backups';
}

function bridge_backup(string $path, string $raw): bool {
    $dir = bridge_backup_dir();
    if (!is_dir($dir) && !@mkdir($dir, 0700, true)) return false;
    $name = $dir . '/' . date('Ymd-His') . '-' . basename($path);
    if (@file_put_contents($name, $raw) !== strlen($raw)) return false;
    $all = glob($dir . '/*') ?: [];
    sort($all);
    foreach (array_slice($all, 0, max(0, count($all) - BRIDGE_BACKUPS_KEPT)) as $old) @unlink($old);
    return true;
}

// a slot file has the key once and plain. in an export it sits
// json-escaped inside savedata, once per entry
function bridge_patch_sympathy(string $raw, string $shape, int $index, int $sympathy): ?string {
    $save = bridge_read_save($raw);
    if ($save === null || $save['shape'] !== $shape) return null;
    if ($shape === 'vars') {
        $hits = preg_match_all('/"_sympathy":(-?\d+)/', $raw, $m, PREG_OFFSET_CAPTURE);
        if ($hits !== 1) return null;
        $index = 0;
    } else {
        $hits = preg_match_all('/\\\\"_sympathy\\\\":(-?\d+)/', $raw, $m, PREG_OFFSET_CAPTURE);
        if ($hits !== count($save['entries']) || !isset($m[1][$index])) return null;
    }
    [$old, $at] = $m[1][$index];
    return substr($raw, 0, $at) . $sympathy . substr($raw, $at + strlen($old));
}

function bridge_patch_verified(string $before, string $after, string $shape, int $index, int $sympathy): bool {
    $a = bridge_read_save($before);
    $b = bridge_read_save($after);
    if ($a === null || $b === null || $a['shape'] !== $shape || $b['shape'] !== $shape) return false;
    if ($shape === 'vars') {
        if (($b['vars']['_sympathy'] ?? null) !== $sympathy) return false;
        $a['vars']['_sympathy'] = $sympathy;
        return $a['vars'] === $b['vars'];
    }
    if (count($a['entries']) !== count($b['entries'])) return false;
    foreach ($a['entries'] as $i => $entry) {
        $va = bridge_vars($entry);
        $vb = bridge_vars($b['entries'][$i]);
        if ($va === null || $vb === null) return false;
        if ($i === $index) {
            if (($vb['_sympathy'] ?? null) !== $sympathy) return false;
            $va['_sympathy'] = $sympathy;
        }
        unset($entry['savedata'], $b['entries'][$i]['savedata']);
        if ($va !== $vb || $entry !== $b['entries'][$i]) return false;
    }
    return true;
}

function bridge_write_sympathy(string $path, string $shape, int $index, int $sympathy): array {
    $raw = @file_get_contents($path);
    if ($raw === false) return ['error' => 'read_failed'];
    if (!is_writable($path) || !is_writable(dirname($path))) return ['error' => 'save_not_writable'];
    $mtime = filemtime($path);
    $patched = bridge_patch_sympathy($raw, $shape, $index, $sympathy);
    if ($patched === null) return ['error' => 'unknown_shape'];
    if ($patched === $raw) return ['ok' => true];
    if (!bridge_patch_verified($raw, $patched, $shape, $index, $sympathy)) return ['error' => 'verify_failed'];
    if (!bridge_backup($path, $raw)) return ['error' => 'backup_failed'];

    $tmp = $path . '.junos-tmp';
    if (@file_put_contents($tmp, $patched) !== strlen($patched)
        || !bridge_patch_verified($raw, (string)@file_get_contents($tmp), $shape, $index, $sympathy)) {
        @unlink($tmp);
        return ['error' => 'temp_write_failed'];
    }
    clearstatcache(true, $path);
    // the game saved while we were busy. its file wins, next boot retries
    if (filemtime($path) !== $mtime) {
        @unlink($tmp);
        return ['error' => 'changed_underneath'];
    }
    if (!@rename($tmp, $path)) {
        @unlink($tmp);
        return ['error' => 'rename_failed'];
    }
    return ['ok' => true];
}
