<?php
/**
 * Shared bootstrap for Jun OS API endpoints.
 *
 * Include at the top of every endpoint:
 *   require_once __DIR__ . '/_lib.php';
 */

// ── Request identity ──────────────────────────────────────────────────────────

function omega_request_id(): string {
    static $id = null;
    if ($id === null) {
        $id = bin2hex(random_bytes(6)); // 12 hex chars
    }
    return $id;
}

function omega_client_id(): string {
    $xff = $_SERVER['HTTP_X_FORWARDED_FOR'] ?? '';
    if ($xff !== '') {
        $first = trim(explode(',', $xff)[0]);
        // Sanitise: keep only characters valid in an IP address / IPv6
        $first = preg_replace('/[^0-9a-fA-F.:\/]/', '', $first);
        if ($first !== '') return $first;
    }
    return $_SERVER['REMOTE_ADDR'] ?? 'unknown';
}

// ── Env helper ────────────────────────────────────────────────────────────────

function omega_env(string $key, string $default = ''): string {
    $v = getenv($key);
    return ($v !== false && $v !== '') ? $v : $default;
}

// ── Logging ───────────────────────────────────────────────────────────────────

function omega_log(array $ctx): void {
    $ctx = array_merge([
        'ts'         => date('c'),
        'request_id' => omega_request_id(),
        'client'     => omega_client_id(),
    ], $ctx);
    error_log(json_encode($ctx, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));
}

// ── Error responses ───────────────────────────────────────────────────────────

/**
 * Emit a JSON error response and exit.
 * $code      — HTTP status code (4xx / 5xx)
 * $machineMsg — stable machine-readable error key (no internals, no stack traces)
 */
function omega_json_error(int $code, string $machineMsg, array $extra = []): never {
    http_response_code($code);
    header('Content-Type: application/json');
    $body = array_merge(['error' => $machineMsg, 'request_id' => omega_request_id()], $extra);
    echo json_encode($body, JSON_UNESCAPED_UNICODE);
    exit;
}

// ── Method / content-type guards ──────────────────────────────────────────────

function omega_require_post(): void {
    if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
        omega_json_error(405, 'method_not_allowed');
    }
}

function omega_require_content_type(string $expected): void {
    $ct = $_SERVER['CONTENT_TYPE'] ?? $_SERVER['HTTP_CONTENT_TYPE'] ?? '';
    // Strip parameters like "; charset=utf-8"
    $ct = trim(explode(';', $ct)[0]);
    if (strcasecmp($ct, $expected) !== 0) {
        omega_json_error(415, 'unsupported_media_type');
    }
}

// ── Body reading ──────────────────────────────────────────────────────────────

/**
 * Read the request body, enforcing a size cap.
 * Returns the raw body string.
 * Sends 413 and exits if the body exceeds $maxBytes.
 */
function omega_read_body(int $maxBytes): string {
    // Fast path: trust Content-Length header if provided
    $cl = isset($_SERVER['CONTENT_LENGTH']) ? (int)$_SERVER['CONTENT_LENGTH'] : -1;
    if ($cl > $maxBytes) {
        omega_json_error(413, 'request_too_large');
    }

    $handle = fopen('php://input', 'r');
    $body   = stream_get_contents($handle, $maxBytes + 1);
    fclose($handle);

    if (strlen($body) > $maxBytes) {
        omega_json_error(413, 'request_too_large');
    }
    return $body;
}

// ── Rate limiting (flat-file token bucket) ────────────────────────────────────

/**
 * Enforce a per-IP, per-bucket rate limit.
 *
 * $bucket      — logical bucket name (e.g. 'chat', 'tts', 'models')
 * $maxPerWindow — max requests allowed in the window
 * $windowSec   — sliding-window length in seconds
 *
 * On limit exceed: sets 429 + Retry-After header and exits.
 * Falls back to sys_get_temp_dir() if /var/lib/omega/rl is not writable.
 */
function omega_rate_limit(string $bucket, int $maxPerWindow, int $windowSec): void {
    $ip  = omega_client_id();
    $key = sha1($bucket . '|' . $ip);

    // Resolve storage directory
    $dir = '/var/lib/omega/rl';
    if (!is_dir($dir) || !is_writable($dir)) {
        $dir = sys_get_temp_dir() . '/omega_rl';
        if (!is_dir($dir)) {
            @mkdir($dir, 0700, true);
        }
    }
    // If we still can't write, skip rate limiting rather than crash
    if (!is_dir($dir) || !is_writable($dir)) {
        return;
    }

    $file = $dir . '/' . $key . '.json';
    $now  = time();

    $fp = fopen($file, 'c+');
    if ($fp === false) return; // can't open — skip

    flock($fp, LOCK_EX);

    $data = ['hits' => [], 'window' => $windowSec];
    $raw  = stream_get_contents($fp);
    if ($raw !== '' && $raw !== false) {
        $parsed = json_decode($raw, true);
        if (is_array($parsed)) $data = $parsed;
    }

    // Evict hits outside the current window
    $cutoff = $now - $windowSec;
    $data['hits'] = array_values(array_filter($data['hits'], fn($t) => $t > $cutoff));

    $count = count($data['hits']);
    if ($count >= $maxPerWindow) {
        flock($fp, LOCK_UN);
        fclose($fp);

        $oldest = min($data['hits']);
        $retryAfter = max(1, ($oldest + $windowSec) - $now);
        header('Retry-After: ' . $retryAfter);
        omega_log([
            'msg'    => 'rate_limit_exceeded',
            'bucket' => $bucket,
            'count'  => $count,
            'limit'  => $maxPerWindow,
        ]);
        omega_json_error(429, 'rate_limit_exceeded', ['retry_after' => $retryAfter]);
    }

    $data['hits'][] = $now;
    ftruncate($fp, 0);
    rewind($fp);
    fwrite($fp, json_encode($data));
    flock($fp, LOCK_UN);
    fclose($fp);
}

// ── Embeddings (Ollama) ───────────────────────────────────────────────────────

const OMEGA_EMBED_MODEL = 'nomic-embed-text';

/**
 * Embed a string via Ollama's /api/embeddings endpoint.
 * Returns a plain float array, or null on any failure (network, model missing,
 * malformed response). Callers must tolerate null and degrade gracefully.
 */
function omega_embed(string $text): ?array {
    $text = trim($text);
    if ($text === '') return null;
    $baseUrl = rtrim(omega_env('OLLAMA_URL', 'http://localhost:11434'), '/');

    // Workaround: resolve hostname explicitly before curl to avoid timeout
    // in Docker environments where curl's DNS handling can be problematic.
    $parts = parse_url($baseUrl);
    if (isset($parts['host'])) {
        $ip = gethostbyname($parts['host']);
        if ($ip !== $parts['host']) { // successful resolution
            $baseUrl = ($parts['scheme'] ?? 'http') . '://' . $ip;
            if (isset($parts['port'])) $baseUrl .= ':' . $parts['port'];
        }
    }

    $url = $baseUrl . '/api/embeddings';

    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_POST           => true,
        CURLOPT_HTTPHEADER     => ['Content-Type: application/json'],
        CURLOPT_POSTFIELDS     => json_encode(['model' => OMEGA_EMBED_MODEL, 'prompt' => $text]),
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT        => 30,
        CURLOPT_CONNECTTIMEOUT => 10,
    ]);
    $resp = curl_exec($ch);
    $err  = $resp === false ? curl_error($ch) : '';
    curl_close($ch);
    if ($resp === false) {
        omega_log(['msg' => 'omega_embed_curl_error', 'err' => $err]);
        return null;
    }
    $obj = json_decode($resp, true);
    if (!isset($obj['embedding']) || !is_array($obj['embedding'])) {
        omega_log(['msg' => 'omega_embed_bad_response']);
        return null;
    }
    return array_values(array_map('floatval', $obj['embedding']));
}

// ── SQLite database ───────────────────────────────────────────────────────────

function omega_db(): PDO {
    static $pdo = null;
    if ($pdo !== null) return $pdo;

    $path = is_writable('/var/lib/omega') ? '/var/lib/omega/omega.sqlite' : sys_get_temp_dir() . '/omega.sqlite';
    $pdo  = new PDO('sqlite:' . $path, null, null, [
        PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
    ]);
    $pdo->exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');

    try {
        $version = $pdo->query('SELECT v FROM schema_version LIMIT 1')->fetchColumn();
    } catch (PDOException $e) {
        $version = false;
    }
    if ($version === false) {
        $sql = file_get_contents(__DIR__ . '/migrations/001_init.sql');
        $pdo->exec($sql);
    }

    return $pdo;
}

// ── Session / user identity ───────────────────────────────────────────────────

function omega_current_user(): ?array {
    static $user = false; // false = not yet resolved; null = no session
    if ($user !== false) return $user;

    $token = $_COOKIE['omega_session'] ?? '';
    if ($token === '') { $user = null; return null; }

    $stmt = omega_db()->prepare(
        'SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token = ? AND s.expires_at > ? LIMIT 1'
    );
    $stmt->execute([$token, time()]);
    $row  = $stmt->fetch();
    $user = $row ?: null;
    return $user;
}

function omega_require_user(): array {
    $user = omega_current_user();
    if ($user === null) {
        omega_json_error(401, 'unauthorized');
    }
    return $user;
}

function omega_new_session(int $userId): string {
    $token   = bin2hex(random_bytes(32));
    $now     = time();
    $expires = $now + 30 * 86400;
    omega_db()->prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
              ->execute([$token, $userId, $now, $expires]);
    $secure = !empty($_SERVER['HTTPS']) || (($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https');
    setcookie('omega_session', $token, [
        'expires'  => $expires,
        'path'     => '/',
        'httponly' => true,
        'samesite' => 'Lax',
        'secure'   => $secure,
    ]);
    return $token;
}
