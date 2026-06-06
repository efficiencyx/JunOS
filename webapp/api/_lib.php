<?php
// Shared helpers pulled in by every endpoint (require_once __DIR__ . '/_lib.php').

function request_id(): string {
    static $id = null;
    if ($id === null) $id = bin2hex(random_bytes(6));
    return $id;
}

function client_ip(): string {
    $xff = $_SERVER['HTTP_X_FORWARDED_FOR'] ?? '';
    if ($xff !== '') {
        // First hop in the list is the original client. Keep only IP-ish chars.
        $first = preg_replace('/[^0-9a-fA-F.:\/]/', '', trim(explode(',', $xff)[0]));
        if ($first !== '') return $first;
    }
    return $_SERVER['REMOTE_ADDR'] ?? 'unknown';
}

function env_str(string $key, string $default = ''): string {
    $v = getenv($key);
    return ($v !== false && $v !== '') ? $v : $default;
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

    $dir = '/var/lib/omega/rl';
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

const EMBED_MODEL = 'nomic-embed-text';

// Returns the embedding vector for $text, or null if Ollama is unreachable or
// gives us something we can't parse. Every caller has to cope with null.
function embed_text(string $text, string $task = ''): ?array {
    $text = trim($text);
    if ($text === '') return null;

    // nomic-embed-text ranks well only when text carries a task prefix
    // ("search_query" for the live query, "search_document" for indexed docs).
    // Retrieval callers pass one; storage paths that must stay byte-compatible
    // with existing message_embeddings rows leave it empty.
    $prompt = $task !== '' ? $task . ': ' . $text : $text;

    $baseUrl = rtrim(env_str('OLLAMA_URL', 'http://localhost:11434'), '/');

    // Resolve the host ourselves first — curl's DNS occasionally stalls inside
    // the docker network and we'd rather not wait out the timeout.
    $parts = parse_url($baseUrl);
    if (isset($parts['host'])) {
        $ip = gethostbyname($parts['host']);
        if ($ip !== $parts['host']) {
            $baseUrl = ($parts['scheme'] ?? 'http') . '://' . $ip;
            if (isset($parts['port'])) $baseUrl .= ':' . $parts['port'];
        }
    }

    $ch = curl_init($baseUrl . '/api/embeddings');
    curl_setopt_array($ch, [
        CURLOPT_POST => true,
        CURLOPT_HTTPHEADER => ['Content-Type: application/json'],
        CURLOPT_POSTFIELDS => json_encode(['model' => EMBED_MODEL, 'prompt' => $prompt]),
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT => 30,
        CURLOPT_CONNECTTIMEOUT => 10,
    ]);
    $resp = curl_exec($ch);
    if ($resp === false) {
        log_event(['msg' => 'embed_curl_error', 'err' => curl_error($ch)]);
        curl_close($ch);
        return null;
    }
    curl_close($ch);

    $obj = json_decode($resp, true);
    if (!isset($obj['embedding']) || !is_array($obj['embedding'])) {
        log_event(['msg' => 'embed_bad_response']);
        return null;
    }
    return array_values(array_map('floatval', $obj['embedding']));
}

function db(): PDO {
    static $pdo = null;
    if ($pdo !== null) return $pdo;

    $path = is_writable('/var/lib/omega') ? '/var/lib/omega/omega.sqlite' : sys_get_temp_dir() . '/omega.sqlite';
    $pdo = new PDO('sqlite:' . $path, null, null, [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
    ]);
    $pdo->exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');

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
