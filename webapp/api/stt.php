<?php

require_once __DIR__ . '/_lib.php';

require_user();

// KOKORO_URL is what TTS_URL was called before, we still take it for old .env files.
$ttsUrl = rtrim(env_str('TTS_URL', env_str('KOKORO_URL', 'http://localhost:8001')), '/');
$action = $_GET['action'] ?? '';

if ($action === 'health') {
    header('Content-Type: application/json');

    $ch = curl_init($ttsUrl . '/health');
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_CONNECTTIMEOUT, 5);
    curl_setopt($ch, CURLOPT_TIMEOUT, 10);
    $res = curl_exec($ch);
    $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);

    if ($res === false || $code >= 500) {
        echo json_encode(['ok' => false, 'stt' => false]);
        exit;
    }

    http_response_code($code);
    echo $res;
    exit;
}

if ($action === 'stt') {
    require_post();
    require_content_type('audio/wav');

    // Lower than tts's 60/60. one utterance per turn, and a turn can't be
    // quicker than the ~700ms of silence that ends it plus a reply.
    rate_limit('stt', 30, 60);

    // 4MB is ~2min of 16kHz mono PCM16, way past voice.js's 30s cap on one
    // utterance. keep it in step with nginx client_max_body_size, PHP
    // post_max_size and STT_MAX_BYTES in tts/server.py, all four have to let
    // it through.
    $rawBody = read_body(4 * 1024 * 1024);
    if ($rawBody === '') fail(400, 'invalid_request');

    $ch = curl_init($ttsUrl . '/stt');
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_POST, true);
    curl_setopt($ch, CURLOPT_POSTFIELDS, $rawBody);
    // "Expect:" turns off libcurl's 100-continue handshake. it adds that by
    // itself for any body over 1KB and an utterance is ~160KB. if the sidecar
    // doesn't answer with 100 Continue, libcurl sits there a full second
    // before it sends the body, which is bigger than every other saving in
    // the voice path put together. tts.php doesn't need it, its JSON bodies
    // stay under 1KB.
    curl_setopt($ch, CURLOPT_HTTPHEADER, ['Content-Type: audio/wav', 'Expect:']);
    curl_setopt($ch, CURLOPT_CONNECTTIMEOUT, 5);
    curl_setopt($ch, CURLOPT_TIMEOUT, 60);
    $res = curl_exec($ch);
    $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);

    header('Content-Type: application/json');

    if ($res === false) {
        http_response_code(502);
        echo json_encode(['error' => 'tts_unreachable']);
        exit;
    }

    if ($code >= 500) {
        log_event(['msg' => 'stt_upstream_error', 'upstream_code' => $code]);
        fail(502, 'stt_failed');
    }

    http_response_code($code);
    echo $res;
    exit;
}

http_response_code(400);
header('Content-Type: application/json');
echo json_encode(['error' => 'unknown_action']);
