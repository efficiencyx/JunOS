<?php

function ai_provider(): string {
    $p = strtolower(env_str('AI_PROVIDER', 'ollama'));
    return in_array($p, ['ollama', 'openrouter', 'llamacpp'], true) ? $p : 'ollama';
}

function provider_is_openai(?string $p = null): bool {
    $p = $p ?? ai_provider();
    return $p === 'openrouter' || $p === 'llamacpp';
}

function chat_api_base(): string {
    switch (ai_provider()) {
        case 'openrouter':
            return rtrim(env_str('OPENROUTER_BASE_URL', 'https://openrouter.ai/api/v1'), '/');
        case 'llamacpp':
            return rtrim(env_str('LLAMACPP_URL', 'http://127.0.0.1:8081'), '/') . '/v1';
        default:
            return rtrim(env_str('OLLAMA_URL', 'http://localhost:11434'), '/');
    }
}

function chat_request_headers(): array {
    $h = ['Content-Type: application/json'];
    if (ai_provider() === 'openrouter') {
        $key = env_str('OPENROUTER_API_KEY');
        if ($key !== '') $h[] = 'Authorization: Bearer ' . $key;
        $h[] = 'HTTP-Referer: https://github.com/efficiencyx/JunOS';
        $h[] = 'X-Title: Jun OS';
    }
    return $h;
}

function default_chat_model(): string {
    switch (ai_provider()) {
        case 'openrouter':
            return env_str('OPENROUTER_MODEL', 'openrouter/auto');
        case 'llamacpp':
            return env_str('LLAMACPP_MODEL_HF', 'efficiencyx/Jun-LoRA-v3-E2B-GGUF:Q4_K_M');
        default:
            return 'hf.co/efficiencyx/Jun-Lora-v2-GGUF:Q4_K_M';
    }
}

// RAG / cross-chat recall embeddings. Always served by Ollama (nomic-embed-text)
// so stored vectors stay byte-compatible; non-Ollama chat providers can opt in
// with EMBEDDINGS=on + a reachable Ollama, or leave them off and the vector
// features degrade silently (embed_text() returns null, every caller copes).
function embeddings_enabled(): bool {
    $v = strtolower(env_str('EMBEDDINGS'));
    if ($v === 'on') return true;
    if ($v === 'off') return false;
    return ai_provider() === 'ollama';
}

function embeddings_base_url(): string {
    return rtrim(env_str('EMBEDDINGS_URL', env_str('OLLAMA_URL', 'http://localhost:11434')), '/');
}

function provider_tools_enabled(): bool {
    if (ai_provider() === 'llamacpp') {
        // Needs the server running with --jinja and a tool-capable chat
        // template; LLAMACPP_TOOLS=off is the escape hatch when it isn't.
        return strtolower(env_str('LLAMACPP_TOOLS', 'on')) !== 'off';
    }
    return true;
}
