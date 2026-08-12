<?php
// Rebuilds the lore file that webapp/api/lore.php reads on every message. it
// takes the hand written game lore Q&A in tools/lore_dataset.jsonl, flattens it
// into {question, answer} pairs, and writes lore_corpus.txt with one answer per
// row. lookup is plain keyword matching so there is no Ollama and no embeddings
// involved. --dry-run just counts the pairs.

define('DATASET_PATH', __DIR__ . '/lore_dataset.jsonl');
// under Docker webapp/* gets copied to /var/www/omega/, on bare metal it is
// right next to us
$webappDir = is_dir(__DIR__ . '/../webapp') ? __DIR__ . '/../webapp' : __DIR__ . '/..';
define('CORPUS_OUT', $webappDir . '/lore_corpus.txt');

function collapse(string $s): string {
    return trim(preg_replace('/\s+/', ' ', $s));
}

if (!is_readable(DATASET_PATH)) {
    fprintf(STDERR, "Cannot read: %s\n", DATASET_PATH);
    exit(1);
}

// Turn every user then assistant turn into a {question, answer} pair. we search
// on the question, the answer is what actually gets handed to her. Multi-turn rows
// become several pairs. Dedup identical questions, keep first-seen order.
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
