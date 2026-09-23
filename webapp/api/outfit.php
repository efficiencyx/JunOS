<?php
require_once __DIR__ . '/lib/bootstrap.php';
require_once __DIR__ . '/lib/wardrobe.php';

$user = require_user();
$userId = (int)$user['id'];

if (require_method('GET', 'PUT') === 'GET') {
    $state = wardrobe_state($userId);
    json_out(['initialized' => $state !== null, 'state' => $state ?? wardrobe_default_state()]);
}

rate_limit('outfit_change_' . $userId, 2, 1);
$state = wardrobe_canonical_state(read_json_body(32 * 1024));
wardrobe_save_state($userId, $state);
json_out(['state' => $state]);
