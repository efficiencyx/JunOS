<?php
// usage: php .github/scripts/migrations.test.php
//
// db() globs ../migrations next to itself, so the broken migration
// goes into a copy of lib/ + migrations/ in a temp dir. NEVER into
// webapp/api/migrations, a leftover there gets synced into the
// live stack and runs against the real db.
$repo = __DIR__ . '/../../webapp/api';
$tmp = sys_get_temp_dir() . '/omega-migrations-' . getmypid();
mkdir("$tmp/lib", 0700, true);
mkdir("$tmp/migrations");
foreach (['env.php', 'http.php', 'db.php'] as $f) copy("$repo/lib/$f", "$tmp/lib/$f");
foreach (glob("$repo/migrations/*.sql") as $f) copy($f, "$tmp/migrations/" . basename($f));
file_put_contents("$tmp/migrations/999_broken.sql",
    "CREATE TABLE boom (x INTEGER);\nSELECT nope FROM nowhere;\nINSERT INTO schema_version(v) VALUES (999);\n");

putenv("OMEGA_STATE_DIR=$tmp/state");
require "$tmp/lib/env.php";
require "$tmp/lib/http.php";
require "$tmp/lib/db.php";

$fails = 0;
$eq = function (string $name, $got, $want) use (&$fails) {
    if ($got === $want) { echo "  ok   $name\n"; return; }
    echo "  FAIL $name: wanted " . var_export($want, true) . ', got ' . var_export($got, true) . "\n";
    $fails++;
};
$tables = function () use ($tmp): array {
    $raw = new PDO("sqlite:$tmp/state/omega.sqlite");
    return $raw->query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")->fetchAll(PDO::FETCH_COLUMN);
};

try {
    db();
    $threw = false;
} catch (PDOException $e) {
    $threw = true;
}
$eq('a broken migration throws', $threw, true);
$eq('and takes the whole run back with it', $tables(), []);

file_put_contents("$tmp/migrations/999_broken.sql",
    "CREATE TABLE boom (x INTEGER);\nINSERT INTO schema_version(v) VALUES (999);\n");
$pdo = db();
$eq('the same process retries once it is fixed', (int)$pdo->query('SELECT MAX(v) FROM schema_version')->fetchColumn(), 999);
$eq('and the migration landed', in_array('boom', $tables(), true), true);

$pdo = null;
array_map('unlink', glob("$tmp/*/*"));
array_map('rmdir', glob("$tmp/*"));
rmdir($tmp);

exit($fails ? 1 : 0);
