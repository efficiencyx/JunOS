<?php

// styles, logos and colours. colours sit in encrypted prefs and the
// mod has no data key, so the browser merges this on its next load

const BRIDGE_LOGOS = [
    10100 => 'fishFearMe', 10101 => 'withStupid', 10102 => 'temple', 10103 => 'gamerTshirt', 10104 => 'botLogo',
    10105 => 'dogeCoin', 10106 => 'sheep', 10107 => 'sylphy', 10108 => 'luxe', 10109 => 'stilou',
    10111 => 'monizmed', 10112 => 'diabete', 10113 => 'cazino', 10114 => 'diabeteColaPow', 10115 => 'diabeteDrSugar',
    10116 => 'diabeteSweetPotato', 10117 => 'hotPinkGames', 10118 => 'inHeat', 10119 => 'ddLogo', 10120 => 'siluman',
    10121 => 'silumanAlice', 10122 => 'fungus', 10123 => 'yaranaika', 10124 => 'baka', 10125 => 'cia',
    10126 => 'polandball', 10127 => 'wyldSpace', 10128 => 'priestbot', 10129 => 'mirthal', 10130 => 'aguiLogo',
    10131 => 'bedabots', 10132 => 'projektMelody', 10133 => 'xoulion', 10134 => 'ufo',
    11100 => 'fishFearMe', 11101 => 'rose', 11102 => 'banana', 11103 => 'usb', 11104 => 'yaranaika',
    11105 => 'wyldSpace', 11106 => 'hikkeiru', 11107 => 'radioactive', 11200 => 'strawberry', 11201 => 'peach',
    11202 => 'avocado', 11203 => 'cherry', 11204 => 'shcPanties', 11205 => 'xoulion',
    17100 => 'dogeCoin', 17101 => 'weeb', 17102 => 'bloodyMoon', 17103 => 'cosplayHouse', 17104 => 'luxe',
    17105 => 'stilou', 17107 => 'monizmed', 17108 => 'diabete', 17109 => 'cazino', 17110 => 'diabeteColaPow',
    17111 => 'diabeteDrSugar', 17112 => 'diabeteSweetPotato', 17113 => 'milfHunter', 17114 => 'polandball',
    17115 => 'aguiLogo', 17116 => 'shcHoodie', 17117 => 'bedabots', 17118 => 'projektMelody69', 17119 => 'worldTamer',
    17120 => 'xoulion', 17121 => 'celestyn', 17122 => 'flowerkidv', 17123 => 'nuteku', 17124 => 'skull',
    17125 => 'tonisAlbum', 17126 => 'madJoram', 17127 => 'sj68', 17128 => 'lightSonic', 17129 => 'rottingSteel',
    17130 => 'nitrori',
];
const BRIDGE_LOGO_SLOTS = ['UpperBody' => 'shirt_logo', 'UpperBodyOuter' => 'hoodie_logo', 'Panties' => 'panties_logo'];

const BRIDGE_ID_VARIANTS = [
    13000 => ['bow_style' => 0], 13015 => ['bow_style' => 1], 13007 => ['bow_style' => 2],
    13005 => ['choker_style' => 0], 13024 => ['choker_style' => 1], 13020 => ['choker_style' => 2],
    13025 => ['choker_style' => 2], 13026 => ['choker_style' => 3], 13014 => ['glasses_style' => 3],
];
const BRIDGE_ID_COLORS = [1506 => ['hair_hologram'], 13014 => ['eyepatch']];

// the game's sock order isn't the catalog's. index = game, value = sock_style
const BRIDGE_SOCK_STYLES = [0, 5, 4, 6, 7, 2, 3, 1];

// _colors is a bare list, the game never names the entries. these orders
// come from comparing values on real saves, source: trust me bro
const BRIDGE_ITEM_COLORS = [
    'hoodie' => ['hoodie', 'hoodie_strings'], 'cat_ears' => ['ear', 'ear_mid'], 'pointy_ears' => ['ear'],
    'hair_h1' => [null, 'hair_h1_strand'], 'hair_h2' => [null, 'hair_h2_strand'], 'hair_h3' => [null, 'hair_h3_strand'],
    'hair_h4' => [],
];
const BRIDGE_SLOT_COLORS = [
    'Skin' => ['skin'], 'Eyes' => ['eye_iris', null, 'eye_pupil', null, 'eye_sclera'],
    'HairMain' => ['hair', 'hair_h0_strand'], 'Glasses' => ['glasses_frame', 'glasses_lens'],
];

function bridge_hex(array $c): string {
    $byte = fn($v) => (int)round(max(0, min(1, (float)$v)) * 255);
    return sprintf('#%02x%02x%02x', $byte($c['r'] ?? 0), $byte($c['g'] ?? 0), $byte($c['b'] ?? 0));
}

function bridge_limb_style(int $id): int {
    if ($id >= 104 && $id <= 107) return 1;
    return $id >= 108 && $id <= 111 ? 2 : 0;
}

function bridge_item_variants(int $id, string $slot, bool $clip): array {
    return match ($slot) {
        'LowerBody' => ['skirt_style' => $id === 15002 ? 1 : 0],
        'StockingL', 'StockingR' => ['sock_style' => BRIDGE_SOCK_STYLES[$id >= 12500 ? $id - 12500 : intdiv($id - 12000, 2)] ?? 0],
        'ShoeL', 'ShoeR' => ['shoe_style' => $id >= 16003 ? 2 : 1],
        'Glasses' => ['glasses_style' => in_array($id, [13002, 13017], true) ? 2 : (int)in_array($id, [13012, 13013], true)],
        'ArmL' => ['arm_style' => bridge_limb_style($id)],
        'LegL' => ['leg_style' => bridge_limb_style($id)],
        'Skin' => ['hightech_skin' => (int)($id === 1200)],
        'HairMain' => ['hair_h0_style' => (int)$clip],
        default => [],
    };
}

function bridge_look_from_equipped(array $equipped): array {
    // the third HairMain colour is NOT her halo, that stays white in the
    // game unless a DefaultHologram (1506) says otherwise
    $look = ['variants' => ['glasses_style' => 0], 'logos' => [], 'colors' => ['hair_hologram' => '#ffffff']];
    foreach ($equipped as $item) {
        if (!bridge_item_worn($item)) continue;
        $id = (int)($item['id'] ?? 0);
        $slot = (string)$item['slot'];
        if (empty($item['mod'])) {
            $look['variants'] = (BRIDGE_ID_VARIANTS[$id] ?? []) + bridge_item_variants($id, $slot, !empty($item['clip'])) + $look['variants'];
            if (isset(BRIDGE_LOGO_SLOTS[$slot])) $look['logos'][BRIDGE_LOGO_SLOTS[$slot]] = BRIDGE_LOGOS[$id] ?? '';
        }
        $groups = empty($item['mod']) && isset(BRIDGE_ID_COLORS[$id]) ? BRIDGE_ID_COLORS[$id] : (BRIDGE_SLOT_COLORS[$slot] ?? []);
        foreach (bridge_item_keys($item) as $key) $groups = array_merge($groups, BRIDGE_ITEM_COLORS[$key] ?? [$key]);
        foreach ($groups as $i => $group) {
            $hex = $item['colors'][$i] ?? null;
            if ($group !== null && $hex !== null) $look['colors'][$group] = $hex;
        }
    }
    return $look;
}
