<?php
// usage: php .github/scripts/difficulty-db.test.php
// throwaway db in a temp state dir, NEVER the live one
$tmp = sys_get_temp_dir() . '/omega-difficulty-db-' . getmypid();
mkdir($tmp, 0700, true);
putenv("OMEGA_STATE_DIR=$tmp");
putenv('MEMORY_DIR=' . "$tmp/memory");
require __DIR__ . '/../../webapp/api/lib/bootstrap.php';

$fails = 0;
$eq = function (string $name, $got, $want) use (&$fails) {
    if ($got === $want) { echo "  ok   $name\n"; return; }
    echo "  FAIL $name: wanted " . var_export($want, true) . ', got ' . var_export($got, true) . "\n";
    $fails++;
};

db()->exec("INSERT INTO users (id, email, password_hash, adult_consent_at, created_at) VALUES (1, 'a@b.c', 'x', 1, 1)");
$eq('unpicked plays as normal', difficulty_level(1), null);
$eq('first pick sticks', difficulty_pick(1, 'hardcore'), true);
$eq('second pick is refused', difficulty_pick(1, 'normal'), false);
$eq('and the level stays', difficulty_level(1), 'hardcore');

$rel = relationship_get(1);
foreach (range(1, 4) as $_) relationship_apply(1, relationship_get(1), ['affection' => 1]);
$eq('four +1 at x0.2 move nothing yet', relationship_get(1)['affection'], $rel['affection']);
relationship_apply(1, relationship_get(1), ['affection' => 1]);
$eq('the fifth pays out the carry', relationship_get(1)['affection'], $rel['affection'] + 1);
relationship_apply(1, relationship_get(1), ['trust' => -30]);
$eq('a -30 lands as the -50 cap', relationship_get(1)['trust'], max(0, $rel['trust'] - 50));

$minutes = [];
foreach (range(1, 3) as $_) $minutes[] = ban_apply(1, 'test')['minutes'];
$eq('hardcore ladder', $minutes, [240, 1440, 2880]);
$eq('the next one is final', ban_is_final(1), true);
$last = ban_apply(1, 'test');
$eq('the fourth blocks', $last['blocked'], true);
$eq('blocked shows up for the app gate', ban_blocked(1), true);
$eq('and chat stays refused past any until', ban_active(1)['blocked'], true);

$eq('hard drops a strike after 14 days', (function () {
    db()->exec('DELETE FROM user_bans');
    difficulty_pick(1, 'hard', true);
    ban_apply(1, 'a');
    ban_apply(1, 'b');
    db()->exec('UPDATE user_bans SET last_ban = last_ban - ' . (15 * 86400));
    return ban_apply(1, 'c')['minutes'];
})(), 240);

array_map('unlink', glob("$tmp/*.*") ?: []);
exit($fails ? 1 : 0);
