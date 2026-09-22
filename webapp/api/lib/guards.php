<?php

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

// Host already got through require_allowed_host() by the time
// this runs. OMEGA_ALLOWED_ORIGINS is for a reverse proxy doing
// TLS in front of us, whose public origin isn't the one we see.
function allowed_origins(): array {
    $out = [];
    $host = strtolower($_SERVER['HTTP_HOST'] ?? '');
    if ($host !== '') {
        $out[] = (request_is_https() ? 'https://' : 'http://') . $host;
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
