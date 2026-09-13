<?php

function ai_provider(): string {
    $p = strtolower(env_str('AI_PROVIDER', 'ollama'));
    return in_array($p, ['ollama', 'openrouter', 'llamacpp'], true) ? $p : 'ollama';
}

function provider_uses_openai_protocol(?string $p = null): bool {
    $p = $p ?? ai_provider();
    return $p === 'openrouter' || $p === 'llamacpp';
}

function chat_api_base(?string $provider = null): string {
    switch ($provider ?? ai_provider()) {
        case 'openrouter':
            return rtrim(env_str('OPENROUTER_BASE_URL', 'https://openrouter.ai/api/v1'), '/');
        case 'llamacpp':
            return rtrim(env_str('LLAMACPP_URL', 'http://127.0.0.1:8081'), '/') . '/v1';
        default:
            return rtrim(env_str('OLLAMA_URL', 'http://localhost:11434'), '/');
    }
}

function chat_request_headers(?string $provider = null): array {
    $provider = $provider ?? ai_provider();
    $h = ['Content-Type: application/json'];
    if ($provider === 'openrouter') {
        $key = env_str('OPENROUTER_API_KEY');
        if ($key !== '') $h[] = 'Authorization: Bearer ' . $key;
        $h[] = 'HTTP-Referer: https://github.com/efficiencyx/JunOS';
        $h[] = 'X-Title: Jun OS';
    }
    return $h;
}

// the MTP model when speculative decoding is on, empty when it's
// off
function ollama_mtp_model(): string {
    if (env_str('OLLAMA_MTP') === '') return '';
    return env_str('OLLAMA_MTP_MODEL', 'jun-mtp');
}

function ollama_base_chat_model(): string {
    foreach (array_map('trim', explode(',', env_str('OLLAMA_MODELS_TO_PULL'))) as $model) {
        if ($model !== '' && !preg_match('/embed/i', $model)) return $model;
    }
    return '';
}

// what the picker offers. jun-mtp is plumbing, it's the model
// below it with a drafter bolted on, so people pick the model
// they actually pulled and the swap happens down here where
// nobody has to think about it.
function display_chat_model(): string {
    $base = ollama_base_chat_model();
    if (ai_provider() === 'ollama' && ollama_mtp_model() !== '' && $base !== '') return $base;
    return default_chat_model();
}

// so the name coming back from the browser is the plain one. swap
// it RIGHT before we talk to ollama, otherwise she answers from
// the twin with no drafter attached and the speedup just quietly
// evaporates.
function ollama_resolve_chat_model(string $model): string {
    if (ai_provider() !== 'ollama') return $model;
    $mtp = ollama_mtp_model();
    if ($mtp === '') return $model;
    return $model === ollama_base_chat_model() ? $mtp : $model;
}

// speculative decoding with a long prompt can kill the MTP runner
// and leave Ollama returning 500 on every retry. the base
// fine-tune has the same weights without drafting, so fallback
// costs speed only. return empty unless this is the twin and a
// base exists.
function ollama_mtp_fallback_model(string $model): string {
    if (ai_provider() !== 'ollama') return '';
    $mtp = ollama_mtp_model();
    if ($mtp === '' || $model !== $mtp) return '';
    return ollama_base_chat_model();
}

function default_chat_model(): string {
    switch (ai_provider()) {
        case 'openrouter':
            return env_str('OPENROUTER_MODEL', 'openrouter/auto');
        case 'llamacpp':
            return env_str('LLAMACPP_MODEL_HF', 'efficiencyx/Jun-LoRA-E2B-GGUF:Q4_K_M');
        default:
            // with MTP on, the ollama entrypoint derives a model carrying the
            // drafter as a DRAFT layer and chat has to ask for THAT one. the
            // model named in OLLAMA_MODELS_TO_PULL is the same weights with no
            // drafter attached, so talking to it silently loses the speedup.
            // same default name on both sides.
            $mtp = ollama_mtp_model();
            if ($mtp !== '') return $mtp;
            $configured = ollama_base_chat_model();
            if ($configured !== '') return $configured;

            $ch = curl_init(chat_api_base('ollama') . '/api/tags');
            curl_setopt_array($ch, [
                CURLOPT_RETURNTRANSFER => true,
                CURLOPT_CONNECTTIMEOUT => 2,
                CURLOPT_TIMEOUT => 3,
            ]);
            $response = curl_exec($ch);
            curl_close($ch);
            $data = is_string($response) ? json_decode($response, true) : null;
            foreach (($data['models'] ?? []) as $entry) {
                $model = (string)($entry['name'] ?? '');
                if ($model !== '' && !preg_match('/embed/i', $model)) return $model;
            }

            return 'hf.co/efficiencyx/Jun-LoRA-E2B-GGUF:Q4_K_M';
    }
}

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

// how many MiB the KV cache (the model's memory of the prompt it
// already read) takes per token at q8_0 on the models we ship.
// read straight off llama.cpp's own kv_cache size line. rounded
// UP on purpose, guessing high costs us some context, guessing
// low costs a partial offload.
const KV_MIB_PER_TOKEN = 0.2;
const VRAM_RESERVE_MB = 2048;
const CTX_TIERS = [6144, 8192, 12288, 16384];

// a thinking turn used to go out with num_predict -1, meaning "no
// limit". the client picks think, so any logged-in user could
// park the runner for the full 600s nginx timeout (or burn
// openrouter credit) on every turn. 16k is more than any real
// trace needs and still a ceiling.
const THINK_MAX_TOKENS = 16384;

// what's left on the card once the weights and a bit of working
// room are gone. zero when we don't know the GPU size, see
// OMEGA_GPU_VRAM_MB in start.sh.
function gpu_ctx_headroom_mb(): int {
    $vram = (int)env_str('OMEGA_GPU_VRAM_MB', '0');
    if ($vram <= 0) return 0;
    $weights = ollama_model_weights_mb(default_chat_model());
    if ($weights <= 0) return 0;
    return (int)($vram - VRAM_RESERVE_MB - $weights);
}

function default_num_ctx(): int {
    static $ctx = null;
    if ($ctx !== null) return $ctx;
    $override = (int)env_str('OMEGA_NUM_CTX', '0');
    if ($override > 0) return $ctx = $override;

    // VRAM is what ACTUALLY limits the KV cache, so use it when the
    // card size made it here from start.sh. under 4 GiB of room the
    // answer would be a context too small to hold a conversation
    // anyway, so fall back to the RAM tiers and let Ollama spill
    // instead of cutting the window to nothing.
    $headroom = gpu_ctx_headroom_mb();
    if ($headroom >= 4096) {
        $fits = (int)($headroom / KV_MIB_PER_TOKEN);
        $ctx = CTX_TIERS[0];
        foreach (CTX_TIERS as $tier) {
            if ($fits >= $tier) $ctx = $tier;
        }
        return $ctx;
    }

    $gib = 0.0;
    $meminfo = @file_get_contents('/proc/meminfo');
    if ($meminfo && preg_match('/^MemTotal:\s+(\d+)\s*kB/m', $meminfo, $m)) {
        $gib = (int)$m[1] / (1024 * 1024);
    }
    if ($gib <= 0) return $ctx = 16384;
    // MemTotal always comes in a bit under the number on the box, so
    // the tiers sit just above it. system RAM is only a stand in,
    // VRAM is the real limit on the KV cache, so just set
    // OMEGA_NUM_CTX yourself on a machine where the two don't line
    // up.
    if ($gib <= 17) return $ctx = 6144;
    if ($gib <= 25) return $ctx = 8192;
    if ($gib <= 33) return $ctx = 12288;
    return $ctx = 16384;
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
    // ACTUALLY fit on the card. when they don't, a partial offload is
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

function provider_chat_payload(
    string $provider,
    string $model,
    array $messages,
    string $reasoning,
    bool $think
): array {
    if (!provider_uses_openai_protocol($provider)) {
        $payload = [
            'model' => $model,
            'messages' => $messages,
            'stream' => true,
            // keep her loaded between turns. an eviction takes the
            // KV prompt cache with it, so the next reply has to read
            // the whole prefix again.
            'keep_alive' => -1,
            'options' => [
                'reasoning_effort' => $reasoning,
                'temperature' => 0.7,
                'top_p' => 0.95,
                'top_k' => 80,
                'min_p' => 0.01,
                'presence_penalty' => 0,
                'num_ctx' => default_num_ctx(),
                'num_predict' => $think ? THINK_MAX_TOKENS : 128,
            ],
        ];
        if (!$think) $payload['think'] = false;
        return $payload;
    }

    $payload = [
        'model' => $model,
        'messages' => $messages,
        'stream' => true,
        'temperature' => 0.7,
        'top_p' => 0.95,
        'top_k' => 80,
        'min_p' => 0.01,
        'stream_options' => ['include_usage' => true],
    ];
    $payload['max_tokens'] = $think ? THINK_MAX_TOKENS : 128;
    if ($provider === 'openrouter' && $think) {
        $payload['reasoning'] = ['effort' => $reasoning];
    }
    return $payload;
}

function generate_chat_title(string $userMessage): ?string {
    if (ai_provider() !== 'ollama') return null;
    $model = env_str('TITLE_MODEL', 'hf.co/efficiencyx/Titlewen-GGUF:F16');
    if ($model === '') return null;

    $msg = preg_replace('/\[\s*A(?:CTIONS?)?\s*:[^\]]*\]/i', '', $userMessage);
    $msg = trim(preg_replace('/\s+/', ' ', $msg));
    if ($msg === '') return null;
    $msg = substr($msg, 0, 500);

    // num_gpu=0 keeps it on the CPU, keep_alive=-1 keeps it loaded.
    // it must NEVER take VRAM or a GPU slot off the pinned chat
    // model. see OLLAMA_MAX_LOADED_MODELS in compose.
    $result = ollama_api_json('/api/chat', [
        'model' => $model,
        'messages' => [
            // no system prompt, ON PURPOSE. the fine-tune turns a plain user
            // turn into a title, and any instruction in a system turn becomes
            // the loudest thing in a short context, so "hi" gets you a chat
            // called "Title Generation". amazing.
            ['role' => 'user', 'content' => $msg],
            // Qwen3 spends the title budget thinking and returns empty
            // content. its template leaves off <|im_end|> after a trailing
            // assistant turn, so prefill a closed think block. think: false
            // and /no_think do not work here.
            ['role' => 'assistant', 'content' => "<think>\n\n</think>\n\n"],
        ],
        'stream' => false,
        'keep_alive' => -1,
        'options' => [
            'num_gpu' => 0,
            'temperature' => 0,
            'num_predict' => 24,
        ],
    ], 20);

    $title = trim(provider_strip_think((string)($result['message']['content'] ?? '')));
    if ($title === '') return null;
    $title = trim(strtok($title, "\n"));
    $title = trim($title, " \t\n\r\0\x0B\"'");
    $title = trim(preg_replace('/\s+/', ' ', $title));
    $title = preg_replace('/^Title:\s*/i', '', $title);
    if (mb_strlen($title) > 60) {
        $title = mb_substr($title, 0, 60);
        $lastSpace = mb_strrpos($title, ' ');
        if ($lastSpace !== false) $title = mb_substr($title, 0, $lastSpace);
        $title = rtrim($title);
    }
    if ($title === '' || !preg_match('/[a-zA-Z]/', $title)) return null;
    return $title;
}

// one non-streaming chat call, decoded. null + $error on failure.
// same MTP fallback chat.php has: jun-mtp failing to load (the
// drafter wants its own VRAM even when the main weights got
// fitted to CPU) retries on the base tag. without it every
// consolidation and title call asked ollama to load the twin
// again, and a second 7 GB runner in the 16 GB container took
// the working one down with it.
function provider_post_chat(string $provider, array $payload, ?string &$error = null): ?array {
    $error = null;
    for ($attempt = 0; $attempt < 2; $attempt++) {
        $ch = curl_init(provider_chat_endpoint($provider));
        curl_setopt_array($ch, [
            CURLOPT_POST => true,
            CURLOPT_HTTPHEADER => chat_request_headers($provider),
            CURLOPT_POSTFIELDS => json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES),
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT => 120,
            CURLOPT_CONNECTTIMEOUT => 10,
        ]);
        $resp = curl_exec($ch);
        $status = (int)curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        $error = $resp === false ? curl_error($ch) : ($status >= 300 ? 'http_' . $status : null);
        curl_close($ch);
        if ($error === null) {
            $obj = json_decode($resp, true);
            if (is_array($obj)) return $obj;
            $error = 'invalid_response';
            return null;
        }
        $fallback = $status >= 400 ? ollama_mtp_fallback_model((string)($payload['model'] ?? '')) : '';
        if ($fallback === '') return null;
        log_event(['msg' => 'mtp_fallback', 'from' => $payload['model'], 'to' => $fallback, 'err' => $error]);
        $payload['model'] = $fallback;
    }
    return null;
}

function provider_complete_once(string $provider, string $model, array $messages, int $maxTokens = 512, bool $think = false, string $reasoning = 'medium'): ?string {
    if (provider_uses_openai_protocol($provider)) {
        $payload = ['model' => $model, 'messages' => $messages, 'stream' => false,
                    'temperature' => 0.3, 'max_tokens' => $maxTokens];
        if ($think && $provider === 'openrouter') $payload['reasoning'] = ['effort' => $reasoning];
    } else {
        $payload = ['model' => $model, 'messages' => $messages, 'stream' => false,
                    'keep_alive' => -1,
                    'options' => ['reasoning_effort' => $reasoning, 'temperature' => 0.3,
                                  'num_ctx' => default_num_ctx(), 'num_predict' => $maxTokens]];
        // same shape as provider_chat_payload(). you ask for thinking by
        // LEAVING `think` out and letting reasoning_effort drive the
        // template. send think:true and Ollama runs a capability check
        // the Jun GGUFs fail, then 400s in your face.
        if (!$think) $payload['think'] = false;
    }

    $obj = provider_post_chat($provider, $payload, $error);
    if ($obj === null) {
        log_event(['msg' => 'complete_once_error', 'err' => $error]);
        return null;
    }
    $text = provider_uses_openai_protocol($provider)
        ? ($obj['choices'][0]['message']['content'] ?? null)
        : ($obj['message']['content'] ?? null);
    if (!is_string($text)) return null;
    $text = provider_strip_think($text);
    return $text !== '' ? $text : null;
}

function provider_complete_tools(string $provider, string $model, array $messages, array $tools, int $maxTokens = 1024, bool $think = false, string $reasoning = 'medium'): array {
    if (provider_uses_openai_protocol($provider)) {
        $payload = [
            'model' => $model,
            'messages' => $messages,
            'stream' => false,
            'temperature' => 0.3,
            'max_tokens' => $maxTokens,
        ];
        if ($tools) $payload['tools'] = $tools;
        if ($think && $provider === 'openrouter') $payload['reasoning'] = ['effort' => $reasoning];
    } else {
        $payload = [
            'model' => $model,
            'messages' => $messages,
            'stream' => false,
            'keep_alive' => -1,
            'options' => [
                'reasoning_effort' => $reasoning,
                'temperature' => 0.3,
                'num_ctx' => default_num_ctx(),
                'num_predict' => $maxTokens,
            ],
        ];
        if ($tools) $payload['tools'] = $tools;
        if (!$think) $payload['think'] = false;
    }

    $obj = provider_post_chat($provider, $payload, $error);
    if ($obj === null) {
        log_event(['msg' => 'complete_tools_error', 'provider' => $provider, 'err' => $error]);
        return ['content' => '', 'tool_calls' => [], 'error' => $error];
    }
    $message = provider_uses_openai_protocol($provider)
        ? ($obj['choices'][0]['message'] ?? null)
        : ($obj['message'] ?? null);
    if (!is_array($message)) return ['content' => '', 'tool_calls' => [], 'error' => 'invalid_response'];
    return [
        'content' => is_string($message['content'] ?? null) ? provider_strip_think($message['content']) : '',
        'tool_calls' => is_array($message['tool_calls'] ?? null) ? $message['tool_calls'] : [],
    ];
}

function provider_chat_endpoint(string $provider): string {
    return provider_uses_openai_protocol($provider)
        ? chat_api_base($provider) . '/chat/completions'
        : chat_api_base($provider) . '/api/chat';
}

function provider_stream_state(): array {
    return [
        'content' => '',
        'tool_calls' => [],
        'stats' => null,
        'done_reason' => '',
        'http_status' => 0,
        'error_body' => '',
        'stream_error' => false,
        'curl_error' => '',
        'aborted' => '',
        'duration_ns' => 0,
        'think_open' => false,
        'think_hold' => '',
    ];
}

function provider_strip_think(string $text): string {
    $text = preg_replace('/<think>.*?<\/think>/is', '', $text);
    $text = preg_replace('/^\s*<think>.*$/is', '', $text);
    return trim($text);
}

function provider_route_think_token(string $token, array &$state, callable $emit): void {
    $buf = $state['think_hold'] . $token;
    $state['think_hold'] = '';

    while ($buf !== '') {
        $tag = $state['think_open'] ? '</think>' : '<think>';
        $pos = stripos($buf, $tag);
        if ($pos === false) break;
        $head = substr($buf, 0, $pos);
        if ($head !== '') {
            if ($state['think_open']) {
                $emit(['thinking' => $head]);
            } else {
                $emit(['token' => $head]);
                $state['content'] .= $head;
            }
        }
        $buf = substr($buf, $pos + strlen($tag));
        $state['think_open'] = !$state['think_open'];
    }

    if ($buf === '') return;

    // a tag can straddle two stream chunks, so hold back the start of
    // one
    $tag = $state['think_open'] ? '</think>' : '<think>';
    $hold = 0;
    for ($n = min(strlen($tag) - 1, strlen($buf)); $n > 0; $n--) {
        if (strcasecmp(substr($buf, -$n), substr($tag, 0, $n)) === 0) {
            $hold = $n;
            break;
        }
    }
    if ($hold > 0) {
        $state['think_hold'] = substr($buf, -$hold);
        $buf = substr($buf, 0, strlen($buf) - $hold);
    }
    if ($buf === '') return;

    if ($state['think_open']) {
        $emit(['thinking' => $buf]);
    } else {
        $emit(['token' => $buf]);
        $state['content'] .= $buf;
    }
}

function provider_flush_think_hold(array &$state, callable $emit): void {
    $rest = $state['think_hold'];
    $state['think_hold'] = '';
    if ($rest === '') return;
    if ($state['think_open']) {
        $emit(['thinking' => $rest]);
    } else {
        $emit(['token' => $rest]);
        $state['content'] .= $rest;
    }
}

function provider_parse_ollama_chunk(string $chunk, string &$buf, array &$state, callable $emit): void {
    $buf .= $chunk;
    while (($nl = strpos($buf, "\n")) !== false) {
        $line = trim(substr($buf, 0, $nl));
        $buf = substr($buf, $nl + 1);
        if ($line === '') continue;
        $obj = json_decode($line, true);
        if (!is_array($obj)) continue;

        if (isset($obj['error'])) {
            $emit(['error' => (string)$obj['error']]);
            $state['stream_error'] = true;
            continue;
        }
        if (!empty($obj['done'])) {
            $state['done_reason'] = (string)($obj['done_reason'] ?? '');
        }
        if (!empty($obj['done']) && isset($obj['eval_count'])) {
            $state['stats'] = [
                'eval_count' => (int)($obj['eval_count'] ?? 0),
                'eval_duration' => (int)($obj['eval_duration'] ?? 0),
                'prompt_eval_count' => (int)($obj['prompt_eval_count'] ?? 0),
                'prompt_eval_duration' => (int)($obj['prompt_eval_duration'] ?? 0),
                'total_duration' => (int)($obj['total_duration'] ?? 0),
                'load_duration' => (int)($obj['load_duration'] ?? 0),
            ];
        }

        $thinking = (string)($obj['message']['thinking'] ?? '');
        if ($thinking !== '') $emit(['thinking' => $thinking]);

        $calls = $obj['message']['tool_calls'] ?? null;
        if (is_array($calls) && $calls) {
            $state['tool_calls'] = array_merge($state['tool_calls'], $calls);
        }

        $token = (string)($obj['message']['content'] ?? '');
        if ($token !== '') provider_route_think_token($token, $state, $emit);

        if (!empty($obj['done'])) provider_flush_think_hold($state, $emit);
    }
}

function provider_parse_openai_chunk(
    string $chunk,
    string &$buf,
    array &$toolAcc,
    array &$state,
    callable $emit
): void {
    $buf .= $chunk;
    while (($nl = strpos($buf, "\n")) !== false) {
        $line = rtrim(substr($buf, 0, $nl), "\r");
        $buf = substr($buf, $nl + 1);
        if ($line === '' || $line[0] === ':') continue;
        if (strncmp($line, 'data:', 5) !== 0) continue;
        $data = trim(substr($line, 5));
        if ($data === '[DONE]') continue;
        $obj = json_decode($data, true);
        if (!is_array($obj)) continue;

        if (isset($obj['error'])) {
            $message = is_array($obj['error'])
                ? (string)($obj['error']['message'] ?? 'upstream_error')
                : (string)$obj['error'];
            $emit(['error' => $message]);
            $state['stream_error'] = true;
            continue;
        }
        if (isset($obj['usage']) && is_array($obj['usage'])) {
            $state['stats'] = [
                'eval_count' => (int)($obj['usage']['completion_tokens'] ?? 0),
                'eval_duration' => 0,
                'prompt_eval_count' => (int)($obj['usage']['prompt_tokens'] ?? 0),
                'prompt_eval_duration' => 0,
                'total_duration' => 0,
                'load_duration' => 0,
            ];
        }
        $choice = $obj['choices'][0] ?? null;
        if (!is_array($choice)) continue;
        if (!empty($choice['finish_reason'])) {
            $state['done_reason'] = (string)$choice['finish_reason'];
        }
        $delta = is_array($choice['delta'] ?? null) ? $choice['delta'] : [];

        $thinking = (string)($delta['reasoning'] ?? $delta['reasoning_content'] ?? '');
        if ($thinking !== '') $emit(['thinking' => $thinking]);

        if (is_array($delta['tool_calls'] ?? null)) {
            foreach ($delta['tool_calls'] as $fragment) {
                if (!is_array($fragment)) continue;
                $index = (int)($fragment['index'] ?? 0);
                if (!isset($toolAcc[$index])) {
                    $toolAcc[$index] = ['id' => '', 'name' => '', 'arguments' => ''];
                }
                if (!empty($fragment['id'])) $toolAcc[$index]['id'] = (string)$fragment['id'];
                if (isset($fragment['function']['name'])) {
                    $toolAcc[$index]['name'] .= (string)$fragment['function']['name'];
                }
                if (isset($fragment['function']['arguments'])) {
                    $toolAcc[$index]['arguments'] .= (string)$fragment['function']['arguments'];
                }
            }
        }

        $token = (string)($delta['content'] ?? '');
        if ($token !== '') provider_route_think_token($token, $state, $emit);

        if (!empty($choice['finish_reason'])) provider_flush_think_hold($state, $emit);
    }
}

function provider_finish_openai_tool_calls(array $toolAcc, array &$state, int $round): void {
    foreach ($toolAcc as $index => $tool) {
        if ($tool['name'] === '') continue;
        $state['tool_calls'][] = [
            'id' => $tool['id'] !== '' ? $tool['id'] : 'call_' . $round . '_' . $index,
            'type' => 'function',
            'function' => ['name' => $tool['name'], 'arguments' => $tool['arguments']],
        ];
    }
}

// the ceilings on one upstream stream. a turn is every tool
// round of one chat.php request, so the deadline is shared and
// each round gets what's left. idle is curl's low speed check:
// under 1 byte/s for that many seconds and it hangs up. that has
// to cover a cold load plus prompt eval on a big context, which
// is minutes on CPU, so it's long. the byte caps are for a
// provider that streams garbage: a frame that never ends, a
// reply that never stops, an error page the size of a novel.
const STREAM_ERROR_BODY_MAX = 64 * 1024;
const STREAM_PENDING_MAX = 1024 * 1024;
const STREAM_CONTENT_MAX = 4 * 1024 * 1024;

function stream_turn_deadline(): float {
    static $deadline = null;
    if ($deadline === null) $deadline = microtime(true) + max(30, (int)env_str('OMEGA_TURN_TIMEOUT_S', '900'));
    return $deadline;
}

function provider_stream_round(string $provider, array $payload, callable $emit, int $round = 0): array {
    $openai = provider_uses_openai_protocol($provider);
    $state = provider_stream_state();
    $buf = '';
    $toolAcc = [];
    $started = microtime(true);

    $ch = curl_init(provider_chat_endpoint($provider));
    curl_setopt($ch, CURLOPT_POST, true);
    curl_setopt($ch, CURLOPT_HTTPHEADER, chat_request_headers($provider));
    curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($payload, JSON_UNESCAPED_UNICODE));
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, false);
    curl_setopt($ch, CURLOPT_TIMEOUT_MS, max(1000, (int)((stream_turn_deadline() - $started) * 1000)));
    curl_setopt($ch, CURLOPT_LOW_SPEED_LIMIT, 1);
    curl_setopt($ch, CURLOPT_LOW_SPEED_TIME, max(10, (int)env_str('OMEGA_STREAM_IDLE_S', '300')));
    curl_setopt($ch, CURLOPT_CONNECTTIMEOUT, 10);

    // returning anything but strlen($chunk) makes curl drop the
    // transfer. that's how every cap below hangs up on upstream.
    $abort = function (string $why) use (&$state, $emit): int {
        $state['aborted'] = $why;
        if ($why !== 'client_gone') {
            $state['stream_error'] = true;
            $emit(['error' => $why]);
        }
        return -1;
    };
    $overflowed = function () use (&$buf, &$state): bool {
        return strlen($buf) > STREAM_PENDING_MAX || strlen($state['content']) > STREAM_CONTENT_MAX;
    };

    if (!$openai) {
        curl_setopt($ch, CURLOPT_WRITEFUNCTION, function ($ch, $chunk) use (&$buf, &$state, $emit, $abort, $overflowed) {
            if (connection_aborted()) return $abort('client_gone');
            if ($state['http_status'] === 0) {
                $state['http_status'] = (int)curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
            }
            // a dead runner comes back as one 500 with a json body, and
            // parsing that as a stream chunk fires the error at the browser
            // before chat.php gets a say. hold it here so the caller can
            // decide to retry somewhere else first.
            if ($state['http_status'] >= 400) {
                if (strlen($state['error_body']) > STREAM_ERROR_BODY_MAX) return $abort('upstream_error');
                $state['error_body'] .= $chunk;
                return strlen($chunk);
            }
            provider_parse_ollama_chunk($chunk, $buf, $state, $emit);
            if ($overflowed()) return $abort('upstream_overflow');
            return strlen($chunk);
        });
    } else {
        curl_setopt($ch, CURLOPT_WRITEFUNCTION, function ($ch, $chunk) use (&$buf, &$toolAcc, &$state, $emit, $abort, $overflowed) {
            if (connection_aborted()) return $abort('client_gone');
            if ($state['http_status'] === 0) {
                $state['http_status'] = (int)curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
            }
            if ($state['http_status'] >= 400) {
                if (strlen($state['error_body']) > STREAM_ERROR_BODY_MAX) return $abort('upstream_error');
                $state['error_body'] .= $chunk;
                return strlen($chunk);
            }

            provider_parse_openai_chunk($chunk, $buf, $toolAcc, $state, $emit);
            if ($overflowed()) return $abort('upstream_overflow');
            return strlen($chunk);
        });
    }

    if (curl_exec($ch) === false && $state['aborted'] === '') {
        $state['curl_error'] = curl_errno($ch) === CURLE_OPERATION_TIMEDOUT
            ? 'timeout: ' . curl_error($ch) : curl_error($ch);
    }
    if ($state['http_status'] === 0) {
        $state['http_status'] = (int)curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    }
    curl_close($ch);
    $state['duration_ns'] = (int)round((microtime(true) - $started) * 1e9);

    if ($openai) provider_finish_openai_tool_calls($toolAcc, $state, $round);

    return $state;
}

function provider_tool_message(string $provider, string $name, string $callId, string $result): array {
    $message = [
        'role' => 'tool',
        'content' => $result,
        'tool_call_id' => $callId,
    ];
    if (!provider_uses_openai_protocol($provider)) $message['name'] = $name;
    return $message;
}

// how many tokens the window holds, before anything is put in it.
// zero for openrouter - the model behind it is whatever the user
// picked and we don't know its window.
function provider_window_tokens(string $provider): int {
    if ($provider === 'llamacpp') return 16384;
    if ($provider === 'openrouter') return 0;
    return default_num_ctx();
}

// overflow drops the FRONT of the prompt, including the system
// rules. discard whole oldest turns ourselves, keeping the system
// and newest turns. budget 4 bytes/token against Gemma's ~3.7,
// reserving space for the reply and tool results added mid-turn.
function fit_messages_to_context(array $messages, int $numCtx, int $reserve = 1024): array {
    $budget = $numCtx - $reserve;
    if ($numCtx <= 0 || $budget <= 0 || count($messages) <= 5) return $messages;
    $cost = static function (array $m): int {
        // +8 for the role and the turn markers the template wraps it in
        return (int)(strlen((string)($m['content'] ?? '')) / 4) + 8;
    };
    $total = 0;
    foreach ($messages as $m) $total += $cost($m);
    $floor = count($messages) - 4;
    $dropped = 0;
    for ($i = 1; $total > $budget && $i < $floor; $i++) {
        $total -= $cost($messages[$i]);
        unset($messages[$i]);
        $dropped++;
    }
    if ($dropped) log_event(['msg' => 'history_trimmed', 'dropped' => $dropped, 'num_ctx' => $numCtx]);
    return array_values($messages);
}

function provider_context_size(string $provider, array $payload): int {
    if ($provider === 'llamacpp') return 16384;
    if (provider_uses_openai_protocol($provider)) return 0;
    return (int)($payload['options']['num_ctx'] ?? 0);
}

function provider_tools_enabled(): bool {
    if (ai_provider() === 'llamacpp') {
        // wants the server up with --jinja and a chat template that can
        // actually do tools. LLAMACPP_TOOLS=off is the escape hatch.
        return strtolower(env_str('LLAMACPP_TOOLS', 'on')) !== 'off';
    }
    return true;
}
