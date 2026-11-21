<?php

const GATE_ASK = "\n\n(OOC, not part of the scene: before Jun does anything, pick what she does next. "
    . 'SPEAK = she says something. ACT = only a face or body reaction, no words. WAIT = she stays as she is, nothing.)';
const GATE_ACT = '(OOC stage direction, not spoken by Anon: ONLY an action this time, a look, a smile, a shrug. No chat or text!)';

// never trained to gate, asked for one word she just starts replying. so "Pick:"
// goes in her mouth (10/10 on v9 E4B, ~150 ms). no grammar, llama-server
// refuses one next to tools, and dropping the tools = KV cache miss
function chat_gate(string $provider, array $payload, string $fallback, string $cue): string {
    $last = count($payload['messages']) - 1;
    if ($last < 0 || !is_string($payload['messages'][$last]['content'] ?? null)) return $fallback;
    $payload['messages'][$last]['content'] .= GATE_ASK;
    $payload['messages'][] = ['role' => 'assistant', 'content' => 'Pick:'];
    $payload['stream'] = false;
    unset($payload['stream_options']);
    $openai = provider_uses_openai_protocol($provider);
    if ($openai) $payload['max_tokens'] = 6;
    else $payload['options']['num_predict'] = 6;
    if ($provider === 'vllm') $payload += ['continue_final_message' => true, 'add_generation_prompt' => false];

    $t = microtime(true);
    $obj = provider_post_chat($provider, $payload, $error);
    $text = (string)(($openai ? ($obj['choices'][0]['message']['content'] ?? '') : ($obj['message']['content'] ?? '')) ?: '');
    $pick = preg_match('/\b(speak|act|wait)\b/i', $text, $m) ? strtolower($m[1]) : $fallback;
    log_event(['msg' => 'gate', 'cue' => $cue, 'pick' => $pick, 'raw' => mb_substr($text, 0, 24),
        'ms' => (int)round((microtime(true) - $t) * 1000), 'err' => $error]);
    return $pick;
}

// in front of the budget token, that one stays dead last
function chat_gate_act(string $content): string {
    return preg_replace('/(\n\n<think:\w+>)$/', "\n\n" . GATE_ACT . '$1', $content, 1) ?? $content;
}

// v9 calls a tool right after the "Tool check:" line of her thinking. thinking
// off it never gets written (E4B 7/48), asked for it her first token names one
function chat_tool_check(string $provider, array $payload): string {
    $names = array_column(array_column($payload['tools'] ?? [], 'function'), 'name');
    $payload['messages'][] = ['role' => 'assistant', 'content' => 'Tool check:'];
    $payload['stream'] = false;
    unset($payload['stream_options']);
    $payload['temperature'] = 0;
    $payload['top_k'] = 1;
    $t = microtime(true);
    $pick = null;
    // " search" and " enter" start two tools each, those peek 3 more
    foreach ([1, 4] as $n) {
        $payload['max_tokens'] = $n;
        $obj = provider_post_chat($provider, $payload, $error);
        $said = (string)($obj['choices'][0]['message']['content'] ?? '');
        $pick = chat_tool_check_pick($said, $names);
        if ($pick !== null || $obj === null) break;
    }
    log_event(['msg' => 'tool_check', 'pick' => $pick ?: 'none', 'ms' => (int)round((microtime(true) - $t) * 1000), 'err' => $error]);
    return (string)$pick;
}

// '' = no tool, null = the prefix fits more than one
function chat_tool_check_pick(string $said, array $names): ?string {
    $word = strtolower(trim(preg_replace('/^\s*Tool check:/i', '', $said)));
    $word = preg_replace('/[^a-z_].*$/s', '', $word);
    if ($word === '') return '';
    $hits = array_values(array_filter($names, fn($n) => str_starts_with($n, $word)));
    if (count($hits) === 1) return $hits[0];
    return $hits ? null : '';
}
