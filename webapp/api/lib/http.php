<?php

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

function json_out(mixed $data, int $code = 200): never {
    http_response_code($code);
    header('Content-Type: application/json');
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function require_method(string ...$allowed): string {
    $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
    if (!in_array($method, $allowed, true)) fail(405, 'method_not_allowed');
    return $method;
}

function require_post(): void {
    require_method('POST');
}

function request_is_https(): bool {
    return !empty($_SERVER['HTTPS']) || (($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https');
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

// content type, size cap and a decoded array, or the request never
// gets past here.
function read_json_body(int $maxBytes): array {
    require_content_type('application/json');
    $body = json_decode(read_body($maxBytes), true);
    if (!is_array($body)) fail(400, 'invalid_request');
    return $body;
}
