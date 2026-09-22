<?php

function ollama_api_json(string $path, ?array $post = null, int $timeout = 3): array {
    $ch = curl_init(chat_api_base('ollama') . $path);
    $opts = [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_CONNECTTIMEOUT => 2,
        CURLOPT_TIMEOUT => $timeout,
    ];
    if ($post !== null) {
        $opts[CURLOPT_POST] = true;
        $opts[CURLOPT_POSTFIELDS] = json_encode($post);
        $opts[CURLOPT_HTTPHEADER] = ['Content-Type: application/json'];
    }
    curl_setopt_array($ch, $opts);
    $response = curl_exec($ch);
    curl_close($ch);
    $data = is_string($response) ? json_decode($response, true) : null;
    return is_array($data) ? $data : [];
}

// ollama reports a model we created as jun-mtp:latest, we ask for
// jun-mtp. compare without the implied tag or nothing matches.
function ollama_model_name(string $name): string {
    return preg_replace('/:latest$/', '', $name);
}

function ollama_model_weights_mb(string $model): int {
    static $cache = [];
    if (isset($cache[$model])) return $cache[$model];
    foreach ((ollama_api_json('/api/tags')['models'] ?? []) as $entry) {
        if (ollama_model_name((string)($entry['name'] ?? '')) !== ollama_model_name($model)) continue;
        return $cache[$model] = (int)round(((int)($entry['size'] ?? 0)) / 1048576);
    }
    return $cache[$model] = 0;
}

// Ollama picks its layer split ONCE, off whatever VRAM was free
// when the model loaded. keep_alive=-1 then pins that split for
// Ever. so if something else had the GPU at load time, every
// later reply drags along the layers it dumped on CPU. evicting
// her lets the next load fit an idle card again.
function ollama_evict_if_partially_offloaded(string $model): void {
    static $done = false;
    if ($done || ai_provider() !== 'ollama') return;
    $done = true;

    // only worth doing when the weights plus a bit of working room
    // actually fit on the card. when they don't, a partial offload is
    // the best it can do and evicting just reloads it badly once per
    // message.
    if (gpu_ctx_headroom_mb() <= 0) return;

    $loaded = null;
    foreach ((ollama_api_json('/api/ps')['models'] ?? []) as $entry) {
        if (ollama_model_name((string)($entry['name'] ?? '')) === ollama_model_name($model)) { $loaded = $entry; break; }
    }
    if ($loaded === null) return;

    $size = (float)($loaded['size'] ?? 0);
    $vram = (float)($loaded['size_vram'] ?? 0);
    if ($size <= 0 || $vram / $size >= 0.9) return;

    // one eviction per cooldown. if it comes back just as badly then
    // something we don't control has the VRAM, and reloading every
    // single turn is worse than just being slow.
    $stamp = state_dir() . '/ollama-refit.stamp';
    $last = is_file($stamp) ? (int)@file_get_contents($stamp) : 0;
    if (time() - $last < 600) return;
    @file_put_contents($stamp, (string)time());

    log_event([
        'msg' => 'ollama_partial_offload_evict',
        'model' => $model,
        'size_vram' => (int)$vram,
        'size' => (int)$size,
    ]);
    ollama_api_json('/api/generate', ['model' => $model, 'keep_alive' => 0], 10);
}

// fails closed. no answer from Ollama, a timeout, an old build
// with no capabilities list, all of it means no audio and the
// turn goes through whisper instead.
function ollama_model_supports_audio(string $model): bool {
    static $cache = [];
    if (isset($cache[$model])) return $cache[$model];
    $caps = ollama_api_json('/api/show', ['model' => $model])['capabilities'] ?? null;
    return $cache[$model] = is_array($caps) && in_array('audio', $caps, true);
}
