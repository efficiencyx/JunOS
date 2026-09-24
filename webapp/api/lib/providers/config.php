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
// off. MTP is multi-token prediction, a small drafter guesses a
// few tokens ahead and the big model only has to check them
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
// it right before we talk to ollama, otherwise she answers from
// the twin with no drafter attached and you lose the speedup
// without anything telling you.
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

// the little CPU-only model that names chats. models.php hides it
// from the picker, you can't chat with it.
function title_model(): string {
    return env_str('TITLE_MODEL', 'hf.co/efficiencyx/Titlewen-GGUF:F16');
}

function default_chat_model(): string {
    switch (ai_provider()) {
        case 'openrouter':
            return env_str('OPENROUTER_MODEL', 'openrouter/auto');
        case 'llamacpp':
            return env_str('LLAMACPP_MODEL_HF', 'efficiencyx/Jun-LoRA-E2B-GGUF:Q4_K_M');
        default:
            // with MTP on, the ollama entrypoint derives a model carrying
            // the drafter as a DRAFT layer, and chat has to ask for that
            // one. the model named in OLLAMA_MODELS_TO_PULL is the same
            // weights with no drafter attached, so talking to it silently
            // loses the speedup. same default name on both sides.
            $mtp = ollama_mtp_model();
            if ($mtp !== '') return $mtp;
            $configured = ollama_base_chat_model();
            if ($configured !== '') return $configured;

            foreach ((ollama_api_json('/api/tags')['models'] ?? []) as $entry) {
                $model = (string)($entry['name'] ?? '');
                if ($model !== '' && !preg_match('/embed/i', $model)) return $model;
            }

            return 'hf.co/efficiencyx/Jun-LoRA-E2B-GGUF:Q4_K_M';
    }
}

function provider_tools_enabled(): bool {
    if (ai_provider() === 'llamacpp') {
        // wants the server up with --jinja and a chat template that can
        // actually do tools. LLAMACPP_TOOLS=off is the escape hatch.
        return strtolower(env_str('LLAMACPP_TOOLS', 'on')) !== 'off';
    }
    return true;
}
