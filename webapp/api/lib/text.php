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
