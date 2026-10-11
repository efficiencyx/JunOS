<?php

// llama-server runs in router mode (docker/llamacpp-entrypoint.sh,
// or start.ps1 on windows): one server, every model in a preset,
// each loaded on demand. its management endpoints sit next to /v1,
// not under it, so this talks to the bare base URL.
function llamacpp_api_json(string $path, ?array $post = null, int $timeout = 3): array {
    $ch = curl_init(rtrim(env_str('LLAMACPP_URL', 'http://127.0.0.1:8081'), '/') . $path);
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

// TITLE_MODEL is written ollama style (hf.co/owner/repo:quant). the
// router names the preset without the hf.co/
function llamacpp_title_model(): string {
    $model = preg_replace('#^hf\.co/#', '', title_model());
    return str_contains($model, '/') ? $model : '';
}

// id => loaded / loading / unloaded. a llama-server of your own that
// isn't a router has no status field, its one model counts as loaded
function llamacpp_models(): array {
    $models = [];
    foreach ((llamacpp_api_json('/v1/models')['data'] ?? []) as $m) {
        if (!is_string($m['id'] ?? null)) continue;
        $models[$m['id']] = (string)($m['status']['value'] ?? 'loaded');
    }
    return $models;
}

// per model. asking about one that isn't loaded makes the router
// load it, so only ever ask about the model she's about to use
function llamacpp_props(string $model): array {
    static $cache = [];
    if (!isset($cache[$model])) {
        $cache[$model] = llamacpp_api_json('/props?model=' . rawurlencode($model), null, 10);
    }
    return $cache[$model];
}

function llamacpp_model_supports_audio(string $model): bool {
    return !empty(llamacpp_props($model)['modalities']['audio']);
}

function llamacpp_num_ctx(string $model): int {
    return (int)(llamacpp_props($model)['default_generation_settings']['n_ctx'] ?? 0);
}

// a second chat model loading next to the first one gets sized by
// --fit off whatever VRAM is left, which is a CPU spill on most
// cards. so the old one goes first, whether it's her in the picker
// switching or karaoke wanting the card for demucs (the vocal
// splitter). the title model stays, it's on the CPU anyway.
function llamacpp_unload_chat_models(string $keep = ''): void {
    $title = llamacpp_title_model();
    foreach (llamacpp_models() as $id => $state) {
        if ($id === $keep || $id === $title || $state === 'unloaded') continue;
        llamacpp_api_json('/models/unload', ['model' => $id], 10);
    }
}

// the llama.cpp half of generate_chat_title(). Qwen3's jinja takes
// enable_thinking:false and closes the think block on its own, so
// no prefill like the ollama call needs. prefill it here and it
// echoes the empty <think></think> straight back into the title.
function llamacpp_title(string $model, string $msg): string {
    $obj = llamacpp_api_json('/v1/chat/completions', [
        'model' => $model,
        'messages' => [['role' => 'user', 'content' => $msg]],
        'chat_template_kwargs' => ['enable_thinking' => false],
        'temperature' => 0,
        'max_tokens' => 24,
    ], 20);
    return (string)($obj['choices'][0]['message']['content'] ?? '');
}
