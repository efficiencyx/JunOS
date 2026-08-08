<?php
require_once __DIR__ . '/_lib.php';

header('Content-Type: application/json');

rate_limit('models', 30, 60);

function http_get_json(string $url, array $headers = [], int $timeout = 10): ?array {
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HTTPHEADER => $headers,
        CURLOPT_CONNECTTIMEOUT => 5,
        CURLOPT_TIMEOUT => $timeout,
    ]);
    $res = curl_exec($ch);
    if ($res === false) {
        log_event(['msg' => 'models_fetch_error', 'url' => $url, 'err' => curl_error($ch)]);
        curl_close($ch);
        return null;
    }
    $status = (int)curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    curl_close($ch);
    if ($status >= 400) {
        log_event(['msg' => 'models_fetch_http_error', 'url' => $url, 'status' => $status]);
        return null;
    }
    $data = json_decode($res, true);
    return is_array($data) ? $data : null;
}

$provider = ai_provider();
$models = null;

if ($provider === 'openrouter') {
    // The boot screen polls this endpoint every 1-3s and OpenRouter's catalog
    // is ~1-2 MB, so cache the extracted id list on disk and serve stale on
    // upstream errors rather than hammering their public API.
    header('Cache-Control: public, max-age=300');
    $cacheFile = state_dir() . '/openrouter_models.json';
    $ttl = 3600;

    if (is_readable($cacheFile) && time() - (int)filemtime($cacheFile) < $ttl) {
        $models = json_decode((string)file_get_contents($cacheFile), true);
    }
    if (!is_array($models)) {
        $data = http_get_json(chat_api_base() . '/models', chat_request_headers(), 20);
        if (is_array($data['data'] ?? null)) {
            $models = [];
            foreach ($data['data'] as $m) {
                if (isset($m['id']) && is_string($m['id'])) $models[] = $m['id'];
            }
            sort($models, SORT_STRING | SORT_FLAG_CASE);
            @file_put_contents($cacheFile, json_encode($models), LOCK_EX);
        } elseif (is_readable($cacheFile)) {
            // Upstream hiccup: a stale list beats an error page.
            $models = json_decode((string)file_get_contents($cacheFile), true);
        }
    }
} elseif ($provider === 'llamacpp') {
    header('Cache-Control: public, max-age=10');
    $data = http_get_json(chat_api_base() . '/models', chat_request_headers());
    if (is_array($data['data'] ?? null)) {
        $models = [];
        foreach ($data['data'] as $m) {
            if (isset($m['id']) && is_string($m['id'])) $models[] = $m['id'];
        }
    }
} else {
    header('Cache-Control: public, max-age=10');
    $data = http_get_json(rtrim(env_str('OLLAMA_URL', 'http://localhost:11434'), '/') . '/api/tags');
    if (is_array($data['models'] ?? null)) {
        $titleModel = env_str('TITLE_MODEL', 'hf.co/efficiencyx/Titlewen-GGUF:F16');
        $models = [];
        foreach ($data['models'] as $m) {
            if (!isset($m['name'])) continue;
            if ($m['name'] === $titleModel || stripos($m['name'], 'title') !== false) continue;
            $models[] = $m['name'];
        }
    }
}

if (!is_array($models)) fail(502, 'upstream_unavailable');

echo json_encode([
    'models' => $models,
    'provider' => $provider,
    'default_model' => default_chat_model(),
]);
