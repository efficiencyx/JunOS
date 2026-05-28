<?php
/**
 * Compact / backfill the per-user chat-history RAG index.
 *
 * Usage:
 *   docker compose exec php php tools/compact_chat_index.php
 *   php tools/compact_chat_index.php          # bare-metal
 *
 * What it does:
 *   1. Embeds messages that are missing a matching message_embeddings row
 *      (typically: messages written while Ollama was down).
 *   2. Removes message_embeddings rows whose message no longer exists
 *      (the FK cascade should already cover this, but be defensive).
 *   3. Skips messages shorter than 8 chars (low-info acks like "ok").
 *
 * Requires Ollama running (configurable via OLLAMA_URL env) with
 * nomic-embed-text pulled.
 */

// Support both Docker (webapp/* copied to /var/www/omega/) and bare-metal (webapp/ subdir) layouts
$libPath = __DIR__ . '/../webapp/api/_lib.php';
if (!is_readable($libPath)) {
    $libPath = __DIR__ . '/../api/_lib.php';
}
require_once $libPath;

$OLLAMA_URL = rtrim(getenv('OLLAMA_URL') ?: 'http://localhost:11434', '/');
$EMBED_URL  = $OLLAMA_URL . '/api/embeddings';

// Reusable curl handle (mirrors tools/build_voice_index.php).
$ch = curl_init($EMBED_URL);
curl_setopt_array($ch, [
    CURLOPT_POST           => true,
    CURLOPT_HTTPHEADER     => ['Content-Type: application/json'],
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_TIMEOUT        => 30,
    CURLOPT_CONNECTTIMEOUT => 5,
]);

function embed_via(string $text, $ch): ?array {
    curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode([
        'model'  => OMEGA_EMBED_MODEL,
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

$db = omega_db();

// ── 1. Drop orphaned embeddings ──────────────────────────────────────────────
$orphans = $db->exec(
    'DELETE FROM message_embeddings
      WHERE message_id NOT IN (SELECT id FROM messages)'
);
echo "Orphans removed: {$orphans}\n";

// ── 2. Backfill missing embeddings ───────────────────────────────────────────
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
$failed     = 0;
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
            OMEGA_EMBED_MODEL,
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
echo "Failed:     {$failed}\n";
echo "Done.\n";
