<?php

require_once __DIR__ . '/retrieval.php';

const LORE_FIELDS = ['q' => 1.5, 'a' => 1.0];
const LORE_PROPER_BOOST = 2.0;
const LORE_FUZZY_PENALTY = 0.6;
const LORE_FUZZY_MIN_IDF = 2.0;
const LORE_MAX_INJECT = 5;
const LORE_DEDUP_JACCARD = 0.5;
const LORE_GATE_COVER = 0.5;
const LORE_GATE_WORDS = 2;
const LORE_HIT_SHARE = 0.5;
const LORE_ASKED_BONUS = 0.5;
const LORE_FILLER_WEIGHT = 0.3;

// IDF (how rare a word is in the lore) has no clue that ordinary
// chat words are common OUTSIDE the corpus. "morning" is rare in
// the lore so it scores high. cool. so retrieval.json lists them out by hand
function lore_filler(): array {
    static $set = null;
    if ($set !== null) return $set;
    $set = [];
    foreach (explode(' ', rt_words()['lore_filler']) as $w) $set[$w] = $set[rt_stem($w)] = true;
    return $set;
}

function lore_index(): ?array {
    // false = not built yet. null = there is no corpus. different things
    static $idx = false;
    if ($idx !== false) return $idx;

    if (function_exists('apcu_fetch')) {
        $cached = apcu_fetch('lore_kw_v3');
        if (is_array($cached)) return $idx = $cached;
    }

    $path = __DIR__ . '/../../lore_corpus.jsonl';
    if (!is_readable($path)) return $idx = null;
    $rows = [];
    foreach (file($path, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) ?: [] as $line) {
        $row = json_decode($line, true);
        if (is_array($row) && ($row['a'] ?? '') !== '') $rows[] = ['q' => (string)($row['q'] ?? ''), 'a' => (string)$row['a']];
    }
    if (!$rows) return $idx = null;

    $cap = []; $low = [];
    foreach ($rows as $row) {
        foreach (['q', 'a'] as $field) {
            $text = $row[$field];
            foreach (rt_tokens($text) as [$stem, $orig, $off]) {
                // count capitals ONLY mid-sentence. "Annalie" turns up
                // after another word. "However" and "Coming" only ever
                // Start sentences, so that capital tells us exactly
                // nothing about whether it's a name.
                $j = $off - 1;
                while ($j >= 0 && $text[$j] === ' ') $j--;
                $initial = ($j < 0) || strpos('.!?:"', $text[$j]) !== false;
                $upper = $orig !== mb_strtolower($orig) && mb_substr($orig, 0, 1) === mb_strtoupper(mb_substr($orig, 0, 1));
                if ($upper && !$initial) $cap[$stem] = ($cap[$stem] ?? 0) + 1;
                elseif (!$upper) $low[$stem] = ($low[$stem] ?? 0) + 1;
            }
        }
    }

    $built = rt_index($rows, LORE_FIELDS);
    $built['rows'] = $rows;
    $built['proper'] = [];
    $built['strict'] = [];
    $days = array_flip(array_map('rt_stem', explode(' ', rt_words()['lore_not_names'])));
    foreach ($cap as $stem => $c) {
        if ($c >= 2 && $c >= ($low[$stem] ?? 0)) $built['proper'][$stem] = true;
        if ($c >= 2 && !isset($low[$stem]) && !isset($days[$stem])) $built['strict'][$stem] = true;
    }
    // fuzzy match only distinctive proper nouns. a typo can land
    // on "Annalie" or "Shanice", but an ordinary word must never
    // get "corrected" into some common capitalised word.
    $built['fuzzy'] = array_values(array_filter(array_keys($built['proper']), fn($s) => ($built['idf'][$s] ?? 0) >= LORE_FUZZY_MIN_IDF));
    if (function_exists('apcu_store')) apcu_store('lore_kw_v3', $built, 0);
    return $idx = $built;
}

// $matched is typo -> lore word, the tool hands it back to her
function lore_query(array $idx, string $text, ?array &$matched = null, bool $filler = true): array {
    $query = rt_query([[$text, 1.0]], true, lore_filler(), rt_words()['lore_aliases']);
    // filler can still tell two Melissa facts apart ("what does she
    // call me"), it just never decides on its own
    if ($filler) {
        $all = rt_query([[$text, LORE_FILLER_WEIGHT]], false);
        $query['terms'] += $all['terms'];
        $query['pairs'] += $all['pairs'];
    }
    $matched = [];
    $resolved = [];
    foreach ($query['terms'] as $t => $w) {
        if (isset($idx['idf'][$t])) { $resolved[$t] = max($resolved[$t] ?? 0, $w); continue; }
        if ($w < 1.0) continue;
        $hit = rt_fuzzy($t, $idx['fuzzy']);
        if ($hit === null) continue;
        $resolved[$hit] = max($resolved[$hit] ?? 0, $w * LORE_FUZZY_PENALTY);
        $matched[$t] = $hit;
    }
    $query['terms'] = $resolved;
    return $query;
}

function lore_boost(array $idx, array $query): array {
    $boost = [];
    foreach ($query['terms'] as $t => $_) if (isset($idx['proper'][$t])) $boost[$t] = LORE_PROPER_BOOST;
    return $boost;
}

// "butt" typed lowercase is chat, not BUTT the cult. lowercase only
// counts as a name when the lore never writes it lowercase either
function lore_names_in(array $idx, string $text): array {
    $names = [];
    foreach (rt_tokens($text, lore_filler()) as [$stem, $orig, $off]) {
        $before = rtrim(substr($text, 0, $off));
        $initial = $before === '' || strpos('.!?:"(', substr($before, -1)) !== false;
        $capital = !$initial && mb_substr($orig, 0, 1) !== mb_strtolower(mb_substr($orig, 0, 1));
        if (!$capital && !isset($idx['strict'][$stem])) continue;
        if (!isset($idx['proper'][$stem])) $stem = $capital ? rt_fuzzy($stem, array_filter($idx['fuzzy'], fn($v) => strlen($v) >= 4)) : null;
        if ($stem !== null && ($idx['idf'][$stem] ?? 0) >= LORE_FUZZY_MIN_IDF) $names[] = $stem;
    }
    return array_values(array_unique($names));
}

// $dedup folds rows sharing half their words into the first one
function lore_search(string $text, int $topK = 1, bool $dedup = false, ?array &$matched = null): array {
    $idx = lore_index();
    if ($idx === null) return [];
    $query = lore_query($idx, $text, $matched);
    if (!$query['terms']) return [];

    $scored = rt_score($idx, $query, lore_boost($idx, $query));
    // "who is Shanice" should land on the row that asks exactly that,
    // not on one of the 249 that mention her in passing
    foreach (array_slice($scored, 0, 40, true) as $i => $s) {
        $asked = array_unique(rt_terms($idx['rows'][$i]['q']));
        $said = count(array_intersect($asked, array_keys($query['terms'])));
        $scored[$i][0] *= 1 + LORE_ASKED_BONUS * ($asked ? $said / count($asked) : 0);
    }
    uasort($scored, fn($a, $b) => $b[0] <=> $a[0]);

    $out = [];
    $kept = [];
    foreach ($scored as $i => [$score, $cover]) {
        $row = $idx['rows'][$i];
        if ($dedup) {
            $terms = rt_terms($row['a']);
            foreach ($kept as $k) if (rt_jaccard($terms, $k) >= LORE_DEDUP_JACCARD) continue 2;
            $kept[] = $terms;
        }
        $out[] = ['score' => round($score, 4), 'cover' => round($cover, 3), 'answer' => $row['a'], 'q' => $row['q']];
        if (count($out) >= $topK) break;
    }
    return $out;
}

// a lore name, or one row covering half of what he typed with two+
// of his words. ONE word is "shut up" scoring like a quest
function lore_gate(string $text): array {
    $idx = lore_index();
    if ($idx === null || trim($text) === '') return [];
    if (!lore_names_in($idx, $text)) {
        $core = lore_query($idx, $text, $_, false);
        $said = array_keys(array_filter($core['terms'], fn($w) => $w >= 1.0));
        $top = rt_score($idx, $core, lore_boost($idx, $core));
        $top = $top ? reset($top) : null;
        if (!$top || $top[1] < LORE_GATE_COVER || count(array_intersect(array_unique($top[2]), $said)) < LORE_GATE_WORDS) return [];
    }
    $hits = lore_search($text, LORE_MAX_INJECT, true);
    if (!$hits) return [];
    $floor = $hits[0]['score'] * LORE_HIT_SHARE;
    return array_values(array_filter($hits, fn($h) => $h['score'] >= $floor));
}

// how the lore itself spells a stem, "annali" -> "Annalie"
function lore_spelling(array $idx, string $stem): ?string {
    foreach ($idx['rows'] as $row) {
        if (preg_match('/\b(' . preg_quote($stem, '/') . '[\p{L}\']*)/iu', $row['a'], $m)) return $m[1];
    }
    return null;
}

function lore_understood(string $text, array $matched): array {
    $idx = lore_index();
    $out = [];
    foreach (rt_tokens($text) as [$stem, $orig]) {
        if (isset($matched[$stem]) && ($fixed = lore_spelling($idx, $matched[$stem])) !== null) $out[$orig] = $fixed;
    }
    return $out;
}

function lore_did_you_mean(string $text, int $max = 3): array {
    $idx = lore_index();
    if ($idx === null) return [];
    $near = [];
    foreach (rt_tokens($text, lore_filler()) as [$stem]) {
        if (strlen($stem) < 4) continue;
        foreach ($idx['fuzzy'] as $v) {
            $d = levenshtein($stem, $v);
            if ($d <= max(2, intdiv(strlen($stem), 3))) $near[$v] = min($near[$v] ?? 99, $d);
        }
    }
    asort($near);
    $out = [];
    foreach (array_keys($near) as $stem) {
        $word = lore_spelling($idx, $stem);
        if ($word !== null) $out[] = $word;
        if (count($out) >= $max) break;
    }
    return array_values(array_unique($out));
}
