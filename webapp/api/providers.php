<?php
// AI provider selection layer. Chat can run on Ollama (default, native NDJSON
// API), OpenRouter, or a llama.cpp llama-server (both OpenAI-compatible).
// Everything is driven by env vars; with none of them set the app behaves
// exactly as the original Ollama-only build.
//
//   AI_PROVIDER          ollama | openrouter | llamacpp   (default ollama)
//   OPENROUTER_API_KEY   Bearer key for openrouter
//   OPENROUTER_MODEL     default chat model id (default openrouter/auto)
//   OPENROUTER_BASE_URL  override for testing (default https://openrouter.ai/api/v1)
//   LLAMACPP_URL         base URL of llama-server (default http://127.0.0.1:8081)
//   LLAMACPP_MODEL_HF    HF repo:quant the managed server loads (llama-server -hf syntax)
//   LLAMACPP_TOOLS       off -> never offer tools to llama.cpp (templates without tool support)
//   EMBEDDINGS           on | off; default on only for ollama. Embeddings always
//                        run on Ollama's nomic-embed-text regardless of chat provider.
//   EMBEDDINGS_URL       where that Ollama lives (default OLLAMA_URL)

function ai_provider(): string {
    $p = strtolower(env_str('AI_PROVIDER', 'ollama'));
    return in_array($p, ['ollama', 'openrouter', 'llamacpp'], true) ? $p : 'ollama';
}

// OpenRouter and llama.cpp share the OpenAI-compatible request/stream path.
function provider_is_openai(?string $p = null): bool {
    $p = $p ?? ai_provider();
    return $p === 'openrouter' || $p === 'llamacpp';
}

// Base URL the chat endpoint lives under. For OpenAI-style providers this
// already includes the /v1 segment, so callers append just /chat/completions.
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
        // OpenRouter attribution headers (optional but recommended).
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
            // llama-server serves whatever it loaded; the id is mostly cosmetic.
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
