<?php

// how many MiB the KV cache (the model's memory of the prompt it
// already read) takes per token at q8_0 on the models we ship.
// read straight off llama.cpp's own kv_cache size line. rounded
// up on purpose. too high and we lose a bit of context. too low
// and she gets a partial offload, layers pushed onto the CPU.
const KV_MIB_PER_TOKEN = 0.2;

const VRAM_RESERVE_MB = 2048;

const CTX_TIERS = [6144, 8192, 12288, 16384];

// NOT num_predict -1 ("no limit") on a thinking turn. the client
// picks think, so any logged-in user could park the runner for
// the full 600s nginx timeout (or burn openrouter credit) on
// every turn. 16k is more than any real trace needs and still a
// ceiling.
const THINK_MAX_TOKENS = 16384;

// 128 is only enough for pre-v7 models. every v7 row carries a
// trace (her thinking text), even at <think:low>, so she thinks
// on every turn. think:false only makes ollama throw the trace
// away, the tokens still come out of num_predict. a low trace is
// ~115 tokens p50 (the median), ~165 max, and it ends with the
// reply, so the reply gets Paid twice. past the cap she never
// gets to speak and the browser sees reply_truncated_in_thinking.
// 512 fits worst-case low plus a long answer and is still a
// ceiling.
const PLAIN_MAX_TOKENS = 512;

const CHAT_TEMPERATURE = 0.4;

// what's left on the card once the weights and a bit of working
// room are gone, can go negative. null when we don't know the GPU
// size (OMEGA_GPU_VRAM_MB, from start.sh / start.ps1) or the
// weights. also null when ollama lives on another machine,
// OMEGA_GPU_VRAM_MB is THIS box's card. a remote one gets
// OMEGA_NUM_CTX instead, colab.ipynb prints it
function gpu_ctx_headroom_mb(): ?int {
    if (model_server_is_remote()) return null;
    $vram = (int)env_str('OMEGA_GPU_VRAM_MB', '0');
    if ($vram <= 0) return null;
    $weights = ollama_model_weights_mb(default_chat_model());
    if ($weights <= 0) return null;
    return (int)($vram - VRAM_RESERVE_MB - $weights);
}

function ctx_tier_for_headroom(int $headroomMb): int {
    $fits = (int)(max(0, $headroomMb) / KV_MIB_PER_TOKEN);
    $ctx = CTX_TIERS[0];
    foreach (CTX_TIERS as $tier) {
        if ($fits >= $tier) $ctx = $tier;
    }
    return $ctx;
}

function default_num_ctx(): int {
    static $ctx = null;
    if ($ctx !== null) return $ctx;
    $override = (int)env_str('OMEGA_NUM_CTX', '0');
    if ($override > 0) return $ctx = $override;

    // VRAM is what ACTUALLY limits the KV cache, so a known card
    // always decides. a crowded one still gets the smallest tier,
    // a few layers spilling to CPU beats a window too small to talk.
    $headroom = gpu_ctx_headroom_mb();
    if ($headroom !== null) return $ctx = ctx_tier_for_headroom($headroom);

    $gib = 0.0;
    $meminfo = @file_get_contents('/proc/meminfo');
    if ($meminfo && preg_match('/^MemTotal:\s+(\d+)\s*kB/m', $meminfo, $m)) {
        $gib = (int)$m[1] / (1024 * 1024);
    }
    if ($gib <= 0) return $ctx = 16384;
    // only reached with no card size (CPU, or a GPU nobody could
    // probe). MemTotal comes in a bit under the number on the box,
    // so the tiers sit just above it.
    if ($gib <= 17) return $ctx = 6144;
    if ($gib <= 25) return $ctx = 8192;
    if ($gib <= 33) return $ctx = 12288;
    return $ctx = 16384;
}

// how many tokens the window holds, before anything is put in it.
// zero for openrouter, the model behind it is whatever the user
// picked and we have no idea what its window is.
function provider_window_tokens(string $provider, string $model = ''): int {
    if ($provider === 'llamacpp') return llamacpp_window_tokens($model !== '' ? $model : default_chat_model());
    if ($provider === 'vllm') return vllm_window_tokens($model !== '' ? $model : default_chat_model());
    if ($provider === 'openrouter') return 0;
    return default_num_ctx();
}

// openrouter has no window we know of, budgets still need a number
function chat_window_tokens(): int {
    return provider_window_tokens(ai_provider()) ?: default_num_ctx();
}

// whatever --fit gave her, read back off the server. capped at 16k
// (or OMEGA_NUM_CTX) because the 16k ceiling in the preset only
// lands on gemma4 GGUFs, a GGUF of your own can come up at 40k+
// and then we'd happily send 40k of history
function llamacpp_window_tokens(string $model): int {
    $cap = (int)env_str('OMEGA_NUM_CTX', '0');
    if ($cap <= 0) $cap = CTX_TIERS[count(CTX_TIERS) - 1];
    $n = llamacpp_num_ctx($model);
    return $n > 0 ? min($n, $cap) : $cap;
}

// overflow drops the FRONT of the prompt, system rules included.
// so we throw out whole oldest turns ourselves and keep the
// system message and the newest turns. budget is 4 bytes/token
// against Gemma's ~3.7, minus a reserve for the reply and the
// tool results that land mid-turn.
// llama.cpp prompt_tokens on the 12B mmproj: a 512 px frame ~123,
// audio exactly 25 a second (source: trust me bro)
const MEDIA_IMAGE_TOKENS = 130;
const MEDIA_AUDIO_TOKENS_PER_S = 25;

function message_media_tokens(array $m): int {
    $tokens = count($m['media']['images'] ?? []) * MEDIA_IMAGE_TOKENS;
    foreach ($m['media']['audio'] ?? [] as $wav) {
        $seconds = max(0, strlen($wav) * 3 / 4 - 44) / 32000;
        $tokens += (int)ceil($seconds * MEDIA_AUDIO_TOKENS_PER_S);
    }
    return $tokens;
}

function fit_messages_to_context(array $messages, int $numCtx, int $reserve = 1024): array {
    $budget = $numCtx - $reserve;
    if ($numCtx <= 0 || $budget <= 0 || count($messages) <= 5) return $messages;
    $cost = static function (array $m): int {
        // +8 for the role and the turn markers the template wraps it in
        return (int)(strlen((string)($m['content'] ?? '')) / 4) + 8 + message_media_tokens($m);
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
    if ($provider === 'llamacpp') return llamacpp_window_tokens((string)($payload['model'] ?? default_chat_model()));
    if ($provider === 'vllm') return vllm_window_tokens((string)($payload['model'] ?? default_chat_model()));
    if (provider_uses_openai_protocol($provider)) return 0;
    return (int)($payload['options']['num_ctx'] ?? 0);
}
