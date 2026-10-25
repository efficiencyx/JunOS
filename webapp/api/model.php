<?php

// the phone app's LAN mode. the phone builds the whole prompt and
// keeps its chats, this only generates, openai-shaped both ways

// bearer token and no cookie, nothing for the origin check to guard
const OMEGA_TOKEN_AUTH = true;

require_once __DIR__ . '/lib/bootstrap.php';
require_once __DIR__ . '/lib/chat/sse.php';

if (strtolower(env_str('LAN_INFERENCE', 'off')) !== 'on') fail(404, 'not_found');
rate_limit('model', 120, 60);

$token = env_str('JUN_LAN_TOKEN');
$auth = $_SERVER['HTTP_AUTHORIZATION'] ?? '';
if (strlen($token) < 32 || !str_starts_with($auth, 'Bearer ') || !hash_equals($token, trim(substr($auth, 7)))) {
    log_event(['msg' => 'model_unauthorized']);
    fail(401, 'unauthorized');
}

$provider = ai_provider();
$method = require_method('GET', 'POST');
if ($method === 'GET') {
    json_out(['model' => display_chat_model(), 'provider' => $provider,
              'ctx' => provider_window_tokens($provider, default_chat_model())]);
}

function model_tool_call(mixed $call, bool $openai, int $index): array {
    $call = is_array($call) ? $call : [];
    $name = (string)($call['function']['name'] ?? '');
    $args = (object)tool_call_args($call);
    if (!$openai) return ['function' => ['name' => $name, 'arguments' => $args]];
    return [
        'id' => (string)($call['id'] ?? '') ?: 'call_' . $index,
        'type' => 'function',
        'function' => ['name' => $name, 'arguments' => json_encode($args, JSON_UNESCAPED_UNICODE)],
    ];
}

function model_messages(mixed $raw, string $provider): array {
    if (!is_array($raw) || !$raw || count($raw) > 400) fail(400, 'invalid_request');
    $out = [];
    foreach (array_values($raw) as $m) {
        $role = is_array($m) ? ($m['role'] ?? '') : '';
        $content = is_array($m) ? ($m['content'] ?? '') : null;
        if (!in_array($role, ['system', 'user', 'assistant', 'tool'], true) || !is_string($content)) fail(400, 'invalid_request');
        if ($role === 'tool') {
            $out[] = provider_tool_message($provider, (string)($m['name'] ?? ''), (string)($m['tool_call_id'] ?? ''), $content);
            continue;
        }
        $message = ['role' => $role, 'content' => $content];
        if ($role === 'assistant' && is_array($m['tool_calls'] ?? null) && $m['tool_calls']) {
            $openai = provider_uses_openai_protocol($provider);
            $message['tool_calls'] = array_map(fn($c, $i) => model_tool_call($c, $openai, $i),
                array_values($m['tool_calls']), array_keys(array_values($m['tool_calls'])));
        }
        $out[] = $message;
    }
    return $out;
}

function sse_fail_openai(string $message): never {
    sse_send(['error' => ['message' => $message]]);
    sse_done();
    exit;
}

$body = read_json_body(4 * 1024 * 1024);
$think = !empty($body['think']);
$reasoning = in_array($body['reasoning'] ?? '', ['low', 'medium', 'high'], true) ? $body['reasoning'] : 'low';
$model = default_chat_model();
$messages = model_messages($body['messages'] ?? null, $provider);

ollama_evict_if_partially_offloaded($model);
if ($provider === 'llamacpp') llamacpp_unload_chat_models($model);
$messages = fit_messages_to_context($messages, provider_window_tokens($provider, $model));

$payload = provider_chat_payload($provider, $model, $messages, $reasoning, $think);
$maxTokens = (int)($body['max_tokens'] ?? 0) ?: ($think ? THINK_MAX_TOKENS : PLAIN_MAX_TOKENS);
$maxTokens = max(16, min($maxTokens, THINK_MAX_TOKENS));
if (isset($payload['options'])) $payload['options']['num_predict'] = $maxTokens;
else $payload['max_tokens'] = $maxTokens;
if (is_array($body['tools'] ?? null) && $body['tools'] && provider_tools_enabled()) {
    $payload['tools'] = array_slice(array_values($body['tools']), 0, 16);
}

sse_open();
$delta = function (array $delta, ?string $finish = null): void {
    sse_send(['choices' => [['index' => 0, 'delta' => (object)$delta, 'finish_reason' => $finish]]]);
};
$emit = function (array $event) use ($delta): void {
    if (isset($event['token'])) $delta(['content' => $event['token']]);
    elseif (isset($event['thinking'])) $delta(['reasoning_content' => $event['thinking']]);
    elseif (isset($event['error'])) sse_send(['error' => ['message' => (string)$event['error']]]);
};

// chat.php's two retries: an MTP twin or preset that won't load falls
// back to her plain model, a template that refuses tools goes again without
$fellBack = false;
while (true) {
    $result = provider_stream_round($provider, $payload, $emit);
    if ($result['curl_error'] !== '' || $result['http_status'] < 400) break;
    log_event(['msg' => 'model_upstream_error', 'provider' => $provider, 'model' => $payload['model'],
               'status' => $result['http_status'], 'body' => mb_substr($result['error_body'], 0, 500)]);
    $fallback = $fellBack ? '' : chat_fallback_model((string)$payload['model']);
    if ($fallback !== '') {
        $fellBack = true;
        $payload['model'] = $fallback;
        continue;
    }
    if (isset($payload['tools'])) {
        unset($payload['tools']);
        continue;
    }
    break;
}

if ($result['curl_error'] !== '') {
    log_event(['msg' => 'model_curl_error', 'provider' => $provider, 'err' => $result['curl_error']]);
    sse_fail_openai('upstream_unavailable');
}
if ($result['http_status'] >= 400) {
    $err = json_decode($result['error_body'], true);
    $err = $err['error']['message'] ?? $err['error'] ?? 'upstream_error';
    sse_fail_openai(is_string($err) ? $err : 'upstream_error');
}

$calls = array_values($result['tool_calls']);
if ($calls) {
    $delta(['tool_calls' => array_map(function ($call, $i) {
        return ['index' => $i] + model_tool_call($call, true, $i);
    }, $calls, array_keys($calls))]);
}
$finish = $calls ? 'tool_calls' : (in_array($result['done_reason'], ['length', 'stop'], true) ? $result['done_reason'] : 'stop');
$stats = $result['stats'] ?? [];
sse_send([
    'choices' => [['index' => 0, 'delta' => (object)[], 'finish_reason' => $finish]],
    'usage' => ['prompt_tokens' => (int)($stats['prompt_eval_count'] ?? 0), 'completion_tokens' => (int)($stats['eval_count'] ?? 0)],
    'model' => (string)$payload['model'],
]);
sse_done();
