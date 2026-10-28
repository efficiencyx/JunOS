<?php
require_once __DIR__ . '/lib/bootstrap.php';
require_once __DIR__ . '/lib/lore.php';
require_once __DIR__ . '/lib/wardrobe.php';

header('Content-Type: application/json');
header('Cache-Control: no-store');

require_user();
rate_limit('health', 30, 60);
require_method('GET');

// the boot screen's checklist. the model itself is models.php,
// it retries that one on its own
$voice = sidecar_call(tts_url() . '/health', null, [], 3);
json_out([
    'provider' => ai_provider(),
    'db' => true,
    'lore' => lore_index() !== null,
    'rig' => rig_assets_present(),
    'voice' => $voice['body'] !== false && $voice['code'] === 200,
]);
