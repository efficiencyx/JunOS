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
    // The boot screen hits this every 1-3s and OpenRouter's catalog is about
    // 1-2 MB, so keep the id list we pulled out on disk and give back an old
    // one when they error, instead of hammering their public API.
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
            // Upstream hiccup. an old list is better than an error page.
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
        // Neither of these is something you can chat with. The drafter can't
        // hold a conversation at all - ask for it and ollama loads it on its
        // own, llama.cpp says "Gemma4Assistant requires ctx_other to be set"
        // and the server exits, which reaches you as an empty reply. jun-mtp
        // can, but it's the model below it with a drafter bolted on, so
        // offering both is offering the same Jun twice.
        //
        // /api/tags always writes the tag out, .env usually doesn't, so fill
        // in :latest before comparing or `jun-mtp` never matches.
        $withTag = fn(string $n): string => strpos($n, ':') === false ? "$n:latest" : $n;
        $hidden = [];
        foreach ([env_str('OLLAMA_MTP'), ollama_mtp_model()] as $name) {
            if ($name !== '') $hidden[] = $withTag($name);
        }
        $models = [];
        foreach ($data['models'] as $m) {
            if (!isset($m['name'])) continue;
            if ($m['name'] === $titleModel || stripos($m['name'], 'title') !== false) continue;
            if (in_array($withTag($m['name']), $hidden, true)) continue;
            $models[] = $m['name'];
        }
    }
}

if (!is_array($models)) fail(502, 'upstream_unavailable');

echo json_encode([
    'models' => $models,
    'provider' => $provider,
    'default_model' => display_chat_model(),
]);
