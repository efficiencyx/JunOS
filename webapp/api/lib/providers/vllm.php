<?php

// vllm is how she runs on a TPU (colab.ipynb), ollama and llama.cpp
// can't drive one. plain openai API, so the only extra it gives us
// is /v1/models carrying max_model_len, the window it was started
// with. id => max_model_len
function vllm_models(): array {
    static $models = null;
    if ($models !== null) return $models;
    $ch = curl_init(chat_api_base('vllm') . '/models');
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HTTPHEADER => chat_request_headers('vllm'),
        CURLOPT_CONNECTTIMEOUT => 5,
        CURLOPT_TIMEOUT => 10,
    ]);
    $res = curl_exec($ch);
    $data = is_string($res) ? json_decode($res, true) : null;
    $models = [];
    foreach ((is_array($data) ? ($data['data'] ?? []) : []) as $m) {
        if (is_string($m['id'] ?? null)) $models[$m['id']] = (int)($m['max_model_len'] ?? 0);
    }
    return $models;
}

// vllm 400s any request whose max_tokens doesn't fit in
// max_model_len next to the prompt ("max_tokens=16384 cannot be
// greater than max_model_len=8192"). ollama and llama.cpp just stop
// when the window is full, so clamp to what the prompt leaves.
// bytes/3 overcounts gemma's ~3.7 bytes a token ON PURPOSE, a low
// guess is the same 400 again. tools count, the template prints them
function vllm_fit_max_tokens(array $payload): array {
    $window = vllm_models()[(string)($payload['model'] ?? '')] ?? 0;
    if ($window <= 0 || !isset($payload['max_tokens'])) return $payload;
    $prompt = (int)ceil(strlen(json_encode([$payload['messages'] ?? [], $payload['tools'] ?? []],
        JSON_UNESCAPED_UNICODE)) / 3) + 64;
    $payload['max_tokens'] = max(1, min((int)$payload['max_tokens'], $window - $prompt));
    return $payload;
}

// same 16k cap (or OMEGA_NUM_CTX) as llama.cpp. a 128k
// --max-model-len doesn't mean we want to send 128k of history
function vllm_window_tokens(string $model): int {
    $cap = (int)env_str('OMEGA_NUM_CTX', '0');
    if ($cap <= 0) $cap = CTX_TIERS[count(CTX_TIERS) - 1];
    $n = vllm_models()[$model] ?? 0;
    return $n > 0 ? min($n, $cap) : $cap;
}
