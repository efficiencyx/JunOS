<?php
require_once __DIR__ . '/_lib.php';
require_once __DIR__ . '/_wardrobe.php';

$user = require_user();
$method = strtoupper($_SERVER['REQUEST_METHOD'] ?? 'GET');
if ($method !== 'GET' && $method !== 'HEAD') fail(405, 'method_not_allowed');
$requestPath = (string)($_SERVER['OMEGA_ASSET_PATH'] ?? '');
if (!str_starts_with($requestPath, '/assets/')) fail(404, 'not_found');
$relative = rawurldecode(substr($requestPath, strlen('/assets/')));
if ($relative === '' || str_contains($relative, "\\0") || str_contains($relative, '..')
    || !preg_match('#^[A-Za-z0-9_./-]+$#', $relative)) fail(404, 'not_found');

$baseDir = realpath(__DIR__ . '/../assets');
$target = $baseDir === false ? false : realpath($baseDir . '/' . $relative);
if ($target === false || !is_file($target)
    || ($target !== $baseDir && !str_starts_with($target, $baseDir . DIRECTORY_SEPARATOR))) fail(404, 'not_found');

// items/ holds the baked wardrobe tiles. every tile is on screen the moment
// the wardrobe opens, so gating them on the active look would just 403 the
// whole grid. same category as the base atlas above: always needed, never
// secret to the user who owns the look.
// logos and the two glasses shots are in here for the same reason. they never
// get baked (they're painted into a face or garment texture, so the crop comes
// back as her whole face), so the picker uses the decal png itself as the
// thumb. gate those on the worn look and every logo you're NOT wearing is a
// 403, which is the entire point of a picker gone.
$baseAsset = preg_match('#^(interaction_model\\.(?:moc3|model3\\.json)|texture_\\d{2}\\.png|items/[A-Za-z0-9_-]+\\.png|variants/logos/[A-Za-z0-9_-]+\\.png|variants/(?:glasses|heartGlasses)\\.png)$#', $relative) === 1;
$metadata = str_ends_with($relative, '.json');
if (!$baseAsset && !$metadata) {
    $state = wardrobe_state((int)$user['id']);
    if ($state === null || !in_array($relative, $state['assets'] ?? [], true)) fail(403, 'asset_not_active');
}

header('Cache-Control: private, max-age=31536000, immutable');
header('Vary: Cookie');
if (($_SERVER['OMEGA_X_ACCEL'] ?? '') === '1') {
    header('X-Accel-Redirect: /_omega_assets/' . implode('/', array_map('rawurlencode', explode('/', $relative))));
    exit;
}
$types = ['json' => 'application/json', 'moc3' => 'application/octet-stream', 'png' => 'image/png'];
$size = filesize($target);
if ($size === false) fail(500, 'asset_unavailable');
header('Content-Type: ' . ($types[strtolower(pathinfo($target, PATHINFO_EXTENSION))] ?? 'application/octet-stream'));
header('Content-Length: ' . $size);
header('Last-Modified: ' . gmdate('D, d M Y H:i:s', filemtime($target)) . ' GMT');
if ($method === 'HEAD') exit;
readfile($target);
