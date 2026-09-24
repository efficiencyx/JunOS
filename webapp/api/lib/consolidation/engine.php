<?php

// messages.id is INTEGER PRIMARY KEY with NO AUTOINCREMENT, so
// SQLite hands out max(rowid)+1 and happily reuses ids a delete
// freed. drop the newest conversation and upto_id is suddenly
// above every row that's left, so `m.id > upto_id` starves
// consolidation for Ever. so: wind back any watermark that ran
// past its user's messages.
function consolidation_repair_watermarks(PDO $db): void {
    $db->exec(
        'UPDATE memory_consolidation SET upto_id = 0
         WHERE upto_id > (SELECT COALESCE(MAX(m.id), 0) FROM messages m
                          JOIN conversations c ON c.id = m.conversation_id
                          WHERE c.user_id = memory_consolidation.user_id)'
    );
}

// ONLY ever called for a run that actually reached the model. a
// poll we skipped must not stomp the outcome the client is still
// showing, and must not move last_run.
function consolidation_record_result(int $userId, string $status, int $noteCount = 0): void {
    db()->prepare(
        'INSERT INTO memory_consolidation (user_id, last_run, last_status, last_note_count) VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET last_run = excluded.last_run,
             last_status = excluded.last_status, last_note_count = excluded.last_note_count'
    )->execute([$userId, time(), $status, $noteCount]);
}

function consolidation_tool(string $name, string $description, array $properties = [], array $required = []): array {
    $parameters = ['type' => 'object', 'properties' => $properties ?: (object)[]];
    if ($required) $parameters['required'] = $required;
    return [
        'type' => 'function',
        'function' => [
            'name' => $name,
            'description' => $description,
            'parameters' => $parameters,
        ],
    ];
}

function consolidation_json_ops(string $content): array {
    $json = trim($content);
    if (preg_match('/```(?:json)?\s*(.*?)\s*```/is', $json, $match)) $json = trim($match[1]);
    $length = strlen($json);
    for ($start = 0; $start < $length; $start++) {
        if ($json[$start] !== '[' || !preg_match('/\G\[\s*\{/A', $json, $match, 0, $start)) continue;
        $depth = 0;
        $inString = false;
        $escaped = false;
        for ($end = $start; $end < $length; $end++) {
            $char = $json[$end];
            if ($inString) {
                if ($escaped) $escaped = false;
                elseif ($char === '\\') $escaped = true;
                elseif ($char === '"') $inString = false;
                continue;
            }
            if ($char === '"') {
                $inString = true;
                continue;
            }
            if ($char === '[') $depth++;
            elseif ($char === ']' && --$depth === 0) {
                $ops = json_decode(substr($json, $start, $end - $start + 1), true);
                if (!is_array($ops) || !array_is_list($ops)) break;
                return array_values(array_filter($ops, function ($op): bool {
                    return is_array($op)
                        && trim((string)($op['tool'] ?? '')) !== ''
                        && is_array($op['args'] ?? []);
                }));
            }
        }
    }
    return [];
}

function consolidation_tool_loop(
    int $userId,
    string $system,
    string $input,
    array $tools,
    callable $exec,
    int $maxRounds = 10
): array {
    $provider = ai_provider();
    $nativeTools = provider_tools_enabled();
    if (!$nativeTools) {
        $system .= "\n\nTool calling is unavailable. Answer with a JSON array of operations shaped "
            . '{"tool":"tool_name","args":{"name":"value"}}. Use an empty array when no operation is needed.';
    }
    $messages = [
        ['role' => 'system', 'content' => $system],
        ['role' => 'user', 'content' => $input],
    ];
    $counts = [];
    $finished = false;

    for ($round = 0; $round < $maxRounds; $round++) {
        $reply = provider_complete_tools(
            $provider,
            default_chat_model(),
            $messages,
            $nativeTools ? $tools : [],
            4000,
            false
        );
        if (isset($reply['error'])) throw new RuntimeException('consolidation_provider_' . $reply['error']);

        $content = (string)($reply['content'] ?? '');
        $calls = is_array($reply['tool_calls'] ?? null) ? $reply['tool_calls'] : [];
        if (!$calls) {
            foreach (consolidation_json_ops($content) as $index => $op) {
                $arguments = $op['args'];
                $messageArguments = $arguments ?: (object)[];
                $calls[] = [
                    'id' => 'consolidation-' . $round . '-' . $index,
                    'type' => 'function',
                    'function' => [
                        'name' => (string)$op['tool'],
                        'arguments' => provider_uses_openai_protocol($provider)
                            ? json_encode($messageArguments, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES)
                            : $messageArguments,
                    ],
                ];
            }
        }
        if (!$calls) break;

        $calls = array_slice($calls, 0, 6);
        foreach ($calls as $index => &$call) {
            if (!isset($call['id']) || trim((string)$call['id']) === '') {
                $call['id'] = 'consolidation-' . $round . '-' . $index;
            }
            if (!isset($call['type'])) $call['type'] = 'function';
            if (!provider_uses_openai_protocol($provider)
                && isset($call['function']['arguments'])
                && $call['function']['arguments'] === []) {
                $call['function']['arguments'] = (object)[];
            }
        }
        unset($call);
        $messages[] = ['role' => 'assistant', 'content' => $content, 'tool_calls' => $calls];

        $roundHadError = false;
        foreach ($calls as $call) {
            $fn = is_array($call['function'] ?? null) ? $call['function'] : [];
            $name = trim((string)($fn['name'] ?? ''));
            $args = tool_call_args($call);
            $counts[$name] = ($counts[$name] ?? 0) + 1;
            try {
                $result = $exec($name, $args);
                if (!is_array($result)) $result = ['result' => $result];
            } catch (Throwable $e) {
                $result = ['error' => 'tool_failed'];
                log_event(['msg' => 'memory_consolidation_tool_error', 'user_id' => $userId, 'tool' => $name, 'err' => $e->getMessage()]);
            }
            if (isset($result['error'])) $roundHadError = true;
            $messages[] = provider_tool_message(
                $provider,
                $name,
                (string)$call['id'],
                json_encode($result, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES)
            );
            if ($name === 'finish_up') {
                if (!$roundHadError) {
                    $finished = true;
                    break;
                }
            }
        }
        if ($finished) break;
    }

    return [
        'counts' => $counts,
        'total' => array_sum($counts),
        'finished' => $finished,
    ];
}
