<?php
// usage: php .github/scripts/consolidation-pass.test.php
// one whole guided pass against fake-pass-ollama.py: windows, the
// guards, the writes, the watermarks, the journal, the dry run
$tmp = sys_get_temp_dir() . '/omega-consolidation-pass-' . getmypid();
mkdir($tmp, 0700, true);
$port = 18000 + getmypid() % 1000;
putenv("OMEGA_STATE_DIR=$tmp");
putenv('MEMORY_DIR=' . "$tmp/memory");
putenv('AI_PROVIDER=ollama');
putenv("OLLAMA_URL=http://127.0.0.1:$port");
putenv('OLLAMA_MODEL=fake-jun');
putenv('OMEGA_NUM_CTX=8192');
$api = __DIR__ . '/../../webapp/api';
require "$api/lib/bootstrap.php";
foreach (['engine', 'feed', 'ask', 'guided', 'passes'] as $f) require "$api/lib/consolidation/$f.php";

$server = proc_open(['python3', __DIR__ . '/fake-pass-ollama.py', (string)$port], [], $pipes);
for ($i = 0; $i < 50 && !@fsockopen('127.0.0.1', $port); $i++) usleep(100000);

$fails = 0;
$eq = function (string $name, $got, $want) use (&$fails) {
    if ($got === $want) { echo "  ok   $name\n"; return; }
    echo "  FAIL $name: wanted " . var_export($want, true) . ', got ' . var_export($got, true) . "\n";
    $fails++;
};

crypt_key(random_bytes(SODIUM_CRYPTO_SECRETBOX_KEYBYTES), true);
db()->exec("INSERT INTO users (id, email, password_hash, adult_consent_at, created_at) VALUES (1, 'a@b.c', 'x', 1, 1)");
db()->prepare('INSERT INTO conversations (id, user_id, title, created_at, updated_at) VALUES (1, 1, ?, 1, 1)')->execute([enc('work talk')]);
$msg = db()->prepare('INSERT INTO messages (conversation_id, role, content, created_at) VALUES (1, ?, ?, ?)');
foreach (range(1, 100) as $i) {
    $msg->execute([$i % 2 ? 'user' : 'assistant', enc($i % 2 ? "I work night shifts at the Lidl warehouse, and Miso my grey cat says hi ($i)" : "night shifts again? poor you ($i)"), $i]);
}

$yacht = memory_note_add(1, 'preferences', 'Anon owns a yacht.', ['kind' => 'chat', 'conv' => 1, 'msg' => 5])['entry']['id'];
$tea = memory_note_add(1, 'preferences', 'Anon likes green tea.', ['kind' => 'chat', 'conv' => 1, 'msg' => 7])['entry']['id'];
foreach (['Anon supports AS Roma.', 'Anon drinks his coffee black.', 'Anon plays Elden Ring.'] as $filler) memory_note_add(1, 'preferences', $filler);
memory_note_flag(1, $yacht, 'doubted', time());
memory_note_flag(1, $tea, 'doubted', time());

$events = function (): array {
    [$all] = consolidation_feed_read(1, '');
    return $all;
};

$eq('a pass runs through', consolidation_run(1, null, true), ['ok' => true]);
$notes = array_column(memory_list(1), 'memory');
$eq('two facts saved, the reworded one folded', array_values(array_intersect(['Anon has a grey cat called Miso.', 'Anon works night shifts at the Lidl warehouse.', 'Anon works the night shift at the Lidl warehouse.'], $notes)), ['Anon has a grey cat called Miso.', 'Anon works night shifts at the Lidl warehouse.']);
$eq('a doubted note he never said is gone', in_array('Anon owns a yacht.', $notes, true), false);
$eq('one the chat backs up stays', in_array('Anon likes green tea.', $notes, true), true);
$eq('a doubt the chat backs up is cleared', isset(memory_meta_load(1)['notes'][$tea]['doubted']), false);
$feed = $events();
$eq('the overlap duplicate shows as twice', in_array('twice', array_column(array_filter($feed, fn($e) => ($e['action'] ?? '') === 'dropped'), 'why'), true), true);
$eq('more than one window read', count(array_filter($feed, fn($e) => $e['type'] === 'step' && $e['step'] === 1)) > 1, true);
$eq('every call answered with its timing', count(array_filter($feed, fn($e) => $e['type'] === 'answer' && isset($e['ms']))) > 0, true);
$done = array_values(array_filter($feed, fn($e) => $e['type'] === 'done'))[0] ?? [];
$eq('done carries the summary', [$done['summary']['tally']['saved'] ?? null, $done['summary']['tally']['deleted:doubted'] ?? null], [2, 1]);
$eq('the chat is committed', (int)db()->query('SELECT upto_id FROM consolidation_chats WHERE conversation_id = 1')->fetchColumn(), 100);
$eq('the journal got today', str_contains(memory_journal_read(1), 'warehouse'), true);

foreach (range(101, 104) as $i) $msg->execute([$i % 2 ? 'user' : 'assistant', enc("I adopted a second cat called Tofu ($i)"), $i]);
$before = memory_list(1);
$eq('a dry run runs through', consolidation_run(1, null, true, false, true), ['ok' => true]);
$eq('and writes no note', memory_list(1), $before);
$eq('and moves no watermark', (int)db()->query('SELECT upto_id FROM consolidation_chats WHERE conversation_id = 1')->fetchColumn(), 100);
$eq('and its saves are marked dry', array_unique(array_column(array_filter($events(), fn($e) => ($e['action'] ?? '') === 'saved'), 'dry')), [true]);
$eq('the real pass before it is kept', consolidation_feed_pass(1, 1) !== '', true);

proc_terminate($server);
exec('rm -rf ' . escapeshellarg($tmp));
echo $fails ? "\n$fails failed\n" : "\nall ok\n";
exit($fails ? 1 : 0);
