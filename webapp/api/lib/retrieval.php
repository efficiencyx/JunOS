<?php

const RT_K1 = 1.2;
const RT_B = 0.75;
const RT_EXPAND_WEIGHT = 0.5;
const RT_PAIR_BONUS = 0.5;



// the android app reads the same retrieval.json, edit it once
function rt_words(): array {
    static $words = null;
    return $words ??= json_decode((string)file_get_contents(__DIR__ . '/retrieval.json'), true);
}

// function words only. chat filler like "coffee" is a real fact in
// his notes, lore.php drops it on its own
function rt_stopwords(): array {
    static $set = null;
    return $set ??= array_flip(preg_split('/\s+/u', implode(' ', rt_words()['stop']), -1, PREG_SPLIT_NO_EMPTY));
}

// light english stemmer. ascii words only, everything else is
// left alone (a cute italian "stemming" would eat real words)
function rt_stem(string $w): string {
    if (!preg_match('/^[a-z]+$/', $w)) return $w;
    $n = strlen($w);
    if ($n > 4 && str_ends_with($w, 'ies')) return substr($w, 0, -3) . 'y';
    if ($n > 4 && str_ends_with($w, 'sses')) return substr($w, 0, -2);
    if ($n > 4 && preg_match('/(?:s|x|z|ch|sh)es$/', $w)) return substr($w, 0, -2);
    if ($n > 5 && str_ends_with($w, 'ing')) $w = substr($w, 0, -3);
    elseif ($n > 4 && str_ends_with($w, 'ed')) $w = substr($w, 0, -2);
    elseif ($n > 3 && str_ends_with($w, 's') && !preg_match('/(?:ss|us|is)$/', $w)) $w = substr($w, 0, -1);
    else return strlen($w) >= 4 && str_ends_with($w, 'e') ? substr($w, 0, -1) : $w;
    if (preg_match('/([bdfgklmnprtz])\1$/', $w)) $w = substr($w, 0, -1);
    return strlen($w) >= 4 && str_ends_with($w, 'e') ? substr($w, 0, -1) : $w;
}

// code point ranges, not \p{Han}: pcre counts the ideographic full stop
// as Han and java doesn't, and the phone has to cut words the same way
const RT_CJK = '\x{0E00}-\x{0E7F}\x{1100}-\x{11FF}\x{2E80}-\x{2FDF}\x{3005}-\x{3007}\x{3021}-\x{3029}\x{3038}-\x{303B}\x{3041}-\x{309F}\x{30A0}-\x{30FF}\x{3130}-\x{318F}\x{31F0}-\x{31FF}\x{3400}-\x{4DBF}\x{4E00}-\x{9FFF}\x{AC00}-\x{D7AF}\x{F900}-\x{FAFF}\x{FF66}-\x{FF9F}\x{20000}-\x{2FA1F}';

// [stem, original, byte offset]. CJK has no spaces between words,
// so a run of it goes in as overlapping character pairs (bigrams)
function rt_tokens(string $s, array $extraStop = []): array {
    $stop = rt_stopwords();
    preg_match_all('/(?:(?![\p{P}\p{S}])[' . RT_CJK . '])+|(?:(?![' . RT_CJK . '])[\p{L}\p{N}\p{M}])+/u', $s, $m, PREG_OFFSET_CAPTURE);
    $out = [];
    foreach ($m[0] as [$w, $off]) {
        if (preg_match('/^[' . RT_CJK . ']/u', $w)) {
            $chars = preg_split('//u', $w, -1, PREG_SPLIT_NO_EMPTY);
            if (count($chars) === 1) $out[] = [$w, $w, $off];
            for ($i = 0; $i + 1 < count($chars); $i++) {
                $out[] = [$chars[$i] . $chars[$i + 1], $chars[$i] . $chars[$i + 1], $off];
                $off += strlen($chars[$i]);
            }
            continue;
        }
        $lw = mb_strtolower($w);
        if (mb_strlen($lw) < 2 || isset($stop[$lw])) continue;
        $stem = rt_stem($lw);
        if (isset($extraStop[$lw]) || isset($extraStop[$stem])) continue;
        $out[] = [$stem, $w, $off];
    }
    return $out;
}

function rt_terms(string $s, array $extraStop = []): array {
    return array_column(rt_tokens($s, $extraStop), 0);
}

function rt_synonym_groups(): array {
    static $groups = null;
    if ($groups !== null) return $groups;
    $groups = [];
    // a phrase in a group pulls in the others at half weight
    foreach (rt_words()['synonyms'] as $group) {
        $groups[] = array_values(array_filter(array_map(fn($p) => rt_terms($p), $group)));
    }
    return $groups;
}

// [[text, weight], ...]. synonyms only add, never outweigh what he typed
function rt_query(array $parts, bool $expand = true, array $extraStop = [], array $extraGroups = []): array {
    $terms = [];
    $pairs = [];
    foreach ($parts as [$text, $weight]) {
        $seq = rt_terms((string)$text, $extraStop);
        foreach ($seq as $i => $t) {
            $terms[$t] = max($terms[$t] ?? 0.0, $weight);
            if ($i > 0) $pairs[$seq[$i - 1] . ' ' . $t] = max($pairs[$seq[$i - 1] . ' ' . $t] ?? 0.0, $weight);
        }
    }
    if ($expand && $terms) {
        $have = $terms;
        $groups = rt_synonym_groups();
        foreach ($extraGroups as $group) $groups[] = array_values(array_filter(array_map(fn($p) => rt_terms($p), $group)));
        foreach ($groups as $group) {
            $hit = 0.0;
            foreach ($group as $phrase) {
                $w = min(array_map(fn($t) => $have[$t] ?? 0.0, $phrase));
                $hit = max($hit, $w);
            }
            if ($hit <= 0) continue;
            foreach ($group as $phrase) {
                foreach ($phrase as $t) $terms[$t] = max($terms[$t] ?? 0.0, $hit * RT_EXPAND_WEIGHT);
            }
        }
    }
    return ['terms' => $terms, 'pairs' => $pairs];
}

// BM25F is BM25 over several weighted fields. postings hold the length
// normalised tf per term, so scoring never walks every doc
function rt_index(array $docs, array $fieldWeights): array {
    $len = [];
    $tfs = [];
    $sum = array_fill_keys(array_keys($fieldWeights), 0);
    foreach ($docs as $i => $doc) {
        foreach ($fieldWeights as $field => $_) {
            $seq = rt_terms((string)($doc[$field] ?? ''));
            $len[$i][$field] = count($seq);
            $sum[$field] += count($seq);
            $tf = [];
            foreach ($seq as $j => $t) {
                $tf[$t] = ($tf[$t] ?? 0) + 1;
                if ($j > 0) $tfs[$i]['pairs'][$seq[$j - 1] . ' ' . $t] = true;
            }
            $tfs[$i][$field] = $tf;
        }
    }
    $n = count($docs);
    $avg = [];
    foreach ($sum as $field => $s) $avg[$field] = max(1.0, $s / max(1, $n));

    $post = [];
    $pairs = [];
    foreach ($tfs as $i => $fields) {
        $acc = [];
        foreach ($fieldWeights as $field => $w) {
            $norm = 1 - RT_B + RT_B * ($len[$i][$field] / $avg[$field]);
            foreach ($fields[$field] ?? [] as $t => $c) $acc[$t] = ($acc[$t] ?? 0.0) + $w * $c / $norm;
        }
        foreach ($acc as $t => $v) $post[$t][$i] = $v;
        foreach (array_keys($fields['pairs'] ?? []) as $p) $pairs[$p][] = $i;
    }
    $idf = [];
    foreach ($post as $t => $docsOf) {
        $df = count($docsOf);
        $idf[$t] = log(1 + ($n - $df + 0.5) / ($df + 0.5));
    }
    return ['n' => $n, 'post' => $post, 'idf' => $idf, 'pairs' => $pairs];
}

// doc => [score, share of the query covered 0-1, matched terms]
function rt_score(array $index, array $query, array $boost = []): array {
    $max = 0.0;
    $scores = [];
    foreach ($query['terms'] as $t => $qw) {
        $idf = $index['idf'][$t] ?? null;
        if ($idf === null) continue;
        $w = $qw * $idf * ($boost[$t] ?? 1.0);
        if ($qw >= 1.0) $max += $w;
        foreach ($index['post'][$t] as $i => $tf) {
            $scores[$i][0] = ($scores[$i][0] ?? 0.0) + $w * $tf * (RT_K1 + 1) / (RT_K1 + $tf);
            $scores[$i][2][] = $t;
        }
    }
    if (!$scores) return [];
    foreach ($query['pairs'] as $p => $qw) {
        foreach ($index['pairs'][$p] ?? [] as $i) {
            if (!isset($scores[$i])) continue;
            [$a, $b] = explode(' ', $p, 2);
            $scores[$i][0] += RT_PAIR_BONUS * $qw * ((($index['idf'][$a] ?? 0) + ($index['idf'][$b] ?? 0)) / 2);
        }
    }
    // (k1+1) is the most one term can ever give, so this is 0-1.
    // synonyms and typo fixes are a bonus, they don't widen the bar
    $top = $max * (RT_K1 + 1);
    foreach ($scores as $i => &$s) $s[1] = $top > 0 ? min(1.0, $s[0] / $top) : 0.0;
    unset($s);
    uasort($scores, fn($a, $b) => $b[0] <=> $a[0]);
    return $scores;
}

// typos land on a word we know. under 4 letters there's nothing to correct
function rt_fuzzy(string $tok, array $vocab): ?string {
    $len = strlen($tok);
    if ($len < 4) return null;
    $max = $len <= 7 ? 1 : 2;
    $best = null; $bestD = $max + 1;
    foreach ($vocab as $v) {
        if (abs(strlen($v) - $len) > $max) continue;
        $d = levenshtein($tok, $v);
        if ($d <= $max && $d < $bestD) { $best = $v; $bestD = $d; }
    }
    return $best;
}

function rt_jaccard(array $a, array $b): float {
    $a = array_flip($a);
    $b = array_flip($b);
    $inter = count(array_intersect_key($a, $b));
    $union = count($a) + count($b) - $inter;
    return $union > 0 ? $inter / $union : 0.0;
}
