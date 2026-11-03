<?php

// flag -> what she'd remember. true = also a memory note, else journal only.
// unmapped flags are skipped, `bridge-sync.php --dry-run` lists them
const BRIDGE_FLAG_TEXT = [
    'firstwalk' => ['Anon took me outside for the first time.', true],
    'date' => ['Anon took me on a date.', true],
    'Karaoke1' => ['We went to karaoke together for the first time.', true],
    'Karaoke2' => ['We went to karaoke again.', false],
    'kino1' => ['We went to the cinema together.', true],
    'restaurant1' => ['Anon took me out to a restaurant.', true],
    'restaurant2' => ['We ate out at a restaurant again.', false],
    'fishing1' => ['We went fishing together.', true],
    'fishing2' => ['We went fishing again.', false],
    'artgallery1' => ['We visited an art gallery together.', true],
    'chess' => ['We started playing chess together.', false],
    'cards' => ['We started playing Old Maid together.', false],
    'wordchain' => ['We started playing word chain together.', false],
    'firstClothes' => ['Anon bought me my first clothes.', true],
    'CustomClothing' => ['Anon had clothes made just for me.', true],
    'StreamStarted' => ['I started streaming.', true],
    'AfterFirstFuck' => ['Anon and I slept together for the first time.', true],
    'SleepingWithBotUnlocked' => ['Anon and I sleep in the same bed now.', true],
    'riots' => ['Riots broke out in the city.', true],
    'riots_beaten_up' => ['Anon got beaten up during the riots.', true],
    'RiotsBotBringsFood' => ['During the riots I went out and brought us food.', true],
];

const BRIDGE_COUNTER_GROUPS = [
    'sex' => [['timesCameInside', 'timesCameInsideAnal', 'timesCameOutside', 'timesCameInMouth'], 'Anon and I had sex %d more %s.', 'time', 'times'],
    'stream' => [['streamCount'], 'I streamed %d more %s.', 'time', 'times'],
    'chess' => [['timesWonChess', 'timesLostChess'], 'We played %d %s of chess.', 'game', 'games'],
    'oldmaid' => [['timesWonOldMaid', 'timesLostOldMaid'], 'We played %d %s of Old Maid.', 'game', 'games'],
    'wordchain' => [['timesWonWordChain', 'timesLostWordChain'], 'We played %d %s of word chain.', 'game', 'games'],
    'church' => [['timesWentToChurch'], 'Anon went to church %d more %s.', 'time', 'times'],
];

// ids match between the mod and the save parser, the caller drops seen ones
function bridge_events(?array $prev, array $snap): array {
    $events = [];
    foreach ($snap['flags'] as $id => $name) {
        if (!isset(BRIDGE_FLAG_TEXT[$name])) continue;
        [$text, $note] = BRIDGE_FLAG_TEXT[$name];
        $events[] = ['id' => $id, 'text' => $text, 'note' => $note];
    }
    if ($prev === null || $prev['timeline'] !== $snap['timeline']) {
        if ($snap['bot_name'] !== '') {
            $events[] = ['id' => 'name:' . $snap['timeline'], 'text' => 'In the game Anon calls me ' . ucfirst($snap['bot_name']) . '.', 'note' => true];
        }
        return $events;
    }
    foreach (BRIDGE_COUNTER_GROUPS as $group => [$keys, $fmt, $one, $many]) {
        $was = array_sum(array_map(fn($k) => (int)($prev['counters'][$k] ?? 0), $keys));
        $now = array_sum(array_map(fn($k) => (int)($snap['counters'][$k] ?? 0), $keys));
        if ($now <= $was) continue;
        $n = $now - $was;
        $events[] = ['id' => "count:$group:{$snap['timeline']}:$now", 'text' => sprintf($fmt, $n, $n === 1 ? $one : $many), 'note' => false];
    }
    return $events;
}

function bridge_unmapped_flags(array $snap): array {
    return array_values(array_unique(array_filter($snap['flags'], fn($n) => !isset(BRIDGE_FLAG_TEXT[$n]))));
}
