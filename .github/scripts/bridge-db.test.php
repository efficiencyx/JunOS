<?php
// usage: php .github/scripts/bridge-db.test.php
// bridge_sync against a throwaway db in a temp state dir, NEVER the live one
$tmp = sys_get_temp_dir() . '/omega-bridge-db-' . getmypid();
mkdir($tmp, 0700, true);
putenv("OMEGA_STATE_DIR=$tmp");
putenv('MEMORY_DIR=' . "$tmp/memory");
$lib = __DIR__ . '/../../webapp/api/lib';
require "$lib/bootstrap.php";
require "$lib/wardrobe.php";
require "$lib/bridge/apply.php";

$fails = 0;
$eq = function (string $name, $got, $want) use (&$fails) {
    if ($got === $want) { echo "  ok   $name\n"; return; }
    echo "  FAIL $name: wanted " . var_export($want, true) . ', got ' . var_export($got, true) . "\n";
    $fails++;
};

db()->exec("INSERT INTO users (id, email, password_hash, adult_consent_at, created_at) VALUES (1, 'a@b.c', 'x', 1, 1)");
$wearing = fn(int $id, string $slot) => bridge_snapshot(['_sympathy' => 100, 'itemManager' => ['items' => [
    ['_gameId' => ['_guid' => ['serializedGuid' => ''], '_id' => $id], '_equipedSlot' => $slot],
]]]);
$step = time();
$later = function () use (&$step) { $step += 10; db()->exec("UPDATE wardrobe_state SET updated_at = $step WHERE user_id = 1"); };

$eq('first sync takes the game outfit', bridge_sync(1, $wearing(10000, 'UpperBody'))['outfit_from_game'], true);
$eq('the browser gets the look once', is_array(bridge_look_take(1)) && bridge_look_take(1) === null, true);
wardrobe_save_state(1, wardrobe_state(1));
$later();
bridge_look_saved(1);
$eq('the next game change still lands after the browser saved the look',
    bridge_sync(1, $wearing(17102, 'UpperBodyOuter'))['outfit_from_game'], true);

wardrobe_save_state(1, wardrobe_state(1));
$later();
$eq('a change made in JunOS still wins', bridge_sync(1, $wearing(10000, 'UpperBody'))['outfit_from_game'], false);

wardrobe_save_state(1, wardrobe_state(1));
$later();
bridge_look_saved(1);
$eq('a game_look save with no look taken changes nothing', bridge_sync(1, $wearing(17102, 'UpperBodyOuter'))['outfit_from_game'], false);

exec('rm -rf ' . escapeshellarg($tmp));
if ($fails) { echo "$fails failed\n"; exit(1); }
echo "all ok\n";
