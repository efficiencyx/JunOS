<?php

require_once __DIR__ . '/lib/bootstrap.php';
require_once __DIR__ . '/lib/lore.php';
require_once __DIR__ . '/lib/wardrobe.php';
require_once __DIR__ . '/lib/chat/sse.php';
require_once __DIR__ . '/lib/chat/request.php';
require_once __DIR__ . '/lib/chat/context.php';
require_once __DIR__ . '/lib/chat/prompt.php';
require_once __DIR__ . '/lib/chat/tools.php';
require_once __DIR__ . '/lib/chat/websearch.php';
require_once __DIR__ . '/lib/chat/flee.php';
require_once __DIR__ . '/lib/chat/tags.php';
require_once __DIR__ . '/lib/chat/persist.php';

sse_open();
$PROVIDER = ai_provider();

$user = require_user();
// 90 not 30. the card table is one chat turn per move and a fast
// hand is 5-8 of them, three hands in a minute tripped 30.
rate_limit('chat', 90, 60);
if (consolidation_locked((int)$user['id'])) fail(418, 'consolidating');

$ban = ban_active((int)$user['id']);
if ($ban !== null) {
    sse_send(['error' => 'user_fled', 'until' => $ban['until'],
              'seconds_left' => $ban['seconds_left'], 'reason' => $ban['reason']]);
    sse_done();
    exit;
}

require_post();
require_content_type('application/json');

$req = chat_parse_request($PROVIDER);
$model = $req['model'];
if (!$req['idle']) consolidation_touch((int)$user['id']);
$convId = chat_require_conversation($user, $req['body']);

$lastUserMsg = chat_last_user_message($req);
$approvedWebSearchQuery = chat_approved_search($lastUserMsg);
$toolsOffered = provider_tools_enabled();

[$convSummary, $summaryCoveredCount] = chat_conversation_summary($convId, (int)$user['id']);
$rel = relationship_get((int)$user['id']);
$liveContext = chat_live_context($req, $user, $lastUserMsg, $convSummary, $rel, $toolsOffered, $approvedWebSearchQuery);
$systemContent = chat_system_content($toolsOffered, (int)$user['id']);
$messages = chat_build_messages($req, $systemContent, $liveContext, $summaryCoveredCount);

$reasoning = $req['reasoning'];
$think = isset($req['body']['think']) ? (bool)$req['body']['think'] : false;
$route = 'manual';
if ($reasoning === 'auto') {
    [$reasoning, $think, $route] = route_reasoning($lastUserMsg, $req['idle']);
}
// ephemeral turns are the card table and touch reactions. a hit
// or stand behind 20 s of thinking kills the game, so no
// thinking there whatever the picker says
if ($req['ephemeral']) {
    [$reasoning, $think, $route] = ['low', false, 'ephemeral'];
}

// the budget token goes dead last, after the live context. v7
// rows end user turns with "\n\n<think:LEVEL>" and the level
// names are low/med/high there, not medium.
$messages[count($messages) - 1]['content'] .= "\n\n<think:" . ($reasoning === 'medium' ? 'med' : $reasoning) . '>';

// this frame carries the WHOLE assembled system prompt, so it
// stays behind the admin role. the dev HUD is the only thing that
// reads it.
if (is_admin($user)) {
    sse_send(['debug' => ['system_prompt' => $systemContent, 'live_context' => $liveContext, 'reasoning' => $reasoning, 'think' => $think, 'route' => $route]]);
}

$userRowId = chat_save_user_message($convId, $req, $lastUserMsg);

ollama_evict_if_partially_offloaded($model);

$messages = fit_messages_to_context($messages, provider_window_tokens($PROVIDER));

$upstreamPayload = provider_chat_payload($PROVIDER, $model, $messages, $reasoning, $think);

if ($toolsOffered) $upstreamPayload['tools'] = tool_catalog($approvedWebSearchQuery);

$sawError = false;
$mtpFellBack = false;
$assistantBuffer = '';
$usedTools = false;
$stats = null;
$doneReason = '';
$state = [
    'silenced' => false,
    'silence_reason' => '',
    // only a spoken turn can be for someone else. typed, the flag is
    // just a normal stay_silent, we're not deleting what he wrote
    'overheard' => false,
    'fled' => null,
    'flee_decided' => false,
    'approved_search' => $approvedWebSearchQuery,
];

for ($round = 0; $round < 3; $round++) {
    $roundContent = '';
    $toolCalls = [];
    $retriedWithoutTools = false;

    do {
        $retryRound = false;
        $result = provider_stream_round($PROVIDER, $upstreamPayload, 'sse_send', $round);
        $roundContent = $result['content'];
        $toolCalls = $result['tool_calls'];
        if ($result['stats'] !== null) $stats = provider_merge_stats($stats, $result['stats']);
        if ($result['done_reason'] !== '') $doneReason = $result['done_reason'];
        if ($result['stream_error']) $sawError = true;

        if ($result['curl_error'] !== '') {
            log_event(['msg' => 'upstream_curl_error', 'provider' => $PROVIDER, 'err' => $result['curl_error']]);
            sse_send(['error' => 'upstream_unavailable']);
            $sawError = true;
        }

        if (!provider_uses_openai_protocol($PROVIDER) && $result['http_status'] >= 400 && !$sawError) {
            log_event(['msg' => 'upstream_http_error', 'provider' => $PROVIDER,
                       'model' => $upstreamPayload['model'], 'status' => $result['http_status'],
                       'body' => mb_substr($result['error_body'], 0, 500)]);
            $fallback = $mtpFellBack ? '' : ollama_mtp_fallback_model((string)$upstreamPayload['model']);
            if ($fallback !== '') {
                $mtpFellBack = true;
                $model = $fallback;
                $upstreamPayload['model'] = $fallback;
                $retryRound = true;
                continue;
            }
            $errObj = json_decode($result['error_body'], true);
            sse_send(['error' => is_array($errObj) && is_string($errObj['error'] ?? null)
                ? $errObj['error'] : 'upstream_error']);
            $sawError = true;
        }

        if (provider_uses_openai_protocol($PROVIDER)) {
            if ($result['http_status'] >= 400 && !$sawError) {
                // NEVER log request headers. the API key is in there.
                log_event(['msg' => 'upstream_http_error', 'provider' => $PROVIDER,
                           'status' => $result['http_status'], 'body' => mb_substr($result['error_body'], 0, 500)]);
                if ($round === 0 && !$retriedWithoutTools && isset($upstreamPayload['tools'])) {
                    // one more go, for llama.cpp templates that refuse tools
                    unset($upstreamPayload['tools']);
                    $toolsOffered = false;
                    $retriedWithoutTools = true;
                    $retryRound = true;
                    continue;
                }
                $errObj = json_decode($result['error_body'], true);
                $msg = is_array($errObj) && isset($errObj['error'])
                    ? (is_array($errObj['error']) ? (string)($errObj['error']['message'] ?? 'upstream_error') : (string)$errObj['error'])
                    : 'upstream_error';
                sse_send(['error' => $msg]);
                $sawError = true;
            }
            if ($stats !== null && ($stats['eval_duration'] ?? 0) === 0) {
                $stats['eval_duration'] = $result['duration_ns'];
                $stats['total_duration'] = $result['duration_ns'];
            }
        }
    } while ($retryRound);

    $assistantBuffer .= $roundContent;
    if ($sawError || !$toolCalls) break;

    if ($roundContent !== '') {
        sse_send(['token' => "\n\n"]);
        $assistantBuffer .= "\n\n";
    }

    $messages[] = [
        'role' => 'assistant',
        'content' => $roundContent,
        'tool_calls' => $toolCalls,
    ];
    foreach (array_slice($toolCalls, 0, 4) as $call) {
        $name = (string)($call['function']['name'] ?? '');
        $args = tool_call_args($call);
        sse_send(['tool_status' => ['name' => $name, 'state' => 'running', 'args' => $args]]);
        $t0 = microtime(true);
        $toolResult = chat_run_tool($name, $args, [
            'provider' => $PROVIDER, 'model' => $model, 'user' => $user, 'conv_id' => $convId, 'req' => $req,
        ], $state);
        sse_send(['tool_status' => [
            'name' => $name, 'state' => 'done',
            'duration_ms' => (int)round((microtime(true) - $t0) * 1000),
            'result' => mb_substr($toolResult, 0, 2000),
        ]]);
        if ($state['silenced'] || $state['fled'] !== null) break;
        $messages[] = provider_tool_message(
            $PROVIDER,
            $name,
            (string)($call['id'] ?? ''),
            $toolResult
        );
    }
    if ($state['silenced'] || $state['fled'] !== null) break;
    $usedTools = true;
    $upstreamPayload['messages'] = $messages;
}

// she sometimes calls a tool and then just. stops. no answer at
// all, and the user gets an error where a reply should be. same
// hole at the other end, if the third round is STILL tool calls
// we run them and never let her speak. both leave the buffer
// empty. so: one more round with the tools taken away, leaving
// her nothing to do except talk.
if ($usedTools && !$sawError && !$state['silenced'] && $state['fled'] === null && trim($assistantBuffer) === '') {
    log_event(['msg' => 'tool_round_silent_retry', 'model' => $model]);
    unset($upstreamPayload['tools']);
    $upstreamPayload['messages'] = $messages;
    $result = provider_stream_round($PROVIDER, $upstreamPayload, 'sse_send', 3);
    $assistantBuffer .= $result['content'];
    if ($result['done_reason'] !== '') $doneReason = $result['done_reason'];
    if ($result['stream_error']) $sawError = true;
    if ($result['stats'] !== null) $stats = provider_merge_stats($stats, $result['stats']);
}

if (!$sawError && $assistantBuffer !== '') {
    $assistantBuffer = chat_parse_action_tags($assistantBuffer, [
        'provider' => $PROVIDER, 'model' => $model, 'user' => $user, 'conv_id' => $convId, 'req' => $req,
    ], $state);
}

if ($state['silenced']) {
    // any lead-in at all and stay_silent is pointless, but the
    // transcript still needs an assistant turn. strict templates
    // reject a dangling user turn on the next request.
    $assistantBuffer = '...';
    sse_send(['silence' => ['reason' => $state['silence_reason'], 'overheard' => $state['overheard']]]);
} elseif ($state['fled'] !== null) {
    if (trim($assistantBuffer) === '') $assistantBuffer = '...';
    sse_send(['fled' => [
        'until' => $state['fled']['until'],
        'minutes' => $state['fled']['minutes'],
        'reason' => $state['fled']['reason'],
    ]]);
}

if ($stats !== null) {
    $stats['num_ctx'] = provider_context_size($PROVIDER, $upstreamPayload);
    $stats['model'] = $model;
    sse_send(['stats' => $stats]);
}

if (!$sawError && $assistantBuffer === '') {
    log_event(['msg' => 'empty_reply', 'model' => $model, 'done_reason' => $doneReason, 'think' => $think]);
    sse_send(['error' => $doneReason === 'length' ? 'reply_truncated_in_thinking' : 'empty_reply']);
}

if (!$sawError && $assistantBuffer !== '') {
    $assistantBuffer = chat_apply_bookkeeping_tags($assistantBuffer, (int)$user['id'], $rel);

    if ($req['ephemeral']) { sse_done(); exit; }

    // not his turn with her, so it never happened. the user row went
    // in before the stream, pull it back out and store no reply.
    // otherwise two people chatting for ten minutes leaves thirty
    // <audio>/... pairs eating context
    if ($state['overheard']) {
        if ($userRowId) db()->prepare('DELETE FROM messages WHERE id=? AND conversation_id=?')->execute([$userRowId, $convId]);
        log_event(['msg' => 'overheard', 'conversation_id' => $convId, 'audio' => $req['audio'] !== '']);
        sse_done();
        exit;
    }

    chat_save_reply($convId, $assistantBuffer, $req, $lastUserMsg);
}

sse_done();

exit;
