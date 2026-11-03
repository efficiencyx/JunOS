<?php

require_once __DIR__ . '/look.php';

// Saves/save.mdrg is the slot index with savedata "", each slot's raw
// GameVariables json is M<slot+1>.mdrgslot (A<n> for autosaves) next to
// it. an export is that index with savedata inline, as a json STRING

const BRIDGE_COUNTERS = [
    'timesCameInside', 'timesCameInsideAnal', 'timesCameOutside', 'timesCameInMouth',
    'streamCount', 'timesWentToChurch',
    'timesWonChess', 'timesLostChess', 'timesWonOldMaid', 'timesLostOldMaid',
    'timesWonWordChain', 'timesLostWordChain',
];

// by the ranges of the game's ItemEnum, 10xxx shirts ... 17xxx hoodies
const BRIDGE_OUTFIT_KEYS = [
    'shirt', 'hoodie', 'dress', 'dress1', 'skirt', 'pants', 'bra', 'panties', 'bikini_top', 'bikini_bot',
    'stockings', 'shoe_l', 'shoe_r', 'choker', 'bow', 'wizard_hat', 'headband',
    'cat_ears', 'pointy_ears', 'tail', 'hair_h1', 'hair_h2', 'hair_h3', 'hair_h4',
    'heart_choker', 'eyeshadow', 'goth_eyeshadow', 'eyeliner', 'lashes', 'eye_sticker', 'lipstick',
    'septum', 'septum2', 'tongue_piercing', 'manicure', 'pedicure',
];
const BRIDGE_OUTFIT_IDS = [
    1 => ['cat_ears'], 1008 => ['cat_ears'], 1009 => ['pointy_ears'], 13008 => ['pointy_ears'],
    11003 => ['bikini_bot'], 11004 => ['bikini_bot'], 11150 => ['bikini_top', 'bikini_bot'], 11151 => ['bikini_top', 'bikini_bot'],
    14002 => ['bikini_top'], 14003 => ['bikini_top'],
    13000 => ['bow'], 13007 => ['bow'], 13015 => ['bow'], 13006 => ['wizard_hat'], 13027 => ['headband'],
    13001 => ['heart_choker'], 13003 => ['eyeshadow'], 13004 => ['goth_eyeshadow'], 13021 => ['eyeliner'],
    13023 => ['lashes'], 13022 => ['eye_sticker'], 13011 => ['lipstick'], 13009 => ['septum'], 13010 => ['septum2'],
    13016 => ['tongue_piercing'], 13018 => ['manicure'], 13019 => ['pedicure'],
    13005 => ['choker'], 13020 => ['choker'], 13024 => ['choker'], 13025 => ['choker'], 13026 => ['choker'],
    15001 => ['pants'], 18000 => ['dress'], 18001 => ['dress1'],
    200 => ['hair_h1'], 201 => ['hair_h2'], 202 => ['hair_h3'], 203 => ['hair_h4'],
];
// mod items (a _guid) reuse low ids, a modded Room_TV is 9 same as the
// fluffy tail. on those only the slot means anything
const BRIDGE_OUTFIT_SLOTS = [
    'UpperBody' => ['shirt'], 'UpperBodyOuter' => ['hoodie'], 'LowerBody' => ['skirt'],
    'Bra' => ['bra'], 'Panties' => ['panties'], 'StockingL' => ['stockings'], 'StockingR' => ['stockings'],
    'ShoeL' => ['shoe_l'], 'ShoeR' => ['shoe_r'], 'NeckAccessory' => ['choker'], 'Tail' => ['tail'],
];

function bridge_outfit_keys(int $id): array {
    if (isset(BRIDGE_OUTFIT_IDS[$id])) return BRIDGE_OUTFIT_IDS[$id];
    if (($id >= 6 && $id <= 9) || ($id >= 50 && $id <= 53)) return ['tail'];
    $range = intdiv($id, 1000);
    if ($range === 16) return match (($id - 16000) % 3) { 0 => ['shoe_l'], 1 => ['shoe_r'], default => ['shoe_l', 'shoe_r'] };
    return match ($range) {
        10 => ['shirt'], 11 => ['panties'], 12 => ['stockings'], 14 => ['bra'], 15 => ['skirt'], 17 => ['hoodie'],
        default => [],
    };
}

function bridge_entry_ok(mixed $e): bool {
    return is_array($e) && is_string($e['savedata'] ?? null) && is_int($e['_time'] ?? null)
        && is_int($e['ingameTime'] ?? null) && is_int($e['slot'] ?? null);
}

// null = a shape we don't know, and that's what keeps writes off it
function bridge_read_save(string $raw): ?array {
    if (str_starts_with($raw, "\xEF\xBB\xBF")) $raw = substr($raw, 3);
    $doc = json_decode($raw, true, 512, JSON_BIGINT_AS_STRING);
    if (!is_array($doc)) return null;
    if (is_int($doc['_sympathy'] ?? null) && !isset($doc['saves'])) return ['shape' => 'vars', 'vars' => $doc];
    if (!is_array($doc['saves'] ?? null) || !is_array($doc['autoSaves'] ?? null)) return null;
    $entries = [];
    foreach (['saves', 'autoSaves'] as $list) {
        foreach ($doc[$list] as $e) {
            if (!bridge_entry_ok($e)) return null;
            $entries[] = $e;
        }
    }
    return ['shape' => 'bundle', 'entries' => $entries];
}

function bridge_slot_file(string $dir, array $entry): string {
    return $dir . '/' . ((int)($entry['_saveType'] ?? 0) === 1 ? 'A' : 'M') . ($entry['slot'] + 1) . '.mdrgslot';
}

// where each entry's GameVariables lives: inline (export) or its slot file
function bridge_candidates(string $path, array $save): array {
    $out = [];
    foreach ($save['entries'] as $i => $e) {
        if ($e['savedata'] !== '') {
            $out[] = ['path' => $path, 'shape' => 'bundle', 'index' => $i, 'entry' => $e];
        } elseif (is_file($slot = bridge_slot_file(dirname($path), $e))) {
            $out[] = ['path' => $slot, 'shape' => 'vars', 'index' => 0, 'entry' => $e];
        }
    }
    return $out;
}

function bridge_candidate_vars(array $c): ?array {
    if ($c['shape'] === 'bundle') return bridge_vars($c['entry']);
    $save = bridge_read_save((string)@file_get_contents($c['path']));
    return $save && $save['shape'] === 'vars' ? $save['vars'] : null;
}

function bridge_newest_entry(array $entries): ?array {
    $best = null;
    foreach ($entries as $i => $e) {
        if ($best === null || $e['_time'] > $entries[$best]['_time']) $best = $i;
    }
    return $best === null ? null : ['index' => $best] + $entries[$best];
}

function bridge_vars(array $entry): ?array {
    $vars = json_decode($entry['savedata'], true);
    return is_array($vars) ? $vars : null;
}

function bridge_snapshot(array $vars): ?array {
    if (!is_numeric($vars['_sympathy'] ?? null)) return null;
    $flags = [];
    $list = (array)($vars['flags'] ?? []);
    usort($list, fn($a, $b) => (int)($a['firstTimeAdded'] ?? 0) <=> (int)($b['firstTimeAdded'] ?? 0));
    foreach ($list as $f) {
        $name = (string)($f['name'] ?? '');
        if ($name === '') continue;
        $flags['flag:' . $name . ':' . (int)($f['firstTimeAdded'] ?? 0)] = $name;
    }
    $counters = [];
    foreach (BRIDGE_COUNTERS as $k) $counters[$k] = (int)($vars[$k] ?? 0);
    $equipped = $vars['equipped'] ?? array_map(
        fn($i) => [
            'id' => (int)($i['_gameId']['_id'] ?? 0),
            'slot' => (string)($i['_equipedSlot'] ?? ''),
            'mod' => (string)($i['_gameId']['_guid']['serializedGuid'] ?? '') !== '',
            'colors' => array_map('bridge_hex', (array)($i['_colors'] ?? [])),
            'clip' => in_array(['K' => 'FrontClippedUp', 'V' => 1], (array)($i['I'] ?? [])),
        ],
        (array)($vars['itemManager']['items'] ?? [])
    );
    $botName = mb_substr(trim((string)($vars['botName'] ?? '')), 0, 40);
    $playerName = mb_substr(trim((string)($vars['playerName'] ?? '')), 0, 40);
    return [
        'timeline' => hash('sha256', mb_strtolower($botName . '|' . $playerName)),
        'sympathy' => max(0, (int)$vars['_sympathy']),
        'ingame_time' => (int)($vars['time'] ?? 0),
        'stage' => (int)($vars['stage'] ?? 0),
        'bot_name' => $botName,
        'player_name' => $playerName,
        'flags' => $flags,
        'counters' => $counters,
        'outfit' => bridge_outfit_from_equipped((array)$equipped),
        'look' => bridge_look_from_equipped((array)$equipped),
    ];
}

// the game goes way past 1000, affection tops out at 100. anything over
// 1000 reads as 100 and is left alone unless her affection drops
function bridge_affection_of(int $sympathy): int {
    return (int)round(min($sympathy, 1000) / 10);
}

function bridge_sympathy_for(int $affection, int $gameSympathy): int {
    return bridge_affection_of($gameSympathy) === $affection ? $gameSympathy : $affection * 10;
}

// worn = any slot but '' (in the bag) and Anon_* (the player's)
function bridge_item_worn(array $item): bool {
    $slot = (string)($item['slot'] ?? '');
    return $slot !== '' && !str_starts_with($slot, 'Anon_');
}

function bridge_item_keys(array $item): array {
    return empty($item['mod']) ? bridge_outfit_keys((int)($item['id'] ?? 0)) : (BRIDGE_OUTFIT_SLOTS[$item['slot']] ?? []);
}

function bridge_outfit_from_equipped(array $equipped): array {
    $outfit = array_fill_keys(BRIDGE_OUTFIT_KEYS, false);
    foreach ($equipped as $item) {
        if (!bridge_item_worn($item)) continue;
        foreach (bridge_item_keys($item) as $key) $outfit[$key] = true;
    }
    return $outfit;
}

function bridge_save_files(string $dir): array {
    if (!is_dir($dir)) return [];
    $out = [];
    $it = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($dir, FilesystemIterator::SKIP_DOTS));
    foreach ($it as $file) {
        if (!$file->isFile() || strtolower($file->getExtension()) !== 'mdrg') continue;
        if (preg_match('#[/\\\\]backups?[/\\\\]#i', substr($file->getPathname(), strlen($dir)))) continue;
        $out[] = $file->getPathname();
    }
    sort($out);
    return $out;
}

// the newest slot by _time across every container and export under $dir
function bridge_newest_save(string $dir): ?array {
    $all = [];
    $paths = is_file($dir) ? [$dir] : bridge_save_files($dir);
    foreach ($paths as $path) {
        $save = bridge_read_save((string)@file_get_contents($path));
        if ($save === null || $save['shape'] !== 'bundle') {
            log_event(['msg' => 'bridge_save_unknown_shape', 'file' => basename($path)]);
            continue;
        }
        array_push($all, ...bridge_candidates($path, $save));
    }
    usort($all, fn($a, $b) => $b['entry']['_time'] <=> $a['entry']['_time']);
    foreach ($all as $c) {
        if (($c['vars'] = bridge_candidate_vars($c)) !== null) return $c;
    }
    return null;
}
