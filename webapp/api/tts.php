<?php
// Proxy for the audio sidecar's TTS endpoints. Handles two routes:
//   GET  ?action=voices  → GET  {TTS_URL}/voices
//   POST ?action=tts     → POST {TTS_URL}/tts  (pass-through JSON body, returns audio)

require_once __DIR__ . '/_lib.php';

require_user();

// KOKORO_URL is the pre-rename name of TTS_URL, honored for existing .env files.
$ttsUrl = rtrim(env_str('TTS_URL', env_str('KOKORO_URL', 'http://localhost:8001')), '/');
$action = $_GET['action'] ?? '';

if ($action === 'voices') {
    header('Content-Type: application/json');

    // 60-second cache: APCu if available, else a tmp file.
    $cacheKey = 'omega_voices_v2';
    $cached = null;

    if (function_exists('apcu_fetch')) {
        $success = false;
        $val = apcu_fetch($cacheKey, $success);
        if ($success) $cached = $val;
    } else {
        $cacheFile = sys_get_temp_dir() . '/omega_voices_v2.cache';
        if (is_readable($cacheFile) && (time() - filemtime($cacheFile)) < 60) {
            $cached = file_get_contents($cacheFile) ?: null;
        }
    }

    if ($cached !== null) {
        header('Cache-Control: public, max-age=60');
        echo $cached;
        exit;
    }

    $ch = curl_init($ttsUrl . '/voices');
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_CONNECTTIMEOUT, 5);
    curl_setopt($ch, CURLOPT_TIMEOUT, 10);
    $res = curl_exec($ch);
    $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);

    if ($res === false) {
        http_response_code(502);
        echo json_encode(['error' => 'tts_unreachable']);
        exit;
    }

    if ($code >= 500) {
        http_response_code(502);
        log_event(['msg' => 'tts_voices_error', 'upstream_code' => $code]);
        echo json_encode(['error' => 'tts_failed']);
        exit;
    }

    if (function_exists('apcu_store')) {
        apcu_store($cacheKey, $res, 60);
    } else {
        $cacheFile = sys_get_temp_dir() . '/omega_voices_v2.cache';
        @file_put_contents($cacheFile, $res);
    }

    header('Cache-Control: public, max-age=60');
    http_response_code($code);
    echo $res;
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

    $voice = $body['voice'] ?? null;
    if ($voice !== null && (!is_string($voice) || !preg_match('/^[a-z][a-z0-9_]*$/', $voice))) {
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

    $ch = curl_init($ttsUrl . '/tts');
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_POST, true);
    curl_setopt($ch, CURLOPT_POSTFIELDS, $rawBody);
    curl_setopt($ch, CURLOPT_HTTPHEADER, ['Content-Type: application/json']);
    curl_setopt($ch, CURLOPT_CONNECTTIMEOUT, 5);
    curl_setopt($ch, CURLOPT_TIMEOUT, 60);
    $res = curl_exec($ch);
    $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $ct  = curl_getinfo($ch, CURLINFO_CONTENT_TYPE);
    curl_close($ch);

    if ($res === false) {
        http_response_code(502);
        header('Content-Type: application/json');
        echo json_encode(['error' => 'tts_unreachable']);
        exit;
    }

    if ($code >= 500) {
        log_event(['msg' => 'tts_upstream_error', 'upstream_code' => $code]);
        fail(502, 'tts_failed');
    }

    http_response_code($code);
    if ($ct) header('Content-Type: ' . $ct);
    echo $res;
    exit;
}

http_response_code(400);
header('Content-Type: application/json');
echo json_encode(['error' => 'unknown_action']);
