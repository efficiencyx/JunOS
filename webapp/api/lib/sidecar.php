<?php

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

// KOKORO_URL is what TTS_URL was called before, old .env files
// still have it.
function tts_url(): string {
    return rtrim(env_str('TTS_URL', env_str('KOKORO_URL', 'http://localhost:8001')), '/');
}

// separation gets its own sidecar so it can hold a GPU torch
// while the voice one stays on the CPU. a bare metal install runs
// both roles in one process, so fall back to the voice sidecar.
function karaoke_url(): string {
    $url = env_str('KARAOKE_URL');
    return $url !== '' ? rtrim($url, '/') : tts_url();
}

// one request to a sidecar. POST when there's a body. body comes
// back false when the sidecar never answered at all.
function sidecar_call(string $url, ?string $body = null, array $headers = [], int $timeout = 10): array {
    $ch = curl_init($url);
    curl_setopt($ch, CURLOPT_HTTPHEADER, sidecar_headers($headers));
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    if ($body !== null) {
        curl_setopt($ch, CURLOPT_POST, true);
        curl_setopt($ch, CURLOPT_POSTFIELDS, $body);
    }
    curl_setopt($ch, CURLOPT_CONNECTTIMEOUT, 5);
    curl_setopt($ch, CURLOPT_TIMEOUT, $timeout);
    $res = curl_exec($ch);
    $out = [
        'url' => $url,
        'body' => $res,
        'code' => (int)curl_getinfo($ch, CURLINFO_HTTP_CODE),
        'type' => (string)curl_getinfo($ch, CURLINFO_CONTENT_TYPE),
    ];
    curl_close($ch);
    return $out;
}

// down or 5xx is a 502 for the browser, with $unreachable or
// $failed as the error. below 500 the caller relays it.
function sidecar_check(array $res, string $unreachable, string $failed): void {
    if ($res['body'] === false) fail(502, $unreachable);
    if ($res['code'] >= 500) {
        log_event(['msg' => 'sidecar_error', 'error' => $failed, 'url' => $res['url'], 'upstream_code' => $res['code']]);
        fail(502, $failed);
    }
}

function sidecar_relay(array $res, string $type = 'application/json'): never {
    http_response_code($res['code']);
    header('Content-Type: ' . $type);
    echo $res['body'];
    exit;
}

// the sidecar's own /health json, or null when it's down. `sep`
// in there is the only flag that means karaoke actually works,
// the voice sidecar answers /health too and says sep=false.
function karaoke_health(): ?array {
    $res = sidecar_call(karaoke_url() . '/health');
    if ($res['body'] === false || $res['code'] >= 500) return null;
    $data = json_decode((string)$res['body'], true);
    return is_array($data) ? $data : null;
}
