<?php
// usage: php .github/scripts/gate.test.php
require __DIR__ . '/../../webapp/api/lib/chat/context.php';
require __DIR__ . '/../../webapp/api/lib/chat/gate.php';

$fails = 0;
$eq = function (string $name, $got, $want) use (&$fails) {
    if ($got === $want) { echo "  ok   $name\n"; return; }
    echo "  FAIL $name: wanted " . var_export($want, true) . ', got ' . var_export($got, true) . "\n";
    $fails++;
};

foreach (['ok', 'K', 'okay!', 'lol', 'haha', "\u{1F602}", 'ok lol', 'fine.'] as $m) $eq("ack: $m", chat_is_short_ack($m), true);
foreach (['', ' ', 'so are you mad', 'nice dress', 'okay so listen'] as $m) $eq("not ack: '$m'", chat_is_short_ack($m), false);

$eq('act line goes before the budget token',
    chat_gate_act("(quiet)\n\n# Live context\n\n<think:low>"),
    "(quiet)\n\n# Live context\n\n" . GATE_ACT . "\n\n<think:low>");
$eq('no budget token, untouched', chat_gate_act('hi'), 'hi');

$names = ['search_recent_chats', 'list_recent_chats', 'search_lore', 'memory_write', 'change_outfit', 'stay_silent', 'enter_shop', 'enter_karaoke'];
$eq('check: none', chat_tool_check_pick(' none', $names), '');
$eq('check: echoed prefill', chat_tool_check_pick('Tool check: memory', $names), 'memory_write');
$eq('check: first token is enough', chat_tool_check_pick(' change', $names), 'change_outfit');
$eq('check: search needs a peek', chat_tool_check_pick(' search', $names), null);
$eq('check: peek settles it', chat_tool_check_pick(' search_lore.', $names), 'search_lore');
$eq('check: peek mid-name', chat_tool_check_pick(' search_recent_', $names), 'search_recent_chats');
$eq('check: tool not offered', chat_tool_check_pick(' plan', $names), '');
$eq('check: empty', chat_tool_check_pick('', $names), '');

exit($fails ? 1 : 0);
