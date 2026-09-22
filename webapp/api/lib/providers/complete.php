<?php

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
    $reply = provider_complete_tools($provider, $model, $messages, [], $maxTokens, $think, $reasoning);
    return $reply['content'] !== '' ? $reply['content'] : null;
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
        // same shape as provider_chat_payload(). you ask for thinking by
        // LEAVING `think` out and letting reasoning_effort drive the
        // template. send think:true and Ollama runs a capability check
        // the Jun GGUFs fail, then 400s in your face.
        if (!$think) $payload['think'] = false;
    }

    $obj = provider_post_chat($provider, $payload, $error);
    if ($obj === null) {
        log_event(['msg' => 'complete_error', 'provider' => $provider, 'tools' => (bool)$tools, 'err' => $error]);
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

function generate_chat_title(string $userMessage): ?string {
    if (ai_provider() !== 'ollama') return null;
    $model = title_model();
    if ($model === '') return null;

    $msg = spoken_text($userMessage);
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
            // Qwen3 spends the title budget thinking and comes back
            // with empty content. its template leaves off <|im_end|>
            // after a trailing assistant turn, so we prefill (write the
            // start of its answer for it) a closed think block.
            // think: false and /no_think both do nothing here.
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
