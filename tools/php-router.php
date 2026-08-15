<?php
// used in baremetal installs with no nginx since php -S can't do routing,
// MIME types, or security headers, so this file plays nginx role.

function router_fail(int $status, string $message): never {
    http_response_code($status);
    header('Content-Type: text/plain; charset=utf-8');
    echo $message;
    exit;
}

function router_request_host(): string {
    $raw = trim($_SERVER['HTTP_HOST'] ?? '');
    if ($raw === '' || preg_match('/[\x00-\x20\/\\\\]/', $raw)) return '';
    $parts = parse_url('http://' . $raw);
    if (!$parts || empty($parts['host']) || isset($parts['user']) || isset($parts['pass'])
        || isset($parts['path']) || isset($parts['query']) || isset($parts['fragment'])) {
        return '';
    }
    return strtolower(trim($parts['host'], '[]'));
}

function router_serve_static(string $path, string $method): never {
    $types = [
        'css' => 'text/css; charset=utf-8',
        'gif' => 'image/gif',
        'html' => 'text/html; charset=utf-8',
        'ico' => 'image/x-icon',
        'jpeg' => 'image/jpeg',
        'jpg' => 'image/jpeg',
        'js' => 'application/javascript; charset=utf-8',
        'json' => 'application/json; charset=utf-8',
        'map' => 'application/json; charset=utf-8',
        'mp3' => 'audio/mpeg',
        'mp4' => 'video/mp4',
        'ogg' => 'audio/ogg',
        'otf' => 'font/otf',
        'png' => 'image/png',
        'svg' => 'image/svg+xml',
        'ttf' => 'font/ttf',
        'txt' => 'text/plain; charset=utf-8',
        'wasm' => 'application/wasm',
        'wav' => 'audio/wav',
        'webm' => 'video/webm',
        'webp' => 'image/webp',
        'woff' => 'font/woff',
        'woff2' => 'font/woff2',
        'zip' => 'application/zip',
    ];
    $size = filesize($path);
    if ($size === false) router_fail(500, 'file unavailable');
    $start = 0;
    $end = max(0, $size - 1);
    $range = $_SERVER['HTTP_RANGE'] ?? '';
    if ($size > 0 && $range !== '') {
        if (!preg_match('/^bytes=(\d*)-(\d*)$/', trim($range), $match)
            || ($match[1] === '' && $match[2] === '')) {
            header('Content-Range: bytes */' . $size);
            router_fail(416, 'invalid range');
        }
        if ($match[1] === '') {
            $suffix = min($size, (int)$match[2]);
            $start = $size - $suffix;
        } else {
            $start = (int)$match[1];
            if ($match[2] !== '') $end = min($end, (int)$match[2]);
        }
        if ($start > $end || $start >= $size) {
            header('Content-Range: bytes */' . $size);
            router_fail(416, 'invalid range');
        }
        http_response_code(206);
        header("Content-Range: bytes $start-$end/$size");
    }

    $extension = strtolower(pathinfo($path, PATHINFO_EXTENSION));
    header('Content-Type: ' . ($types[$extension] ?? 'application/octet-stream'));
    header('Accept-Ranges: bytes');
    header('Content-Length: ' . ($size === 0 ? 0 : $end - $start + 1));
    if ($method === 'HEAD' || $size === 0) exit;

    $stream = fopen($path, 'rb');
    if ($stream === false) router_fail(500, 'file unavailable');
    fseek($stream, $start);
    $remaining = $end - $start + 1;
    while ($remaining > 0 && !feof($stream)) {
        $chunk = fread($stream, min(64 * 1024, $remaining));
        if ($chunk === false) break;
        echo $chunk;
        $remaining -= strlen($chunk);
    }
    fclose($stream);
    exit;
}

ini_set('display_errors', '0');
ini_set('log_errors', '1');
header_remove('X-Powered-By');

$allowedHosts = [];
foreach (preg_split('/[\s,]+/', getenv('OMEGA_ALLOWED_HOSTS') ?: 'localhost,127.0.0.1,::1') as $host) {
    $host = strtolower(trim($host, " \t\n\r\0\x0B[]"));
    if ($host !== '') $allowedHosts[] = $host;
}
if (!in_array(router_request_host(), $allowedHosts, true)) router_fail(421, 'invalid host');

header('X-Content-Type-Options: nosniff');
header('X-Frame-Options: DENY');
header('Referrer-Policy: strict-origin-when-cross-origin');
header('Permissions-Policy: microphone=(self), camera=(), geolocation=()');
header("Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' data:; worker-src 'self' blob:; frame-ancestors 'none'; base-uri 'self'; form-action 'none'; object-src 'none'");

$path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH);
if (!is_string($path)) router_fail(400, 'invalid request');
$path = rawurldecode($path);
if (str_contains($path, "\0")) router_fail(400, 'invalid request');

$segments = explode('/', trim($path, '/'));
foreach ($segments as $segment) {
    if ($segment === '.' || $segment === '..' || str_starts_with($segment, '.')) {
        router_fail(404, 'not found');
    }
}

if ($path === '/system_prompt.txt' || str_starts_with($path, '/api/migrations/')
    || $path === '/api/consolidation-worker.php') {
    router_fail(404, 'not found');
}

$isApi = preg_match('#^/api/[^/]+\.php$#', $path) === 1;
$method = strtoupper($_SERVER['REQUEST_METHOD'] ?? 'GET');
if (!$isApi && $method !== 'GET' && $method !== 'HEAD') router_fail(405, 'method not allowed');

$docroot = realpath($_SERVER['DOCUMENT_ROOT'] ?? '');
if ($docroot === false) router_fail(500, 'document root unavailable');
$candidate = $docroot . ($path === '/' ? '/index.html' : $path);
$target = realpath($candidate);
if ($target === false || ($target !== $docroot && !str_starts_with($target, $docroot . DIRECTORY_SEPARATOR))) {
    router_fail(404, 'not found');
}
if (!is_file($target)) router_fail(404, 'not found');

if (str_ends_with(strtolower($target), '.php') && !$isApi) router_fail(404, 'not found');
if ($isApi) {
    header('Cache-Control: no-store');
    $_SERVER['SCRIPT_FILENAME'] = $target;
    $_SERVER['SCRIPT_NAME'] = $path;
    $_SERVER['PHP_SELF'] = $path;
    require $target;
    return true;
} elseif ($path === '/' || $path === '/index.html') {
    header('Cache-Control: no-cache');
} elseif (isset($_GET['v'])) {
    header('Cache-Control: public, max-age=31536000, immutable');
}

router_serve_static($target, $method);
