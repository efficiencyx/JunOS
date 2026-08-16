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
    'hair_clip' => false,
];

const WARDROBE_VARIANT_MAX = [
    'arm_style' => 2, 'leg_style' => 2, 'hightech_skin' => 1,
    'skirt_style' => 1, 'sock_style' => 7, 'shoe_style' => 2,
    'glasses_style' => 2, 'shirt_logo' => 100, 'sleeve_logo' => 100,
    'hoodie_logo' => 100, 'panties_logo' => 100,
];

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

    $conflicts = [
        ['dress', 'shirt'], ['dress', 'hoodie'], ['dress', 'skirt'], ['dress', 'pants'], ['dress', 'dress1'],
        ['dress1', 'shirt'], ['dress1', 'hoodie'], ['dress1', 'skirt'], ['dress1', 'pants'],
        ['skirt', 'pants'], ['bra', 'bikini_top'], ['panties', 'bikini_bot'],
        ['headband', 'wizard_hat'], ['cat_ears', 'pointy_ears'],
    ];
    foreach ($conflicts as [$left, $right]) {
        if ($state['items'][$left] && $state['items'][$right]) fail(400, 'invalid_wardrobe');
    }
    if ($state['items']['hair_clip'] && !$state['items']['hair_h0']) fail(400, 'invalid_wardrobe');

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
