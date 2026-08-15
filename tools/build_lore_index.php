<?php
// webapp/api/lore.php does plain keyword lookup over
// lore_corpus.txt. this flattens every user -> assistant pair in
// tools/lore_dataset.jsonl into one answer row. no Ollama, no
// embeddings, none of that. --dry-run counts without writing.

define('DATASET_PATH', __DIR__ . '/lore_dataset.jsonl');
// in the repo it's ../webapp. deployed copies keep the files
// one level above tools/ in /var/www/omega/.
$webappDir = is_dir(__DIR__ . '/../webapp') ? __DIR__ . '/../webapp' : __DIR__ . '/..';
define('CORPUS_OUT', $webappDir . '/lore_corpus.txt');

function collapse(string $s): string {
    return trim(preg_replace('/\s+/', ' ', $s));
}

if (!is_readable(DATASET_PATH)) {
    fprintf(STDERR, "Cannot read: %s\n", DATASET_PATH);
    exit(1);
}

// each user -> assistant turn becomes a searchable pair.
// multi-turn rows make several. duplicate questions keep the
// first answer and their first-seen order.
$pairs = [];
$seen = [];
$rawLines = 0;
foreach (file(DATASET_PATH, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) as $line) {
    $rawLines++;
    $obj = json_decode($line, true);
    if (!is_array($obj) || !isset($obj['messages']) || !is_array($obj['messages'])) continue;

    $pendingQ = null;
    foreach ($obj['messages'] as $m) {
        $role = $m['role'] ?? '';
        $content = collapse((string)($m['content'] ?? ''));
        if ($content === '') { $pendingQ = null; continue; }
        if ($role === 'user') {
            $pendingQ = $content;
        } elseif ($role === 'assistant' && $pendingQ !== null) {
            $key = mb_strtolower($pendingQ);
            if (!isset($seen[$key])) {
                $seen[$key] = true;
                $pairs[] = ['q' => $pendingQ, 'a' => $content];
            }
            $pendingQ = null;
        }
    }
}

$total = count($pairs);
echo "Pairs: {$total} (from {$rawLines} dataset rows).\n";

if (in_array('--dry-run', $argv ?? [], true)) {
    echo "Dry-run mode: nothing written. Exiting.\n";
    exit(0);
}

$answers = array_column($pairs, 'a');
file_put_contents(CORPUS_OUT, implode("\n", $answers));

echo "Wrote:\n";
echo "  " . CORPUS_OUT . "  ({$total} answers)\n";
echo "Done.\n";
