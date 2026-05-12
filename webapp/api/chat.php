<?php
// SSE proxy: client -> Ollama /api/chat (NDJSON stream) -> SSE to browser.

@ini_set('output_buffering', 'off');
@ini_set('zlib.output_compression', '0');
@ini_set('implicit_flush', '1');
while (ob_get_level() > 0) { ob_end_flush(); }
ob_implicit_flush(true);

// Ollama base URL: env-configurable so the PHP container can reach the
// ollama service over the docker network. Defaults to localhost for the
// bare-metal `php -S` setup.
$OLLAMA_URL = rtrim(getenv('OLLAMA_URL') ?: 'http://localhost:11434', '/');

header('Content-Type: text/event-stream');
header('Cache-Control: no-cache, no-transform');
header('X-Accel-Buffering: no');
header('Connection: keep-alive');

function sse_send(array $obj): void {
    echo 'data: ' . json_encode($obj, JSON_UNESCAPED_UNICODE) . "\n\n";
    @flush();
}
function sse_done(): void {
    echo "data: [DONE]\n\n";
    @flush();
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    sse_send(['error' => 'method not allowed']);
    exit;
}

$raw = file_get_contents('php://input');
$body = json_decode($raw, true);
if (!is_array($body) || !isset($body['messages']) || !is_array($body['messages'])) {
    sse_send(['error' => 'invalid request: messages[] required']);
    sse_done();
    exit;
}

$model = isset($body['model']) && is_string($body['model']) && $body['model'] !== ''
    ? $body['model']
    : 'qwen2.5:7b';

// Inject system prompt server-side from system_prompt.txt.
$promptPath = __DIR__ . '/../system_prompt.txt';
$systemPrompt = is_readable($promptPath) ? file_get_contents($promptPath) : '';

// Retrieve top-K voice exemplars from the embedded corpus and append them.
// No-ops silently if the index hasn't been built yet or Ollama is unreachable.
function voice_retrieve(array $messages, string $systemPrompt, string $ollamaUrl): string {
    $metaPath   = __DIR__ . '/../voice_meta.json';
    $corpusPath = __DIR__ . '/../voice_corpus.txt';
    $binPath    = __DIR__ . '/../voice_index.bin';

    if (!is_readable($metaPath) || !is_readable($corpusPath) || !is_readable($binPath)) {
        return $systemPrompt;
    }

    // Find last user message.
    $lastUser = '';
    for ($i = count($messages) - 1; $i >= 0; $i--) {
        if (($messages[$i]['role'] ?? '') === 'user') {
            $lastUser = trim((string)($messages[$i]['content'] ?? ''));
            break;
        }
    }
    if ($lastUser === '') return $systemPrompt;

    // Load index (warm-cache via APCu if available).
    static $idx = null;
    if ($idx === null && function_exists('apcu_fetch')) {
        $idx = apcu_fetch('voice_index_v1') ?: null;
    }
    if ($idx === null) {
        $meta  = json_decode(file_get_contents($metaPath), true);
        $lines = file($corpusPath, FILE_IGNORE_NEW_LINES);
        $dim   = (int)($meta['dim'] ?? 0);
        $count = (int)($meta['count'] ?? 0);
        if ($dim <= 0 || $count <= 0) return $systemPrompt;

        $flat    = unpack('f*', file_get_contents($binPath));
        $vectors = [];
        for ($i = 0; $i < $count; $i++) {
            $v = [];
            $base = $i * $dim + 1; // unpack is 1-indexed
            for ($j = 0; $j < $dim; $j++) $v[] = $flat[$base + $j];
            $vectors[] = $v;
        }
        $idx = ['lines' => $lines, 'vectors' => $vectors, 'model' => $meta['model'], 'dim' => $dim];
        if (function_exists('apcu_store')) apcu_store('voice_index_v1', $idx, 0);
    }

    // Embed the user message.
    $ch = curl_init($ollamaUrl . '/api/embeddings');
    curl_setopt_array($ch, [
        CURLOPT_POST           => true,
        CURLOPT_HTTPHEADER     => ['Content-Type: application/json'],
        CURLOPT_POSTFIELDS     => json_encode(['model' => $idx['model'], 'prompt' => $lastUser]),
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT        => 5,
        CURLOPT_CONNECTTIMEOUT => 3,
    ]);
    $resp = curl_exec($ch);
    curl_close($ch);
    if ($resp === false) return $systemPrompt;

    $q = json_decode($resp, true);
    if (!isset($q['embedding']) || !is_array($q['embedding'])) return $systemPrompt;
    $qvec = array_values(array_map('floatval', $q['embedding']));

    // Cosine similarity over all vectors, pick top 8.
    $qNorm = 0.0;
    foreach ($qvec as $x) $qNorm += $x * $x;
    $qNorm = sqrt($qNorm) ?: 1.0;

    $scores = [];
    foreach ($idx['vectors'] as $i => $v) {
        $dot = 0.0; $vNorm = 0.0;
        foreach ($v as $j => $vj) { $dot += $vj * $qvec[$j]; $vNorm += $vj * $vj; }
        $scores[$i] = $dot / ($qNorm * (sqrt($vNorm) ?: 1.0));
    }
    arsort($scores);
    $top = array_slice($scores, 0, 8, true);

    // Build voice section and append to system prompt.
    $bullets = [];
    foreach ($top as $i => $_) $bullets[] = '- "' . $idx['lines'][$i] . '"';

    return rtrim($systemPrompt)
        . "\n\n## Voice Reference\nExamples of how Jun phrased things in similar moments."
        . " Match the cadence, register, and brevity. Do not copy verbatim.\n"
        . implode("\n", $bullets);
}

$systemPrompt = voice_retrieve($body['messages'], $systemPrompt, $OLLAMA_URL);

// Append current outfit state (chosen by the user via the UI) so the model
// knows what Jun is wearing without being told in chat.
$outfitContext = isset($body['outfit_context']) && is_string($body['outfit_context'])
    ? trim($body['outfit_context'])
    : '';
if ($outfitContext !== '') {
    $systemPrompt = rtrim($systemPrompt) . "\n\n## Current Wardrobe State\n" . $outfitContext
        . "\nThis state is set by the user, not by you. Do not emit [ACTION:outfit|...] tags to put on or take off the items listed as currently worn unless Anon explicitly asks Jun to change clothes in the conversation.";
}

$messages = [];
if ($systemPrompt !== '') {
    $messages[] = ['role' => 'system', 'content' => $systemPrompt];
}
foreach ($body['messages'] as $m) {
    if (!is_array($m) || !isset($m['role'], $m['content'])) continue;
    if ($m['role'] === 'system') continue; // system is server-controlled
    $messages[] = ['role' => $m['role'], 'content' => (string)$m['content']];
}

$reasoning = isset($body['reasoning']) ? (string)$body['reasoning'] : 'low'; // low|medium|high
$think     = isset($body['think']) ? (bool)$body['think'] : false;

$ollamaPayload = [
    'model'    => $model,
    'messages' => $messages,
    'stream'   => true,
    'think'    => $think,
    'options'  => [
        'reasoning_effort' => $reasoning,
    ],
];

$ch = curl_init($OLLAMA_URL . '/api/chat');
curl_setopt($ch, CURLOPT_POST, true);
curl_setopt($ch, CURLOPT_HTTPHEADER, ['Content-Type: application/json']);
curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($ollamaPayload, JSON_UNESCAPED_UNICODE));
curl_setopt($ch, CURLOPT_RETURNTRANSFER, false);
curl_setopt($ch, CURLOPT_TIMEOUT, 0);
curl_setopt($ch, CURLOPT_CONNECTTIMEOUT, 10);

$buf = '';
$emittedAny = false;
$sawError = false;

curl_setopt($ch, CURLOPT_WRITEFUNCTION, function ($ch, $chunk) use (&$buf, &$emittedAny, &$sawError) {
    $buf .= $chunk;
    while (($nl = strpos($buf, "\n")) !== false) {
        $line = substr($buf, 0, $nl);
        $buf = substr($buf, $nl + 1);
        $line = trim($line);
        if ($line === '') continue;
        $obj = json_decode($line, true);
        if (!is_array($obj)) continue;

        if (isset($obj['error'])) {
            sse_send(['error' => (string)$obj['error']]);
            $sawError = true;
            continue;
        }
        if (isset($obj['message']['content'])) {
            $tok = (string)$obj['message']['content'];
            if ($tok !== '') {
                sse_send(['token' => $tok]);
                $emittedAny = true;
            }
        }
        if (!empty($obj['done'])) {
            // Let outer code emit DONE after curl returns.
        }
    }
    return strlen($chunk);
});

$ok = curl_exec($ch);
if ($ok === false) {
    $err = curl_error($ch);
    sse_send(['error' => 'ollama unreachable: ' . $err]);
}
curl_close($ch);

sse_done();
