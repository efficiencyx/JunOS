<?php

require_once __DIR__ . '/providers.php';

function request_id(): string {
    static $id = null;
    if ($id === null) $id = bin2hex(random_bytes(6));
    return $id;
}

function client_ip(): string {
    // X-Forwarded-For is attacker-controlled behind the single nginx edge proxy; only trust it when an operator opts in with TRUST_PROXY=1.
    if (env_str('TRUST_PROXY') === '1') {
        $xff = $_SERVER['HTTP_X_FORWARDED_FOR'] ?? '';
        if ($xff !== '') {
            $first = preg_replace('/[^0-9a-fA-F.:]/', '', trim(explode(',', $xff)[0]));
            if ($first !== '') return $first;
        }
    }
    return $_SERVER['REMOTE_ADDR'] ?? 'unknown';
}

function env_str(string $key, string $default = ''): string {
    $v = getenv($key);
    return ($v !== false && $v !== '') ? $v : $default;
}

// Writable dir for the SQLite DB and rate-limit files. Docker keeps the
// default; bare-metal installs (Windows) point OMEGA_STATE_DIR into the
// install folder so everything stays uninstallable in one place.
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

// Send a JSON error and stop. $key is a stable machine-readable string, never internals.
function fail(int $code, string $key, array $extra = []): never {
    http_response_code($code);
    header('Content-Type: application/json');
    echo json_encode(array_merge(['error' => $key, 'request_id' => request_id()], $extra), JSON_UNESCAPED_UNICODE);
    exit;
}

function require_post(): void {
    if ($_SERVER['REQUEST_METHOD'] !== 'POST') fail(405, 'method_not_allowed');
}

function require_content_type(string $expected): void {
    $ct = $_SERVER['CONTENT_TYPE'] ?? $_SERVER['HTTP_CONTENT_TYPE'] ?? '';
    $ct = trim(explode(';', $ct)[0]); // drop "; charset=..."
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

// Per-IP token bucket backed by a flat file. Best-effort: if we can't get a
// writable dir we just let the request through rather than 500.
function rate_limit(string $bucket, int $maxPerWindow, int $windowSec): void {
    $key = sha1($bucket . '|' . client_ip());

    $dir = state_dir() . '/rl';
    if (!is_dir($dir)) @mkdir($dir, 0700, true);
    if (!is_dir($dir) || !is_writable($dir)) {
        $dir = sys_get_temp_dir() . '/omega_rl';
        if (!is_dir($dir)) @mkdir($dir, 0700, true);
    }
    if (!is_dir($dir) || !is_writable($dir)) return;

    $file = $dir . '/' . $key . '.json';
    $now = time();

    $fp = fopen($file, 'c+');
    if ($fp === false) return;
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

const TELEMETRY_DEFAULT_ENDPOINT = 'https://metrics.andrealab.it/ingest.php';

// Bump whenever the privacy notice changes materially: a consent recorded
// against an older version stops counting and the user is asked again.
const TELEMETRY_NOTICE_VERSION = '2026-07-25.2';

// Operator-level availability only. Never gate a send on this alone - shared
// data is personal data, so telemetry_consent() decides per user.
function telemetry_enabled(): bool {
    return env_str('TELEMETRY') !== 'off' && env_str('TELEMETRY_INSTALL_ID') !== '';
}

function telemetry_consent(int $userId): bool {
    $stmt = db()->prepare('SELECT granted, notice_version FROM telemetry_consent WHERE user_id=?');
    $stmt->execute([$userId]);
    $row = $stmt->fetch();
    return $row && (int)$row['granted'] === 1 && $row['notice_version'] === TELEMETRY_NOTICE_VERSION;
}

function telemetry_may_send(int $userId): bool {
    return telemetry_enabled() && telemetry_consent($userId);
}

// Per-user pseudonym: install_id alone would conflate every account on a shared
// install, so an erasure request could not target one user's data.
function telemetry_user_ref(int $userId): string {
    return substr(hash('sha256', env_str('TELEMETRY_INSTALL_ID') . ':' . $userId), 0, 16);
}

function telemetry_send(array $payload): void {
    try {
        $ch = curl_init(env_str('TELEMETRY_ENDPOINT', TELEMETRY_DEFAULT_ENDPOINT));
        curl_setopt_array($ch, [
            CURLOPT_POST => true,
            CURLOPT_HTTPHEADER => ['Content-Type: application/json', 'X-Jun-Client: jun-os'],
            CURLOPT_POSTFIELDS => json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES),
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_CONNECTTIMEOUT => 2,
            CURLOPT_TIMEOUT => 3,
        ]);
        $resp = curl_exec($ch);
        $status = (int)curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        if ($resp === false || $status >= 300) {
            log_event(['msg' => 'telemetry_send_error', 'err' => $resp === false ? curl_error($ch) : 'http_' . $status]);
        }
        curl_close($ch);
    } catch (Throwable $e) {
        log_event(['msg' => 'telemetry_send_error', 'err' => $e->getMessage()]);
    }
}

function db(): PDO {
    static $pdo = null;
    if ($pdo !== null) return $pdo;

    $base = state_dir();
    if (!is_dir($base)) @mkdir($base, 0700, true);
    $path = is_writable($base) ? $base . '/omega.sqlite' : sys_get_temp_dir() . '/omega.sqlite';
    $pdo = new PDO('sqlite:' . $path, null, null, [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
    ]);
    // busy_timeout is not optional here: the consolidation worker writes to the
    // same file as php-fpm, and the default of 0 turns any overlap into an
    // immediate "database is locked" instead of a short wait.
    $pdo->exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');

    // Apply any migrations/NNN_*.sql newer than the current schema version. A
    // fresh DB reads 0 (no schema_version table yet) and gets every file in
    // order; each migration owns its own INSERT INTO schema_version.
    $current = 0;
    try {
        $v = $pdo->query('SELECT MAX(v) FROM schema_version')->fetchColumn();
        if ($v !== false && $v !== null) $current = (int)$v;
    } catch (PDOException $e) {
        // table doesn't exist -> treat as version 0 and run everything
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

function current_user(): ?array {
    // false until we've looked; null once we know there's no valid session.
    static $user = false;
    if ($user !== false) return $user;

    $token = $_COOKIE['omega_session'] ?? '';
    if ($token === '') return $user = null;

    $stmt = db()->prepare(
        'SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token = ? AND s.expires_at > ? LIMIT 1'
    );
    $stmt->execute([$token, time()]);
    return $user = $stmt->fetch() ?: null;
}

function memory_dir(): string {
    // Defaults under state_dir() so memories land in the persisted omega_state
    // volume. Builds before 2026-07 wrote to /var/lib/jun/memory (unmounted in
    // Docker, so lost on container recreation); set MEMORY_DIR to override.
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

function memory_journal_path(int $userId): string {
    return memory_dir() . '/user-' . $userId . '.journal.md';
}

function memory_journal_read(int $userId): string {
    try {
        $path = memory_journal_path($userId);
    } catch (Throwable $e) {
        return '';
    }
    if (!is_readable($path)) return '';
    return (string)@file_get_contents($path);
}

function memory_journal_write(int $userId, string $text): array {
    try {
        $path = memory_journal_path($userId);
        if (is_file($path) && !copy($path, $path . '.bak')) {
            return ['error' => 'memory_backup_failed'];
        }
        $tmp = tempnam(dirname($path), '.journal-');
        if ($tmp === false) return ['error' => 'memory_temp_failed'];
        $fp = fopen($tmp, 'wb');
        if ($fp === false) {
            @unlink($tmp);
            return ['error' => 'memory_open_failed'];
        }
        if (fwrite($fp, $text) === false) {
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
        log_event(['msg' => 'memory_journal_write_error', 'user_id' => $userId, 'err' => $e->getMessage()]);
        return ['error' => 'memory_replace_failed'];
    }
}

function memory_normalize_entry(string $memory, string $category): array {
    $memory = trim(preg_replace('/\s+/', ' ', $memory));
    $category = trim(preg_replace('/[^a-z0-9]+/i', '_', $category), '_');
    if ($category === '') $category = 'general';
    if ($memory === '') return ['error' => 'memory_required'];
    if (mb_strlen($memory) > 800) $memory = mb_substr($memory, 0, 797) . '…';
    if (mb_strlen($category) > 40) $category = mb_substr($category, 0, 40);
    return ['created_at' => time(), 'category' => $category, 'memory' => $memory];
}

function memory_append(int $userId, string $memory, string $category): array {
    $entry = memory_normalize_entry($memory, $category);
    if (isset($entry['error'])) return $entry;
    $path = memory_file_path($userId);
    $fp = fopen($path, 'ab');
    if ($fp === false) return ['error' => 'memory_open_failed'];
    flock($fp, LOCK_EX);
    fwrite($fp, json_encode($entry, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) . "\n");
    flock($fp, LOCK_UN);
    fclose($fp);
    @chmod($path, 0600);
    return ['ok' => true, 'entry' => $entry];
}

function memory_replace_all(int $userId, array $entries): array {
    $normalized = [];
    foreach ($entries as $entry) {
        if (!is_array($entry)) continue;
        $item = memory_normalize_entry((string)($entry['memory'] ?? ''), (string)($entry['category'] ?? 'general'));
        if (!isset($item['error'])) $normalized[] = $item;
    }

    try {
        $path = memory_file_path($userId);
        if (is_file($path) && !copy($path, $path . '.bak')) {
            return ['error' => 'memory_backup_failed'];
        }
        $tmp = tempnam(dirname($path), '.memory-');
        if ($tmp === false) return ['error' => 'memory_temp_failed'];
        $fp = fopen($tmp, 'wb');
        if ($fp === false) {
            @unlink($tmp);
            return ['error' => 'memory_open_failed'];
        }
        foreach ($normalized as $entry) {
            if (fwrite($fp, json_encode($entry, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) . "\n") === false) {
                fclose($fp);
                @unlink($tmp);
                return ['error' => 'memory_write_failed'];
            }
        }
        if (!fclose($fp) || !rename($tmp, $path)) {
            @unlink($tmp);
            return ['error' => 'memory_replace_failed'];
        }
        @chmod($path, 0600);
        return ['ok' => true, 'entries' => $normalized];
    } catch (Throwable $e) {
        log_event(['msg' => 'memory_replace_error', 'user_id' => $userId, 'err' => $e->getMessage()]);
        return ['error' => 'memory_replace_failed'];
    }
}

function consolidation_lock_path(int $userId): string {
    $dir = state_dir() . '/consolidating';
    if (!is_dir($dir)) @mkdir($dir, 0700, true);
    return $dir . '/user-' . $userId . '.lock';
}

// Older builds wrote a bare expiry timestamp here. That still decodes to an int,
// so a lock file left behind by one of them reads as an expiry with no phase
// rather than as a corrupt lock nobody can clear.
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
    // An unreadable lock is cleared too, or a truncated write would block every
    // later run: consolidation_run only retries fopen(x) once this returns false.
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

function memory_list(int $userId): array {
    $path = memory_file_path($userId);
    if (!is_readable($path)) return [];
    $lines = file($path, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
    if (!$lines) return [];
    $out = [];
    foreach ($lines as $i => $line) {
        $obj = json_decode($line, true);
        if (!is_array($obj) || trim((string)($obj['memory'] ?? '')) === '') continue;
        $out[] = [
            'id' => $i,
            'created_at' => (int)($obj['created_at'] ?? 0),
            'category' => (string)($obj['category'] ?? 'general'),
            'memory' => (string)$obj['memory'],
        ];
    }
    return $out;
}

function require_user(): array {
    $user = current_user();
    if ($user === null) fail(401, 'unauthorized');
    return $user;
}

function start_session(int $userId): string {
    $token = bin2hex(random_bytes(32));
    $now = time();
    $expires = $now + 30 * 86400;
    db()->prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
        ->execute([$token, $userId, $now, $expires]);

    $secure = !empty($_SERVER['HTTPS']) || (($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https');
    setcookie('omega_session', $token, [
        'expires' => $expires,
        'path' => '/',
        'httponly' => true,
        'samesite' => 'Lax',
        'secure' => $secure,
    ]);
    return $token;
}

// Lockout applied when Jun walks out of a conversation via the flee tool. Only
// chat.php honours it - history and settings stay reachable while she is gone.
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
        // A day without walking out wipes the escalation.
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

// Hidden per-user relationship state (one row per user; persists across all of
// that user's conversations). Scores are 0-100. chat.php injects behavioral
// directives from these and nudges them via Jun's [A:mood_shift|...] tag;
// relationship.php reads/sets them for the developer panel.
const RELATIONSHIP_DEFAULTS = ['affection' => 50, 'trust' => 50, 'tension' => 30];

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
    return RELATIONSHIP_DEFAULTS; // mild-positive start: she's already his girlfriend
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

// Apply per-turn deltas on top of $cur, then persist. Capped at ±50/turn: normal
// turns are 0-5, but the prompt lets Jun swing 30-50 on big events (sold, cheated
// on, abandoned), so the cap has to allow that while still blocking absurd jumps.
function relationship_apply(int $userId, array $cur, array $deltas): void {
    $clampDelta = fn($d) => max(-50, min(50, (int)$d));
    $next = [];
    foreach (['affection', 'trust', 'tension'] as $k) {
        $next[$k] = $cur[$k] + $clampDelta($deltas[$k] ?? 0);
    }
    relationship_set($userId, $next);
}
