<?php
require_once __DIR__ . '/lib/bootstrap.php';
require_once __DIR__ . '/lib/wardrobe.php';
require_once __DIR__ . '/lib/bridge/apply.php';

$user = require_user();
$userId = (int)$user['id'];

if (require_method('GET', 'PUT') === 'GET') {
    $state = wardrobe_state($userId);
    json_out([
        'initialized' => $state !== null,
        'state' => $state ?? wardrobe_default_state(),
        'game_look' => bridge_enabled() ? bridge_look_take($userId) : null,
    ]);
}

rate_limit('outfit_change_' . $userId, 2, 1);
$body = read_json_body(32 * 1024);
$state = wardrobe_canonical_state($body);
$before = wardrobe_state($userId);
wardrobe_save_state($userId, $state);
if (($body['game_look'] ?? false) === true && bridge_enabled()) bridge_look_saved($userId);
// the first save is the page setting up, not a change. and the
// browser re-saves after her change_outfit tool, which counted it
// already, the same state twice is not a second change
if (ach_worn_changed($before, $state)) ach_add($userId, 'outfits');
json_out(['state' => $state]);
