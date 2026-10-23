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
            'messages' => $messages,
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
        'messages' => $messages,
        'stream' => true,
        'temperature' => CHAT_TEMPERATURE,
        'top_p' => 0.95,
        'top_k' => 80,
        'min_p' => 0.01,
        'stream_options' => ['include_usage' => true],
    ];
    $payload['max_tokens'] = $think ? THINK_MAX_TOKENS : PLAIN_MAX_TOKENS;
    if ($provider === 'openrouter' && $think) {
        $payload['reasoning'] = ['effort' => $reasoning];
    }
    // the GGUF's jinja with enable_thinking:X renders byte for byte
    // what ollama's gemma4 renderer does with think:X, <|think|> in
    // the system turn or not. so same switch, same prompt. vllm reads
    // the same kwarg off the safetensors repo's chat_template.jinja
    if ($provider === 'llamacpp' || $provider === 'vllm') {
        $payload['chat_template_kwargs'] = ['enable_thinking' => $think];
    }
    if ($provider === 'llamacpp') {
        $payload['messages'] = array_map('llamacpp_audio_parts', $messages);
    }
    return $payload;
}

function provider_chat_endpoint(string $provider): string {
    return provider_uses_openai_protocol($provider)
        ? chat_api_base($provider) . '/chat/completions'
        : chat_api_base($provider) . '/api/chat';
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

// prompt.php hangs the recording off `images` because that's the
// only field ollama reads media from. llama.cpp wants openai parts
// instead. audio FIRST, ollama puts the media tag in front of the
// text too. done here, last thing, so everything upstream keeps
// treating content as a string.
function llamacpp_audio_parts(array $message): array {
    if (empty($message['images'])) return $message;
    $parts = [];
    foreach ($message['images'] as $wav) {
        $parts[] = ['type' => 'input_audio', 'input_audio' => ['data' => $wav, 'format' => 'wav']];
    }
    $parts[] = ['type' => 'text', 'text' => (string)($message['content'] ?? '')];
    $message['content'] = $parts;
    unset($message['images']);
    return $message;
}
