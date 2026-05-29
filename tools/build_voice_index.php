<?php
// Embeds bot_lines.txt into the voice RAG index that chat.php reads at request
// time. Outputs voice_corpus.txt, voice_index.bin (packed float32, row-aligned)
// and voice_meta.json. Pass --dry-run to just check the cleaned line count.
// Needs Ollama up (OLLAMA_URL) with nomic-embed-text pulled.

define('EMBEDDING_MODEL', 'nomic-embed-text');
define('OLLAMA_EMBED_URL', rtrim(getenv('OLLAMA_URL') ?: 'http://localhost:11434', '/') . '/api/embeddings');
define('BOT_LINES_PATH', __DIR__ . '/bot_lines.txt');
// webapp/* is copied to /var/www/omega/ in Docker, sits beside us bare-metal
$webappDir = is_dir(__DIR__ . '/../webapp') ? __DIR__ . '/../webapp' : __DIR__ . '/..';
define('CORPUS_OUT', $webappDir . '/voice_corpus.txt');
define('BIN_OUT', $webappDir . '/voice_index.bin');
define('META_OUT', $webappDir . '/voice_meta.json');

function clean_line(string $raw): string {
    // Strip "Bot: " prefix (case-exact as exported).
    if (str_starts_with($raw, 'Bot: ')) {
        $line = substr($raw, 5);
    } elseif (str_starts_with($raw, 'Bot:')) {
        $line = substr($raw, 4);
    } else {
        return ''; // not a bot line
    }

    $line = str_replace(['{f_playerName}', '{f_PlayerName}'], 'Anon', $line);
    $line = str_replace(['{f_botName}', '{f_BotName}'], 'Jun', $line);
    $line = str_replace('{{wi}}', ' ', $line); // pause marker becomes a space

    // anything with a leftover {…} template is junk we can't resolve
    if (preg_match('/\{[^}]+\}/', $line)) return '';

    return preg_replace('/\s+/', ' ', trim($line));
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

if (!is_readable(BOT_LINES_PATH)) {
    fprintf(STDERR, "Cannot read: %s\n", BOT_LINES_PATH);
    exit(1);
}

$raw = file(BOT_LINES_PATH, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);

$cleaned = [];
$interjectionCount = 0;
$interjectionMax = 5; // keep only a handful of bare-punctuation lines

foreach ($raw as $rawLine) {
    $line = clean_line(trim($rawLine));
    if ($line === '') continue;

    if (mb_strlen($line) <= 3) {
        if ($interjectionCount >= $interjectionMax) continue;
        $interjectionCount++;
    }

    $cleaned[] = $line;
}

$cleaned = array_values(array_unique($cleaned)); // dedupe, keep first-seen order

$total = count($cleaned);
echo "Cleaned corpus: {$total} lines (from " . count($raw) . " raw).\n";

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
echo "Embedding {$total} lines...\n";

$allVecs = [];
$failed = 0;

foreach ($cleaned as $i => $line) {
    $vec = embed($line);
    if ($vec === null) {
        $failed++;
        $allVecs[] = array_fill(0, $dim, 0.0); // zero-fill keeps rows aligned
    } else {
        $allVecs[] = $vec;
    }

    if (($i + 1) % 50 === 0 || ($i + 1) === $total) {
        printf("\r  %d / %d", $i + 1, $total);
    }
}
echo "\n";

if ($failed > 0) {
    fprintf(STDERR, "Warning: %d lines failed to embed (stored as zero vectors).\n", $failed);
}

// flatten row-major (vector i lives at offset i*dim) and pack as float32
$flat = [];
foreach ($allVecs as $vec) {
    foreach ($vec as $f) $flat[] = $f;
}
$binData = pack('f*', ...$flat);

file_put_contents(CORPUS_OUT, implode("\n", $cleaned));
file_put_contents(BIN_OUT, $binData);
file_put_contents(META_OUT, json_encode([
    'model' => EMBEDDING_MODEL,
    'dim' => $dim,
    'count' => $total,
    'generated_at' => date('c'),
], JSON_PRETTY_PRINT));

$sizeMB = round(strlen($binData) / 1048576, 2);
echo "Wrote:\n";
echo "  " . CORPUS_OUT . "  (" . $total . " lines)\n";
echo "  " . BIN_OUT    . "  ({$sizeMB} MB)\n";
echo "  " . META_OUT   . "\n";
echo "Done.\n";
