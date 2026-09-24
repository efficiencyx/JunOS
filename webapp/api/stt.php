<?php

require_once __DIR__ . '/lib/bootstrap.php';

require_user();

$action = $_GET['action'] ?? '';

if ($action === 'health') {
    $res = sidecar_call(tts_url() . '/health');
    if ($res['body'] === false || $res['code'] >= 500) json_out(['ok' => false, 'stt' => false]);
    sidecar_relay($res);
}

if ($action === 'stt') {
    require_post();
    require_content_type('audio/wav');

    // Lower than tts's 60/60. one utterance per turn, and a turn
    // can't be quicker than the ~700ms of silence that ends it plus a
    // reply.
    rate_limit('stt', 30, 60);

    // 4MB is ~2min of 16kHz mono PCM16, way past voice.js's 30s cap
    // on one utterance. keep it in step with nginx
    // client_max_body_size, PHP post_max_size and STT_MAX_BYTES in
    // tts/sidecar/config.py, all four have to let it through.
    $rawBody = read_body(4 * 1024 * 1024);
    if ($rawBody === '') fail(400, 'invalid_request');

    // "Expect:" turns off libcurl's 100-continue handshake. it adds
    // that by itself for any body over 1KB and an utterance is
    // ~160KB. if the sidecar doesn't answer with 100 Continue,
    // libcurl sits there a full second before it sends the body,
    // which is bigger than every other saving in the voice path put
    // together. tts.php doesn't need it, its JSON bodies stay under
    // 1KB.
    $res = sidecar_call(tts_url() . '/stt', $rawBody, ['Content-Type: audio/wav', 'Expect:'], 60);
    sidecar_check($res, 'stt_unreachable', 'stt_failed');
    sidecar_relay($res);
}

fail(400, 'unknown_action');
