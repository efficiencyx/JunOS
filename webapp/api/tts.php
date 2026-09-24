<?php

require_once __DIR__ . '/lib/bootstrap.php';

require_user();

$action = $_GET['action'] ?? '';

const VOICES_CACHE_KEY = 'omega_voices_v2';

function voices_cache_read(): ?string {
    if (function_exists('apcu_fetch')) {
        $success = false;
        $val = apcu_fetch(VOICES_CACHE_KEY, $success);
        return $success ? $val : null;
    }
    $cacheFile = sys_get_temp_dir() . '/' . VOICES_CACHE_KEY . '.cache';
    if (is_readable($cacheFile) && (time() - filemtime($cacheFile)) < 60) {
        return file_get_contents($cacheFile) ?: null;
    }
    return null;
}

function voices_cache_write(string $voices): void {
    if (function_exists('apcu_store')) {
        apcu_store(VOICES_CACHE_KEY, $voices, 60);
    } else {
        @file_put_contents(sys_get_temp_dir() . '/' . VOICES_CACHE_KEY . '.cache', $voices);
    }
}

// voice names and pocket-tts language ids (english, french_24l,
// ...). only the shape gets checked here, the sidecar puts a
// language it doesn't know back to its default.
function tts_valid_id(mixed $id): bool {
    return $id === null || (is_string($id) && preg_match('/^[a-z][a-z0-9_]*$/', $id));
}

if ($action === 'voices') {
    $cached = voices_cache_read();
    if ($cached === null) {
        $res = sidecar_call(tts_url() . '/voices');
        sidecar_check($res, 'tts_unreachable', 'tts_failed');
        $cached = (string)$res['body'];
        voices_cache_write($cached);
        http_response_code($res['code']);
    }
    header('Content-Type: application/json');
    header('Cache-Control: public, max-age=60');
    echo $cached;
    exit;
}

if ($action === 'tts') {
    require_post();
    require_content_type('application/json');

    rate_limit('tts', 60, 60);

    $rawBody = read_body(8 * 1024);
    $body = json_decode($rawBody, true);
    if (!is_array($body)) fail(400, 'invalid_request');

    $text = $body['text'] ?? null;
    if (!is_string($text) || trim($text) === '' || strlen($text) > 2000) {
        fail(400, 'invalid_request');
    }
    if (!tts_valid_id($body['voice'] ?? null) || !tts_valid_id($body['lang'] ?? null)) {
        fail(400, 'invalid_request');
    }

    $engine = $body['engine'] ?? null;
    if ($engine !== null && !in_array($engine, ['kokoro', 'pockettts'], true)) {
        fail(400, 'invalid_request');
    }

    $speed = $body['speed'] ?? null;
    if ($speed !== null) {
        $speed = filter_var($speed, FILTER_VALIDATE_FLOAT);
        if ($speed === false || $speed < 0.5 || $speed > 2.0) fail(400, 'invalid_request');
    }

    $res = sidecar_call(tts_url() . '/tts', $rawBody, ['Content-Type: application/json'], 60);
    sidecar_check($res, 'tts_unreachable', 'tts_failed');
    sidecar_relay($res, $res['type'] ?: 'application/json');
}

if ($action === 'warm') {
    require_post();
    require_content_type('application/json');

    rate_limit('tts_warm', 60, 60);

    $rawBody = read_body(1024);
    $body = json_decode($rawBody, true);
    if (!is_array($body) || !tts_valid_id($body['lang'] ?? null)) fail(400, 'invalid_request');

    // a cold language checkpoint can take several seconds to load.
    // the client isn't waiting on this one, so let the sidecar finish
    $res = sidecar_call(tts_url() . '/warm', $rawBody, ['Content-Type: application/json'], 120);
    sidecar_check($res, 'tts_unreachable', 'tts_failed');
    sidecar_relay($res);
}

fail(400, 'unknown_action');
