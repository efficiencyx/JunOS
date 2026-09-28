<?php
// usage: php .github/scripts/trip-intent.test.php
require __DIR__ . '/../../webapp/api/lib/chat/tools.php';

$fails = 0;
$eq = function (string $name, $got, $want) use (&$fails) {
    if ($got === $want) { echo "  ok   $name\n"; return; }
    echo "  FAIL $name: wanted " . var_export($want, true) . ', got ' . var_export($got, true) . "\n";
    $fails++;
};

$eq('typed karaoke invite', trip_guess_invite('wanna go to karaoke tonight?', ''), 'karaoke');
$eq('typed dinner invite', trip_guess_invite("Let\u{2019}s go out for dinner", ''), 'date');
$eq('typed shop invite', trip_guess_invite("how about we visit Annalie's shop", ''), 'shop');
$eq('typed cards invite', trip_guess_invite('up for some blackjack?', ''), 'cards');
$eq('why dont we is a yes', trip_guess_invite("why don't we play cards", ''), 'cards');
$eq('yes to her ask', trip_guess_invite('yeah sure!', '[A:smile] Hey... wanna go sing karaoke with me?'), 'karaoke');
$eq('yes to her list picks his', trip_guess_invite('yes, blackjack', 'Shop or blackjack?'), 'cards');
$eq('yes to a list is ambiguous', trip_guess_invite('yes', 'Shop or blackjack?'), '');
$eq('yes to no question', trip_guess_invite('yes', 'I had dinner already.'), '');
$eq('mention is not an invite', trip_guess_invite('I went to karaoke yesterday', ''), '');
$eq('negated invite', trip_guess_invite("I don't want to go shopping", ''), '');
$eq('later is not now', trip_guess_invite("let's go shopping later", ''), '');
$eq('two trips named', trip_guess_invite("let's do dinner then karaoke", ''), '');

$eq('reply yes', trip_reply_accepts("[A:happy] Yes! Let's go, I'll grab my coat."), true);
$eq('reply cant wait', trip_reply_accepts("Can't wait!"), true);
$eq('reply no', trip_reply_accepts('Hmm, not today. Maybe later?'), false);
$eq('reply yes but', trip_reply_accepts("I'd love to, but I can't right now."), false);
$eq('reply unrelated', trip_reply_accepts('What song would you pick?'), false);

exit($fails ? 1 : 0);
