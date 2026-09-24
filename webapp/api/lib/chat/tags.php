<?php

// same training quirk as memory_write below. Jun sometimes just
// writes these as her own [A:...] tags instead of calling the
// tool, so send them down the same path. flee_adjudicate() still
// has to approve a flee tag, the tag itself proves nothing.
function chat_parse_action_tags(string $buffer, array $ctx, array &$state): string {
    // the second form is the call itself, unparsed. about 1 turn in
    // 6 with the overheard hint on, she writes
    // `stay_silent{overheard:true,...}` or
    // `stay_silent(overheard=true)` as plain text and ollama's
    // parser lets it through. Anon would read that on screen.
    if (!$state['silenced'] && !$ctx['req']['idle'] && (preg_match('/\[\s*A(?:CTIONS?)?\s*:\s*stay_silent\b([^\]]*)\]/i', $buffer, $sm)
            || preg_match('/^\s*stay_silent\s*[({](.*)$/is', $buffer, $sm))) {
        $state['silenced'] = true;
        if (preg_match('/\breason\s*=\s*([^|\]]+)/i', $sm[1], $sr)) $state['silence_reason'] = trim($sr[1]);
        $state['overheard'] = $ctx['req']['spoken'] && (bool)preg_match('/\boverheard\s*[:=]\s*true\b/i', $sm[1]);
    }
    if (!$state['silenced'] && $state['fled'] === null && !$state['flee_decided']
        && preg_match('/\[\s*A(?:CTIONS?)?\s*:\s*flee\b([^\]]*)\]/i', $buffer, $fm)) {
        $state['flee_decided'] = true;
        $fleeReason = preg_match('/\breason\s*=\s*([^|\]]+)/i', $fm[1], $fr) ? trim($fr[1]) : '';
        $destination = preg_match('/\bdestination\s*=\s*([^|\]]+)/i', $fm[1], $fd) ? trim($fd[1]) : '';
        chat_flee($ctx, $state, $fleeReason, $destination, 'action_tag');
    }
    return trim(preg_replace('/\[\s*A(?:CTIONS?)?\s*:\s*(?:flee|stay_silent)\b[^\]]*\]/i', '', $buffer));
}

function chat_apply_bookkeeping_tags(string $buffer, int $userId, array $rel): string {
    // relationship tags are state, not dialogue. never persist them.
    if (preg_match('/\[\s*A(?:CTIONS?)?\s*:\s*mood_shift\b([^\]]*)\]/i', $buffer, $mm)) {
        $deltas = [];
        foreach (['affection', 'trust', 'tension'] as $k) {
            if (preg_match('/' . $k . '\s*=\s*([+-]?\d+)/i', $mm[1], $p)) $deltas[$k] = (int)$p[1];
        }
        if ($deltas) relationship_apply($userId, $rel, $deltas);
        $buffer = trim(preg_replace('/\[\s*A(?:CTIONS?)?\s*:\s*mood_shift\b[^\]]*\]/i', '', $buffer));
    }

    // Jun sometimes writes memory_write as one of her [A:...]
    // tags instead of calling the tool. it's write-only though, so
    // the tag already has everything we need. save it here instead
    // of throwing the note away.
    if (preg_match_all('/\[\s*A(?:CTIONS?)?\s*:\s*memory_write\b([^\]]*)\]/i', $buffer, $mws, PREG_SET_ORDER)) {
        foreach ($mws as $mw) {
            // category comes out FIRST, separator and all, because
            // memory= runs to the end of the tag (the note can have
            // commas) and would take a trailing |category=... with it
            $args = $mw[1];
            $category = 'general';
            if (preg_match('/(?:^|[|,])\s*category\s*=\s*([^|,\]]+)/i', $args, $cat)) {
                $category = trim($cat[1]);
                $args = str_replace($cat[0], '', $args);
            }
            if (!preg_match('/\bmemory\s*=\s*(.+)$/is', $args, $mem)) continue;
            $res = memory_note_add($userId, $category, trim($mem[1]));
            sse_send(['tool_status' => [
                'name' => 'memory_write', 'state' => 'done', 'duration_ms' => 0,
                'result' => json_encode($res, JSON_UNESCAPED_UNICODE),
            ]]);
        }
    }
    return trim(preg_replace('/\[\s*A(?:CTIONS?)?\s*:\s*memory_write\b[^\]]*\]/i', '', $buffer));
}
