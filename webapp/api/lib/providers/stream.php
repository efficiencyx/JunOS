<?php

function provider_stream_state(): array {
    return [
        'content' => '',
        'thinking' => '',
        'tool_calls' => [],
        'stats' => null,
        'done_reason' => '',
        'http_status' => 0,
        'error_body' => '',
        'stream_error' => false,
        'curl_error' => '',
        'aborted' => '',
        'duration_ns' => 0,
        'think_open' => false,
        'think_hold' => '',
    ];
}

function provider_parse_ollama_chunk(string $chunk, string &$buf, array &$state, callable $emit): void {
    $buf .= $chunk;
    while (($nl = strpos($buf, "\n")) !== false) {
        $line = trim(substr($buf, 0, $nl));
        $buf = substr($buf, $nl + 1);
        if ($line === '') continue;
        $obj = json_decode($line, true);
        if (!is_array($obj)) continue;

        if (isset($obj['error'])) {
            $emit(['error' => (string)$obj['error']]);
            $state['stream_error'] = true;
            continue;
        }
        if (!empty($obj['done'])) {
            $state['done_reason'] = (string)($obj['done_reason'] ?? '');
        }
        if (!empty($obj['done']) && isset($obj['eval_count'])) {
            $state['stats'] = [
                'eval_count' => (int)($obj['eval_count'] ?? 0),
                'eval_duration' => (int)($obj['eval_duration'] ?? 0),
                'prompt_eval_count' => (int)($obj['prompt_eval_count'] ?? 0),
                'prompt_eval_duration' => (int)($obj['prompt_eval_duration'] ?? 0),
                'total_duration' => (int)($obj['total_duration'] ?? 0),
                'load_duration' => (int)($obj['load_duration'] ?? 0),
            ];
        }

        $thinking = (string)($obj['message']['thinking'] ?? '');
        if ($thinking !== '') {
            $emit(['thinking' => $thinking]);
            $state['thinking'] .= $thinking;
        }

        $calls = $obj['message']['tool_calls'] ?? null;
        if (is_array($calls) && $calls) {
            $state['tool_calls'] = array_merge($state['tool_calls'], $calls);
        }

        $token = (string)($obj['message']['content'] ?? '');
        if ($token !== '') provider_route_think_token($token, $state, $emit);

        if (!empty($obj['done'])) provider_flush_think_hold($state, $emit);
    }
}

function provider_parse_openai_chunk(
    string $chunk,
    string &$buf,
    array &$toolAcc,
    array &$state,
    callable $emit
): void {
    $buf .= $chunk;
    while (($nl = strpos($buf, "\n")) !== false) {
        $line = rtrim(substr($buf, 0, $nl), "\r");
        $buf = substr($buf, $nl + 1);
        if ($line === '' || $line[0] === ':') continue;
        if (strncmp($line, 'data:', 5) !== 0) continue;
        $data = trim(substr($line, 5));
        if ($data === '[DONE]') continue;
        $obj = json_decode($data, true);
        if (!is_array($obj)) continue;

        if (isset($obj['error'])) {
            $message = is_array($obj['error'])
                ? (string)($obj['error']['message'] ?? 'upstream_error')
                : (string)$obj['error'];
            $emit(['error' => $message]);
            $state['stream_error'] = true;
            continue;
        }
        if (isset($obj['usage']) && is_array($obj['usage'])) {
            $state['stats'] = [
                'eval_count' => (int)($obj['usage']['completion_tokens'] ?? 0),
                'eval_duration' => 0,
                'prompt_eval_count' => (int)($obj['usage']['prompt_tokens'] ?? 0),
                'prompt_eval_duration' => 0,
                'total_duration' => 0,
                'load_duration' => 0,
            ];
        }
        if (isset($obj['timings']['prompt_ms']) && $state['stats'] !== null) {
            $t = $obj['timings'];
            $state['stats']['eval_duration'] = (int)(($t['predicted_ms'] ?? 0) * 1e6);
            $state['stats']['prompt_eval_duration'] = (int)($t['prompt_ms'] * 1e6);
            $state['stats']['prompt_new'] = (int)($t['prompt_n'] ?? 0);
        }
        $choice = $obj['choices'][0] ?? null;
        if (!is_array($choice)) continue;
        if (!empty($choice['finish_reason'])) {
            $state['done_reason'] = (string)$choice['finish_reason'];
        }
        $delta = is_array($choice['delta'] ?? null) ? $choice['delta'] : [];

        $thinking = (string)($delta['reasoning'] ?? $delta['reasoning_content'] ?? '');
        if ($thinking !== '') {
            $emit(['thinking' => $thinking]);
            $state['thinking'] .= $thinking;
        }

        if (is_array($delta['tool_calls'] ?? null)) {
            foreach ($delta['tool_calls'] as $fragment) {
                if (!is_array($fragment)) continue;
                $index = (int)($fragment['index'] ?? 0);
                if (!isset($toolAcc[$index])) {
                    $toolAcc[$index] = ['id' => '', 'name' => '', 'arguments' => ''];
                }
                if (!empty($fragment['id'])) $toolAcc[$index]['id'] = (string)$fragment['id'];
                if (isset($fragment['function']['name'])) {
                    $toolAcc[$index]['name'] .= (string)$fragment['function']['name'];
                }
                if (isset($fragment['function']['arguments'])) {
                    $toolAcc[$index]['arguments'] .= (string)$fragment['function']['arguments'];
                }
            }
        }

        $token = (string)($delta['content'] ?? '');
        if ($token !== '') provider_route_think_token($token, $state, $emit);

        if (!empty($choice['finish_reason'])) provider_flush_think_hold($state, $emit);
    }
}

function provider_finish_openai_tool_calls(array $toolAcc, array &$state, int $round): void {
    foreach ($toolAcc as $index => $tool) {
        if ($tool['name'] === '') continue;
        // a no-arg call can stream back "". llama-server json::parse's
        // it when we send the history back and 400s "empty input"
        $args = is_array(json_decode($tool['arguments'], true)) ? $tool['arguments'] : '{}';
        $state['tool_calls'][] = [
            'id' => $tool['id'] !== '' ? $tool['id'] : 'call_' . $round . '_' . $index,
            'type' => 'function',
            'function' => ['name' => $tool['name'], 'arguments' => $args],
        ];
    }
}

// the ceilings on one upstream stream. a turn is every tool
// round of one chat.php request, so the deadline is shared and
// each round gets what's left. idle is curl's low speed check:
// under 1 byte/s for that many seconds and it hangs up. that has
// to cover a cold load plus prompt eval on a big context, which
// is minutes on CPU, so it's long. the byte caps are for a
// provider that streams garbage: a frame that never ends, a
// reply that never stops, an error page the size of a novel.
const STREAM_ERROR_BODY_MAX = 64 * 1024;

const STREAM_PENDING_MAX = 1024 * 1024;

const STREAM_CONTENT_MAX = 4 * 1024 * 1024;

const STREAM_LOOP_RETRIES = 3;
const STREAM_LOOP_MIN_CHARS = 200;
const STREAM_LOOP_MAX_PERIOD = 400;
const STREAM_LOOP_TAIL = 1200;

// stuck = the tail is one chunk said 3+ times back to back, 200+ chars of it
function stream_looping(string $text): bool {
    $len = strlen($text);
    for ($period = 1; $period <= STREAM_LOOP_MAX_PERIOD && $period * 3 <= $len; $period++) {
        $reps = max(3, (int)ceil(STREAM_LOOP_MIN_CHARS / $period));
        if ($period * $reps > $len) continue;
        $block = substr($text, -$period);
        if (substr($text, -2 * $period, $period) !== $block) continue;
        if (str_repeat($block, $reps) === substr($text, -$period * $reps)) return true;
    }
    return false;
}

// same prompt at the same temperature walks right back into the same loop
function stream_warmer(array $payload): array {
    if (isset($payload['options']['temperature'])) $payload['options']['temperature'] = min(1.0, $payload['options']['temperature'] + 0.2);
    elseif (isset($payload['temperature'])) $payload['temperature'] = min(1.0, $payload['temperature'] + 0.2);
    return $payload;
}

// [emit, stop] for provider_stream_round. the caller decides what a
// loop looks like to the user, so the abort's error frame stays here
function stream_loop_guard(callable $emit): array {
    $tail = ['thinking' => '', 'token' => ''];
    $track = function (array $out) use (&$tail, $emit) {
        if (($out['error'] ?? '') === 'looping') return;
        foreach ($tail as $key => $text) {
            if (isset($out[$key])) $tail[$key] = substr($text . $out[$key], -STREAM_LOOP_TAIL);
        }
        $emit($out);
    };
    $stuck = function () use (&$tail): string {
        return stream_looping($tail['thinking']) || stream_looping($tail['token']) ? 'looping' : '';
    };
    return [$track, $stuck];
}

const COPY_GUARD_SHARE = 0.5;
const COPY_GUARD_MIN_WORDS = 4;
const COPY_GUARD_OLD_SHARE = 0.6;
const COPY_GUARD_OLD_MIN_WORDS = 6;
const COPY_GUARD_RETRIES = 2;

function copy_words(string $text): array {
    $text = strtolower(preg_replace('/\[[^\]]*\]/', ' ', $text));
    return preg_split("/[^a-z0-9']+/", $text, -1, PREG_SPLIT_NO_EMPTY);
}

function copy_trigrams(array $words): array {
    $grams = [];
    for ($i = 0; $i + 2 < count($words); $i++) $grams[$words[$i] . ' ' . $words[$i + 1] . ' ' . $words[$i + 2]] = true;
    return $grams;
}

// [how much of one earlier reply the draft reuses, that reply]. both
// ways, or the old line word for word plus a new sentence slips through
function copy_closest(string $draft, array $earlier): array {
    $words = copy_words($draft);
    if (count($words) < COPY_GUARD_MIN_WORDS) return [0.0, ''];
    $grams = copy_trigrams($words);
    $best = [0.0, ''];
    foreach ($earlier as $reply) {
        $oldWords = copy_words($reply);
        $old = copy_trigrams($oldWords);
        $shared = count(array_intersect_key($grams, $old));
        $share = $shared / count($grams);
        if (count($oldWords) >= COPY_GUARD_OLD_MIN_WORDS && $shared / count($old) >= COPY_GUARD_OLD_SHARE) $share = max($share, $shared / count($old));
        if ($share > $best[0]) $best = [$share, $reply];
    }
    return $best;
}

// her replies before the new user turn, for the copy guard
function copy_guard_earlier(array $messages): array {
    $earlier = [];
    foreach (array_slice($messages, 0, -1) as $m) {
        if (($m['role'] ?? '') !== 'assistant' || !empty($m['tool_calls']) || !is_string($m['content'] ?? null)) continue;
        if (trim($m['content']) !== '') $earlier[] = $m['content'];
    }
    return $earlier;
}

// the same in content makes llama-server inject an empty thought block
function copy_guard_resend(string $provider, array $messages, string $prefill): array {
    return [...provider_messages($provider, $messages), ['role' => 'assistant', 'content' => '', 'reasoning_content' => $prefill]];
}

// her own voice, it goes into her thinking. the second one is for
// when she writes the same draft right back after the first
function copy_guard_line(int $attempt, string $earlier): string {
    $earlier = trim(preg_replace('/\s+/', ' ', preg_replace('/\[[^\]]*\]/', ' ', $earlier)));
    return $attempt === 1
        ? "Wait, I already said \"{$earlier}\" earlier. Not repeating myself, I will answer with new words and a new angle.\n"
        : "Still the same line as before. I will drop that idea completely and say something I have not said to him yet.\n";
}

// [emit, stop, hit, flush] for provider_stream_round. her trace drafts
// "- " lines and the reply copies the pick, so a copied draft gets
// caught BEFORE she says it. held until whole, the cut is a line end
function stream_copy_guard(callable $emit, array $earlier): array {
    $line = '';
    $shown = 0;
    $seen = '';
    $hit = null;
    $flush = function () use (&$line, &$shown, $emit) {
        if (strlen($line) > $shown) $emit(['thinking' => substr($line, $shown)]);
        $shown = strlen($line);
    };
    $track = function (array $out) use (&$line, &$shown, &$seen, &$hit, $emit, $earlier, $flush) {
        if (($out['error'] ?? '') === 'copying') return;
        if (!isset($out['thinking']) || $hit !== null) {
            $flush();
            $emit($out);
            return;
        }
        $line .= $out['thinking'];
        while (($nl = strpos($line, "\n")) !== false) {
            $whole = substr($line, 0, $nl + 1);
            if (strlen($whole) > $shown) $emit(['thinking' => substr($whole, $shown)]);
            $seen .= $whole;
            $line = substr($line, $nl + 1);
            $shown = 0;
            if (!str_starts_with($whole, '- ')) continue;
            [$share, $reply] = copy_closest(substr($whole, 2), $earlier);
            if ($share >= COPY_GUARD_SHARE) {
                $hit = ['thinking' => $seen, 'earlier' => $reply];
                [$line, $shown] = ['', 0];
                return;
            }
        }
        if ($line !== '' && $line !== '-' && !str_starts_with($line, '- ')) $flush();
    };
    // NOT fn(), an arrow fn copies $hit while it's still null
    $stop = function () use (&$hit): string { return $hit !== null ? 'copying' : ''; };
    $caught = function () use (&$hit): ?array { return $hit; };
    return [$track, $stop, $caught, $flush];
}

// a turn's stats across tool rounds. generation is spread over
// every round so those counters add up. the prompt ones do NOT.
// each round resends the whole transcript, last round's output
// included, so only the number from the last round is real.
function provider_merge_stats(?array $total, array $round): array {
    if ($total === null) return $round;
    $round['eval_count'] += $total['eval_count'];
    $round['eval_duration'] += $total['eval_duration'];
    $round['total_duration'] += $total['total_duration'];
    // TTFT is the first round's prefill, a tool round comes after
    foreach (['prompt_eval_duration', 'prompt_new'] as $k) {
        if (isset($total[$k])) $round[$k] = $total[$k];
    }
    return $round;
}

function stream_turn_deadline(): float {
    static $deadline = null;
    if ($deadline === null) $deadline = microtime(true) + max(30, (int)env_str('OMEGA_TURN_TIMEOUT_S', '900'));
    return $deadline;
}

// $stop runs after every chunk, a non-empty string hangs up with that as the reason
function provider_stream_round(string $provider, array $payload, callable $emit, int $round = 0, ?float $deadline = null, ?callable $stop = null): array {
    // ollama throws the trace away on think:false. llama.cpp and
    // vllm hand back whatever reasoning they parsed out anyway, so the
    // browser would get thinking on turns that asked for none
    if (($provider === 'llamacpp' || $provider === 'vllm') && empty($payload['chat_template_kwargs']['enable_thinking'])) {
        $emit = function (array $out) use ($emit) {
            if (!isset($out['thinking'])) $emit($out);
        };
    }
    $openai = provider_uses_openai_protocol($provider);
    $state = provider_stream_state();
    $buf = '';
    $toolAcc = [];
    $started = microtime(true);
    if ($provider === 'vllm') $payload = vllm_fit_max_tokens($payload);

    $ch = curl_init(provider_chat_endpoint($provider));
    curl_setopt($ch, CURLOPT_POST, true);
    curl_setopt($ch, CURLOPT_HTTPHEADER, chat_request_headers($provider));
    curl_setopt($ch, CURLOPT_POSTFIELDS, provider_json_body($payload));
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, false);
    curl_setopt($ch, CURLOPT_TIMEOUT_MS, max(1000, (int)((($deadline ?? stream_turn_deadline()) - $started) * 1000)));
    curl_setopt($ch, CURLOPT_LOW_SPEED_LIMIT, 1);
    curl_setopt($ch, CURLOPT_LOW_SPEED_TIME, max(10, (int)env_str('OMEGA_STREAM_IDLE_S', '300')));
    curl_setopt($ch, CURLOPT_CONNECTTIMEOUT, 10);

    // returning anything but strlen($chunk) makes curl drop the
    // transfer. that's how every cap below hangs up on upstream.
    $abort = function (string $why) use (&$state, $emit): int {
        $state['aborted'] = $why;
        if ($why !== 'client_gone') {
            $state['stream_error'] = true;
            $emit(['error' => $why]);
        }
        return -1;
    };
    $overflowed = function () use (&$buf, &$state): bool {
        return strlen($buf) > STREAM_PENDING_MAX || strlen($state['content']) > STREAM_CONTENT_MAX;
    };

    if (!$openai) {
        curl_setopt($ch, CURLOPT_WRITEFUNCTION, function ($ch, $chunk) use (&$buf, &$state, $emit, $abort, $overflowed, $stop) {
            if (connection_aborted()) return $abort('client_gone');
            if ($state['http_status'] === 0) {
                $state['http_status'] = (int)curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
            }
            // a dead runner comes back as one 500 with a json body, and
            // parsing that as a stream chunk fires the error at the browser
            // before chat.php gets a say. hold it here so the caller can
            // decide to retry somewhere else first.
            if ($state['http_status'] >= 400) {
                if (strlen($state['error_body']) > STREAM_ERROR_BODY_MAX) return $abort('upstream_error');
                $state['error_body'] .= $chunk;
                return strlen($chunk);
            }
            provider_parse_ollama_chunk($chunk, $buf, $state, $emit);
            if ($overflowed()) return $abort('upstream_overflow');
            if ($stop && ($why = $stop()) !== '') return $abort($why);
            return strlen($chunk);
        });
    } else {
        curl_setopt($ch, CURLOPT_WRITEFUNCTION, function ($ch, $chunk) use (&$buf, &$toolAcc, &$state, $emit, $abort, $overflowed, $stop) {
            if (connection_aborted()) return $abort('client_gone');
            if ($state['http_status'] === 0) {
                $state['http_status'] = (int)curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
            }
            if ($state['http_status'] >= 400) {
                if (strlen($state['error_body']) > STREAM_ERROR_BODY_MAX) return $abort('upstream_error');
                $state['error_body'] .= $chunk;
                return strlen($chunk);
            }

            provider_parse_openai_chunk($chunk, $buf, $toolAcc, $state, $emit);
            if ($overflowed()) return $abort('upstream_overflow');
            if ($stop && ($why = $stop()) !== '') return $abort($why);
            return strlen($chunk);
        });
    }

    if (curl_exec($ch) === false && $state['aborted'] === '') {
        $state['curl_error'] = curl_errno($ch) === CURLE_OPERATION_TIMEDOUT
            ? 'timeout: ' . curl_error($ch) : curl_error($ch);
    }
    if ($state['http_status'] === 0) {
        $state['http_status'] = (int)curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
    }
    $state['duration_ns'] = (int)round((microtime(true) - $started) * 1e9);

    if ($openai) provider_finish_openai_tool_calls($toolAcc, $state, $round);

    return $state;
}
