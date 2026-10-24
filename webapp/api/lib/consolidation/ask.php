<?php

// streams, so the feed and the worker's stall watchdog see her move

const CONSOLIDATION_CALL_TIMEOUT = 600;
const CONSOLIDATION_FEED_FLUSH_S = 0.4;
// until a call measures it. low ON PURPOSE, a CPU box reading a
// 3000 token chat gets two minutes of quiet before the watchdog cares
const CONSOLIDATION_PREFILL_GUESS_TPS = 25;

function consolidation_stopped(array $ctx): bool {
    $stmt = db()->prepare('SELECT interrupt_at FROM memory_consolidation WHERE user_id = ?');
    $stmt->execute([$ctx['user']]);
    $at = (int)$stmt->fetchColumn();
    $stmt->closeCursor();
    return $at >= $ctx['started'];
}

function consolidation_payload(string $provider, string $model, array $messages, ?array $schema, int $maxTokens, bool $think, string $effort, float $temperature): array {
    if (!provider_uses_openai_protocol($provider)) {
        $payload = [
            'model' => $model,
            'messages' => $messages,
            'stream' => true,
            'keep_alive' => -1,
            'options' => [
                'reasoning_effort' => $effort,
                'temperature' => $temperature,
                'num_ctx' => default_num_ctx(),
                'num_predict' => $maxTokens,
            ],
        ];
        // you ask ollama for thinking by LEAVING think out, see provider_complete_tools
        if (!$think) $payload['think'] = false;
        if ($schema) $payload['format'] = $schema;
        return $payload;
    }
    $payload = [
        'model' => $model,
        'messages' => $messages,
        'stream' => true,
        'temperature' => $temperature,
        'max_tokens' => $maxTokens,
        'stream_options' => ['include_usage' => true],
    ];
    if ($schema) $payload['response_format'] = ['type' => 'json_schema', 'json_schema' => ['name' => 'answer', 'schema' => $schema]];
    if ($provider === 'openrouter' && $think) $payload['reasoning'] = ['effort' => $effort];
    if ($provider === 'llamacpp' || $provider === 'vllm') $payload['chat_template_kwargs'] = ['enable_thinking' => $think];
    return $payload;
}

// json_schema is a request not a promise (openrouter, LLAMACPP_TOOLS=off), dig it out of fences and prose
function consolidation_parse_json(string $content): ?array {
    $text = trim(provider_strip_think($content));
    $data = json_decode($text, true);
    if (is_array($data)) return $data;
    $start = strpos($text, '{');
    $end = strrpos($text, '}');
    if ($start === false || $end === false || $end <= $start) return null;
    $data = json_decode(substr($text, $start, $end - $start + 1), true);
    return is_array($data) ? $data : null;
}

// with a schema: array or null. without: text or ''
function consolidation_call(array &$ctx, string $label, string $task, ?array $schema, int $maxTokens = 300, bool $think = false, float $temperature = 0.3) {
    if (consolidation_stopped($ctx)) throw new RuntimeException('consolidation_interrupted');
    $provider = ai_provider();
    $model = default_chat_model();
    // same budget token chat.php ends every turn with, it's what the dataset trained
    $effort = $think ? $ctx['effort'] : 'low';
    $marker = "\n\n<think:" . ($effort === 'medium' ? 'med' : $effort) . '>';
    $messages = [['role' => 'system', 'content' => $ctx['voice']], ['role' => 'user', 'content' => $task . $marker]];
    if ($think) $maxTokens = max($maxTokens, 1500);

    for ($attempt = 0; $attempt < 2; $attempt++) {
        $ctx['calls']++;
        $promptTokens = (int)ceil((strlen($ctx['voice']) + strlen($task)) / 4);
        $quiet = (int)ceil($promptTokens / max(1, $ctx['tps'] ?? CONSOLIDATION_PREFILL_GUESS_TPS));
        // the first call of a pass may load her from disk first
        if ($ctx['calls'] === 1) $quiet += 60;
        $quietUntil = time() + $quiet;
        consolidation_lock_update($ctx['user'], ['quiet_until' => $quietUntil]);
        consolidation_feed_emit($ctx['user'], ['type' => 'call', 'label' => $label, 'think' => $think, 'quiet_until' => $quietUntil]);

        $pending = ['think' => '', 'out' => ''];
        $flushedAt = microtime(true);
        $flush = function () use (&$pending, &$flushedAt, $ctx) {
            foreach ($pending as $kind => $text) {
                if ($text !== '') consolidation_feed_emit($ctx['user'], ['type' => 'tok', 'kind' => $kind, 'text' => $text]);
            }
            $pending = ['think' => '', 'out' => ''];
            $flushedAt = microtime(true);
        };
        $emit = function (array $out) use (&$pending, &$flushedAt, $flush) {
            if (isset($out['thinking'])) $pending['think'] .= $out['thinking'];
            if (isset($out['token'])) $pending['out'] .= $out['token'];
            if (microtime(true) - $flushedAt >= CONSOLIDATION_FEED_FLUSH_S) $flush();
        };

        $payload = consolidation_payload($provider, $model, $messages, $schema, $maxTokens, $think, $effort, $temperature);
        $state = provider_stream_round($provider, $payload, $emit, 0, microtime(true) + CONSOLIDATION_CALL_TIMEOUT);
        $flush();

        if ($state['http_status'] >= 400 && $attempt === 0) {
            $fallback = chat_fallback_model($model);
            if ($fallback !== '') {
                log_event(['msg' => 'mtp_fallback', 'from' => $model, 'to' => $fallback, 'err' => 'http_' . $state['http_status']]);
                $model = $fallback;
                continue;
            }
        }
        $stats = $state['stats'] ?? null;
        if ($stats && ($stats['prompt_eval_count'] ?? 0) > 64 && ($stats['prompt_eval_duration'] ?? 0) > 0) {
            $ctx['tps'] = $stats['prompt_eval_count'] / ($stats['prompt_eval_duration'] / 1e9);
        }
        if ($state['stream_error'] || $state['curl_error'] !== '' || $state['http_status'] >= 400) {
            log_event(['msg' => 'consolidation_call_error', 'user_id' => $ctx['user'], 'label' => $label,
                'status' => $state['http_status'], 'err' => $state['curl_error'] ?: $state['aborted']]);
            throw new RuntimeException('consolidation_provider_error');
        }
        $content = (string)$state['content'];
        if (!$schema) return trim(provider_strip_think($content));
        $data = consolidation_parse_json($content);
        if ($data !== null) return $data;
        log_event(['msg' => 'consolidation_bad_json', 'user_id' => $ctx['user'], 'label' => $label]);
    }
    return $schema ? null : '';
}

// a tie or a broken answer counts as $safe, the choice that keeps the note
function consolidation_vote(array &$ctx, string $label, string $task, array $values, string $safe, int $n = 3): array {
    $tally = [];
    for ($i = 0; $i < $n; $i++) {
        $answer = consolidation_call($ctx, $label, $task, ['type' => 'object', 'properties' => ['answer' => ['type' => 'string', 'enum' => $values]], 'required' => ['answer']], 60, $ctx['think'], 0.7)['answer'] ?? $safe;
        if (!in_array($answer, $values, true)) $answer = $safe;
        $tally[$answer] = ($tally[$answer] ?? 0) + 1;
    }
    arsort($tally);
    $top = (string)array_key_first($tally);
    return [$tally[$top] > $n / 2 ? $top : $safe, $tally];
}
