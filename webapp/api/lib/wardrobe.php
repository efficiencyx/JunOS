<?php

const WARDROBE_ITEM_DEFAULTS = [
    'shirt' => true, 'hoodie' => false, 'dress' => false, 'dress1' => false,
    'skirt' => true, 'pants' => false, 'bra' => true, 'panties' => true,
    'bikini_top' => false, 'bikini_bot' => false, 'shoe_l' => true,
    'shoe_r' => true, 'stockings' => true, 'headband' => false,
    'wizard_hat' => false, 'bow' => false, 'choker' => false,
    'cat_ears' => true, 'pointy_ears' => false, 'tail' => true,
    'hair_hologram' => true, 'hair_h0' => true, 'hair_h1' => false,
    'hair_h2' => false, 'hair_h3' => false, 'hair_h4' => false,
];

const WARDROBE_VARIANT_MAX = [
    'hair_h0_style' => 1, 'arm_style' => 2, 'leg_style' => 2, 'hightech_skin' => 1,
    'skirt_style' => 1, 'sock_style' => 7, 'shoe_style' => 2,
    'glasses_style' => 2, 'shirt_logo' => 100, 'sleeve_logo' => 100,
    'hoodie_logo' => 100, 'panties_logo' => 100,
];

const WARDROBE_COLOR_DEFAULTS = [
    'skin' => null, 'blush' => '#ff3a3a', 'hair' => null,
    'hair_h0_strand' => null, 'hair_h1_strand' => null,
    'hair_h2_strand' => null, 'hair_h3_strand' => null,
    'hair_hologram' => null, 'ear' => null, 'ear_mid' => null, 'tail' => null,
    'eyebrows' => null, 'eye_sclera' => null, 'eye_iris' => null,
    'eye_pupil' => null, 'eye_highlight' => null, 'lips' => null,
    'mouth_interior' => null, 'glasses_frame' => null, 'glasses_lens' => null,
    'shirt' => null, 'hoodie' => null, 'dress' => null, 'dress1' => null,
    'skirt' => null, 'pants' => null, 'bra' => null, 'panties' => null,
    'bikini_top' => null, 'bikini_bot' => null, 'shoe_l' => null,
    'shoe_r' => null, 'stockings' => null, 'stockings_accent' => null, 'headband' => null,
    'wizard_hat' => null, 'bow' => null, 'choker' => null, 'hair_clip' => null,
];

// pairs that cannot both be on. this is the same list
// ITEMS[].excludes holds in outfit/catalog.js and the two
// have to stay in step: a state the browser thinks is fine and
// this file rejects means every wardrobe PUT after it 400s and
// nothing the user does in the shop persists again.
const WARDROBE_CONFLICTS = [
    ['dress', 'shirt'], ['dress', 'hoodie'], ['dress', 'skirt'], ['dress', 'pants'], ['dress', 'dress1'],
    ['dress1', 'shirt'], ['dress1', 'hoodie'], ['dress1', 'skirt'], ['dress1', 'pants'],
    ['skirt', 'pants'], ['bra', 'bikini_top'], ['panties', 'bikini_bot'],
    ['headband', 'wizard_hat'], ['cat_ears', 'pointy_ears'],
];

// what a person calls the thing -> the keys the state uses.
// mirrors the alias table in syncFromAction in
// outfit/chat-tools.js, because she reaches for the same words
// whichever channel she uses.
const WARDROBE_ALIASES = [
    'shoes' => ['shoe_l', 'shoe_r'],
    'shoe' => ['shoe_l', 'shoe_r'],
    'shoe_left' => ['shoe_l'],
    'left_shoe' => ['shoe_l'],
    'shoe_right' => ['shoe_r'],
    'right_shoe' => ['shoe_r'],
    'hat' => ['wizard_hat'],
    'witch_hat' => ['wizard_hat'],
    'dress_alt' => ['dress1'],
    'alt_dress' => ['dress1'],
    'socks' => ['stockings'],
    'sock' => ['stockings'],
    'catears' => ['cat_ears'],
    'cat_ear' => ['cat_ears'],
    'pointy_ear' => ['pointy_ears'],
    'bikini' => ['bikini_top', 'bikini_bot'],
    'swimsuit' => ['bikini_top', 'bikini_bot'],
    'bikini_bottom' => ['bikini_bot'],
    'underwear' => ['bra', 'panties'],
    'top' => ['shirt'],
    't_shirt' => ['shirt'],
    'tshirt' => ['shirt'],
    'trousers' => ['pants'],
    'choker' => ['choker'],
    'collar' => ['choker'],
    'hair' => ['hair_h0'],
];

// only the keys that don't read as English on their own.
// everything else gets its underscores swapped for spaces.
const WARDROBE_LABELS = [
    'shoe_l' => 'left shoe', 'shoe_r' => 'right shoe',
    'bikini_top' => 'bikini top', 'bikini_bot' => 'bikini bottom',
    'dress1' => 'alt dress', 'wizard_hat' => 'witch hat',
    'hair_h0' => 'default hair', 'hair_h1' => 'side swept hair',
    'hair_h2' => 'front bang', 'hair_h3' => 'hime cut hair',
    'hair_h4' => 'ponytail', 'hair_hologram' => 'hair hologram',
    'choker' => 'bell choker',
];

function wardrobe_label(string $key): string {
    return WARDROBE_LABELS[$key] ?? str_replace('_', ' ', $key);
}

function wardrobe_excludes(string $key): array {
    $out = [];
    foreach (WARDROBE_CONFLICTS as [$left, $right]) {
        if ($left === $key) $out[] = $right;
        if ($right === $key) $out[] = $left;
    }
    return $out;
}

// one name she asked for -> item keys, empty when nothing vanilla
// answers to it (which is the caller's cue to go looking through
// the mod list)
function wardrobe_resolve_item(string $name): array {
    $key = strtolower(trim($name));
    $key = preg_replace('/[^a-z0-9]+/', '_', $key);
    $key = trim((string)$key, '_');
    if ($key === '') return [];
    if (isset(WARDROBE_ALIASES[$key])) return WARDROBE_ALIASES[$key];
    if (array_key_exists($key, WARDROBE_ITEM_DEFAULTS)) return [$key];
    // the tool hands her the LABELS as the list of what exists, so
    // every label has to come back. without this she reads "bell
    // choker" off valid_items, asks for it by that name and is told
    // she doesn't own one.
    foreach (WARDROBE_LABELS as $itemKey => $label) {
        if (str_replace(' ', '_', $label) === $key) return [$itemKey];
    }
    return [];
}

// every clothing key, which is everything except the body and
// hair sections. "nude" means these and only these. taking her
// ears and tail off is not getting undressed.
const WARDROBE_CLOTHING = [
    'shirt', 'hoodie', 'dress', 'dress1', 'skirt', 'pants', 'bra', 'panties',
    'bikini_top', 'bikini_bot', 'shoe_l', 'shoe_r', 'stockings', 'headband',
    'wizard_hat', 'bow', 'choker',
];

// turn one item on or off in a state, resolving the conflicts the
// way the browser does: putting something on takes off whatever
// it can't share the body with. returns the keys that actually
// moved.
function wardrobe_set_item(array &$state, string $key, bool $on): array {
    $moved = [];
    if ($state['items'][$key] !== $on) {
        $state['items'][$key] = $on;
        $moved[] = $key;
    }
    if (!$on) return $moved;
    foreach (wardrobe_excludes($key) as $other) {
        if (!$state['items'][$other]) continue;
        $state['items'][$other] = false;
        $moved[] = $other;
    }
    return $moved;
}

// an asset stays authorized only while the state it belongs to is
// still on. without this pass, taking the side-swept hair off
// leaves its texture in the list and the next PUT from the
// browser is rejected as invalid_wardrobe.
function wardrobe_prune_assets(array $state): array {
    $state['assets'] = array_values(array_filter(
        $state['assets'],
        fn($asset) => wardrobe_asset_matches_state($asset, $state)
    ));
    return $state;
}

function wardrobe_worn(array $state): array {
    $worn = [];
    foreach ($state['items'] as $key => $on) {
        if ($on) $worn[] = wardrobe_label($key);
    }
    return $worn;
}

function wardrobe_default_state(): array {
    return [
        'items' => WARDROBE_ITEM_DEFAULTS,
        'variants' => array_fill_keys(array_keys(WARDROBE_VARIANT_MAX), 0),
        'assets' => [],
    ];
}

function wardrobe_canonical_state(array $input): array {
    $state = wardrobe_default_state();
    $items = $input['items'] ?? [];
    $variants = $input['variants'] ?? [];
    $assets = $input['assets'] ?? [];
    if (!is_array($items) || !is_array($variants) || !is_array($assets)) fail(400, 'invalid_wardrobe');
    if (array_key_exists('hair_clip', $items) && !is_bool($items['hair_clip'])) fail(400, 'invalid_wardrobe');

    foreach (WARDROBE_ITEM_DEFAULTS as $key => $default) {
        if (array_key_exists($key, $items)) {
            if (!is_bool($items[$key])) fail(400, 'invalid_wardrobe');
            $state['items'][$key] = $items[$key];
        }
    }
    foreach (WARDROBE_VARIANT_MAX as $key => $max) {
        if (!array_key_exists($key, $variants)) continue;
        $value = $variants[$key];
        if (!is_int($value) || $value < 0 || $value > $max) fail(400, 'invalid_wardrobe');
        $state['variants'][$key] = $value;
    }
    if (!array_key_exists('hair_h0_style', $variants) && ($items['hair_clip'] ?? false)) {
        $state['variants']['hair_h0_style'] = 1;
    }

    foreach (WARDROBE_CONFLICTS as [$left, $right]) {
        if ($state['items'][$left] && $state['items'][$right]) fail(400, 'invalid_wardrobe');
    }
    $clean = [];
    foreach ($assets as $asset) {
        if (!is_string($asset) || !preg_match('#^variants/[A-Za-z0-9_./-]+\\.png$#', $asset)
            || str_contains($asset, '..')) fail(400, 'invalid_wardrobe');
        $clean[$asset] = true;
    }
    if (count($clean) > 80) fail(400, 'invalid_wardrobe');
    $state['assets'] = array_keys($clean);
    foreach ($state['assets'] as $asset) {
        if (!wardrobe_asset_matches_state($asset, $state)) fail(400, 'invalid_wardrobe');
    }
    sort($state['assets']);
    return $state;
}

function wardrobe_canonical_preset(array $input): array {
    foreach (array_keys($input) as $key) {
        if (!in_array($key, ['items', 'colors', 'variants'], true)) fail(400, 'invalid_wardrobe');
    }

    $items = $input['items'] ?? [];
    $colors = $input['colors'] ?? [];
    $variants = $input['variants'] ?? [];
    if (!is_array($items) || !is_array($colors) || !is_array($variants)) fail(400, 'invalid_wardrobe');

    foreach (array_keys($items) as $key) {
        if ($key === 'hair_clip') {
            if (!is_bool($items[$key])) fail(400, 'invalid_wardrobe');
        } elseif (!array_key_exists($key, WARDROBE_ITEM_DEFAULTS)) fail(400, 'invalid_wardrobe');
    }
    foreach (array_keys($variants) as $key) {
        if (!array_key_exists($key, WARDROBE_VARIANT_MAX)) fail(400, 'invalid_wardrobe');
    }

    $wardrobe = wardrobe_canonical_state([
        'items' => $items,
        'variants' => $variants,
        'assets' => [],
    ]);
    $cleanColors = WARDROBE_COLOR_DEFAULTS;
    foreach ($colors as $key => $value) {
        if (!array_key_exists($key, WARDROBE_COLOR_DEFAULTS)) fail(400, 'invalid_wardrobe');
        if ($value !== null && (!is_string($value) || !preg_match('/^#[0-9a-f]{6}$/iD', $value))) {
            fail(400, 'invalid_wardrobe');
        }
        $cleanColors[$key] = is_string($value) ? strtolower($value) : null;
    }

    return [
        'items' => $wardrobe['items'],
        'colors' => $cleanColors,
        'variants' => $wardrobe['variants'],
    ];
}

function wardrobe_asset_matches_state(string $asset, array $state): bool {
    $items = $state['items'];
    $variants = $state['variants'];
    if (str_starts_with($asset, 'variants/hair/clothier/')) return $items['hair_h1'];
    if (str_starts_with($asset, 'variants/hair/eye_covering_bang/')) return $items['hair_h2'];
    if (str_starts_with($asset, 'variants/hair/hime/')) return $items['hair_h3'];
    if (str_starts_with($asset, 'variants/limbs/experimental/AttachArm')) return $variants['arm_style'] > 0;
    if (str_starts_with($asset, 'variants/limbs/experimental/AttachLeg')) return $variants['leg_style'] > 0;
    if (str_starts_with($asset, 'variants/limbs/hightech/')) return $variants['hightech_skin'] > 0;
    if ($asset === 'variants/miniskirt.png') return $items['skirt'] && $variants['skirt_style'] === 1;
    if (preg_match('#^variants/(kneehighSock|shortSock|twostripedStocking|longSock|lingerieSock|stripedStocking|stirrup)[LR]\\.png$#', $asset)) {
        return $items['stockings'] && $variants['sock_style'] > 0;
    }
    if (preg_match('#^variants/(sneaker|classyShoe)[LR]\\.png$#', $asset)) {
        return ($items['shoe_l'] || $items['shoe_r']) && $variants['shoe_style'] > 0;
    }
    if ($asset === 'variants/glasses.png' || str_starts_with($asset, 'variants/glasses/glasses_')) {
        return $variants['glasses_style'] === 1;
    }
    if ($asset === 'variants/heartGlasses.png' || str_starts_with($asset, 'variants/glasses/heartGlasses_')) {
        return $variants['glasses_style'] === 2;
    }
    if (str_starts_with($asset, 'variants/logos/')) {
        return ($items['shirt'] && ($variants['shirt_logo'] > 0 || $variants['sleeve_logo'] > 0))
            || ($items['hoodie'] && $variants['hoodie_logo'] > 0)
            || ($items['panties'] && $variants['panties_logo'] > 0);
    }
    return false;
}

function wardrobe_presets(int $userId): array {
    $st = db()->prepare('SELECT name, data FROM wardrobe_presets WHERE user_id=? ORDER BY name COLLATE NOCASE');
    $st->execute([$userId]);
    $out = [];
    foreach ($st->fetchAll() as $row) {
        $data = json_decode((string)$row['data'], true);
        if (is_array($data)) $out[(string)$row['name']] = $data;
    }
    return $out;
}

// the stored state, with every key present and nothing outside
// the schema. deliberately NOT wardrobe_canonical_state(): that
// one calls fail(), which prints a json error and exits. do that
// halfway through chat.php's SSE stream (the reply going out
// token by token) and the browser is left holding a half-written
// reply.
function wardrobe_tool_state(int $userId): array {
    $state = wardrobe_state($userId);
    if (!is_array($state)) $state = wardrobe_default_state();
    $items = is_array($state['items'] ?? null) ? $state['items'] : [];
    $variants = is_array($state['variants'] ?? null) ? $state['variants'] : [];
    return [
        'items' => array_merge(WARDROBE_ITEM_DEFAULTS, array_filter(
            array_intersect_key($items, WARDROBE_ITEM_DEFAULTS), 'is_bool')),
        'variants' => array_merge(array_fill_keys(array_keys(WARDROBE_VARIANT_MAX), 0), array_filter(
            array_intersect_key($variants, WARDROBE_VARIANT_MAX), 'is_int')),
        'assets' => array_values(array_filter(
            is_array($state['assets'] ?? null) ? $state['assets'] : [], 'is_string')),
    ];
}

function wardrobe_tool_names($value): array {
    if (is_string($value)) $value = [$value];
    if (!is_array($value)) return [];
    $out = [];
    foreach ($value as $name) {
        if (!is_string($name)) continue;
        $name = trim($name);
        if ($name === '' || mb_strlen($name) > 80) continue;
        $out[] = $name;
        if (count($out) >= 12) break;
    }
    return $out;
}

// mods never reach the server as anything but names the browser
// hands up for this one turn, so matching them is string work.
// same rules as Mods.wearByName so both channels accept the same
// words.
function wardrobe_match_mod(string $name, array $modItems): ?string {
    $want = strtolower(trim($name));
    foreach ($modItems as $item) {
        if (strtolower($item) === $want) return $item;
    }
    foreach ($modItems as $item) {
        $label = strtolower($item);
        if (mb_strlen($label) >= 4 && (str_contains($label, $want) || str_contains($want, $label))) return $item;
    }
    return null;
}

const WARDROBE_STRIP_WORDS = ['nude', 'naked', 'everything', 'all', 'clothes', 'all clothes', 'undress'];

// the change_outfit tool. every answer here is computed against
// the state the browser last wrote, so what she reads back is her
// actual clothes and not what she hoped happened. that's the
// whole point of it being a tool: an [A:outfit] tag goes out and
// NOTHING comes back, so she has no way to know she asked for an
// item that doesn't exist, or one she already had on, and she
// reports the change she intended either way.
//
// returns ['reply' => what the model reads, 'apply' => what the
// browser does]. apply is null when nothing moved.
function wardrobe_tool_change(array $args, int $userId, array $modItems): array {
    $state = wardrobe_tool_state($userId);
    $look = is_string($args['look'] ?? null) ? trim($args['look']) : '';

    if ($look !== '') {
        $presets = wardrobe_presets($userId);
        $hit = null;
        foreach (array_keys($presets) as $name) {
            if (strcasecmp($name, $look) === 0) { $hit = $name; break; }
        }
        if ($hit === null) {
            foreach (array_keys($presets) as $name) {
                if (stripos($name, $look) !== false) { $hit = $name; break; }
            }
        }
        if ($hit === null) {
            return ['apply' => null, 'reply' => [
                'changed' => false,
                'error' => 'no_saved_look_by_that_name',
                'saved_looks' => array_keys($presets),
                'note' => $presets
                    ? 'You are still wearing exactly what you had on. Use one of the names in saved_looks, or put_on/take_off instead.'
                    : 'You are still wearing exactly what you had on. There are no saved looks at all - use put_on and take_off.',
            ]];
        }
        $preset = $presets[$hit];
        $items = is_array($preset['items'] ?? null) ? $preset['items'] : [];
        $variants = is_array($preset['variants'] ?? null) ? $preset['variants'] : [];
        $state['items'] = array_merge($state['items'], array_filter(
            array_intersect_key($items, WARDROBE_ITEM_DEFAULTS), 'is_bool'));
        $state['variants'] = array_merge($state['variants'], array_filter(
            array_intersect_key($variants, WARDROBE_VARIANT_MAX), 'is_int'));
        wardrobe_save_state($userId, wardrobe_prune_assets($state));
        return ['apply' => ['look' => $hit], 'reply' => [
            'changed' => true,
            'look' => $hit,
            'wearing' => wardrobe_worn($state),
        ]];
    }

    $applyItems = [];
    $applyMods = [];
    $put = $took = $already = $unknown = [];

    foreach ([[wardrobe_tool_names($args['put_on'] ?? []), true],
              [wardrobe_tool_names($args['take_off'] ?? []), false]] as [$names, $on]) {
        foreach ($names as $name) {
            // "nude" means the same thing whichever list she put it in
            if (in_array(strtolower($name), WARDROBE_STRIP_WORDS, true)) {
                foreach (WARDROBE_CLOTHING as $key) {
                    foreach (wardrobe_set_item($state, $key, false) as $moved) {
                        $applyItems[$moved] = false;
                        $took[] = wardrobe_label($moved);
                    }
                }
                continue;
            }
            $keys = wardrobe_resolve_item($name);
            if (!$keys) {
                $mod = wardrobe_match_mod($name, $modItems);
                if ($mod === null) { $unknown[] = $name; continue; }
                $applyMods[$mod] = $on;
                if ($on) $put[] = $mod; else $took[] = $mod;
                continue;
            }
            $moved = [];
            foreach ($keys as $key) {
                foreach (wardrobe_set_item($state, $key, $on) as $k) $moved[] = $k;
            }
            if (!$moved) { $already[] = wardrobe_label($keys[0]); continue; }
            foreach ($moved as $key) {
                $applyItems[$key] = $state['items'][$key];
                if ($state['items'][$key]) $put[] = wardrobe_label($key);
                else $took[] = wardrobe_label($key);
            }
        }
    }

    if ($applyItems) wardrobe_save_state($userId, wardrobe_prune_assets($state));

    $reply = [
        'changed' => (bool)($applyItems || $applyMods),
        'put_on' => array_values(array_unique($put)),
        'took_off' => array_values(array_unique($took)),
        'wearing' => wardrobe_worn($state),
    ];
    if ($modItems) {
        $wornMods = [];
        foreach ($modItems as $item) {
            if (($applyMods[$item] ?? false)) $wornMods[] = $item;
        }
        if ($wornMods) $reply['wearing'] = array_merge($reply['wearing'], $wornMods);
    }
    if ($already) {
        $reply['already_like_that'] = array_values(array_unique($already));
        $reply['note'] = 'The items in already_like_that were in that state before you asked. Do not announce a change you did not make.';
    }
    if ($unknown) {
        $reply['unknown'] = array_values(array_unique($unknown));
        $reply['valid_items'] = array_map('wardrobe_label', array_keys(WARDROBE_ITEM_DEFAULTS));
        if ($modItems) $reply['your_special_items'] = array_slice($modItems, 0, 40);
        $reply['note'] = 'You do not own the names in unknown and nothing about them changed. Only names from valid_items'
            . ($modItems ? ' or your_special_items' : '') . ' exist. Say so plainly rather than pretending.';
    }
    if (!$reply['changed'] && !$unknown && !$already) {
        $reply['note'] = 'You named nothing to change, so nothing changed. wearing is what you have on right now.';
    }
    $apply = ($applyItems || $applyMods) ? ['items' => $applyItems, 'mods' => $applyMods] : null;
    return ['apply' => $apply, 'reply' => $reply];
}

function wardrobe_state(int $userId): ?array {
    $stmt = db()->prepare('SELECT data FROM wardrobe_state WHERE user_id=?');
    $stmt->execute([$userId]);
    $raw = $stmt->fetchColumn();
    if ($raw === false) return null;
    $parsed = json_decode((string)$raw, true);
    return is_array($parsed) ? $parsed : null;
}

function wardrobe_save_state(int $userId, array $state): void {
    db()->prepare(
        'INSERT INTO wardrobe_state (user_id, data, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at'
    )->execute([$userId, json_encode($state, JSON_UNESCAPED_SLASHES), time()]);
}
