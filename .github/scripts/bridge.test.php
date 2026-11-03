<?php
// usage: php .github/scripts/bridge.test.php
$lib = __DIR__ . '/../../webapp/api/lib';
require "$lib/http.php";
require "$lib/env.php";
require "$lib/bridge/parse.php";
require "$lib/bridge/events.php";
require "$lib/bridge/write.php";

$fails = 0;
$eq = function (string $name, $got, $want) use (&$fails) {
    if ($got === $want) { echo "  ok   $name\n"; return; }
    echo "  FAIL $name: wanted " . var_export($want, true) . ', got ' . var_export($got, true) . "\n";
    $fails++;
};

$vars = fn(int $sym, int $time, array $flags) => json_encode([
    'customData' => ['I' => [], 'F' => [], 'S' => []], 'emptyThing' => new stdClass, '_maxCum' => 75.0,
    '_sympathy' => $sym, 'time' => $time, 'stage' => 3, 'botName' => 'evelyn', 'playerName' => 'anon',
    'timesCameInside' => 2, 'streamCount' => 1,
    'flags' => array_map(fn($f) => ['name' => $f[0], 'timeAdded' => $f[1], 'firstTimeAdded' => $f[1], 'times' => 1], $flags),
    'itemManager' => ['items' => [['_gameId' => ['_id' => 17000], '_equipedSlot' => 'UpperBodyOuter'],
                                  ['_gameId' => ['_id' => 15001], '_equipedSlot' => ''],
                                  ['_gameId' => ['_id' => 16002], '_equipedSlot' => 'ShoeL'],
                                  ['_gameId' => ['_id' => 2002000], '_equipedSlot' => 'Anon_FishingBait']]],
], JSON_PRESERVE_ZERO_FRACTION);
$entry = fn(int $t, int $slot, string $data, int $type = 0) => ['notes' => '', '_time' => $t, 'ingameTime' => 1, 'slot' => $slot, 'savedata' => $data, '_saveType' => $type];
$bundle = "\xEF\xBB\xBF" . json_encode([
    'flags' => ['keys' => [], 'values' => []],
    'saves' => [$entry(100, 15, $vars(813, 500, [['date', 10], ['DAY 3, 16:29', 20]]))],
    'autoSaves' => [$entry(50, 0, $vars(700, 400, [])), $entry(200, 1, $vars(820, 600, [['date', 10], ['Karaoke1', 30]]))],
]);

$save = bridge_read_save($bundle);
$eq('parse: bundle', [$save['shape'], count($save['entries'])], ['bundle', 3]);
$newest = bridge_newest_entry($save['entries']);
$eq('parse: newest by _time', [$newest['index'], $newest['slot']], [2, 1]);
$snap = bridge_snapshot(bridge_vars($newest));
$eq('snapshot: sympathy', $snap['sympathy'], 820);
$eq('outfit: worn items by id', [$snap['outfit']['hoodie'], $snap['outfit']['shirt'], $snap['outfit']['shoe_r']], [true, false, true]);
$eq('outfit: in the bag is not worn', $snap['outfit']['pants'], false);
$eq('parse: slot file is raw GameVariables', bridge_read_save($vars(1, 1, []))['shape'], 'vars');
$eq('parse: junk refused', bridge_read_save('{"saves": "nope"}'), null);

$dir = sys_get_temp_dir() . '/bridge-test-' . getmypid();
@mkdir($dir);
file_put_contents("$dir/save.mdrg", json_encode(['saves' => [$entry(100, 15, '')], 'autoSaves' => [$entry(300, 0, '', 1), $entry(200, 1, '', 1)]]));
file_put_contents("$dir/M16.mdrgslot", $vars(500, 1, []));
file_put_contents("$dir/A2.mdrgslot", $vars(600, 1, []));
$found = bridge_newest_save($dir);
$eq('container: newest slot with a file wins', [basename($found['path']), $found['shape'], $found['vars']['_sympathy']], ['A2.mdrgslot', 'vars', 600]);
array_map('unlink', glob("$dir/*"));
rmdir($dir);

$texts = array_column(bridge_events(null, $snap), 'text');
$eq('events: mapped flags + name', $texts, ['Anon took me on a date.', 'We went to karaoke together for the first time.', 'In the game Anon calls me Evelyn.']);
$later = $snap;
$later['counters']['timesCameInside'] += 3;
$eq('events: counter delta', array_column(bridge_events($snap, $later), 'text'), ['Anon took me on a date.', 'We went to karaoke together for the first time.', 'Anon and I had sex 3 more times.']);
$eq('events: same flag same id', bridge_events(null, $snap)[0]['id'], 'flag:date:10');

$patched = bridge_patch_sympathy($bundle, 'bundle', 2, 540);
$eq('write: patched', $patched !== null && $patched !== $bundle, true);
$eq('write: verified', bridge_patch_verified($bundle, $patched, 'bundle', 2, 540), true);
$eq('write: only that entry', bridge_vars(bridge_read_save($patched)['entries'][0])['_sympathy'], 813);
$eq('write: bytes otherwise identical', strlen($patched) - strlen($bundle), 0);
$eq('write: 75.0 and {} survive', str_contains($patched, '75.0') && str_contains($patched, '\"emptyThing\":{}'), true);
$eq('write: wrong value fails verify', bridge_patch_verified($bundle, $patched, 'bundle', 2, 541), false);
$eq('write: tampered fails verify', bridge_patch_verified($bundle, str_replace('Karaoke1', 'Karaoke2', $patched), 'bundle', 2, 540), false);
$slotRaw = $vars(813, 1, []);
$slotPatched = bridge_patch_sympathy($slotRaw, 'vars', 0, 2400);
$eq('write: slot file', bridge_patch_verified($slotRaw, $slotPatched, 'vars', 0, 2400), true);
$eq('write: slot file wrong shape refused', bridge_patch_sympathy($slotRaw, 'bundle', 0, 1), null);
$eq('sympathy: keeps the game value', bridge_sympathy_for(81, 813), 813);
$eq('sympathy: moves to hers', bridge_sympathy_for(54, 813), 540);
$eq('sympathy: over 1000 is affection 100', bridge_affection_of(2400), 100);
$eq('sympathy: over 1000 left alone', bridge_sympathy_for(100, 2400), 2400);
$eq('sympathy: 1300 to 1250 moves nothing', bridge_affection_of(1250) - bridge_affection_of(1300), 0);
$eq('snapshot: no 1000 cap', bridge_snapshot(['_sympathy' => 2400])['sympathy'], 2400);

exit($fails ? 1 : 0);
