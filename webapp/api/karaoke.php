<?php

require_once __DIR__ . '/_lib.php';

require_user();

// KOKORO_URL is the pre-rename name of TTS_URL, honored for existing .env files.
$ttsUrl = rtrim(env_str('TTS_URL', env_str('KOKORO_URL', 'http://localhost:8001')), '/');
$action = $_GET['action'] ?? '';

// Source separation is heavy and long; one request evicts the chat model first,
// so 30/60s is generous headroom over any realistic karaoke session.
rate_limit('karaoke', 30, 60);

// 30MB ≈ a few minutes of compressed audio, well past a single song. Kept in
// step with nginx client_max_body_size, PHP post_max_size, and the sidecar's
// own upload cap - all have to allow it through.
const KARAOKE_MAX_BYTES = 30 * 1024 * 1024;

// Free the LLM's VRAM before demucs runs, so the two don't fight over the GPU.
// Best-effort and Ollama-only: /api/ps and keep_alive:0 are Ollama-specific, and
// a failed eviction must never block separation - worst case the two contend.
function evict_chat_model(): void {
    if (ai_provider() !== 'ollama') return;

    $ollamaUrl = rtrim(env_str('OLLAMA_URL', 'http://localhost:11434'), '/');

    $ch = curl_init($ollamaUrl . '/api/ps');
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_CONNECTTIMEOUT, 3);
    curl_setopt($ch, CURLOPT_TIMEOUT, 5);
    $res = curl_exec($ch);
    curl_close($ch);
    if ($res === false) return;

    $data = json_decode($res, true);
    $name = $data['models'][0]['name'] ?? null;
    if (!is_string($name) || $name === '') return;

    $ch = curl_init($ollamaUrl . '/api/generate');
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_POST, true);
    curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode(['model' => $name, 'keep_alive' => 0]));
    curl_setopt($ch, CURLOPT_HTTPHEADER, ['Content-Type: application/json']);
    curl_setopt($ch, CURLOPT_CONNECTTIMEOUT, 3);
    curl_setopt($ch, CURLOPT_TIMEOUT, 10);
    curl_exec($ch);
    curl_close($ch);
}

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
        echo json_encode(['ok' => false, 'sep' => false]);
        exit;
    }

    http_response_code($code);
    echo $res;
    exit;
}

if ($action === 'separate') {
    require_post();

    evict_chat_model();

    $rawBody = read_body(KARAOKE_MAX_BYTES);
    if ($rawBody === '') fail(400, 'invalid_request');

    $ch = curl_init($ttsUrl . '/separate');
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_POST, true);
    curl_setopt($ch, CURLOPT_POSTFIELDS, $rawBody);
    // "Expect:" disables libcurl's 100-continue handshake, which it adds for
    // bodies over 1KB - a song is megabytes, and a non-answering sidecar would
    // otherwise stall a full second before the body goes out.
    curl_setopt($ch, CURLOPT_HTTPHEADER, ['Content-Type: application/octet-stream', 'Expect:']);
    curl_setopt($ch, CURLOPT_CONNECTTIMEOUT, 5);
    curl_setopt($ch, CURLOPT_TIMEOUT, 300);
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
        log_event(['msg' => 'karaoke_separate_error', 'upstream_code' => $code]);
        fail(502, 'separate_failed');
    }

    http_response_code($code);
    echo $res;
    exit;
}

if ($action === 'stem') {
    $which = $_GET['which'] ?? '';
    $token = $_GET['token'] ?? '';
    if (!in_array($which, ['instrumental', 'guide'], true)) fail(400, 'invalid_request');
    if (!is_string($token) || !preg_match('/^[0-9a-f]+$/', $token)) fail(400, 'invalid_request');

    $url = $ttsUrl . '/separate/stem?token=' . urlencode($token) . '&which=' . urlencode($which);
    $ch = curl_init($url);
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_CONNECTTIMEOUT, 5);
    curl_setopt($ch, CURLOPT_TIMEOUT, 60);
    $res = curl_exec($ch);
    $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);

    if ($res === false) {
        http_response_code(502);
        header('Content-Type: application/json');
        echo json_encode(['error' => 'tts_unreachable']);
        exit;
    }

    if ($code >= 400) {
        log_event(['msg' => 'karaoke_stem_error', 'upstream_code' => $code]);
        http_response_code($code);
        header('Content-Type: application/json');
        echo json_encode(['error' => 'stem_failed']);
        exit;
    }

    http_response_code($code);
    header('Content-Type: audio/wav');
    echo $res;
    exit;
}

if ($action === 'transcribe') {
    require_post();

    $rawBody = read_body(KARAOKE_MAX_BYTES);
    if ($rawBody === '') fail(400, 'invalid_request');

    $ch = curl_init($ttsUrl . '/transcribe_timed');
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_POST, true);
    curl_setopt($ch, CURLOPT_POSTFIELDS, $rawBody);
    curl_setopt($ch, CURLOPT_HTTPHEADER, ['Content-Type: application/octet-stream', 'Expect:']);
    curl_setopt($ch, CURLOPT_CONNECTTIMEOUT, 5);
    curl_setopt($ch, CURLOPT_TIMEOUT, 300);
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
        log_event(['msg' => 'karaoke_transcribe_error', 'upstream_code' => $code]);
        fail(502, 'transcribe_failed');
    }

    http_response_code($code);
    echo $res;
    exit;
}

if ($action === 'lyrics') {
    header('Content-Type: application/json');

    $title = trim((string)($_GET['title'] ?? ''));
    $artist = trim((string)($_GET['artist'] ?? ''));
    $album = trim((string)($_GET['album'] ?? ''));
    $duration = (int)($_GET['duration'] ?? 0);

    if ($title === '') { echo json_encode(['found' => false]); exit; }

    // LRCLIB asks clients to identify themselves with a linked User-Agent.
    $ua = 'Jun-OS Karaoke (https://github.com/efficiencyx/jun)';
    $fetch = function (string $url) use ($ua): array {
        $ch = curl_init($url);
        curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
        curl_setopt($ch, CURLOPT_USERAGENT, $ua);
        curl_setopt($ch, CURLOPT_CONNECTTIMEOUT, 5);
        curl_setopt($ch, CURLOPT_TIMEOUT, 10);
        $res = curl_exec($ch);
        $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);
        return [$res, $code];
    };

    $base = 'https://lrclib.net/api';
    $result = null;

    // Exact-signature lookup first: LRCLIB matches artist+track+album+duration.
    if ($artist !== '' && $duration > 0) {
        $q = http_build_query([
            'artist_name' => $artist,
            'track_name'  => $title,
            'album_name'  => $album,
            'duration'    => $duration,
        ]);
        [$res, $code] = $fetch("$base/get?$q");
        if (is_string($res) && $code === 200) {
            $data = json_decode($res, true);
            if (is_array($data)) $result = $data;
        }
    }

    // Fall back to fuzzy search, preferring the first hit that carries synced lyrics.
    if ($result === null) {
        $q = http_build_query(['track_name' => $title, 'artist_name' => $artist]);
        [$res, $code] = $fetch("$base/search?$q");
        if (is_string($res) && $code === 200) {
            $list = json_decode($res, true);
            if (is_array($list) && $list) {
                $result = $list[0];
                foreach ($list as $item) {
                    if (!empty($item['syncedLyrics'])) { $result = $item; break; }
                }
            }
        }
    }

    if (!is_array($result)) { echo json_encode(['found' => false]); exit; }

    $synced = !empty($result['syncedLyrics']) && is_string($result['syncedLyrics']) ? $result['syncedLyrics'] : null;
    $plain = !empty($result['plainLyrics']) && is_string($result['plainLyrics']) ? $result['plainLyrics'] : null;
    if ($synced === null && $plain === null) { echo json_encode(['found' => false]); exit; }

    echo json_encode([
        'found'      => true,
        'synced'     => $synced,
        'plain'      => $plain,
        'trackName'  => $result['trackName'] ?? $title,
        'artistName' => $result['artistName'] ?? $artist,
    ]);
    exit;
}

http_response_code(400);
header('Content-Type: application/json');
echo json_encode(['error' => 'unknown_action']);
