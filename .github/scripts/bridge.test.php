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
$worn = fn(array ...$items) => array_keys(array_filter(bridge_outfit_from_equipped($items)));
$eq('outfit: mod furniture is not a tail or ears', $worn(
    ['id' => 9, 'slot' => 'Room_TV', 'mod' => true], ['id' => 1, 'slot' => 'Room_Plush', 'mod' => true],
    ['id' => 6, 'slot' => 'LegR', 'mod' => true], ['id' => 1, 'slot' => 'Skin', 'mod' => true],
), []);
$eq('outfit: a modded shirt counts by its slot', $worn(['id' => 5, 'slot' => 'UpperBody', 'mod' => true]), ['shirt']);
$eq('outfit: dresses', [$worn(['id' => 18000, 'slot' => 'UpperBody']), $worn(['id' => 18001, 'slot' => 'UpperBody'])], [['dress'], ['dress1']]);
$modGuid = ['_guid' => ['serializedGuid' => '5bc5b141'], '_id' => 9];
$eq('outfit: the save _guid marks a mod item', bridge_snapshot(['_sympathy' => 1, 'itemManager' => ['items' => [
    ['_gameId' => $modGuid, '_equipedSlot' => 'Room_TV'],
]]])['outfit']['tail'], false);
$look = bridge_look_from_equipped([
    ['id' => 17102, 'slot' => 'UpperBodyOuter', 'colors' => ['#333333', '#db2220']],
    ['id' => 10000, 'slot' => 'UpperBody', 'colors' => ['#111111']],
    ['id' => 12005, 'slot' => 'StockingR', 'colors' => ['#505050']],
    ['id' => 16004, 'slot' => 'ShoeR', 'colors' => ['#fcfbfb']],
    ['id' => 15002, 'slot' => 'LowerBody', 'colors' => ['#222222']],
    ['id' => 1008, 'slot' => 'Head', 'colors' => ['#242424', '#ee0055']],
    ['id' => 1006, 'slot' => 'Eyes', 'colors' => ['#010101', '#010101', '#020202', '#020202', '#030303']],
    ['id' => 1, 'slot' => 'Skin', 'mod' => true, 'colors' => ['#d5a391']],
    ['id' => 9, 'slot' => 'Room_TV', 'mod' => true, 'colors' => ['#ffffff']],
    ['id' => 2000001, 'slot' => 'Anon_FishingRod', 'colors' => ['#ffffff']],
]);
$eq('look: styles', $look['variants'], ['skirt_style' => 1, 'shoe_style' => 2, 'sock_style' => 4, 'glasses_style' => 0]);
$eq('look: logos, plain clears', $look['logos'], ['hoodie_logo' => 'bloodyMoon', 'shirt_logo' => '']);
$eq('look: colours', [$look['colors']['hoodie_strings'], $look['colors']['ear_mid'], $look['colors']['eye_iris'], $look['colors']['eye_pupil'], $look['colors']['skin']],
    ['#db2220', '#ee0055', '#010101', '#020202', '#d5a391']);
$eq('look: furniture has no colour', count($look['colors']), 13);
$eq('look: the halo is white, whatever her hair says', bridge_look_from_equipped([
    ['id' => 1005, 'slot' => 'HairMain', 'colors' => ['#242424', '#ee0055', '#796f45']],
])['colors'], ['hair_hologram' => '#ffffff', 'hair' => '#242424', 'hair_h0_strand' => '#ee0055']);
$eq('look: a hologram item colours it', bridge_look_from_equipped([
    ['id' => 1506, 'slot' => 'Hologram', 'colors' => ['#00ff00']],
])['colors']['hair_hologram'], '#00ff00');
$eq('outfit: makeup and accessories', $worn(
    ['id' => 13003, 'slot' => 'EyeMakeup'], ['id' => 13019, 'slot' => 'Pedicure'], ['id' => 13001, 'slot' => 'NeckAccessory'],
), ['heart_choker', 'eyeshadow', 'pedicure']);
$accessories = bridge_look_from_equipped([
    ['id' => 13026, 'slot' => 'NeckAccessory', 'colors' => ['#111111']],
    ['id' => 13007, 'slot' => 'HairAccessoryL', 'colors' => ['#222222']],
    ['id' => 13014, 'slot' => 'Glasses', 'colors' => ['#333333']],
    ['id' => 13011, 'slot' => 'Lipstick', 'colors' => ['#444444']],
]);
$eq('look: accessory styles', [$accessories['variants']['choker_style'], $accessories['variants']['bow_style'], $accessories['variants']['glasses_style']], [3, 2, 3]);
$eq('look: accessory colours', [$accessories['colors']['eyepatch'], $accessories['colors']['lipstick'], $accessories['colors']['choker']],
    ['#333333', '#444444', '#111111']);
$eq('look: hex from unity floats', bridge_hex(['r' => 0.125490203, 'g' => 0.886274516, 'b' => 1.0, 'a' => 1.0]), '#20e2ff');
foreach (['omega.conf.template', 'omega-tls.conf.template'] as $conf) {
    $text = (string)file_get_contents(__DIR__ . "/../../docker/nginx/templates/$conf");
    $eq("nginx: $conf takes the mod's body", preg_match('#location = /api/bridge\.php \{[^}]*client_max_body_size 2m;#', $text), 1);
}
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
