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
