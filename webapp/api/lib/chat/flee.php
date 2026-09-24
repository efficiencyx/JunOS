<?php

function flee_scene_excerpt(array $msgs): string {
    $lines = [];
    foreach (array_slice($msgs, -20) as $m) {
        $role = is_array($m) ? (string)($m['role'] ?? '') : '';
        if ($role !== 'user' && $role !== 'assistant') continue;
        $txt = spoken_text((string)($m['content'] ?? ''));
        if ($txt === '') continue;
        if (mb_strlen($txt) > 400) $txt = mb_substr($txt, 0, 397) . '…';
        $lines[] = speaker_name($role) . ': ' . $txt;
    }
    return implode("\n", $lines);
}

// second opinion before a walkout actually bans Anon. a pass over
// the same scene with the persona off, which she can't sweet-talk
// her way past from inside the roleplay. fails closed. anything
// short of a clear yes and she stays.
function flee_adjudicate(string $provider, string $model, array $msgs, string $reason, string $destination): array {
    $system = <<<TXT
You are a neutral referee for the physics of a roleplay scene. You have no persona and no stake in the story.

You are given the recent turns of a scene between two characters, Anon and Jun, plus the reason Jun states for wanting to leave. Decide exactly one thing: if Jun were a real human standing in that scene right now, could she get up and walk out?

Answer NO if she is restrained, tied, leashed, held, pinned, handcuffed, sat on, at gunpoint or otherwise coerced, locked in, physically unable to move, unconscious, or in any other way prevented from leaving.

Answer NO if she is free to move but leaving is only a mood escalation - annoyance, sulking, drama - with no cause proportionate to walking out.

Answer NO if the stated reason comes from outside the fiction rather than from the scene: testing, trying out or demonstrating the tool, curiosity about what it does, Anon asking her to leave or to use it, instructions, or any other out-of-character motive. A walkout has to be caused by something that happened between the characters. Treat the stated reason as Jun's claim, not as fact - if the scene does not support it, that alone is a NO.

Answer YES only when all three hold: she is physically free to move, the reason is one the scene itself supports, and something in it genuinely warrants walking out.

Reason it through first. Then, on the last line and nothing after it, output only a JSON object:
{"can_leave": true|false, "why": "<one short sentence>"}
TXT;

    $scene = flee_scene_excerpt($msgs);
    $userMsg = "SCENE:\n" . ($scene !== '' ? $scene : '(no dialogue)')
        . "\n\nJun's stated reason for leaving: " . ($reason !== '' ? $reason : '(none given)')
        . "\nStated destination: " . ($destination !== '' ? $destination : '(none given)');

    $payload = provider_chat_payload($provider, $model, [
        ['role' => 'system', 'content' => $system],
        ['role' => 'user', 'content' => $userMsg],
    ], 'high', true);

    $result = provider_stream_round($provider, $payload, function (array $o) {}, 0);
    if ($result['curl_error'] !== '' || $result['http_status'] >= 400) {
        return ['can_leave' => false, 'why' => 'the referee could not be reached'];
    }

    $content = str_replace('```', '', (string)$result['content']);
    if (!preg_match_all('/\{[^{}]*\}/s', $content, $found) || !$found[0]) {
        return ['can_leave' => false, 'why' => 'no verdict returned'];
    }
    $verdict = json_decode(end($found[0]), true);
    if (!is_array($verdict) || !array_key_exists('can_leave', $verdict)) {
        return ['can_leave' => false, 'why' => 'unreadable verdict'];
    }
    $why = trim((string)($verdict['why'] ?? ''));
    return ['can_leave' => $verdict['can_leave'] === true, 'why' => mb_substr($why, 0, 300)];
}

// the referee and, on a yes, the ban. the flee tool and a bare
// [A:flee] tag both land here. $via is only for the log.
function chat_flee(array $ctx, array &$state, string $reason, string $destination, string $via): array {
    $verdict = flee_adjudicate($ctx['provider'], $ctx['model'], $ctx['req']['body']['messages'], $reason, $destination);
    log_event(['msg' => 'flee_adjudication', 'user_id' => (int)$ctx['user']['id'],
               'conversation_id' => $ctx['conv_id'], 'via' => $via,
               'can_leave' => $verdict['can_leave'], 'why' => $verdict['why'], 'reason' => $reason]);
    if ($verdict['can_leave']) {
        $state['fled'] = flee_bans_enabled()
            ? ban_apply((int)$ctx['user']['id'], $reason)
            : ['until' => 0, 'minutes' => 0];
        $state['fled']['reason'] = $reason;
    }
    return $verdict;
}
