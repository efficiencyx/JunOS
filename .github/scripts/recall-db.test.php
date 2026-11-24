<?php
// usage: php .github/scripts/recall-db.test.php
// search_recent_chats over real sealed rows, in a throwaway state dir
$tmp = sys_get_temp_dir() . '/omega-recall-db-' . getmypid();
mkdir($tmp, 0700, true);
putenv("OMEGA_STATE_DIR=$tmp");
putenv('MEMORY_DIR=' . "$tmp/memory");
require __DIR__ . '/../../webapp/api/lib/bootstrap.php';
require __DIR__ . '/../../webapp/api/lib/lore.php';
require __DIR__ . '/../../webapp/api/lib/chat/recall.php';

$fails = 0;
$eq = function (string $name, $got, $want) use (&$fails) {
    if ($got === $want) { echo "  ok   $name\n"; return; }
    echo "  FAIL $name: wanted " . var_export($want, true) . ', got ' . var_export($got, true) . "\n";
    $fails++;
};

crypt_key(random_bytes(SODIUM_CRYPTO_SECRETBOX_KEYBYTES), true);
db()->exec("INSERT INTO users (id, email, password_hash, adult_consent_at, created_at) VALUES (1, 'a@b.c', 'x', 1, 1)");
$conv = db()->prepare('INSERT INTO conversations (id, user_id, title, created_at, updated_at) VALUES (?, 1, ?, ?, ?)');
$conv->execute([1, enc('old chat'), 100, 100]);
$conv->execute([2, enc('this chat'), 200, 200]);
$msg = db()->prepare('INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, ?, ?, ?)');
$t = 1000;
foreach ([
    [1, 'user', 'my boss moved my shifts again, I am so done with that warehouse'],
    [1, 'assistant', 'he really does that every week huh'],
    [1, 'user', 'we threw a birthday party for my nephew Luca'],
    [1, 'user', 'the party was loud'],
    [2, 'user', 'my boss is the worst'],
] as [$c, $role, $text]) $msg->execute([$c, $role, enc($text), $t++]);

$hits = fn(string $q) => array_column(recall_search(1, 2, $q, 5)['results'] ?? [], 'content');
$eq('a stem finds the plural', $hits('shift'), ['my boss moved my shifts again, I am so done with that warehouse']);
$eq('one stray word no longer zeroes it', $hits('boss moved my schedule'), ['my boss moved my shifts again, I am so done with that warehouse']);
$eq('the whole phrase ranks first', $hits('birthday party')[0] ?? null, 'we threw a birthday party for my nephew Luca');
$eq('the current chat is left out', in_array('my boss is the worst', $hits('boss'), true), false);
$eq('nothing about it, nothing back', recall_search(1, 2, 'dentist', 5), []);

memory_note_add(1, 'family', "Anon's nephew Luca turns seven in December.");
$found = recall_search(1, 2, 'Luca birthday', 5);
$eq('his notes come back with the chats', $found['notes'][0]['category'] ?? null, 'family');
$eq('a typo gets a name to try', recall_try(1, 'Lucca'), ['Luca']);

exec('rm -rf ' . escapeshellarg($tmp));
echo $fails ? "\n$fails failed\n" : "\nall ok\n";
exit($fails ? 1 : 0);
