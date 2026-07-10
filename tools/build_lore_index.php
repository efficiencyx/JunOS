<?php
// Embeds the curated game-lore Q&A (tools/lore_dataset.jsonl) into the lore RAG
// index that chat.php reads at request time. We key retrieval on the QUESTION
// (embedded as "search_document") and inject the ANSWER as a canonical fact, so
// a live user message ("search_query") matches the closest canon question and
// Jun gets its answer to draw on. Outputs lore_corpus.txt (answers, one per
// row), lore_index.bin (packed float32, row-aligned) and lore_meta.json.
// Pass --dry-run to just count the pairs. Needs Ollama up (OLLAMA_URL) with
// nomic-embed-text pulled.

define('EMBEDDING_MODEL', 'nomic-embed-text');
define('OLLAMA_EMBED_URL', rtrim(getenv('OLLAMA_URL') ?: 'http://localhost:11434', '/') . '/api/embeddings');
define('DATASET_PATH', __DIR__ . '/lore_dataset.jsonl');
// webapp/* is copied to /var/www/omega/ in Docker, sits beside us bare-metal
$webappDir = is_dir(__DIR__ . '/../webapp') ? __DIR__ . '/../webapp' : __DIR__ . '/..';
define('CORPUS_OUT', $webappDir . '/lore_corpus.txt');
define('BIN_OUT', $webappDir . '/lore_index.bin');
define('META_OUT', $webappDir . '/lore_meta.json');

function collapse(string $s): string {
    return trim(preg_replace('/\s+/', ' ', $s));
}

function embed(string $text): ?array {
    static $ch = null;
    if ($ch === null) {
        $ch = curl_init(OLLAMA_EMBED_URL);
        curl_setopt_array($ch, [
            CURLOPT_POST => true,
            CURLOPT_HTTPHEADER => ['Content-Type: application/json'],
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT => 30,
        ]);
    }
    curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode([
        'model' => EMBEDDING_MODEL,
        'prompt' => $text,
    ], JSON_UNESCAPED_UNICODE));

    $resp = curl_exec($ch);
    if ($resp === false) {
        fprintf(STDERR, "curl error: %s\n", curl_error($ch));
        return null;
    }
    $obj = json_decode($resp, true);
    if (!isset($obj['embedding']) || !is_array($obj['embedding'])) {
        fprintf(STDERR, "unexpected response: %s\n", $resp);
        return null;
    }
    return array_values(array_map('floatval', $obj['embedding']));
}

if (!is_readable(DATASET_PATH)) {
    fprintf(STDERR, "Cannot read: %s\n", DATASET_PATH);
    exit(1);
}

// Flatten every (user -> assistant) turn into a {question, answer} pair. The
// question is the retrieval key; the answer is what we inject. Multi-turn rows
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
    echo "Dry-run mode: no HTTP requests will be made. Exiting.\n";
    exit(0);
}

// Make sure Ollama answers before we fire off hundreds of requests.
$pingCh = curl_init(OLLAMA_EMBED_URL);
curl_setopt_array($pingCh, [
    CURLOPT_POST => true,
    CURLOPT_HTTPHEADER => ['Content-Type: application/json'],
    CURLOPT_POSTFIELDS => json_encode(['model' => EMBEDDING_MODEL, 'prompt' => 'test']),
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_TIMEOUT => 10,
    CURLOPT_CONNECTTIMEOUT => 5,
]);
$pingResp = curl_exec($pingCh);
$pingObj  = json_decode($pingResp ?: '', true);
curl_close($pingCh);
if (!isset($pingObj['embedding'])) {
    fprintf(STDERR,
        "Cannot reach Ollama embedding endpoint.\n" .
        "Make sure Ollama is running and `ollama pull %s` has been done.\n",
        EMBEDDING_MODEL
    );
    exit(1);
}

$dim = count($pingObj['embedding']);
echo "Embedding model: " . EMBEDDING_MODEL . " ({$dim}-dim).\n";
echo "Embedding {$total} questions...\n";

$answers = [];
$allVecs = [];
$failed = 0;

foreach ($pairs as $i => $p) {
    // "search_document" must match the "search_query" prefix chat.php uses at
    // retrieval time - without the pair, nomic-embed-text ranks poorly.
    $vec = embed('search_document: ' . $p['q']);
    if ($vec === null) {
        $failed++;
        $allVecs[] = array_fill(0, $dim, 0.0); // zero-fill keeps rows aligned
    } else {
        $allVecs[] = $vec;
    }
    $answers[] = $p['a'];

    if (($i + 1) % 50 === 0 || ($i + 1) === $total) {
        printf("\r  %d / %d", $i + 1, $total);
    }
}
echo "\n";

if ($failed > 0) {
    fprintf(STDERR, "Warning: %d questions failed to embed (stored as zero vectors).\n", $failed);
}

// flatten row-major (vector i lives at offset i*dim) and pack as float32
$flat = [];
foreach ($allVecs as $vec) {
    foreach ($vec as $f) $flat[] = $f;
}
$binData = pack('f*', ...$flat);

file_put_contents(CORPUS_OUT, implode("\n", $answers));
file_put_contents(BIN_OUT, $binData);
file_put_contents(META_OUT, json_encode([
    'model' => EMBEDDING_MODEL,
    'dim' => $dim,
    'count' => $total,
    'generated_at' => date('c'),
], JSON_PRETTY_PRINT));

$sizeMB = round(strlen($binData) / 1048576, 2);
echo "Wrote:\n";
echo "  " . CORPUS_OUT . "  ({$total} answers)\n";
echo "  " . BIN_OUT    . "  ({$sizeMB} MB)\n";
echo "  " . META_OUT   . "\n";
echo "Done.\n";
