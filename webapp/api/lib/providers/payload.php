<?php

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
            'messages' => provider_messages($provider, $messages),
            'stream' => true,
            // keep her loaded between turns. an eviction takes the
            // KV prompt cache with it, so the next reply has to read
            // the whole prefix again.
            'keep_alive' => -1,
            'options' => [
                'reasoning_effort' => $reasoning,
                'temperature' => CHAT_TEMPERATURE,
                'top_p' => 0.95,
                'top_k' => 80,
                'min_p' => 0.01,
                'presence_penalty' => 0,
                'num_ctx' => default_num_ctx(),
                'num_predict' => $think ? THINK_MAX_TOKENS : PLAIN_MAX_TOKENS,
            ],
        ];
        if (!$think) $payload['think'] = false;
        return $payload;
    }

    $payload = [
        'model' => $model,
        'messages' => provider_messages($provider, $messages),
        'stream' => true,
        'temperature' => CHAT_TEMPERATURE,
        'top_p' => 0.95,
        'top_k' => 80,
        'min_p' => 0.01,
        'stream_options' => ['include_usage' => true],
    ];
    $payload['max_tokens'] = $think ? THINK_MAX_TOKENS : PLAIN_MAX_TOKENS;
    // the GGUF's jinja with enable_thinking:X renders byte for byte
    // what ollama's gemma4 renderer does with think:X, <|think|> in
    // the system turn or not. so same switch, same prompt. vllm reads
    // the same kwarg off the safetensors repo's chat_template.jinja
    if ($provider === 'llamacpp' || $provider === 'vllm') {
        $payload['chat_template_kwargs'] = ['enable_thinking' => $think];
    }
    if ($think && $provider === 'openai-compatible') $payload['reasoning_effort'] = $reasoning;
    // DRY, a penalty on reusing her own earlier lines word for word.
    // no "\n" breaker ON PURPOSE, she dodges via mid-sentence newlines. -1 = 400
    if ($provider === 'llamacpp') {
        $payload += [
            'dry_multiplier' => 0.4,
            'dry_base' => 1.75,
            'dry_allowed_length' => 3,
            'dry_penalty_last_n' => llamacpp_window_tokens($model),
            'dry_sequence_breakers' => [':', '"', '*', '[', '|', ']'],
        ];
    }
    return $payload;
}

// a trailing assistant message makes llama-server turn on
// continue_final_message, which injects an empty thought block in
// front of her reply and breaks the prefix on the next turn. an
// empty user turn closes hers with <turn|>\n<|turn>user\n instead.
function provider_chat_warm_payload(
    string $provider,
    string $model,
    array $messages,
    string $reasoning,
    bool $think,
    array $tools = []
): array {
    $last = $messages ? $messages[count($messages) - 1] : null;
    if (is_array($last) && ($last['role'] ?? '') === 'assistant') {
        $messages[] = ['role' => 'user', 'content' => ''];
    }
    $payload = provider_chat_payload($provider, $model, $messages, $reasoning, $think);
    $payload['stream'] = false;
    unset($payload['stream_options']);
    if ($tools) $payload['tools'] = $tools;
    if (!provider_uses_openai_protocol($provider)) {
        $payload['options']['num_predict'] = 0;
    } elseif ($provider === 'vllm') {
        $payload['max_tokens'] = 1;
    } else {
        $payload['max_tokens'] = 0;
        $payload['n_predict'] = 0;
        $payload['cache_prompt'] = true;
    }
    return $payload;
}

function provider_chat_endpoint(string $provider): string {
    return provider_uses_openai_protocol($provider)
        ? chat_api_base($provider) . '/chat/completions'
        : chat_api_base($provider) . '/api/chat';
}

// one bad UTF-8 byte and json_encode returns false, curl posts an
// empty body and the server 400s with "attempting to parse an empty input"
function provider_json_body(array $payload, int $flags = JSON_UNESCAPED_UNICODE): string {
    $body = json_encode($payload, $flags);
    if ($body !== false) return $body;
    $bad = [];
    foreach ($payload['messages'] ?? [] as $i => $m) {
        if (json_encode($m) === false) $bad[] = $i . ':' . ($m['role'] ?? '?');
    }
    log_event(['msg' => 'payload_not_json', 'err' => json_last_error_msg(), 'messages' => $bad]);
    return (string)json_encode($payload, $flags | JSON_INVALID_UTF8_SUBSTITUTE | JSON_PARTIAL_OUTPUT_ON_ERROR);
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

// arguments come back as an object from ollama and as a JSON string
// from the openai-style servers. anything unreadable is no args.
function tool_call_args(array $call): array {
    $args = $call['function']['arguments'] ?? [];
    if (is_string($args)) $args = json_decode($args, true);
    return is_array($args) ? $args : [];
}

// runs on EVERY round, or a tool round resends the raw messages
// and loses the recording. ollama only reads media out of `images`
// (tells wav from jpeg by the bytes), openai servers want parts.
// so only they get a [m:ss] label above each frame
function provider_messages(string $provider, array $messages): array {
    return array_map(fn($m) => provider_media_message($provider, $m), $messages);
}

function provider_media_message(string $provider, array $message): array {
    $media = $message['media'] ?? null;
    unset($message['media']);
    if (!is_array($media)) return $message;
    $images = $media['images'] ?? [];
    $audio = $media['audio'] ?? [];
    if (!$images && !$audio) return $message;
    if (!provider_uses_openai_protocol($provider)) {
        $message['images'] = [...$images, ...$audio];
        return $message;
    }
    $labels = $media['labels'] ?? [];
    $parts = [];
    foreach ($images as $i => $jpeg) {
        if (isset($labels[$i])) $parts[] = ['type' => 'text', 'text' => '[' . $labels[$i] . ']'];
        $parts[] = ['type' => 'image_url', 'image_url' => ['url' => 'data:image/jpeg;base64,' . $jpeg]];
    }
    foreach ($audio as $wav) {
        $parts[] = ['type' => 'input_audio', 'input_audio' => ['data' => $wav, 'format' => 'wav']];
    }
    $parts[] = ['type' => 'text', 'text' => (string)($message['content'] ?? '')];
    $message['content'] = $parts;
    return $message;
}
