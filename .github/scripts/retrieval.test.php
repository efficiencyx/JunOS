<?php
// usage: php .github/scripts/retrieval.test.php
// retrieval-golden.json pins tokens, the top lore hit and the gate.
// the android unit test reads the same file, so php and kotlin can't drift
$lib = __DIR__ . '/../../webapp/api/lib';
require "$lib/retrieval.php";
require "$lib/lore.php";

$golden = json_decode(file_get_contents(__DIR__ . '/retrieval-golden.json'), true);
$fails = 0;
$eq = function (string $name, $got, $want) use (&$fails) {
    if ($got === $want) { echo "  ok   $name\n"; return; }
    echo "  FAIL $name: wanted " . json_encode($want, JSON_UNESCAPED_UNICODE) . ', got ' . json_encode($got, JSON_UNESCAPED_UNICODE) . "\n";
    $fails++;
};

foreach ($golden['tokens'] as $c) $eq('terms: ' . $c['in'], rt_terms($c['in']), $c['terms']);
foreach ($golden['lore_top'] as $c) $eq('lore: ' . $c['q'], lore_search($c['q'], 1, true)[0]['q'] ?? null, $c['has']);
foreach ($golden['gate'] as $c) $eq('gate: ' . $c['q'], (bool)lore_gate($c['q']), $c['fires']);

$q = rt_query([['my boss moved my shift', 1.0]]);
$eq('synonyms: job pulls work in at half weight', $q['terms']['job'] ?? null, RT_EXPAND_WEIGHT);
$eq('synonyms: never outweigh what he said', $q['terms']['shift'], 1.0);
$eq('jaccard: same words', rt_jaccard(['a', 'b'], ['b', 'a']), 1.0);
$eq('fuzzy: one typo', rt_fuzzy('annalli', ['annali', 'shanic']), 'annali');
$eq('fuzzy: too short to fix', rt_fuzzy('ann', ['annali']), null);

lore_search('Annallie', 1, true, $matched);
$eq('lore: read_as spells it like the lore', lore_understood('Annallie', $matched), ['Annallie' => 'Annalie']);
$eq('lore: nothing found', lore_search('Ecclesiasticl', 4, true), []);
$eq('lore: did you mean', lore_did_you_mean('Ecclesiasticl'), ['Ecclesiasticalot']);

echo $fails ? "\n$fails failed\n" : "\nall ok\n";
exit($fails ? 1 : 0);
