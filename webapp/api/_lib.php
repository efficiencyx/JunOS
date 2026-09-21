<?php

require_once __DIR__ . '/providers.php';

function request_id(): string {
    static $id = null;
    if ($id === null) $id = bin2hex(random_bytes(6));
    return $id;
}

function client_ip(): string {
    // behind our one nginx, X-Forwarded-For is literally whatever the
    // caller typed. only trust it when the operator asks for it with
    // TRUST_PROXY=1, and then take the LAST entry, the one the proxy
    // itself appended. the first is whatever the client put there.
    if (env_str('TRUST_PROXY') === '1') {
        $xff = $_SERVER['HTTP_X_FORWARDED_FOR'] ?? '';
        if ($xff !== '') {
            $hops = explode(',', $xff);
            $last = preg_replace('/[^0-9a-fA-F.:]/', '', trim(end($hops)));
            if ($last !== '') return $last;
        }
    }
    return $_SERVER['REMOTE_ADDR'] ?? 'unknown';
}

function env_str(string $key, string $default = ''): string {
    $v = getenv($key);
    return ($v !== false && $v !== '') ? $v : $default;
}

// the tts and karaoke sidecars take a shared secret in a header
// and 403 anything without it (tts/server.py). start.sh and
// start.ps1 mint one into .env, colab passes a fresh one per run.
// empty means the sidecar was started without one, it then
// falls back to its Host allowlist and says so in its log.
function sidecar_headers(array $headers = []): array {
    $secret = env_str('SIDECAR_SECRET');
    if ($secret !== '') $headers[] = 'X-Sidecar-Secret: ' . $secret;
    return $headers;
}

// separation gets its own sidecar so it can hold a GPU torch
// while the voice one stays on the CPU. a bare metal install runs
// both roles in one process, so fall back to the voice sidecar's
// URL, and to KOKORO_URL, its old name.
function karaoke_url(): string {
    return rtrim(env_str('KARAOKE_URL', env_str('TTS_URL', env_str('KOKORO_URL', 'http://localhost:8001'))), '/');
}

// the sidecar's own /health json, or null when it's down. `sep`
// in there is the only flag that means karaoke actually works,
// the voice sidecar answers /health too and says sep=false.
function karaoke_health(): ?array {
    $ch = curl_init(karaoke_url() . '/health');
    curl_setopt($ch, CURLOPT_HTTPHEADER, sidecar_headers());
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_CONNECTTIMEOUT, 5);
    curl_setopt($ch, CURLOPT_TIMEOUT, 10);
    $res = curl_exec($ch);
    $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    if ($res === false || $code >= 500) return null;
    $data = json_decode((string)$res, true);
    return is_array($data) ? $data : null;
}

// somewhere we can actually write, for the SQLite DB and the rate
// limit files. docker keeps the default. a bare metal install on
// Windows points OMEGA_STATE_DIR at the install folder so the
// whole thing still uninstalls in one go.
function state_dir(): string {
    return rtrim(env_str('OMEGA_STATE_DIR', '/var/lib/omega'), '/\\');
}

function log_event(array $ctx): void {
    $ctx = array_merge([
        'ts' => date('c'),
        'request_id' => request_id(),
        'client' => client_ip(),
    ], $ctx);
    error_log(json_encode($ctx, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));
}

// send a JSON error and stop. $key is a fixed string for
// machines, Never our internals.
function fail(int $code, string $key, array $extra = []): never {
    http_response_code($code);
    header('Content-Type: application/json');
    echo json_encode(array_merge(['error' => $key, 'request_id' => request_id()], $extra), JSON_UNESCAPED_UNICODE);
    exit;
}

function require_post(): void {
    if ($_SERVER['REQUEST_METHOD'] !== 'POST') fail(405, 'method_not_allowed');
}

function url_origin(string $url): string {
    $parts = parse_url($url);
    if (!$parts || empty($parts['scheme']) || empty($parts['host'])) return '';
    $origin = strtolower($parts['scheme'] . '://' . $parts['host']);
    return empty($parts['port']) ? $origin : $origin . ':' . $parts['port'];
}

function request_host(): string {
    $raw = trim($_SERVER['HTTP_HOST'] ?? '');
    if ($raw === '' || preg_match('/[\x00-\x20\/\\\\]/', $raw)) return '';
    $parts = parse_url('http://' . $raw);
    if (!$parts || empty($parts['host']) || isset($parts['user']) || isset($parts['pass'])
        || isset($parts['path']) || isset($parts['query']) || isset($parts['fragment'])) {
        return '';
    }
    return strtolower(trim($parts['host'], '[]'));
}

function allowed_request_hosts(): array {
    $configured = env_str('OMEGA_ALLOWED_HOSTS', 'localhost,127.0.0.1,::1');
    $hosts = [];
    // commas OR spaces. the same list goes into nginx's server_name,
    // which only takes spaces, so both have to parse whatever you
    // typed.
    foreach (preg_split('/[\s,]+/', $configured) as $host) {
        $host = strtolower(trim($host, " \t\n\r\0\x0B[]"));
        if ($host !== '') $hosts[] = $host;
    }
    return array_values(array_unique($hosts));
}

function require_allowed_host(): void {
    $host = request_host();
    if ($host === '' || !in_array($host, allowed_request_hosts(), true)) {
        log_event(['msg' => 'invalid_host', 'host' => $host]);
        fail(421, 'invalid_host');
    }
}

// Host has already passed the explicit allowlist before this
// runs. Extra origins cover a TLS-terminating reverse proxy whose
// public origin differs.
function allowed_origins(): array {
    $out = [];
    $host = strtolower($_SERVER['HTTP_HOST'] ?? '');
    if ($host !== '') {
        $https = !empty($_SERVER['HTTPS']) || (($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https');
        $out[] = ($https ? 'https://' : 'http://') . $host;
        // a proxy that terminates TLS and forwards plain http without
        // telling us leaves the browser saying https while we'd have
        // guessed http
        $out[] = 'https://' . $host;
    }
    foreach (explode(',', env_str('OMEGA_ALLOWED_ORIGINS')) as $extra) {
        $extra = strtolower(trim($extra, " \t\n\r\0\x0B/"));
        if ($extra !== '') $out[] = $extra;
    }
    return $out;
}

// SameSite=Strict and JSON block cross-site forms, but localhost
// ports share a site. a page on another 127.0.0.1 port can send
// our cookie. check request origin as well.
function require_same_origin(): void {
    $method = strtoupper($_SERVER['REQUEST_METHOD'] ?? 'GET');
    if ($method === 'GET' || $method === 'HEAD' || $method === 'OPTIONS') return;

    // Sec-Fetch-Site is the browser's own verdict, decided before any
    // proxy touched a header, so it goes first. same-site is NOT good
    // enough here, that is EXACTLY the neighbour on the other port.
    $site = $_SERVER['HTTP_SEC_FETCH_SITE'] ?? '';
    if ($site !== '') {
        if ($site === 'same-origin') return;
        log_event(['msg' => 'cross_origin_blocked', 'sec_fetch_site' => $site]);
        fail(403, 'cross_origin_blocked');
    }

    $origin = strtolower(rtrim($_SERVER['HTTP_ORIGIN'] ?? '', '/'));
    if ($origin === '' && isset($_SERVER['HTTP_REFERER'])) {
        $origin = url_origin($_SERVER['HTTP_REFERER']);
    }
    // no Origin, no Referer, no Sec-Fetch-Site, but a session cookie
    // anyway? that's not a browser we know. curl and friends can set
    // Origin themselves.
    if ($origin === '' || !in_array($origin, allowed_origins(), true)) {
        log_event(['msg' => 'cross_origin_blocked', 'origin' => $origin]);
        fail(403, 'cross_origin_blocked');
    }
}

function require_content_type(string $expected): void {
    $ct = $_SERVER['CONTENT_TYPE'] ?? $_SERVER['HTTP_CONTENT_TYPE'] ?? '';
    $ct = trim(explode(';', $ct)[0]);
    if (strcasecmp($ct, $expected) !== 0) fail(415, 'unsupported_media_type');
}

function read_body(int $maxBytes): string {
    $cl = isset($_SERVER['CONTENT_LENGTH']) ? (int)$_SERVER['CONTENT_LENGTH'] : -1;
    if ($cl > $maxBytes) fail(413, 'request_too_large');

    $handle = fopen('php://input', 'r');
    $body = stream_get_contents($handle, $maxBytes + 1);
    fclose($handle);

    if (strlen($body) > $maxBytes) fail(413, 'request_too_large');
    return $body;
}

// token bucket per IP in a flat file. this used to let the
// request through when it couldn't get a writable dir, which
// made "state dir is read only" mean "login has no brute force
// lockout". now it's a 503, same as db() below, and the state
// dir gets fixed.
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

function db(): PDO {
    static $pdo = null;
    if ($pdo !== null) return $pdo;

    $base = state_dir();
    if (!is_dir($base)) @mkdir($base, 0700, true);
    if (is_dir($base)) @chmod($base, 0700);
    // no /tmp fallback. a db that lands there looks like it works
    // and then every account is gone on the next restart.
    if (!is_writable($base)) {
        log_event(['msg' => 'state_dir_unwritable', 'dir' => $base]);
        fail(503, 'state_unavailable');
    }
    $path = $base . '/omega.sqlite';
    $pdo = new PDO('sqlite:' . $path, null, null, [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
    ]);
    @chmod($path, 0600);
    // busy_timeout is NOT optional here. the consolidation worker
    // writes the same file as php-fpm, and the default of 0 turns any
    // overlap into an instant "database is locked" instead of a short
    // wait.
    $pdo->exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    foreach ([$path . '-wal', $path . '-shm'] as $sidecar) {
        if (file_exists($sidecar)) @chmod($sidecar, 0600);
    }

    // run any migrations/NNN_*.sql newer than the schema version
    // we're on. a fresh DB reads 0 (there's no schema_version table
    // yet) so it gets every file in order. each migration does its
    // own INSERT INTO schema_version.
    $current = 0;
    try {
        $v = $pdo->query('SELECT MAX(v) FROM schema_version')->fetchColumn();
        if ($v !== false && $v !== null) $current = (int)$v;
    } catch (PDOException $e) {
    }
    $files = glob(__DIR__ . '/migrations/*.sql');
    sort($files);
    foreach ($files as $file) {
        if (!preg_match('/(\d+)_[^\/]*\.sql$/', basename($file), $m)) continue;
        if ((int)$m[1] <= $current) continue;
        $pdo->exec(file_get_contents($file));
    }

    return $pdo;
}

function no_users_yet(): bool {
    return db()->query('SELECT id FROM users LIMIT 1')->fetchColumn() === false;
}

function current_user(): ?array {
    // false until we've looked. null once we know there's no session.
    static $user = false;
    if ($user !== false) return $user;

    $token = $_COOKIE['omega_session'] ?? '';
    if ($token === '') return $user = null;

    // store sha256(cookie) so a stolen omega.sqlite cannot
    // authenticate. NEVER also accept raw stored tokens: both are 64
    // hex chars, making that fallback accept the hash as a cookie.
    // migration 014 deletes old sessions and requires one sign-in.
    $stmt = db()->prepare(
        'SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token = ? AND s.expires_at > ? LIMIT 1'
    );
    $stmt->execute([session_token_hash($token), time()]);
    $user = $stmt->fetch() ?: null;
    // a session without its omega_key cookie can't read a single
    // row, so it counts as signed out. re-login mints the cookie.
    if ($user !== null && crypt_key() === null) $user = null;
    return $user;
}

function memory_dir(): string {
    // sits under state_dir() by default so memories land in the
    // omega_state volume that actually survives. builds before
    // 2026-07 wrote to /var/lib/jun/memory, which docker never
    // mounted, so they died with the container. RIP. set MEMORY_DIR
    // if you want it somewhere else.
    $dir = rtrim(env_str('MEMORY_DIR', state_dir() . '/memory'), '/');
    if (!is_dir($dir)) @mkdir($dir, 0700, true);
    if (!is_dir($dir) || !is_writable($dir)) {
        throw new RuntimeException('memory_dir_unwritable');
    }
    return $dir;
}

function memory_file_path(int $userId): string {
    return memory_dir() . '/user-' . $userId . '.jsonl';
}

// a note saying "tomorrow" means nothing without the day it was
// written, but stamping EVERY note costs us a whole category off
// the end of the context budget. so only the notes whose wording
// leans on their own date get one.
const MEMORY_RELATIVE_TIME_RE = '/\b(today|tonight|tomorrow|yesterday|this (?:morning|afternoon|evening|week|month|weekend)|last (?:night|week|month|weekend)|next (?:week|month|weekend|monday|tuesday|wednesday|thursday|friday|saturday|sunday)|in (?:a few|a couple of|\d{1,2}) (?:days?|weeks?|months?)|days? from now|weeks? from now)\b/i';

// phrases we can pin to one exact day, given the day the note was
// written. everything else in the regex above ("next week", "in a
// few days") stays fuzzy and only gets the anchor stamp.
const MEMORY_RELATIVE_TIME_OFFSETS = [
    'today' => 0, 'tonight' => 0, 'this morning' => 0, 'this afternoon' => 0,
    'this evening' => 0, 'tomorrow' => 1, 'yesterday' => -1, 'last night' => -1,
];

function memory_note_stamp(array $note): string {
    if (!preg_match(MEMORY_RELATIVE_TIME_RE, (string)$note['text'])) return '';
    $created = (int)($note['created'] ?? 0);
    if ($created <= 0) return '';
    return '(noted ' . date('l j F Y', $created) . ', ' . memory_days_phrase($created) . ') ';
}

function memory_days_phrase(int $when): string {
    $days = (int)floor((strtotime('today', $when) - strtotime('today')) / 86400);
    if ($days === 0) return 'that is today';
    if ($days === 1) return 'that is tomorrow';
    if ($days === -1) return 'that was yesterday, already past';
    if ($days > 1) return 'that is in ' . $days . ' days';
    return 'that was ' . abs($days) . ' days ago, already past';
}

// Jun absolutely will NOT do the date arithmetic herself. give
// her "(noted Monday 10 August)" next to "tomorrow" and she repeats
// "tomorrow", four days late. so we do the sum and paste the real
// day right after the phrase, leaving her nothing to work out.
function memory_note_render(array $note): string {
    $text = (string)$note['text'];
    $created = (int)($note['created'] ?? 0);
    if ($created <= 0) return $text;

    return preg_replace_callback(MEMORY_RELATIVE_TIME_RE, function (array $m) use ($created): string {
        $phrase = strtolower($m[0]);
        $day = null;
        if (isset(MEMORY_RELATIVE_TIME_OFFSETS[$phrase])) {
            $day = strtotime(MEMORY_RELATIVE_TIME_OFFSETS[$phrase] . ' days', $created);
        } elseif (preg_match('/^next (monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/', $phrase, $d)) {
            $day = strtotime('next ' . $d[1], $created);
        } elseif (preg_match('/^(?:in (\d{1,2})|(\d{1,2})) (day|week|month)s? ?(?:from now)?$/', $phrase, $d)) {
            $day = strtotime('+' . ($d[1] !== '' ? $d[1] : $d[2]) . ' ' . $d[3] . 's', $created);
        }
        if (!$day) return $m[0];
        return $m[0] . ' (= ' . date('l j F Y', $day) . ', ' . memory_days_phrase($day) . ')';
    }, $text) ?? $text;
}

function memory_normalize_entry(string $memory, string $category): array {
    $memory = trim(preg_replace('/\s+/', ' ', $memory));
    $category = memory_category_note_slug($category);
    if ($memory === '') return ['error' => 'memory_required'];
    if (mb_strlen($memory) > 800) $memory = mb_substr($memory, 0, 797) . '…';
    return ['created_at' => time(), 'category' => $category, 'memory' => $memory];
}

function memory_user_dir(int $userId): string {
    $dir = memory_dir() . '/user-' . $userId;
    if (!is_dir($dir)) @mkdir($dir, 0700, true);
    if (!is_dir($dir) || !is_writable($dir)) {
        throw new RuntimeException('memory_user_dir_unwritable');
    }
    return $dir;
}

function memory_with_user_lock(int $userId, callable $operation): array {
    $path = memory_dir() . '/.user-' . $userId . '.write.lock';
    $fp = fopen($path, 'c+b');
    if ($fp === false) return ['error' => 'memory_lock_failed'];
    @chmod($path, 0600);
    if (!flock($fp, LOCK_EX)) {
        fclose($fp);
        return ['error' => 'memory_lock_failed'];
    }
    try {
        $result = $operation();
        return is_array($result) ? $result : ['ok' => true];
    } finally {
        flock($fp, LOCK_UN);
        fclose($fp);
    }
}

function memory_category_slug(string $category): string {
    $category = strtolower(trim(preg_replace('/[^a-z0-9]+/i', '_', $category), '_'));
    if ($category === '') $category = 'general';
    if (mb_strlen($category) > 40) $category = mb_substr($category, 0, 40);
    return $category;
}

function memory_category_note_slug(string $category): string {
    $slug = memory_category_slug($category);
    return $slug === 'journal' ? 'journal_notes' : $slug;
}

function memory_atomic_write(string $path, string $text, string $prefix = '.memory-'): array {
    try {
        $text = enc($text);
        if (is_file($path) && !copy($path, $path . '.bak')) {
            return ['error' => 'memory_backup_failed'];
        }
        $tmp = tempnam(dirname($path), $prefix);
        if ($tmp === false) return ['error' => 'memory_temp_failed'];
        $fp = fopen($tmp, 'wb');
        if ($fp === false) {
            @unlink($tmp);
            return ['error' => 'memory_open_failed'];
        }
        $written = fwrite($fp, $text);
        if ($written === false || $written !== strlen($text)) {
            fclose($fp);
            @unlink($tmp);
            return ['error' => 'memory_write_failed'];
        }
        if (!fclose($fp) || !rename($tmp, $path)) {
            @unlink($tmp);
            return ['error' => 'memory_replace_failed'];
        }
        @chmod($path, 0600);
        return ['ok' => true];
    } catch (Throwable $e) {
        log_event(['msg' => 'memory_atomic_write_error', 'path' => basename($path), 'err' => $e->getMessage()]);
        return ['error' => 'memory_replace_failed'];
    }
}

function memory_meta_load(int $userId): array {
    $path = memory_user_dir($userId) . '/meta.json';
    $raw = is_readable($path) ? @file_get_contents($path) : false;
    $data = $raw === false ? null : json_decode((string)dec($raw), true);
    return is_array($data) && is_array($data['notes'] ?? null) ? $data : ['notes' => []];
}

function memory_meta_write(int $userId, array $meta): array {
    $meta['notes'] = is_array($meta['notes'] ?? null) ? $meta['notes'] : [];
    $encoded = $meta;
    if (!$encoded['notes']) $encoded['notes'] = (object)[];
    $json = json_encode($encoded, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT);
    if ($json === false) return ['error' => 'memory_encode_failed'];
    return memory_atomic_write(memory_user_dir($userId) . '/meta.json', $json . "\n", '.meta-');
}

function memory_mint_id(array $used): string {
    do {
        $id = str_pad(base_convert((string)random_int(0, 60466175), 10, 36), 5, '0', STR_PAD_LEFT);
    } while (isset($used[$id]));
    return $id;
}

function memory_note_links(string $text): array {
    if (!preg_match_all('/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/u', $text, $matches)) return [];
    $links = [];
    foreach ($matches[1] as $category) $links[] = memory_category_slug($category);
    return array_values(array_unique($links));
}

function memory_migrate_legacy(int $userId): void {
    $root = memory_dir();
    $legacy = $root . '/user-' . $userId . '.jsonl';
    $legacyJournal = $root . '/user-' . $userId . '.journal.md';
    if (is_dir($root . '/user-' . $userId) || (!is_file($legacy) && !is_file($legacyJournal))) return;
    $path = $root . '/.user-' . $userId . '.migration.lock';
    $fp = fopen($path, 'c+b');
    if ($fp === false) throw new RuntimeException('memory_migration_lock_failed');
    @chmod($path, 0600);
    if (!flock($fp, LOCK_EX)) {
        fclose($fp);
        throw new RuntimeException('memory_migration_lock_failed');
    }
    try {
        memory_migrate_legacy_unlocked($userId);
    } finally {
        flock($fp, LOCK_UN);
        fclose($fp);
    }
}

function memory_migrate_legacy_unlocked(int $userId): void {
    $root = memory_dir();
    $legacy = memory_file_path($userId);
    $legacyJournal = $root . '/user-' . $userId . '.journal.md';
    $target = $root . '/user-' . $userId;
    if ((!is_file($legacy) && !is_file($legacyJournal)) || is_dir($target)) return;

    $groups = [];
    $meta = ['notes' => []];
    $used = [];
    $lines = is_file($legacy) ? (file($legacy, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) ?: []) : [];
    foreach ($lines as $line) {
        $obj = json_decode($line, true);
        if (!is_array($obj)) continue;
        $entry = memory_normalize_entry((string)($obj['memory'] ?? ''), (string)($obj['category'] ?? 'general'));
        if (isset($entry['error'])) continue;
        $id = memory_mint_id($used);
        $used[$id] = true;
        $created = max(0, (int)($obj['created_at'] ?? time()));
        $groups[$entry['category']][] = ['id' => $id, 'text' => $entry['memory']];
        $meta['notes'][$id] = ['created' => $created, 'updated' => $created];
    }

    $tmpDir = $root . '/.user-' . $userId . '-migration-' . bin2hex(random_bytes(4));
    if (!mkdir($tmpDir, 0700)) throw new RuntimeException('memory_migration_dir_failed');
    try {
        foreach ($groups as $category => $notes) {
            $bullets = array_map(fn($note) => '- ' . $note['text'] . ' ^' . $note['id'], $notes);
            $text = '# ' . $category . "\n\n" . implode("\n", $bullets) . "\n";
            if (@file_put_contents($tmpDir . '/' . $category . '.md', $text, LOCK_EX) === false) {
                throw new RuntimeException('memory_migration_write_failed');
            }
            @chmod($tmpDir . '/' . $category . '.md', 0600);
        }
        $encodedMeta = $meta;
        if (!$encodedMeta['notes']) $encodedMeta['notes'] = (object)[];
        $metaJson = json_encode($encodedMeta, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRETTY_PRINT);
        if ($metaJson === false || @file_put_contents($tmpDir . '/meta.json', $metaJson . "\n", LOCK_EX) === false) {
            throw new RuntimeException('memory_migration_meta_failed');
        }
        @chmod($tmpDir . '/meta.json', 0600);

        if (is_file($legacyJournal) && !copy($legacyJournal, $tmpDir . '/journal.md')) {
            throw new RuntimeException('memory_migration_journal_failed');
        }
        if (is_file($tmpDir . '/journal.md')) @chmod($tmpDir . '/journal.md', 0600);
        if (!rename($tmpDir, $target)) throw new RuntimeException('memory_migration_replace_failed');
        if (is_file($legacy) && !rename($legacy, $legacy . '.migrated')) {
            throw new RuntimeException('memory_migration_archive_failed');
        }
        if (is_file($legacyJournal) && !rename($legacyJournal, $legacyJournal . '.migrated')) {
            throw new RuntimeException('memory_migration_journal_archive_failed');
        }
    } finally {
        if (is_dir($tmpDir)) {
            foreach (glob($tmpDir . '/*') ?: [] as $path) @unlink($path);
            @rmdir($tmpDir);
        }
    }
}

function memory_notes_write_file(int $userId, string $category, array $notes): array {
    $category = memory_category_note_slug($category);
    $path = memory_user_dir($userId) . '/' . $category . '.md';
    if (!$notes) {
        if (!is_file($path)) return ['ok' => true];
        if (!copy($path, $path . '.bak')) return ['error' => 'memory_backup_failed'];
        return @unlink($path) ? ['ok' => true] : ['error' => 'memory_replace_failed'];
    }
    $bullets = [];
    foreach ($notes as $note) {
        $id = strtolower((string)($note['id'] ?? ''));
        if (!preg_match('/^[a-z0-9]{5}$/', $id)) return ['error' => 'memory_id_invalid'];
        $entry = memory_normalize_entry((string)($note['text'] ?? $note['memory'] ?? ''), $category);
        if (isset($entry['error'])) return $entry;
        $bullets[] = '- ' . $entry['memory'] . ' ^' . $id;
    }
    return memory_atomic_write($path, '# ' . $category . "\n\n" . implode("\n", $bullets) . "\n");
}

function memory_notes_load_unlocked(int $userId): array {
    memory_migrate_legacy($userId);
    $dir = memory_user_dir($userId);
    $metaMissing = !is_file($dir . '/meta.json');
    $meta = memory_meta_load($userId);
    $used = [];
    $out = [];
    $metaChanged = false;
    $paths = glob($dir . '/*.md') ?: [];
    sort($paths, SORT_STRING);

    foreach ($paths as $path) {
        if (basename($path) === 'journal.md') continue;
        $slug = memory_category_slug(pathinfo($path, PATHINFO_FILENAME));
        $name = $slug;
        $notes = [];
        $rewrite = false;
        $mtime = (int)(filemtime($path) ?: time());
        foreach (preg_split('/\R/', (string)dec((string)@file_get_contents($path))) as $line) {
            if (preg_match('/^\s*#\s+(.+?)\s*$/u', $line, $heading)) {
                $name = trim($heading[1]);
                continue;
            }
            if (!preg_match('/^-\s+(.*?)(?:\s+\^([a-z0-9]{5}))?$/u', $line, $match)) continue;
            $text = trim($match[1]);
            if ($text === '') continue;
            $id = strtolower((string)($match[2] ?? ''));
            if ($id === '' || isset($used[$id])) {
                $id = memory_mint_id($used);
                $rewrite = true;
                $meta['notes'][$id] = ['created' => $mtime, 'updated' => $mtime];
                $metaChanged = true;
            }
            $used[$id] = true;
            $times = is_array($meta['notes'][$id] ?? null) ? $meta['notes'][$id] : [];
            $notes[] = [
                'id' => $id,
                'text' => $text,
                'links' => memory_note_links($text),
                'created' => (int)($times['created'] ?? $mtime),
                'updated' => (int)($times['updated'] ?? $mtime),
            ];
        }
        if ($rewrite) memory_notes_write_file($userId, $slug, $notes);
        $out[$slug] = ['name' => $name, 'notes' => $notes];
    }
    if ($metaChanged || $metaMissing) memory_meta_write($userId, $meta);
    return $out;
}

function memory_notes_load(int $userId): array {
    $result = memory_with_user_lock($userId, fn() => memory_notes_load_unlocked($userId));
    if (isset($result['error']) && is_string($result['error'])) {
        throw new RuntimeException($result['error']);
    }
    return $result;
}

function memory_journal_path(int $userId): string {
    memory_migrate_legacy($userId);
    $dir = memory_user_dir($userId);
    if (!is_file($dir . '/meta.json')) memory_meta_write($userId, ['notes' => []]);
    return $dir . '/journal.md';
}

function memory_journal_read(int $userId): string {
    try {
        $path = memory_journal_path($userId);
    } catch (Throwable $e) {
        return '';
    }
    if (!is_readable($path)) return '';
    return (string)dec((string)@file_get_contents($path));
}

function memory_journal_write_unlocked(int $userId, string $text): array {
    return memory_atomic_write(memory_journal_path($userId), $text, '.journal-');
}

function memory_journal_write(int $userId, string $text): array {
    return memory_with_user_lock(
        $userId,
        fn() => memory_journal_write_unlocked($userId, $text)
    );
}

function journal_parse(string $doc): array {
    $entries = [];
    foreach (preg_split('/\R/', $doc) as $line) {
        if (!preg_match('/^\s*[*-]\s+(\d{4}-\d{2}-\d{2})\s*:\s*(.+)$/', $line, $m)) continue;
        $text = trim(preg_replace('/\s+/', ' ', $m[2]));
        if ($text === '') continue;
        $entries[] = ['date' => $m[1], 'text' => $text];
    }
    return $entries;
}

function journal_sort(array $entries): array {
    $keyed = [];
    foreach ($entries as $i => $entry) $keyed[] = [$entry['date'], $i, $entry];
    usort($keyed, fn($a, $b) => ($b[0] <=> $a[0]) ?: ($a[1] <=> $b[1]));
    return array_column($keyed, 2);
}

function journal_render(array $entries): string {
    $today = DateTimeImmutable::createFromFormat('!Y-m-d', date('Y-m-d'));
    $buckets = ['## Lately' => [], '## The past few weeks' => [], '## Further back' => []];
    foreach (journal_sort($entries) as $entry) {
        $when = DateTimeImmutable::createFromFormat('!Y-m-d', $entry['date']);
        $age = $when === false ? 0 : (int)$when->diff($today)->format('%r%a');
        $heading = $age <= 7 ? '## Lately' : ($age <= 60 ? '## The past few weeks' : '## Further back');
        $buckets[$heading][] = '* ' . $entry['date'] . ': ' . $entry['text'];
    }

    $sections = [];
    foreach ($buckets as $heading => $bullets) {
        $sections[] = rtrim($heading . "\n" . implode("\n", $bullets));
    }
    return implode("\n\n", $sections);
}

function memory_journal_upsert_unlocked(int $userId, string $date, string $text): array {
    $when = DateTimeImmutable::createFromFormat('!Y-m-d', $date);
    if ($when === false || $when->format('Y-m-d') !== $date) return ['error' => 'journal_date_invalid'];
    $text = trim(preg_replace('/\s+/', ' ', $text));
    if ($text === '') return ['error' => 'journal_text_required'];
    if (mb_strlen($text) > 1600) $text = mb_substr($text, 0, 1597) . '…';
    $entries = journal_parse(memory_journal_read($userId));
    $next = [];
    $found = false;
    foreach ($entries as $entry) {
        if ($entry['date'] === $date) {
            if (!$found) $next[] = ['date' => $date, 'text' => $text];
            $found = true;
            continue;
        }
        $next[] = $entry;
    }
    if (!$found) $next[] = ['date' => $date, 'text' => $text];
    return memory_journal_write_unlocked($userId, journal_render($next));
}

function memory_journal_delete_unlocked(int $userId, string $date): array {
    $entries = journal_parse(memory_journal_read($userId));
    $filtered = array_values(array_filter($entries, fn($entry) => $entry['date'] !== $date));
    if (count($filtered) === count($entries)) return ['error' => 'journal_not_found'];
    return memory_journal_write_unlocked($userId, journal_render($filtered));
}

function memory_note_add_unlocked(int $userId, string $category, string $text): array {
    $entry = memory_normalize_entry($text, $category);
    if (isset($entry['error'])) return $entry;
    $categories = memory_notes_load_unlocked($userId);
    $used = [];
    foreach ($categories as $data) {
        foreach ($data['notes'] as $note) $used[$note['id']] = true;
    }
    $id = memory_mint_id($used);
    $now = time();
    $notes = $categories[$entry['category']]['notes'] ?? [];
    $notes[] = ['id' => $id, 'text' => $entry['memory']];
    $result = memory_notes_write_file($userId, $entry['category'], $notes);
    if (empty($result['ok'])) return $result;
    $meta = memory_meta_load($userId);
    $meta['notes'][$id] = ['created' => $now, 'updated' => $now];
    $result = memory_meta_write($userId, $meta);
    if (empty($result['ok'])) return $result;
    return ['ok' => true, 'entry' => [
        'id' => $id,
        'created_at' => $now,
        'category' => $entry['category'],
        'memory' => $entry['memory'],
    ]];
}

function memory_note_edit_unlocked(int $userId, string $id, string $text): array {
    $categories = memory_notes_load_unlocked($userId);
    foreach ($categories as $category => $data) {
        foreach ($data['notes'] as $index => $note) {
            if ($note['id'] !== $id) continue;
            $entry = memory_normalize_entry($text, $category);
            if (isset($entry['error'])) return $entry;
            $data['notes'][$index]['text'] = $entry['memory'];
            $result = memory_notes_write_file($userId, $category, $data['notes']);
            if (empty($result['ok'])) return $result;
            $meta = memory_meta_load($userId);
            $meta['notes'][$id] = [
                'created' => (int)($meta['notes'][$id]['created'] ?? $note['created']),
                'updated' => time(),
            ];
            $result = memory_meta_write($userId, $meta);
            return empty($result['ok']) ? $result : ['ok' => true];
        }
    }
    return ['error' => 'memory_not_found'];
}

function memory_note_delete_unlocked(int $userId, string $id): array {
    $categories = memory_notes_load_unlocked($userId);
    foreach ($categories as $category => $data) {
        foreach ($data['notes'] as $index => $note) {
            if ($note['id'] !== $id) continue;
            array_splice($data['notes'], $index, 1);
            $result = memory_notes_write_file($userId, $category, $data['notes']);
            if (empty($result['ok'])) return $result;
            $meta = memory_meta_load($userId);
            unset($meta['notes'][$id]);
            $result = memory_meta_write($userId, $meta);
            return empty($result['ok']) ? $result : ['ok' => true];
        }
    }
    return ['error' => 'memory_not_found'];
}

function memory_note_move_unlocked(int $userId, string $id, string $category): array {
    $target = memory_category_note_slug($category);
    $categories = memory_notes_load_unlocked($userId);
    foreach ($categories as $source => $data) {
        foreach ($data['notes'] as $index => $note) {
            if ($note['id'] !== $id) continue;
            if ($source === $target) return ['ok' => true];
            array_splice($data['notes'], $index, 1);
            $targetNotes = $categories[$target]['notes'] ?? [];
            $originalTargetNotes = $targetNotes;
            $targetNotes[] = $note;
            $result = memory_notes_write_file($userId, $target, $targetNotes);
            if (empty($result['ok'])) return $result;
            $result = memory_notes_write_file($userId, $source, $data['notes']);
            if (empty($result['ok'])) {
                $rollback = memory_notes_write_file($userId, $target, $originalTargetNotes);
                if (empty($rollback['ok'])) {
                    log_event([
                        'msg' => 'memory_move_rollback_failed',
                        'user_id' => $userId,
                        'id' => $id,
                        'source' => $source,
                        'target' => $target,
                    ]);
                }
                return $result;
            }
            $meta = memory_meta_load($userId);
            $meta['notes'][$id] = [
                'created' => (int)($meta['notes'][$id]['created'] ?? $note['created']),
                'updated' => time(),
            ];
            $result = memory_meta_write($userId, $meta);
            return empty($result['ok']) ? $result : ['ok' => true];
        }
    }
    return ['error' => 'memory_not_found'];
}

function memory_journal_upsert(int $userId, string $date, string $text): array {
    return memory_with_user_lock(
        $userId,
        fn() => memory_journal_upsert_unlocked($userId, $date, $text)
    );
}

function memory_journal_delete(int $userId, string $date): array {
    return memory_with_user_lock(
        $userId,
        fn() => memory_journal_delete_unlocked($userId, $date)
    );
}

function memory_note_add(int $userId, string $category, string $text): array {
    return memory_with_user_lock(
        $userId,
        fn() => memory_note_add_unlocked($userId, $category, $text)
    );
}

function memory_note_edit(int $userId, string $id, string $text): array {
    return memory_with_user_lock(
        $userId,
        fn() => memory_note_edit_unlocked($userId, $id, $text)
    );
}

function memory_note_delete(int $userId, string $id): array {
    return memory_with_user_lock(
        $userId,
        fn() => memory_note_delete_unlocked($userId, $id)
    );
}

function memory_note_move(int $userId, string $id, string $category): array {
    return memory_with_user_lock(
        $userId,
        fn() => memory_note_move_unlocked($userId, $id, $category)
    );
}

// migrate FIRST, then delete. an un-migrated account still has
// its notes in the old flat files, and wiping only the directory
// leaves those sitting there to get picked up and restored next
// time anything reads her memory.
function memory_wipe_user(int $userId): array {
    return memory_with_user_lock($userId, function () use ($userId): array {
        memory_migrate_legacy($userId);
        $dir = memory_dir() . '/user-' . $userId;
        if (is_dir($dir)) {
            foreach (new DirectoryIterator($dir) as $item) {
                if ($item->isDot()) continue;
                if ((!$item->isFile() && !$item->isLink()) || !@unlink($item->getPathname())) {
                    return ['error' => 'memory_delete_failed'];
                }
            }
            if (!@rmdir($dir)) return ['error' => 'memory_delete_failed'];
        }
        $legacy = [
            memory_file_path($userId),
            memory_dir() . '/user-' . $userId . '.journal.md',
        ];
        foreach ($legacy as $path) {
            if (is_file($path) && !@unlink($path)) return ['error' => 'memory_delete_failed'];
            if (is_file($path . '.migrated') && !@unlink($path . '.migrated')) {
                return ['error' => 'memory_delete_failed'];
            }
        }
        return ['ok' => true];
    });
}

function memory_list(int $userId): array {
    $out = [];
    foreach (memory_notes_load($userId) as $category => $data) {
        foreach ($data['notes'] as $note) {
            $out[] = [
                'id' => $note['id'],
                'created_at' => $note['created'],
                'updated_at' => $note['updated'],
                'category' => $category,
                'memory' => $note['text'],
                'links' => $note['links'],
            ];
        }
    }
    return $out;
}

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

function require_user(): array {
    $user = current_user();
    if ($user === null) fail(401, 'unauthorized');
    // default for anything behind a session: chats, memory, prefs,
    // her voice. the few endpoints that want caching (models,
    // voices, assets) set their own header after this and win.
    header('Cache-Control: no-store');
    return $user;
}

function require_admin(): array {
    $user = require_user();
    if (($user['role'] ?? '') !== 'admin') fail(403, 'forbidden');
    return $user;
}

function start_session(int $userId, string $dek): string {
    $token = bin2hex(random_bytes(32));
    $now = time();
    $expires = $now + 30 * 86400;
    db()->prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
        ->execute([session_token_hash($token), $userId, $now, $expires]);

    $secure = !empty($_SERVER['HTTPS']) || (($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https');
    // Strict, NOT Lax. nothing links into this app from outside so
    // there's no cross-site navigation that needs the cookie, and Lax
    // would still send it on a top level GET some other page shoved
    // us into.
    $attrs = [
        'expires' => $expires,
        'path' => '/',
        'httponly' => true,
        'samesite' => 'Strict',
        'secure' => $secure,
    ];
    setcookie('omega_session', $token, $attrs);
    setcookie('omega_key', base64_encode($dek), $attrs);
    return $token;
}

function session_token_hash(string $token): string {
    return hash('sha256', $token);
}

// per-user data key. 32 random bytes minted at signup and stored
// ONLY wrapped, once under Argon2id(password, kdf_salt) and once
// under the recovery code. the open key rides in the omega_key
// cookie next to the session and never touches disk, so the
// volume, a backup tarball, or .env on their own read as noise.
// the flip side: lose the password AND the recovery code and the
// chats are gone, there is nothing on the server to reset them
// with. that is the whole point, not a bug.
const CRYPT_PREFIX = 'v1:';

function crypt_kdf(string $password, string $salt): string {
    return sodium_crypto_pwhash(
        SODIUM_CRYPTO_SECRETBOX_KEYBYTES, $password, $salt,
        SODIUM_CRYPTO_PWHASH_OPSLIMIT_INTERACTIVE,
        SODIUM_CRYPTO_PWHASH_MEMLIMIT_INTERACTIVE,
        SODIUM_CRYPTO_PWHASH_ALG_ARGON2ID13
    );
}

// 20 chars from 31 symbols, grouped by 5, ~99 bits of entropy.
// the random code needs one generichash, not the slower Argon2id
// password derivation.
function crypt_recovery_code_new(): string {
    $alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
    $code = '';
    for ($i = 0; $i < 20; $i++) $code .= $alphabet[random_int(0, strlen($alphabet) - 1)];
    return implode('-', str_split($code, 5));
}

function crypt_recovery_key(string $code): string {
    $clean = strtolower(preg_replace('/[^a-z0-9]/i', '', $code));
    return sodium_crypto_generichash($clean, '', SODIUM_CRYPTO_SECRETBOX_KEYBYTES);
}

function crypt_seal(string $plain, string $key): string {
    $nonce = random_bytes(SODIUM_CRYPTO_SECRETBOX_NONCEBYTES);
    return CRYPT_PREFIX . base64_encode($nonce . sodium_crypto_secretbox($plain, $nonce, $key));
}

function crypt_open(string $stored, string $key): ?string {
    if (!str_starts_with($stored, CRYPT_PREFIX)) return null;
    $raw = base64_decode(substr($stored, strlen(CRYPT_PREFIX)), true);
    $n = SODIUM_CRYPTO_SECRETBOX_NONCEBYTES;
    if ($raw === false || strlen($raw) < $n + SODIUM_CRYPTO_SECRETBOX_MACBYTES) return null;
    $plain = sodium_crypto_secretbox_open(substr($raw, $n), substr($raw, 0, $n), $key);
    return $plain === false ? null : $plain;
}

// the key for whoever we're working for right now. php-fpm reads
// it off the cookie, one user per request so a static is fine.
// the consolidation worker has no cookie, it binds the key it got
// pushed (key_push below) before each user's run and unbinds after.
function crypt_bind(?string $dek): void {
    crypt_key($dek, true);
}

function crypt_key(?string $dek = null, bool $bind = false): ?string {
    static $key = null;
    if ($bind) {
        if ($key !== null) sodium_memzero($key);
        $key = $dek;
        return null;
    }
    if ($key === null && isset($_COOKIE['omega_key'])) {
        $raw = base64_decode((string)$_COOKIE['omega_key'], true);
        if ($raw !== false && strlen($raw) === SODIUM_CRYPTO_SECRETBOX_KEYBYTES) $key = $raw;
    }
    return $key;
}

// enc/dec for anything with his words in it: message content,
// titles, summaries, prefs, the welcome queue, every memory file.
// dec passes a value without the v1: prefix straight through, that
// is how rows from before migration 016 keep reading until
// crypt_encrypt_backlog rewrites them, and how the <audio>
// placeholder chat.php stores unencrypted stays matchable by
// conversations.php set_audio_text. a v1: value that won't open
// under the bound key throws instead of coming back as garbage, a
// wrong key must never turn into a blank prompt.
function enc(?string $plain): ?string {
    if ($plain === null) return null;
    $key = crypt_key();
    if ($key === null) throw new RuntimeException('no_data_key');
    return crypt_seal($plain, $key);
}

function dec(?string $stored): ?string {
    if ($stored === null || !str_starts_with($stored, CRYPT_PREFIX)) return $stored;
    $key = crypt_key();
    if ($key === null) throw new RuntimeException('no_data_key');
    $plain = crypt_open($stored, $key);
    if ($plain === null) throw new RuntimeException('data_key_mismatch');
    return $plain;
}

// the consolidation worker is a seperate process with no cookie,
// so every activity touch hands it this user's key over localhost.
// it keeps the key in RAM until the idle run for that user is
// done, then drops it. no worker listening = nothing happens, he
// gets consolidated after the next touch that finds one. any
// local process can connect and push junk, which only makes that
// user's next run fail to open his rows until a real touch
// overwrites it seconds later. nothing can be read back out.
function key_push_port(): int {
    return (int)env_str('OMEGA_KEY_PORT', '9099');
}

function key_push(int $userId): void {
    if (PHP_SAPI === 'cli') return;
    $key = crypt_key();
    if ($key === null) return;
    $sock = @stream_socket_client('tcp://127.0.0.1:' . key_push_port(), $errno, $errstr, 0.2);
    if ($sock === false) return;
    fwrite($sock, json_encode(['user_id' => $userId, 'dek' => base64_encode($key)]) . "\n");
    fclose($sock);
}

// every login retries the backlog pass in case migration 016's
// first sign-in failed after saving the key. values with the v1:
// prefix stay as they are.
function crypt_encrypt_backlog(int $userId): void {
    $db = db();
    $db->beginTransaction();
    try {
        $rows = $db->prepare(
            'SELECT m.id, m.content FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE c.user_id = ?'
        );
        $rows->execute([$userId]);
        $up = $db->prepare('UPDATE messages SET content = ? WHERE id = ?');
        foreach ($rows->fetchAll() as $r) {
            if ($r['content'] === '<audio>' || str_starts_with((string)$r['content'], CRYPT_PREFIX)) continue;
            $up->execute([enc((string)$r['content']), (int)$r['id']]);
        }

        $rows = $db->prepare('SELECT id, title, summary FROM conversations WHERE user_id = ?');
        $rows->execute([$userId]);
        $up = $db->prepare('UPDATE conversations SET title = ?, summary = ? WHERE id = ?');
        foreach ($rows->fetchAll() as $r) {
            $seal = fn(?string $v) => ($v === null || str_starts_with($v, CRYPT_PREFIX)) ? $v : enc($v);
            $up->execute([$seal($r['title']), $seal($r['summary']), (int)$r['id']]);
        }

        foreach (['preferences' => 'data', 'welcome_queue' => 'messages'] as $table => $col) {
            $row = $db->prepare("SELECT $col FROM $table WHERE user_id = ?");
            $row->execute([$userId]);
            $v = $row->fetchColumn();
            if ($v === false || $v === null || str_starts_with((string)$v, CRYPT_PREFIX)) continue;
            $db->prepare("UPDATE $table SET $col = ? WHERE user_id = ?")->execute([enc((string)$v), $userId]);
        }
        $db->commit();
    } catch (Throwable $e) {
        $db->rollBack();
        throw $e;
    }

    $res = memory_with_user_lock($userId, function () use ($userId): void {
        memory_migrate_legacy($userId);
        $root = memory_dir();
        $files = array_merge(glob($root . '/user-' . $userId . '/*') ?: [], glob($root . '/user-' . $userId . '.*') ?: []);
        foreach ($files as $path) {
            if (!is_file($path)) continue;
            $raw = (string)@file_get_contents($path);
            if ($raw === '' || str_starts_with($raw, CRYPT_PREFIX)) continue;
            if (@file_put_contents($path, enc($raw), LOCK_EX) === false) {
                throw new RuntimeException('memory_backlog_write_failed');
            }
        }
    });
    if (isset($res['error'])) throw new RuntimeException((string)$res['error']);
}

// going out is her call. the shop, karaoke and date pages bounce
// to index.html unless a trips row says she agreed (the tool in
// chat.php writes it, index.html clears it when you're home).
// FREE_ROAM=on turns the gate off and gives everyone the Force
// buttons, off means only an admin gets them.
function free_roam_enabled(): bool {
    return strtolower(env_str('FREE_ROAM', 'off')) === 'on';
}

function trip_get(int $userId): ?array {
    $st = db()->prepare('SELECT destination, since, conversation_id FROM trips WHERE user_id=?');
    $st->execute([$userId]);
    $row = $st->fetch();
    $st->closeCursor();
    if (!$row) return null;
    return ['where' => (string)$row['destination'], 'since' => (int)$row['since'], 'conversation_id' => (int)$row['conversation_id']];
}

function trip_set(int $userId, string $where, int $convId): void {
    db()->prepare('INSERT OR REPLACE INTO trips (user_id, destination, since, conversation_id) VALUES (?, ?, ?, ?)')
        ->execute([$userId, $where, time(), $convId]);
}

function trip_clear(int $userId): void {
    db()->prepare('DELETE FROM trips WHERE user_id=?')->execute([$userId]);
}

// the lockout we slap on when Jun walks out of a conversation
// with the flee tool. ONLY chat.php cares about it, history and
// settings still work fine while she's gone.
function flee_bans_enabled(): bool {
    return strtolower(env_str('FLEE_BANS', 'on')) !== 'off';
}

function ban_active(int $userId): ?array {
    if (!flee_bans_enabled()) return null;
    try {
        $st = db()->prepare('SELECT until, reason FROM user_bans WHERE user_id=?');
        $st->execute([$userId]);
        $row = $st->fetch();
        $st->closeCursor();
        if (!$row) return null;
        $until = (int)$row['until'];
        if ($until <= time()) return null;
        return ['until' => $until, 'reason' => (string)($row['reason'] ?? ''), 'seconds_left' => $until - time()];
    } catch (Throwable $e) {
        log_event(['msg' => 'ban_active_error', 'err' => $e->getMessage()]);
        return null;
    }
}

function ban_apply(int $userId, string $reason): array {
    $now = time();
    $strikes = 0;
    try {
        $st = db()->prepare('SELECT strikes, last_ban FROM user_bans WHERE user_id=?');
        $st->execute([$userId]);
        $row = $st->fetch();
        $st->closeCursor();
        // one day without walking out and the escalation resets
        if ($row && $now - (int)$row['last_ban'] < 86400) $strikes = (int)$row['strikes'];
        $strikes++;
        $minutes = (int)min(30, 5 * (2 ** ($strikes - 1)));
        $until = $now + $minutes * 60;
        db()->prepare(
            'INSERT INTO user_bans (user_id, until, strikes, last_ban, reason) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(user_id) DO UPDATE SET until=excluded.until, strikes=excluded.strikes,
                                                last_ban=excluded.last_ban, reason=excluded.reason'
        )->execute([$userId, $until, $strikes, $now, mb_substr(trim($reason), 0, 300)]);
        return ['until' => $until, 'minutes' => $minutes];
    } catch (Throwable $e) {
        log_event(['msg' => 'ban_apply_error', 'err' => $e->getMessage()]);
        return ['until' => $now + 300, 'minutes' => 5];
    }
}

// hidden relationship state per user,
// migrations/002_relationship.sql explains the model. chat.php
// turns these scores into directives for how she behaves, and her
// [A:mood_shift|...] tag is what moves them.
const RELATIONSHIP_DEFAULTS = ['affection' => 60, 'trust' => 50, 'tension' => 20];

function relationship_get(int $userId): array {
    try {
        $st = db()->prepare('SELECT affection, trust, tension FROM relationship WHERE user_id=?');
        $st->execute([$userId]);
        $row = $st->fetch();
        if ($row) {
            return [
                'affection' => (int)$row['affection'],
                'trust' => (int)$row['trust'],
                'tension' => (int)$row['tension'],
            ];
        }
    } catch (Throwable $e) {
        log_event(['msg' => 'relationship_get_error', 'err' => $e->getMessage()]);
    }
    // she starts mildly positive. she's already his girlfriend after
    // all
    return RELATIONSHIP_DEFAULTS;
}

function relationship_set(int $userId, array $values): void {
    $clamp = fn($n) => max(0, min(100, (int)$n));
    try {
        db()->prepare(
            'INSERT INTO relationship (user_id, affection, trust, tension, updated_at) VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(user_id) DO UPDATE SET affection=excluded.affection, trust=excluded.trust, tension=excluded.tension, updated_at=excluded.updated_at'
        )->execute([
            $userId,
            $clamp($values['affection'] ?? RELATIONSHIP_DEFAULTS['affection']),
            $clamp($values['trust'] ?? RELATIONSHIP_DEFAULTS['trust']),
            $clamp($values['tension'] ?? RELATIONSHIP_DEFAULTS['tension']),
            time(),
        ]);
    } catch (Throwable $e) {
        log_event(['msg' => 'relationship_set_error', 'err' => $e->getMessage()]);
    }
}

// stack this turn's deltas onto $cur and save. capped at +/-50 a
// turn. normal turns move 0-5, but the prompt lets Jun swing
// 30-50 on the big ones (sold, cheated on, abandoned) so the cap
// has to leave room for that and still stop the model inventing
// drama.
function relationship_apply(int $userId, array $cur, array $deltas): void {
    $clampDelta = fn($d) => max(-50, min(50, (int)$d));
    $next = [];
    foreach (['affection', 'trust', 'tension'] as $k) {
        $next[$k] = $cur[$k] + $clampDelta($deltas[$k] ?? 0);
    }
    relationship_set($userId, $next);
}

// every endpoint pulls in this file, so the CSRF check lives HERE
// and not in each one, where the next endpoint somebody writes
// would just forget it. the consolidation worker runs on the CLI,
// there's no request to check there.
if (PHP_SAPI !== 'cli') {
    require_allowed_host();
    require_same_origin();
}
