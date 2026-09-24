<?php

// keep this byte-identical between turns or Ollama throws away
// the KV cache, the work it already did on the prefix. persona,
// fixed rubrics and tool prose live here. NEVER a per-turn value.
// the journal is the one exception, only idle consolidation
// rewrites it and only while Anon is away. everything else that
// moves goes in the live context.
function chat_system_prompt(): string {
    $promptPath = __DIR__ . '/../../../system_prompt.txt';
    return is_readable($promptPath) ? rtrim(file_get_contents($promptPath)) : '';
}

// the `<!--tools-->` block tells her to use search_lore and
// search_recent_chats. with no tools, or LLAMACPP_TOOLS=off,
// those calls don't exist. she tries anyway. about one turn in
// five comes back as a raw <|tool_call> blob where her reply
// should be, and the HF pull has no parser, so Anon reads it. lol
//
// markers get stripped either way. with tools ON what's left is
// byte-identical to the shipped prompt. touch that prefix and
// Ollama dumps the KV cache and TTFT (time to first token)
// increases because it has to read the prefix again.
function prompt_apply_tool_gate(string $prompt, bool $toolsOffered): string {
    if ($toolsOffered) return preg_replace('/^<!--\/?tools-->\R/m', '', $prompt);
    $prompt = preg_replace('/^<!--tools-->\R.*?^<!--\/tools-->\R/ms', '', $prompt);
    return preg_replace('/\R{3,}/', "\n\n", $prompt);
}

function chat_system_content(bool $toolsOffered, int $userId): string {
    // she learns how to read the blocks and when to reach for a tool
    // from TRAINING, not from here, so the prompt stays thin. must
    // match tools/dataset_v5.
    $systemContent = prompt_apply_tool_gate(chat_system_prompt(), $toolsOffered);
    $journalContext = journal_context($userId);
    if ($journalContext !== '') $systemContent .= "\n\n" . $journalContext;
    return $systemContent;
}

function chat_build_messages(array $req, string $systemContent, string $liveContext, int $summaryCoveredCount): array {
    $messages = [];
    $messages[] = ['role' => 'system', 'content' => $systemContent];
    $skipCovered = max(0, $summaryCoveredCount - $req['dropped_oldest']);
    foreach ($req['body']['messages'] as $m) {
        if (!is_array($m) || !isset($m['role'], $m['content'])) continue;
        // the system turn is ours. Never the client's.
        if ($m['role'] === 'system') continue;
        // these turns already live in the summary. don't send them twice
        if ($skipCovered > 0) { $skipCovered--; continue; }
        $messages[] = ['role' => $m['role'], 'content' => (string)$m['content']];
    }

    if ($req['idle']) {
        $messages[] = ['role' => 'user', 'content' =>
            '(OOC stage direction, not spoken by Anon: Anon has gone quiet and is just '
            . 'saying nothing. The silence has stretched on. '
            . 'Unless he specifically asked you to be quiet say or do something on your own initiative, the way Jun '
            . 'naturally would when Anon goes still and stares at her. '
            . 'If asked to be quiet Break the silence with ONLY an action. such as a wave or a smile. No chat or text!)'];
    }

    // per turn context goes into the LAST user turn. strict templates
    // only take a system role at the front, and a prefix that never
    // moves keeps Ollama's KV cache alive. only things that change go
    // here, how to read them lives in the cached system message.
    //
    // and what he SAID comes first, context after. that's the shape
    // she was trained on, tools/build_dataset_v6.py writes every row
    // as user_text + "\n\n# Live context ..." and splits his words
    // back off on that same marker. put the block in front instead
    // and his message becomes a loose line dangling off the end of a
    // system dump, she can't tell it apart anymore, and she answers
    // the wardrobe and the gauges instead of him.
    $lastIdx = count($messages) - 1;
    if ($lastIdx >= 0 && $messages[$lastIdx]['role'] === 'user') {
        if ($req['audio'] !== '') {
            // Ollama ONLY reads media out of `images`, whatever's in it. send
            // the wav under `audio` or `audios` and it drops the field
            // silently, then she answers a turn with nothing in it. no error.
            // nothing.
            $messages[$lastIdx]['content'] =
                "## How Anon is talking\nHe is saying this out loud, the recording is attached. He is not typing."
                . "\n\n" . $liveContext;
            $messages[$lastIdx]['images'] = [$req['audio']];
        } else {
            $messages[$lastIdx]['content'] .= "\n\n" . $liveContext;
        }
    } else {
        $messages[] = ['role' => 'user', 'content' => $liveContext];
    }
    return $messages;
}

// tuple order is effort, think, reason
function route_reasoning(string $msg, bool $idle): array {
    if ($idle || trim($msg) === '') return ['low', false, 'idle/empty'];

    $m = mb_strtolower(trim($msg));
    $wordCount = count(preg_split('/\s+/u', $m, -1, PREG_SPLIT_NO_EMPTY));
    $questions = substr_count($m, '?');
    $signals = [];

    if (preg_match('/\b(explain|why|how (?:do|does|did|can|would|should|to)|calculat|'
        . 'comput|solve|prove|deriv|reason|analy[sz]|compare|difference between|'
        . 'step by step|walk me through|figure out|work out|plan|strateg|debug|'
        . 'optimi[sz]|translate|summar|pros and cons|which is better|trade-?off)\b/u', $m)) {
        $signals[] = 'analytical';
    }

    if (preg_match('#\d+\s*[-+*/x×÷%=]\s*\d+#u', $m)
        || preg_match('/\b(how many|how much|how long|how old|days? (?:since|ago|until)|'
            . 'hours? (?:since|ago)|what time|percentage|average|total)\b/u', $m)) {
        $signals[] = 'quantitative';
    }

    if ($questions >= 2) $signals[] = 'multi-question';
    if ($wordCount >= 25) $signals[] = 'long';

    if (!$signals) return ['low', false, 'simple'];

    $effort = (count($signals) >= 2 || $wordCount >= 60) ? 'high' : 'medium';
    return [$effort, true, implode('+', $signals)];
}
