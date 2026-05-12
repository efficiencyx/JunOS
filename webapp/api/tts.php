<?php
// Proxy for Kokoro TTS sidecar. Handles two routes:
//   GET  ?action=voices  → GET  {KOKORO_URL}/voices
//   POST ?action=tts     → POST {KOKORO_URL}/tts  (pass-through JSON body, returns audio)

$kokoroUrl = rtrim(getenv('KOKORO_URL') ?: 'http://localhost:8001', '/');
$action = $_GET['action'] ?? '';

if ($action === 'voices') {
    header('Content-Type: application/json');
    header('Cache-Control: no-cache');
    $ch = curl_init($kokoroUrl . '/voices');
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_CONNECTTIMEOUT, 5);
    curl_setopt($ch, CURLOPT_TIMEOUT, 10);
    $res = curl_exec($ch);
    $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    if ($res === false) {
        http_response_code(502);
        echo json_encode(['error' => 'kokoro unreachable']);
        exit;
    }
    http_response_code($code);
    echo $res;
    exit;
}

if ($action === 'tts' && $_SERVER['REQUEST_METHOD'] === 'POST') {
    $body = file_get_contents('php://input');
    $ch = curl_init($kokoroUrl . '/tts');
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_POST, true);
    curl_setopt($ch, CURLOPT_POSTFIELDS, $body);
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
        echo json_encode(['error' => 'kokoro unreachable']);
        exit;
    }
    http_response_code($code);
    if ($ct) header('Content-Type: ' . $ct);
    echo $res;
    exit;
}

http_response_code(400);
header('Content-Type: application/json');
echo json_encode(['error' => 'unknown action']);
