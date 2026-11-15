<?php

// one sealed line per uploaded part, so php never holds a whole zip.
// memory_limit is 128M and a 32 MB zip sealed in one piece wants ~3x that
const MOD_GUID = '/^[a-zA-Z0-9._-]{1,128}$/';
const MOD_PART_BYTES = 4 * 1024 * 1024;
const MOD_MAX_PARTS = 8;
// sealed bytes on disk, base64 makes that ~256 MB of zips
const MODS_USER_MAX_BYTES = 352 * 1024 * 1024;
const MODS_STATE_MAX_BYTES = 64 * 1024;
const MODS_PART_STALE_SECONDS = 3600;

function mods_dir(int $userId): string {
    $dir = state_dir() . '/mods/user-' . $userId;
    if (!is_dir($dir)) @mkdir($dir, 0700, true);
    if (!is_dir($dir) || !is_writable($dir)) throw new RuntimeException('mods_dir_unwritable');
    return $dir;
}

// new folder, new epoch. a browser that synced under another one (other
// account, factory reset) drops its copies instead of uploading them back
function mods_epoch(int $userId): string {
    $path = mods_dir($userId) . '/epoch';
    if (!is_file($path)) file_put_contents($path, bin2hex(random_bytes(8)), LOCK_EX);
    return trim((string)file_get_contents($path));
}

function mods_path(int $userId, string $guid, string $ext = 'sealed'): string {
    return mods_dir($userId) . '/mod-' . $guid . '.' . $ext;
}

function mods_list(int $userId): array {
    $out = [];
    foreach (glob(mods_dir($userId) . '/mod-*.sealed') ?: [] as $path) {
        $out[] = ['guid' => substr(basename($path, '.sealed'), 4), 'updated' => (int)filemtime($path)];
    }
    return $out;
}

// half uploads count too, and any left an hour go
function mods_disk_bytes(int $userId, string $except): int {
    $total = 0;
    foreach (glob(mods_dir($userId) . '/mod-*') ?: [] as $path) {
        if (str_contains($path, '.part') && filemtime($path) < time() - MODS_PART_STALE_SECONDS) {
            @unlink($path);
            continue;
        }
        if (!str_starts_with(basename($path), "mod-$except.")) $total += (int)filesize($path);
    }
    return $total;
}

function mods_line_count(string $path): int {
    $n = 0;
    $h = fopen($path, 'rb');
    while (fgets($h) !== false) $n++;
    fclose($h);
    return $n;
}

// the part count is in the .part name so the size reserved at part 0
// holds. the last part swaps the file in, never a half upload
function mods_put_part(int $userId, string $guid, int $part, int $parts, string $chunk): ?string {
    $tmp = mods_path($userId, $guid, 'part' . $parts);
    if ($chunk === '') return 'empty_part';
    if ($part === 0) {
        if (!str_starts_with($chunk, "PK\x03\x04")) return 'not_a_zip';
        $sealedMax = (int)ceil($parts * MOD_PART_BYTES * 4 / 3) + $parts * 128;
        if (mods_disk_bytes($userId, $guid) + $sealedMax > MODS_USER_MAX_BYTES) return 'mods_full';
        foreach (glob(mods_dir($userId) . "/mod-$guid.part*") ?: [] as $old) @unlink($old);
        file_put_contents($tmp, '');
    } elseif (!is_file($tmp) || mods_line_count($tmp) !== $part) {
        return 'part_out_of_order';
    }
    file_put_contents($tmp, enc($chunk) . "\n", FILE_APPEND | LOCK_EX);
    if ($part === $parts - 1 && !rename($tmp, mods_path($userId, $guid))) return 'mods_write_failed';
    return null;
}

function mods_stream(int $userId, string $guid): bool {
    $path = mods_path($userId, $guid);
    if (!is_file($path)) return false;
    $h = fopen($path, 'rb');
    while (($line = fgets($h)) !== false) {
        $line = rtrim($line, "\n");
        if ($line !== '') echo dec($line);
    }
    fclose($h);
    return true;
}

function mods_delete(int $userId, string $guid): void {
    foreach (glob(mods_dir($userId) . "/mod-$guid.*") ?: [] as $path) @unlink($path);
}

function mods_state_get(int $userId): ?array {
    $path = mods_dir($userId) . '/state.sealed';
    if (!is_file($path)) return null;
    $state = json_decode((string)dec((string)file_get_contents($path)), true);
    return is_array($state) ? $state : null;
}

// +1 per save. the browser keeps the version its copy came from, so it
// can tell a newer server copy from its own unsent change
function mods_state_put(int $userId, array $state): int {
    $path = mods_dir($userId) . '/state.sealed';
    $state['version'] = (int)(mods_state_get($userId)['version'] ?? 0) + 1;
    file_put_contents($path . '.tmp', enc(json_encode($state, JSON_UNESCAPED_SLASHES)), LOCK_EX);
    rename($path . '.tmp', $path);
    return $state['version'];
}

function mods_wipe_user(int $userId): bool {
    $dir = state_dir() . '/mods/user-' . $userId;
    if (!is_dir($dir)) return true;
    foreach (glob($dir . '/*') ?: [] as $path) if (!@unlink($path)) return false;
    return @rmdir($dir);
}
