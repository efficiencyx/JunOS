<?php

// a message the way a model should read it in a transcript: every
// [A:...] / [ACTION:...] tag gone, whitespace squashed to single
// spaces. the tags are for the avatar, not for whoever summarizes.
function spoken_text(string $text): string {
    return trim(preg_replace('/\s+/', ' ', preg_replace('/\[\s*A(?:CTIONS?)?\s*:[^\]]*\]/i', '', $text)));
}

function speaker_name(string $role): string {
    return $role === 'assistant' ? 'Jun' : 'Anon';
}

// byte offset of $needle starting a word in $text, or null. a
// bare substring would let "ai" hit "said". lookbehind, not \b,
// so a needle that opens with "(" still matches
function recall_word_at(string $text, string $needle): ?int {
    if (!preg_match('/(?<![\p{L}\p{N}])' . preg_quote($needle, '/') . '/iu', $text, $m, PREG_OFFSET_CAPTURE)) return null;
    return $m[0][1];
}

// char offset of the hit, or null. exact phrase first, then every
// word of the query in any order, so "her birthday party" still
// finds "threw a party for her birthday"
function recall_match(string $text, string $query, array $terms): ?int {
    $at = recall_word_at($text, $query);
    if ($at === null && $terms) {
        foreach ($terms as $t) {
            $hit = recall_word_at($text, $t);
            if ($hit === null) return null;
            $at = min($at ?? PHP_INT_MAX, $hit);
        }
    }
    return $at === null ? null : mb_strlen(substr($text, 0, $at));
}

// 500 chars around the hit. the first 500 of a long message can
// leave out the very line the search found
function recall_excerpt(string $text, int $at, int $max = 500): string {
    $len = mb_strlen($text);
    if ($len <= $max) return $text;
    $keep = $max - 2;
    $start = max(0, min($at - intdiv($keep, 3), $len - $keep));
    return ($start > 0 ? '…' : '') . mb_substr($text, $start, $keep) . ($start + $keep < $len ? '…' : '');
}
