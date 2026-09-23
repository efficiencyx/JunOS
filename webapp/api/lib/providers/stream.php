<?php

function provider_stream_state(): array {
    return [
        'content' => '',
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
        if ($thinking !== '') $emit(['thinking' => $thinking]);

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
        $choice = $obj['choices'][0] ?? null;
        if (!is_array($choice)) continue;
        if (!empty($choice['finish_reason'])) {
            $state['done_reason'] = (string)$choice['finish_reason'];
        }
        $delta = is_array($choice['delta'] ?? null) ? $choice['delta'] : [];

        $thinking = (string)($delta['reasoning'] ?? $delta['reasoning_content'] ?? '');
        if ($thinking !== '') $emit(['thinking' => $thinking]);

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
        $state['tool_calls'][] = [
            'id' => $tool['id'] !== '' ? $tool['id'] : 'call_' . $round . '_' . $index,
            'type' => 'function',
            'function' => ['name' => $tool['name'], 'arguments' => $tool['arguments']],
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

// a turn's stats across tool rounds. generation is spread over
// every round so those counters add up. the prompt ones do NOT.
// each round resends the whole transcript, last round's output
// included, so only the number from the last round is real.
function provider_merge_stats(?array $total, array $round): array {
    if ($total === null) return $round;
    $round['eval_count'] += $total['eval_count'];
    $round['eval_duration'] += $total['eval_duration'];
    $round['total_duration'] += $total['total_duration'];
    return $round;
}

function stream_turn_deadline(): float {
    static $deadline = null;
    if ($deadline === null) $deadline = microtime(true) + max(30, (int)env_str('OMEGA_TURN_TIMEOUT_S', '900'));
    return $deadline;
}

function provider_stream_round(string $provider, array $payload, callable $emit, int $round = 0): array {
    $openai = provider_uses_openai_protocol($provider);
    $state = provider_stream_state();
    $buf = '';
    $toolAcc = [];
    $started = microtime(true);

    $ch = curl_init(provider_chat_endpoint($provider));
    curl_setopt($ch, CURLOPT_POST, true);
    curl_setopt($ch, CURLOPT_HTTPHEADER, chat_request_headers($provider));
    curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($payload, JSON_UNESCAPED_UNICODE));
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, false);
    curl_setopt($ch, CURLOPT_TIMEOUT_MS, max(1000, (int)((stream_turn_deadline() - $started) * 1000)));
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
        curl_setopt($ch, CURLOPT_WRITEFUNCTION, function ($ch, $chunk) use (&$buf, &$state, $emit, $abort, $overflowed) {
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
            return strlen($chunk);
        });
    } else {
        curl_setopt($ch, CURLOPT_WRITEFUNCTION, function ($ch, $chunk) use (&$buf, &$toolAcc, &$state, $emit, $abort, $overflowed) {
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
    curl_close($ch);
    $state['duration_ns'] = (int)round((microtime(true) - $started) * 1e9);

    if ($openai) provider_finish_openai_tool_calls($toolAcc, $state, $round);

    return $state;
}
