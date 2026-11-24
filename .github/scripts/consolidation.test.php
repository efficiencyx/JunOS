<?php
// usage: php .github/scripts/consolidation.test.php
// the memory pass minus the model: dev controls, dry run, the PHP guards
$tmp = sys_get_temp_dir() . '/omega-consolidation-controls-' . getmypid();
mkdir($tmp, 0700, true);
putenv("OMEGA_STATE_DIR=$tmp");
putenv('MEMORY_DIR=' . "$tmp/memory");
$api = __DIR__ . '/../../webapp/api';
require "$api/lib/bootstrap.php";
foreach (['engine', 'feed', 'ask', 'guided', 'passes', 'cabinet'] as $f) require "$api/lib/consolidation/$f.php";

$fails = 0;
$eq = function (string $name, $got, $want) use (&$fails) {
    if ($got === $want) { echo "  ok   $name\n"; return; }
    echo "  FAIL $name: wanted " . var_export($want, true) . ', got ' . var_export($got, true) . "\n";
    $fails++;
};

crypt_key(random_bytes(SODIUM_CRYPTO_SECRETBOX_KEYBYTES), true);
db()->exec("INSERT INTO users (id, email, password_hash, adult_consent_at, created_at) VALUES (1, 'a@b.c', 'x', 1, 1)");
db()->exec('INSERT INTO memory_consolidation (user_id) VALUES (1)');
$set = fn(string $sql) => db()->exec("UPDATE memory_consolidation SET $sql WHERE user_id = 1");
$ctx = ['user' => 1, 'started' => time() - 5, 'dry' => false, 'calls' => 0];
consolidation_feed_reset(1, 'test');

$eq('nothing asked', consolidation_control($ctx, true), '');
$set('skip_kind = \'item\', skip_at = ' . time());
$eq('a skip comes through', consolidation_control($ctx, true), 'skip:item');
$eq('and only once', consolidation_control($ctx, true), '');
$set('skip_kind = \'call\', skip_at = ' . (time() + 1));
$eq('a skipped call never reaches the model', consolidation_call($ctx, 'test', 'task', ['type' => 'object']), null);
[$events] = consolidation_feed_read(1, '');
$eq('and says so in the feed', array_column(array_filter($events, fn($e) => $e['type'] === 'skip'), 'kind'), ['call']);
$set('skip_kind = \'chat\', skip_at = ' . (time() + 2));
$eq('a chat skip goes up to whoever owns it', (function () use (&$ctx) {
    try { consolidation_call($ctx, 'test', 'task', null); } catch (ConsolidationSkip $s) { return $s->kind; }
    return null;
})(), 'chat');
$set('pause_at = ' . time());
$eq('paused', consolidation_control($ctx, true), 'pause');
$set('interrupt_at = ' . time());
$eq('stop beats pause', consolidation_control($ctx, true), 'stop');
$eq('a stop throws', (function () use (&$ctx) {
    try { consolidation_obey($ctx, 'stop'); } catch (RuntimeException $e) { return $e->getMessage(); }
    return null;
})(), 'consolidation_interrupted');

$dry = ['user' => 1, 'dry' => true, 'dry_ids' => 0];
$eq('dry add looks saved', cg_add($dry, 'work', 'Anon works nights.', ['kind' => 'pass'])['ok'], true);
$eq('and writes nothing', memory_list(1), []);
$real = memory_note_add(1, 'work', 'Anon works nights.')['entry']['id'];
cg_delete($dry, $real);
$eq('dry delete keeps the note', count(memory_list(1)), 1);

foreach (range(1, 3) as $i) consolidation_feed_reset(1, "p$i");
$eq('the two passes before stay', [consolidation_feed_pass(1, 1), consolidation_feed_pass(1, 2)], ['p2', 'p1']);
memory_wipe_user(1);
$eq('a wipe takes the old feeds too', is_file(consolidation_feed_path(1, 1)), false);

consolidation_feed_reset(1, 'game');
$add = fn(string $cat, string $text) => memory_note_add(1, $cat, $text)['entry']['id'];
$work = $add('work', 'Anon works nights at the Lidl warehouse.');
$limit = $add('boundaries', "Anon doesn't want to talk about his brother.");
$health = $add('health', 'Anon is allergic to peanuts.');
$cat = $add('events', 'Anon has a grey cat called Miso.');
$changed = $add('work', 'Anon works days at the Lidl warehouse.');
consolidation_feed_emit(1, ['type' => 'note', 'action' => 'dropped', 'why' => 'passing', 'text' => 'Anon is tired today.']);
consolidation_feed_emit(1, ['type' => 'note', 'action' => 'dropped', 'why' => 'not_said', 'text' => 'Anon owns a yacht.']);
consolidation_feed_emit(1, ['type' => 'note', 'action' => 'updated', 'id' => $changed, 'category' => 'work', 'text' => 'Anon works days at the Lidl warehouse.', 'was' => 'Anon works nights at Lidl.']);
[$feed] = consolidation_feed_read(1, '');
$ref = fn(string $text) => array_values(array_filter($feed, fn($e) => ($e['text'] ?? '') === $text))[0]['cursor'];
$eq('feed: a note event keeps its note id', array_values(array_filter($feed, fn($e) => ($e['action'] ?? '') === 'updated'))[0]['id'], $changed);

$deck = cabinet_deck(1);
$eq('deck: dropped and changed from this pass', [count($deck['dropped']), count($deck['changed'])], [2, 1]);
$play = fn(array $b) => cabinet_play(1, $b);
$eq('game: same drawer agrees', $play(['kind' => 'note', 'id' => $work, 'drawer' => 'work']), ['reaction' => null, 'agreed' => true]);
$eq('game: twice is refused', $play(['kind' => 'note', 'id' => $work, 'drawer' => 'work'])['error'] ?? null, 'already_played');
$eq('game: his drawer moves it', $play(['kind' => 'note', 'id' => $cat, 'drawer' => 'family'])['reaction'], 'moved');
$eq('game: and it moved', cabinet_note(1, $cat)['category'], 'family');
$eq('game: a limit stays put', $play(['kind' => 'note', 'id' => $limit, 'drawer' => 'likes'])['reaction'], 'limit');
$eq('game: a health note is not shredded', $play(['kind' => 'note', 'id' => $health, 'drawer' => 'shred'])['reaction'], 'health');
$eq('game: passing gets rescued', $play(['kind' => 'dropped', 'ref' => $ref('Anon is tired today.'), 'drawer' => 'health'])['reaction'], 'rescued');
$rescued = array_values(array_filter(memory_list(1), fn($n) => $n['memory'] === 'Anon is tired today.'));
$eq('game: into his drawer', $rescued[0]['category'] ?? null, 'health');
$eq('game: never said stays out', $play(['kind' => 'dropped', 'ref' => $ref('Anon owns a yacht.'), 'drawer' => 'likes'])['reaction'], 'never_said');
$eq('game: shredding her change undoes it', $play(['kind' => 'changed', 'ref' => $ref('Anon works days at the Lidl warehouse.'), 'drawer' => 'shred'])['reaction'], 'undone');
$eq('game: back to before', cabinet_note(1, $changed)['text'], 'Anon works nights at Lidl.');
$eq('game: a made up ref is refused', $play(['kind' => 'dropped', 'ref' => 'game:999', 'drawer' => 'work'])['error'] ?? null, 'gone');
$noteIds = array_column(cabinet_deck(1)['notes'], 'id');
$eq('deck: a sorted note is not dealt again', in_array($work, $noteIds, true), false);
$doubtMe = $add('preferences', 'Anon hates pizza.');
$eq('game: shredding her note doubts it', $play(['kind' => 'note', 'id' => $doubtMe, 'drawer' => 'shred'])['reaction'], 'doubted');
$eq('game: and marks it for the next pass', (int)(memory_meta_load(1)['notes'][$doubtMe]['doubted'] ?? 0) > 0, true);
$score = cabinet_settle(1, ['waited' => false, 'tz' => 0]);
$eq('settle: counts from the server, not the browser', $score, ['agreed' => 1, 'total' => 8]);

$rows = [];
foreach (range(1, 9) as $i) $rows[] = ['id' => $i, 'line' => "Anon: line $i " . str_repeat('x', 30)];
$chunks = cg_chunks($rows, 200, 2);
$eq('windows: more than one', count($chunks) > 1, true);
$eq('windows: the next one opens with the last two lines', array_slice($chunks[0]['ids'], -2), array_slice($chunks[1]['ids'], 0, 2));
$eq('windows: every row committed exactly once', array_column($chunks, 'upto'), array_values(array_unique(array_column($chunks, 'upto'))));
$eq('windows: the last one ends on the last row', end($chunks)['upto'], 9);

$eq('names: whole words only', cg_has_word('we went to Miami', 'mia'), false);
$eq('names: possessive still counts', cg_has_word("Mia's birthday", 'mia'), true);
$eq('names: a number inside another', cg_has_word('flat 13', '3'), false);
$eq('keeps all: the name has to survive', cg_keeps_all('Anon went to Miami', ['Anon met Mia']), false);

$eq('similar: a synonym finds the note', array_column(cg_similar('he quit his job at the warehouse', [
    ['id' => 'a', 'text' => 'Anon loves spicy ramen'],
    ['id' => 'b', 'text' => 'Anon works night shifts at the Lidl warehouse'],
]), 'id'), ['b']);

$day = ['title' => 't', 'rows' => array_map(fn($i) => ['line' => "Anon: moment $i " . str_repeat('y', 40)], range(1, 20))];
$kept = cg_journal_lines([$day], 400);
$eq('journal: the morning stays', str_contains($kept[0], 'moment 1 '), true);
$eq('journal: and so does the evening', str_contains(end($kept), 'moment 20 '), true);
$eq('journal: under budget', strlen(implode("\n", $kept)) <= 400, true);

$eq('think: rewrites a level under', [consolidation_write_effort('high'), consolidation_write_effort('medium'), consolidation_write_effort('off')], ['medium', 'low', false]);

exec('rm -rf ' . escapeshellarg($tmp));
echo $fails ? "\n$fails failed\n" : "\nall ok\n";
exit($fails ? 1 : 0);
