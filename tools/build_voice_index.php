<?php
/**
 * Build voice RAG index from bot_lines.txt.
 *
 * Usage:  php tools/build_voice_index.php
 *
 * Reads:  bot_lines.txt (repo root)
 * Writes: webapp/voice_corpus.txt   — one cleaned line per row
 *         webapp/voice_index.bin    — packed float32 vectors, row-aligned
 *         webapp/voice_meta.json    — {model, dim, count, generated_at}
 *
 * Requires Ollama running on localhost:11434 with nomic-embed-text pulled.
 */

define('EMBEDDING_MODEL',  'nomic-embed-text');
define('OLLAMA_EMBED_URL', 'http://localhost:11434/api/embeddings');
define('BOT_LINES_PATH',   __DIR__ . '/bot_lines.txt');
define('CORPUS_OUT',       __DIR__ . '/../webapp/voice_corpus.txt');
define('BIN_OUT',          __DIR__ . '/../webapp/voice_index.bin');
define('META_OUT',         __DIR__ . '/../webapp/voice_meta.json');

// ── helpers ──────────────────────────────────────────────────────────────────

function clean_line(string $raw): string {
    // Strip "Bot: " prefix (case-exact as exported).
    if (str_starts_with($raw, 'Bot: ')) {
        $line = substr($raw, 5);
    } elseif (str_starts_with($raw, 'Bot:')) {
        $line = substr($raw, 4);
    } else {
        return ''; // not a bot line
    }

    // Normalise game placeholders.
    $line = str_replace(['{f_playerName}', '{f_PlayerName}'], 'Anon', $line);
    $line = str_replace(['{f_botName}', '{f_BotName}'],       'Jun',  $line);
    $line = str_replace('{{wi}}', ' ', $line);                 // pause marker → space

    // Drop lines that still contain unresolved {…} templates.
    if (preg_match('/\{[^}]+\}/', $line)) return '';

    // Normalise whitespace.
    $line = preg_replace('/\s+/', ' ', trim($line));

    return $line;
}

function embed(string $text): ?array {
    static $ch = null;
    if ($ch === null) {
        $ch = curl_init(OLLAMA_EMBED_URL);
        curl_setopt_array($ch, [
            CURLOPT_POST           => true,
            CURLOPT_HTTPHEADER     => ['Content-Type: application/json'],
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_TIMEOUT        => 30,
        ]);
    }
    curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode([
        'model'  => EMBEDDING_MODEL,
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

// ── load & clean ─────────────────────────────────────────────────────────────

if (!is_readable(BOT_LINES_PATH)) {
    fprintf(STDERR, "Cannot read: %s\n", BOT_LINES_PATH);
    exit(1);
}

$raw = file(BOT_LINES_PATH, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);

$cleaned = [];
$interjectionCount = 0;
$interjectionMax   = 5; // keep a small sample of bare punctuation lines

foreach ($raw as $rawLine) {
    $line = clean_line(trim($rawLine));
    if ($line === '') continue;

    // Cap very short interjections (single-char punct, "...", "!", "?").
    if (mb_strlen($line) <= 3) {
        if ($interjectionCount >= $interjectionMax) continue;
        $interjectionCount++;
    }

    $cleaned[] = $line;
}

// Deduplicate (preserve first occurrence order).
$cleaned = array_values(array_unique($cleaned));

$total = count($cleaned);
echo "Cleaned corpus: {$total} lines (from " . count($raw) . " raw).\n";

// ── embed ─────────────────────────────────────────────────────────────────────

// Quick connectivity check.
$pingCh = curl_init(OLLAMA_EMBED_URL);
curl_setopt_array($pingCh, [
    CURLOPT_POST           => true,
    CURLOPT_HTTPHEADER     => ['Content-Type: application/json'],
    CURLOPT_POSTFIELDS     => json_encode(['model' => EMBEDDING_MODEL, 'prompt' => 'test']),
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_TIMEOUT        => 10,
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
$failed  = 0;

foreach ($cleaned as $i => $line) {
    $vec = embed($line);
    if ($vec === null) {
        $failed++;
        // Use a zero vector so index stays row-aligned; mark for later removal.
        $allVecs[] = array_fill(0, $dim, 0.0);
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

// ── write output ──────────────────────────────────────────────────────────────

// Flatten vectors: index i → floats at offset i*dim.
$flat = [];
foreach ($allVecs as $vec) {
    foreach ($vec as $f) $flat[] = $f;
}

$binData = pack('f*', ...$flat);

file_put_contents(CORPUS_OUT, implode("\n", $cleaned));
file_put_contents(BIN_OUT, $binData);
file_put_contents(META_OUT, json_encode([
    'model'        => EMBEDDING_MODEL,
    'dim'          => $dim,
    'count'        => $total,
    'generated_at' => date('c'),
], JSON_PRETTY_PRINT));

$sizeMB = round(strlen($binData) / 1048576, 2);
echo "Wrote:\n";
echo "  " . CORPUS_OUT . "  (" . $total . " lines)\n";
echo "  " . BIN_OUT    . "  ({$sizeMB} MB)\n";
echo "  " . META_OUT   . "\n";
echo "Done.\n";
