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
        $h[] = 'HTTP-Referer: https://github.com/efficiencyx/Jun';
        $h[] = 'X-Title: Jun OS';
    }
    return $h;
}

function default_chat_model(): string {
    switch (ai_provider()) {
        case 'openrouter':
            return env_str('OPENROUTER_MODEL', 'openrouter/auto');
        case 'llamacpp':
            return env_str('LLAMACPP_MODEL_HF', 'efficiencyx/Jun-LoRA-v4-E2B-GGUF:Q4_K_M');
        default:
            $configured = array_map('trim', explode(',', env_str('OLLAMA_MODELS_TO_PULL')));
            foreach ($configured as $model) {
                if ($model !== '' && !preg_match('/embed/i', $model)) return $model;
            }

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

            return 'hf.co/efficiencyx/Jun-LoRA-v4-E2B-GGUF:Q4_K_M';
    }
}

function default_num_ctx(): int {
    static $ctx = null;
    if ($ctx !== null) return $ctx;
    $override = (int)env_str('OMEGA_NUM_CTX', '0');
    if ($override > 0) return $ctx = $override;
    $gib = 0.0;
    $meminfo = @file_get_contents('/proc/meminfo');
    if ($meminfo && preg_match('/^MemTotal:\s+(\d+)\s*kB/m', $meminfo, $m)) {
        $gib = (int)$m[1] / (1024 * 1024);
    }
    if ($gib <= 0) return $ctx = 16384;
    // MemTotal reports slightly under the nominal size, so tiers sit just above it.
    // System RAM is only a proxy: VRAM is what actually bounds the KV cache, so set
    // OMEGA_NUM_CTX by hand on machines where the two diverge.
    if ($gib <= 17) return $ctx = 6144;
    if ($gib <= 25) return $ctx = 8192;
    if ($gib <= 33) return $ctx = 12288;
    return $ctx = 16384;
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
            // Without a pin the chat model is the one Ollama evicts under VRAM pressure,
            // since the embedder holds its own; every eviction also wipes the KV prompt cache.
            'keep_alive' => -1,
            'options' => [
                'reasoning_effort' => $reasoning,
                'temperature' => 0.7,
                'top_p' => 0.95,
                'top_k' => 80,
                'min_p' => 0.01,
                'presence_penalty' => 0,
                'num_ctx' => default_num_ctx(),
                'num_predict' => $think ? -1 : 128,
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
    if (!$think) $payload['max_tokens'] = 128;
    if ($provider === 'openrouter' && $think) {
        $payload['reasoning'] = ['effort' => $reasoning];
    }
    return $payload;
}

function provider_complete_once(string $provider, string $model, array $messages, int $maxTokens = 512, bool $think = false, string $reasoning = 'medium'): ?string {
    $endpoint = provider_chat_endpoint($provider);
    if (provider_uses_openai_protocol($provider)) {
        $payload = ['model' => $model, 'messages' => $messages, 'stream' => false,
                    'temperature' => 0.3, 'max_tokens' => $maxTokens];
        if ($think && $provider === 'openrouter') $payload['reasoning'] = ['effort' => $reasoning];
    } else {
        $payload = ['model' => $model, 'messages' => $messages, 'stream' => false,
                    'keep_alive' => -1,
                    'options' => ['reasoning_effort' => $reasoning, 'temperature' => 0.3,
                                  'num_ctx' => default_num_ctx(), 'num_predict' => $maxTokens]];
        // Same shape as provider_chat_payload(): thinking is requested by *omitting*
        // `think` and letting reasoning_effort drive the template. Sending think:true
        // makes Ollama run a capability check the Jun GGUFs fail, and it 400s.
        if (!$think) $payload['think'] = false;
    }

    $ch = curl_init($endpoint);
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
    if ($resp === false || $status >= 300) {
        log_event(['msg' => 'complete_once_error', 'err' => $resp === false ? curl_error($ch) : 'http_' . $status]);
        curl_close($ch);
        return null;
    }
    curl_close($ch);

    $obj = json_decode($resp, true);
    if (!is_array($obj)) return null;
    $text = provider_uses_openai_protocol($provider)
        ? ($obj['choices'][0]['message']['content'] ?? null)
        : ($obj['message']['content'] ?? null);
    if (!is_string($text)) return null;
    $text = trim($text);
    return $text !== '' ? $text : null;
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
        'duration_ns' => 0,
    ];
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
        if ($token !== '') {
            $emit(['token' => $token]);
            $state['content'] .= $token;
        }
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
        if ($token !== '') {
            $emit(['token' => $token]);
            $state['content'] .= $token;
        }
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
    curl_setopt($ch, CURLOPT_TIMEOUT, 0);
    curl_setopt($ch, CURLOPT_CONNECTTIMEOUT, 10);

    if (!$openai) {
        curl_setopt($ch, CURLOPT_WRITEFUNCTION, function ($ch, $chunk) use (&$buf, &$state, $emit) {
            provider_parse_ollama_chunk($chunk, $buf, $state, $emit);
            return strlen($chunk);
        });
    } else {
        curl_setopt($ch, CURLOPT_WRITEFUNCTION, function ($ch, $chunk) use (&$buf, &$toolAcc, &$state, $emit) {
            if ($state['http_status'] === 0) {
                $state['http_status'] = (int)curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
            }
            if ($state['http_status'] >= 400) {
                $state['error_body'] .= $chunk;
                return strlen($chunk);
            }

            provider_parse_openai_chunk($chunk, $buf, $toolAcc, $state, $emit);
            return strlen($chunk);
        });
    }

    if (curl_exec($ch) === false) $state['curl_error'] = curl_error($ch);
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

function provider_context_size(string $provider, array $payload): int {
    if ($provider === 'llamacpp') return 16384;
    if (provider_uses_openai_protocol($provider)) return 0;
    return (int)($payload['options']['num_ctx'] ?? 0);
}

function provider_tools_enabled(): bool {
    if (ai_provider() === 'llamacpp') {
        // Needs the server running with --jinja and a tool-capable chat
        // template; LLAMACPP_TOOLS=off is the escape hatch when it isn't.
        return strtolower(env_str('LLAMACPP_TOOLS', 'on')) !== 'off';
    }
    return true;
}
