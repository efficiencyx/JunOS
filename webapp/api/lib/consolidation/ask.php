<?php

// streams, so the feed and the worker's stall watchdog see her move

const CONSOLIDATION_CALL_TIMEOUT = 600;
const CONSOLIDATION_FEED_FLUSH_S = 0.4;
// until a call measures it. low ON PURPOSE, a CPU box reading a
// 3000 token chat gets two minutes of quiet before the watchdog cares
const CONSOLIDATION_PREFILL_GUESS_TPS = 25;

// a thinking call needs room to think AND answer. at medium and high
// the old flat 1500 ran out mid-thought and the fact was just gone
const CONSOLIDATION_THINK_TOKENS = ['low' => 1500, 'medium' => 3000, 'high' => 6000];

const CONSOLIDATION_CONTROL_EVERY_S = 1.0;
const CONSOLIDATION_PAUSE_MAX_S = 1800;

// a developer skipped something. 'call' is handled right in
// consolidation_call, the rest bubble up to whoever owns that kind
final class ConsolidationSkip extends RuntimeException {
    public function __construct(public readonly string $kind) {
        parent::__construct('consolidation_skip_' . $kind);
    }
}

// stop, pause, skip:<kind> or ''. read at most once a second unless
// $fresh, it runs inside the token stream
function consolidation_control(array &$ctx, bool $fresh = false): string {
    if (!$fresh && microtime(true) - ($ctx['control_at'] ?? 0) < CONSOLIDATION_CONTROL_EVERY_S) return '';
    $ctx['control_at'] = microtime(true);
    $stmt = db()->prepare('SELECT interrupt_at, pause_at, skip_kind, skip_at FROM memory_consolidation WHERE user_id = ?');
    $stmt->execute([$ctx['user']]);
    $row = $stmt->fetch() ?: [];
    $stmt->closeCursor();
    if ((int)($row['interrupt_at'] ?? 0) >= $ctx['started']) return 'stop';
    if ((int)($row['pause_at'] ?? 0) > 0) return 'pause';
    $at = (int)($row['skip_at'] ?? 0);
    if ($at >= $ctx['started'] && $at > ($ctx['skip_seen'] ?? 0) && in_array($row['skip_kind'] ?? '', CONSOLIDATION_SKIPS, true)) {
        $ctx['skip_seen'] = $at;
        return 'skip:' . $row['skip_kind'];
    }
    return '';
}

// lock and feed get touched or the stall watchdog calls it dead.
// gives back whatever came after the pause (a skip, a stop, nothing)
function consolidation_wait_paused(array &$ctx): string {
    $since = time();
    consolidation_feed_emit($ctx['user'], ['type' => 'paused']);
    while (true) {
        consolidation_lock_update($ctx['user'], ['paused' => true]);
        @touch(consolidation_feed_path($ctx['user']));
        $control = consolidation_control($ctx, true);
        if ($control === 'stop' || time() - $since > CONSOLIDATION_PAUSE_MAX_S) throw new RuntimeException('consolidation_interrupted');
        if ($control !== 'pause') break;
        sleep(2);
    }
    consolidation_lock_update($ctx['user'], ['paused' => false]);
    consolidation_feed_emit($ctx['user'], ['type' => 'resumed']);
    return $control;
}

function consolidation_obey(array &$ctx, string $control): void {
    if ($control === 'pause') $control = consolidation_wait_paused($ctx);
    if ($control === 'stop') throw new RuntimeException('consolidation_interrupted');
    if (str_starts_with($control, 'skip:')) throw new ConsolidationSkip(substr($control, 5));
}

function consolidation_skipped(array &$ctx, ConsolidationSkip $skip, string $what): void {
    $ctx['skips'] = ($ctx['skips'] ?? 0) + 1;
    consolidation_feed_emit($ctx['user'], ['type' => 'skip', 'kind' => $skip->kind, 'what' => $what]);
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
    if ($provider === 'llamacpp' || $provider === 'vllm') $payload['chat_template_kwargs'] = ['enable_thinking' => $think];
    if ($think && $provider === 'openai-compatible') $payload['reasoning_effort'] = $effort;
    return $payload;
}

// json_schema is a request not a promise (hosted servers, LLAMACPP_TOOLS=off), dig it out of fences and prose
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
function consolidation_call(array &$ctx, string $label, string $task, ?array $schema, int $maxTokens = 300, bool|string $think = false, float $temperature = 0.3) {
    try {
        return consolidation_call_inner($ctx, $label, $task, $schema, $maxTokens, $think, $temperature);
    } catch (ConsolidationSkip $skip) {
        if ($skip->kind !== 'call') throw $skip;
        consolidation_skipped($ctx, $skip, $label);
        return $schema ? null : '';
    }
}

// $think: false, true for the pass's own level, or a level by name
function consolidation_call_inner(array &$ctx, string $label, string $task, ?array $schema, int $maxTokens, bool|string $think, float $temperature) {
    consolidation_obey($ctx, consolidation_control($ctx, true));
    $provider = ai_provider();
    $model = default_chat_model();
    $askedTokens = $maxTokens;
    $setThink = function (bool|string $level) use (&$think, &$effort, &$messages, &$maxTokens, $ctx, $task, $askedTokens) {
        $effort = $level === true ? $ctx['effort'] : (is_string($level) ? $level : 'low');
        $think = $level !== false;
        // same budget token chat.php ends every turn with, it's what the dataset trained
        $marker = "\n\n<think:" . ($effort === 'medium' ? 'med' : $effort) . '>';
        $messages = [['role' => 'system', 'content' => $ctx['voice']], ['role' => 'user', 'content' => $task . $marker]];
        $maxTokens = $think ? max($askedTokens, CONSOLIDATION_THINK_TOKENS[$effort] ?? 1500) : $askedTokens;
    };
    $setThink($think);

    $loops = 0;
    for ($attempt = 0; $attempt < 2; $attempt++) {
        $ctx['calls']++;
        $promptTokens = (int)ceil((strlen($ctx['voice']) + strlen($task)) / 4);
        $quiet = (int)ceil($promptTokens / max(1, $ctx['tps'] ?? CONSOLIDATION_PREFILL_GUESS_TPS));
        // the first call of a pass may load her from disk first
        if ($ctx['calls'] === 1) $quiet += 60;
        $quietUntil = time() + $quiet;
        consolidation_lock_update($ctx['user'], ['quiet_until' => $quietUntil]);
        consolidation_feed_emit($ctx['user'], ['type' => 'call', 'label' => $label, 'think' => $think, 'effort' => $effort,
            'quiet_until' => $quietUntil, 'prompt_tokens' => $promptTokens, 'prompt' => $task]);

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
        [$emit, $stuck] = stream_loop_guard($emit);
        $stop = function () use (&$ctx, $stuck): string {
            if (($why = $stuck()) !== '') return $why;
            $control = consolidation_control($ctx);
            if ($control === '') return '';
            $ctx['control'] = $control;
            return 'control';
        };

        $payload = consolidation_payload($provider, $model, $messages, $schema, $maxTokens, $think, $effort, $temperature);
        $began = microtime(true);
        $state = provider_stream_round($provider, $payload, $emit, 0, microtime(true) + CONSOLIDATION_CALL_TIMEOUT, $stop);
        $flush();

        // paused, skipped or stopped mid-answer. a pause asks the same thing again after
        if ($state['aborted'] === 'control') {
            $control = $ctx['control'];
            unset($ctx['control']);
            if ($control === 'pause') $control = consolidation_wait_paused($ctx);
            consolidation_obey($ctx, $control);
            $attempt--;
            continue;
        }

        if ($state['aborted'] === 'looping') {
            log_event(['msg' => 'consolidation_looping', 'user_id' => $ctx['user'], 'label' => $label, 'retry' => $loops + 1]);
            $ctx['loops'] = ($ctx['loops'] ?? 0) + 1;
            if (++$loops > STREAM_LOOP_RETRIES) throw new RuntimeException('consolidation_looping');
            consolidation_feed_emit($ctx['user'], ['type' => 'loop', 'label' => $label, 'retry' => $loops, 'of' => STREAM_LOOP_RETRIES]);
            $temperature = min(1.0, $temperature + 0.2);
            $attempt--;
            continue;
        }

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
        $out = $stats['eval_count'] ?? null;
        $genMs = ($stats['eval_duration'] ?? 0) / 1e6;
        consolidation_feed_emit($ctx['user'], ['type' => 'answer', 'label' => $label,
            'ms' => (int)round((microtime(true) - $began) * 1000), 'prompt_tokens' => $stats['prompt_eval_count'] ?? null,
            'out_tokens' => $out, 'tok_s' => $out && $genMs > 0 ? round($out / ($genMs / 1000), 1) : null,
            'budget' => $state['done_reason'] === 'length', 'text' => trim(provider_strip_think($content))]);
        if (!$schema) return trim(provider_strip_think($content));
        $data = consolidation_parse_json($content);
        if ($data !== null) return $data;
        $ctx['bad_json'] = ($ctx['bad_json'] ?? 0) + 1;
        log_event(['msg' => 'consolidation_bad_json', 'user_id' => $ctx['user'], 'label' => $label, 'budget' => $state['done_reason'] === 'length']);
        // mostly she thought until the budget ran out and never got to
        // the JSON. once more without thinking beats losing the fact
        $setThink(false);
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
    $result = $tally[$top] > $n / 2 ? $top : $safe;
    consolidation_feed_emit($ctx['user'], ['type' => 'vote', 'label' => $label, 'tally' => $tally, 'result' => $result]);
    return [$result, $tally];
}
