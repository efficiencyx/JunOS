<?php
// Proxy for the audio sidecar's STT endpoint. Two routes:
//   GET  ?action=health → GET  {TTS_URL}/health  ({"ok":..,"stt":bool})
//   POST ?action=stt    → POST {TTS_URL}/stt  (raw WAV body in, {"text":...} out)
//
// Mirrors tts.php, the other half of the voice loop, on the same sidecar. The
// body is a raw 16kHz mono WAV from js/voice.js rather than multipart - it's a
// single file with no metadata, so there's nothing for multipart to carry.

require_once __DIR__ . '/_lib.php';

require_user();

// KOKORO_URL is the pre-rename name of TTS_URL, honored for existing .env files.
$ttsUrl = rtrim(env_str('TTS_URL', env_str('KOKORO_URL', 'http://localhost:8001')), '/');
$action = $_GET['action'] ?? '';

if ($action === 'health') {
    // Whether this sidecar build actually has whisper, so the UI can disable the
    // mic toggle up front instead of failing on the first utterance.
    header('Content-Type: application/json');

    $ch = curl_init($ttsUrl . '/health');
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_CONNECTTIMEOUT, 5);
    curl_setopt($ch, CURLOPT_TIMEOUT, 10);
    $res = curl_exec($ch);
    $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);

    if ($res === false || $code >= 500) {
        // Unreachable is reported as "no stt" rather than an error: to the client
        // the outcome is identical (hide the mic), and it keeps the JSON shape.
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

    // Lower ceiling than tts's 60/60: one utterance per turn, and a turn can't
    // finish faster than the ~700ms of silence that ends it plus a reply.
    rate_limit('stt', 30, 60);

    // 4MB ≈ 2min of 16kHz mono PCM16, well past voice.js's 30s utterance cap.
    // Kept in step with nginx client_max_body_size, PHP post_max_size, and
    // STT_MAX_BYTES in tts/server.py - all four have to allow it through.
    $rawBody = read_body(4 * 1024 * 1024);
    if ($rawBody === '') fail(400, 'invalid_request');

    $ch = curl_init($ttsUrl . '/stt');
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_POST, true);
    curl_setopt($ch, CURLOPT_POSTFIELDS, $rawBody);
    // "Expect:" disables libcurl's 100-continue handshake, which it adds on its
    // own for bodies over 1KB - and an utterance is ~160KB. If the sidecar
    // doesn't answer with 100 Continue, libcurl stalls a full second before
    // sending the body, which would dwarf every other latency saving in the
    // voice path. tts.php doesn't need this: its JSON bodies stay under 1KB.
    curl_setopt($ch, CURLOPT_HTTPHEADER, ['Content-Type: audio/wav', 'Expect:']);
    curl_setopt($ch, CURLOPT_CONNECTTIMEOUT, 5);
    curl_setopt($ch, CURLOPT_TIMEOUT, 60);
    $res = curl_exec($ch);
    $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);

    header('Content-Type: application/json');

    if ($res === false) {
        // Same error key tts.php uses, so the client handles one shape for both.
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
