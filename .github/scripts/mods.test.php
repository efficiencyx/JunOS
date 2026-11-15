<?php
// usage: php .github/scripts/mods.test.php
// sealed mod storage in a throwaway state dir, NEVER the live one
$tmp = sys_get_temp_dir() . '/omega-mods-' . getmypid();
mkdir($tmp, 0700, true);
putenv("OMEGA_STATE_DIR=$tmp");
$lib = __DIR__ . '/../../webapp/api/lib';
require "$lib/http.php";
require "$lib/env.php";
require "$lib/crypto.php";
require "$lib/mods.php";

$fails = 0;
$eq = function (string $name, $got, $want) use (&$fails) {
    if ($got === $want) { echo "  ok   $name\n"; return; }
    echo "  FAIL $name: wanted " . var_export($want, true) . ', got ' . var_export($got, true) . "\n";
    $fails++;
};
$read = function (int $user, string $guid): ?string {
    ob_start();
    $found = mods_stream($user, $guid);
    $out = ob_get_clean();
    return $found ? $out : null;
};

crypt_bind(random_bytes(SODIUM_CRYPTO_SECRETBOX_KEYBYTES));
$zip = "PK\x03\x04" . random_bytes(10000);
[$a, $b, $c] = str_split($zip, 4000);

$eq('part 0 starts the upload', mods_put_part(1, 'g1', 0, 3, $a), null);
$eq('nothing listed until the last part', mods_list(1), []);
$eq('a skipped part is refused', mods_put_part(1, 'g1', 2, 3, $c), 'part_out_of_order');
$eq('part 1', mods_put_part(1, 'g1', 1, 3, $b), null);
$eq('last part', mods_put_part(1, 'g1', 2, 3, $c), null);
$eq('listed once done', array_column(mods_list(1), 'guid'), ['g1']);
$eq('comes back byte for byte', $read(1, 'g1'), $zip);
$eq('sealed on disk', str_contains((string)file_get_contents(mods_path(1, 'g1')), substr($zip, 4, 64)), false);
$eq('another user does not see it', [mods_list(2), $read(2, 'g1')], [[], null]);

$eq('not a zip', mods_put_part(1, 'g2', 0, 1, 'hello'), 'not_a_zip');
$eq('parts can not grow past what part 0 reserved', [mods_put_part(1, 'g4', 0, 2, $a), mods_put_part(1, 'g4', 1, 8, $b)], [null, 'part_out_of_order']);
touch(mods_path(1, 'g4', 'part2'), time() - 7200);
mods_disk_bytes(1, 'x');
$eq('a half upload left an hour is cleaned up', is_file(mods_path(1, 'g4', 'part2')), false);
$eq('a broken re-upload keeps the old copy', [mods_put_part(1, 'g1', 0, 2, $a), $read(1, 'g1')], [null, $zip]);

$big = mods_path(1, 'huge');
$h = fopen($big, 'w');
ftruncate($h, MODS_USER_MAX_BYTES - 1000);
fclose($h);
$eq('over the per-user cap', mods_put_part(1, 'g3', 0, 1, $a), 'mods_full');
$eq('replacing the big one still fits', mods_put_part(1, 'huge', 0, 1, $a), null);
$h = fopen(mods_path(1, 'gone', 'part8'), 'w');
ftruncate($h, MODS_USER_MAX_BYTES - 1000);
fclose($h);
$eq('a half upload counts against the cap', mods_put_part(1, 'g5', 0, 1, $a), 'mods_full');
mods_delete(1, 'gone');

$eq('guid rules keep it in the folder', [preg_match(MOD_GUID, '../x'), preg_match(MOD_GUID, 'a/b'), preg_match(MOD_GUID, '5bc5b141-7006')], [0, 0, 1]);

$eq('state save returns its version', [mods_state_put(1, ['removed' => []]), mods_state_put(1, ['state' => ['g1' => ['items' => ['0' => true]]], 'removed' => ['old']])], [1, 2]);
$eq('state round trip', mods_state_get(1), ['state' => ['g1' => ['items' => ['0' => true]]], 'removed' => ['old'], 'version' => 2]);
$eq('no state for a new user', mods_state_get(3), null);

mods_delete(1, 'g1');
$eq('deleted', $read(1, 'g1'), null);
$epoch = mods_epoch(1);
$eq('epoch holds', mods_epoch(1), $epoch);
$eq('factory reset wipes the folder', [mods_wipe_user(1), is_dir("$tmp/mods/user-1")], [true, false]);
$eq('and the next epoch is a new one', mods_epoch(1) !== $epoch, true);

exec('rm -rf ' . escapeshellarg($tmp));
if ($fails) { echo "$fails failed\n"; exit(1); }
echo "all ok\n";
