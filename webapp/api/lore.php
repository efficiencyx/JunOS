<?php

const LORE_PROPER_BOOST   = 2.0;  // a term that's a proper noun in the corpus
const LORE_FLOOR          = 3.0;  // min score to inject
const LORE_FUZZY_PENALTY  = 0.6;  // discount on a typo-corrected (fuzzy) term
const LORE_FUZZY_MIN_IDF  = 2.0;  // only fuzzy-match distinctive (rare) names
const LORE_MAX_INJECT     = 5;    // up to this many *distinct* facts injected
const LORE_DEDUP_JACCARD  = 0.5;  // candidates sharing this much vocab collapse

// Ordinary English + conversational filler. IDF can't drop these on its own:
// words like "morning" or "look" are rare *in the lore* even though they're
// common in chat, so they'd otherwise score high. Listed explicitly instead.
const LORE_STOP = [
    'a','an','and','are','as','at','be','been','being','but','by','can','could','did','do','does',
    'doing','done','for','from','had','has','have','having','he','her','hers','him','his','how','i',
    'if','in','into','is','it','its','just','like','me','my','no','not','of','off','on','once','only',
    'or','our','out','over','she','should','so','some','such','than','that','the','their','them','then',
    'there','these','they','this','those','to','too','up','us','was','we','were','what','when','where',
    'which','who','whom','why','will','with','would','you','your','yours','am','about','above','after',
    'again','against','all','any','because','before','below','between','both','during','each','few',
    'more','most','other','own','same','through','under','until','very','s','t','re','ve','ll','d','m','o',
    'hi','hey','hello','yo','good','morning','evening','night','afternoon','thanks','thank','please','ok',
    'okay','yeah','yep','nope','lol','haha','hmm','oh','ah','well','now','today','tomorrow','yesterday',
    'let','lets','want','wanna','gonna','get','got','go','going','come','came','nice','cool','great',
    'cute','hot','sexy','love','tired','happy','sad','bored','fun','funny','grab','coffee','tea','drink',
    'eat','look','see','say','said','tell','told','know','think','feel','make','made','give','take',
    'need','mean','sound','seem','talk','ask','call','help','try','use','find','keep','put','show','turn',
    'work','play','hope','guess','suppose','wonder','miss','wait','really','very','much','many','lot',
    'kind','sort','thing','stuff','way','bit','sure','maybe','perhaps','also','even','still','back',
    'around','here',
];

function lore_tokens(string $s): array {
    static $stop = null;
    if ($stop === null) $stop = array_flip(LORE_STOP);

    preg_match_all('/[A-Za-z0-9]+/', $s, $m, PREG_OFFSET_CAPTURE);
    $out = [];
    foreach ($m[0] as [$w, $off]) {
        $lw = strtolower($w);
        if (strlen($lw) < 2 || isset($stop[$lw])) continue;
        $stem = (strlen($lw) > 3 && $lw[strlen($lw) - 1] === 's') ? substr($lw, 0, -1) : $lw;
        $out[] = [$stem, $w, $off];
    }
    return $out;
}

function lore_index(): ?array {
    static $idx = false; // false = not built yet; array|null afterwards
    if ($idx !== false) return $idx;

    if (function_exists('apcu_fetch')) {
        $cached = apcu_fetch('lore_kw_v2');
        if (is_array($cached)) return $idx = $cached;
    }

    $path = __DIR__ . '/../lore_corpus.txt';
    if (!is_readable($path)) return $idx = null;
    $answers = file($path, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
    if (!$answers) return $idx = null;
    $n = count($answers);

    $cap = []; $low = []; $df = []; $docTf = [];
    foreach ($answers as $a) {
        $tf = [];
        foreach (lore_tokens($a) as [$stem, $orig, $off]) {
            $tf[$stem] = ($tf[$stem] ?? 0) + 1;
            // Count capitalization only mid-sentence: a name like "Annalie" turns
            // up capitalized after another word, whereas "However"/"Coming" only
            // lead sentences. Sentence-initial caps carry no proper-noun signal.
            $j = $off - 1;
            while ($j >= 0 && $a[$j] === ' ') $j--;
            $initial = ($j < 0) || strpos('.!?:"', $a[$j]) !== false;
            if (ctype_upper($orig[0]) && !$initial) $cap[$stem] = ($cap[$stem] ?? 0) + 1;
            elseif (!ctype_upper($orig[0]))         $low[$stem] = ($low[$stem] ?? 0) + 1;
        }
        $docTf[] = $tf;
        foreach ($tf as $stem => $_) $df[$stem] = ($df[$stem] ?? 0) + 1;
    }

    $idfMap = [];
    foreach ($df as $stem => $c) $idfMap[$stem] = log($n / $c);

    $proper = [];
    foreach ($cap as $stem => $c) {
        if ($c >= 2 && $c >= ($low[$stem] ?? 0)) $proper[$stem] = true;
    }
    // Fuzzy only against distinctive proper nouns (real names), so typos resolve
    // to "Annalie"/"Shanice" but an ordinary word can't be dragged onto a
    // capitalized common word.
    $fuzzy = [];
    foreach ($proper as $stem => $_) {
        if (($idfMap[$stem] ?? 0) >= LORE_FUZZY_MIN_IDF) $fuzzy[] = $stem;
    }

    $built = ['answers' => $answers, 'docTf' => $docTf, 'idf' => $idfMap,
              'proper' => $proper, 'fuzzy' => $fuzzy];
    if (function_exists('apcu_store')) apcu_store('lore_kw_v2', $built, 0);
    return $idx = $built;
}

function lore_fuzzy(string $tok, array $vocab): ?string {
    $len = strlen($tok);
    if ($len < 4) return null;                  // too short to correct safely
    $max = $len <= 7 ? 1 : 2;
    $best = null; $bestD = $max + 1;
    foreach ($vocab as $v) {
        if (abs(strlen($v) - $len) > $max) continue;
        $d = levenshtein($tok, $v);
        if ($d <= $max && $d < $bestD) { $best = $v; $bestD = $d; }
    }
    return $best;
}

function lore_resolve(array $idx, string $query): array {
    $res = [];
    foreach (lore_tokens($query) as [$stem, $orig]) {
        if (isset($idx['idf'][$stem])) {
            $res[] = ['token' => $orig, 'term' => $stem, 'fuzzy' => false];
        } else {
            $hit = lore_fuzzy($stem, $idx['fuzzy']);
            $res[] = ['token' => $orig, 'term' => $hit, 'fuzzy' => $hit !== null];
        }
    }
    return $res;
}

// Jaccard overlap of two term-count maps' key sets - used to fold near-duplicate
// answers (the corpus has many rephrasings of the same fact) into one.
function lore_jaccard(array $a, array $b): float {
    $inter = 0;
    foreach ($a as $k => $_) if (isset($b[$k])) $inter++;
    $union = count($a) + count($b) - $inter;
    return $union > 0 ? $inter / $union : 0.0;
}

function lore_search(string $query, int $topK = 1, bool $dedup = false): array {
    $idx = lore_index();
    if ($idx === null) return [];

    $terms = []; // stem => weight factor (1.0 exact, LORE_FUZZY_PENALTY fuzzy)
    foreach (lore_resolve($idx, $query) as $r) {
        if ($r['term'] === null) continue;
        $f = $r['fuzzy'] ? LORE_FUZZY_PENALTY : 1.0;
        $terms[$r['term']] = max($terms[$r['term']] ?? 0.0, $f);
    }
    if (!$terms) return [];

    $scores = [];
    foreach ($idx['docTf'] as $i => $tf) {
        $s = 0.0;
        foreach ($terms as $stem => $factor) {
            if (!isset($tf[$stem])) continue;
            $w = $idx['idf'][$stem] * (isset($idx['proper'][$stem]) ? LORE_PROPER_BOOST : 1.0) * $factor;
            $s += $w * (1 + 0.3 * log($tf[$stem]));
        }
        if ($s > 0) $scores[$i] = $s;
    }
    if (!$scores) return [];

    arsort($scores);
    $out = [];
    $kept = []; // token sets already chosen, for dedup
    foreach ($scores as $i => $score) {
        if ($dedup) {
            $ts = $idx['docTf'][$i];
            foreach ($kept as $ks) {
                if (lore_jaccard($ts, $ks) >= LORE_DEDUP_JACCARD) continue 2;
            }
            $kept[] = $ts;
        }
        $out[] = ['score' => round($score, 4), 'answer' => $idx['answers'][$i]];
        if (count($out) >= $topK) break;
    }
    return $out;
}
