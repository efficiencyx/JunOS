<?php
// Backfills message_embeddings for messages that never got embedded (usually
// because Ollama was down when they were written) and drops orphan rows.
// Run it from cron or by hand:  php tools/compact_chat_index.php
// Needs Ollama up (OLLAMA_URL) with nomic-embed-text pulled.

// webapp/* lives under /var/www/omega/ in Docker but next to us bare-metal.
$libPath = __DIR__ . '/../webapp/api/_lib.php';
if (!is_readable($libPath)) $libPath = __DIR__ . '/../api/_lib.php';
require_once $libPath;

$OLLAMA_URL = rtrim(getenv('OLLAMA_URL') ?: 'http://localhost:11434', '/');

// One curl handle reused for every line.
$ch = curl_init($OLLAMA_URL . '/api/embeddings');
curl_setopt_array($ch, [
    CURLOPT_POST => true,
    CURLOPT_HTTPHEADER => ['Content-Type: application/json'],
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_TIMEOUT => 30,
    CURLOPT_CONNECTTIMEOUT => 5,
]);

function embed_via(string $text, $ch): ?array {
    curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode([
        'model' => EMBED_MODEL,
        'prompt' => $text,
    ], JSON_UNESCAPED_UNICODE));
    $resp = curl_exec($ch);
    if ($resp === false) {
        fprintf(STDERR, "  curl error: %s\n", curl_error($ch));
        return null;
    }
    $obj = json_decode($resp, true);
    if (!isset($obj['embedding']) || !is_array($obj['embedding'])) return null;
    return array_values(array_map('floatval', $obj['embedding']));
}

$db = db();

// orphans: the FK cascade should handle these, but clean up just in case
$orphans = $db->exec(
    'DELETE FROM message_embeddings
      WHERE message_id NOT IN (SELECT id FROM messages)'
);
echo "Orphans removed: {$orphans}\n";

// anything missing an embedding, skipping tiny low-info acks ("ok", "lol")
$sel = $db->prepare(
    'SELECT m.id, m.content, c.user_id
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
  LEFT JOIN message_embeddings me ON me.message_id = m.id
      WHERE me.message_id IS NULL
        AND length(m.content) >= 8
      ORDER BY m.id ASC'
);
$sel->execute();
$rows = $sel->fetchAll();

$total = count($rows);
echo "Candidates to backfill: {$total}\n";
if ($total === 0) {
    curl_close($ch);
    exit(0);
}

$ins = $db->prepare(
    'INSERT INTO message_embeddings (message_id, user_id, embedding, model, dim)
     VALUES (?, ?, ?, ?, ?)'
);

$backfilled = 0;
$failed = 0;
foreach ($rows as $i => $row) {
    $vec = embed_via((string)$row['content'], $ch);
    if ($vec === null) {
        $failed++;
        continue;
    }
    try {
        $ins->execute([
            (int)$row['id'],
            (int)$row['user_id'],
            pack('f*', ...$vec),
            EMBED_MODEL,
            count($vec),
        ]);
        $backfilled++;
    } catch (Throwable $e) {
        fprintf(STDERR, "  insert error for message %d: %s\n", $row['id'], $e->getMessage());
        $failed++;
    }
    if (($i + 1) % 25 === 0 || ($i + 1) === $total) {
        printf("\r  %d / %d", $i + 1, $total);
    }
}
echo "\n";

curl_close($ch);

echo "Backfilled: {$backfilled}\n";
echo "Failed: {$failed}\n";
echo "Done.\n";
