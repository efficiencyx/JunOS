<?php
require_once __DIR__ . '/_lib.php';

header('Content-Type: application/json');
header('Cache-Control: public, max-age=10');

rate_limit('models', 30, 60);

$ollamaUrl = rtrim(env_str('OLLAMA_URL', 'http://localhost:11434'), '/');
$ch = curl_init($ollamaUrl . '/api/tags');
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
curl_setopt($ch, CURLOPT_CONNECTTIMEOUT, 5);
curl_setopt($ch, CURLOPT_TIMEOUT, 10);
$res = curl_exec($ch);
if ($res === false) {
    log_event(['msg' => 'ollama_tags_error', 'err' => curl_error($ch)]);
    curl_close($ch);
    fail(502, 'upstream_unavailable');
}
curl_close($ch);

$data = json_decode($res, true);
$models = [];
if (is_array($data) && isset($data['models']) && is_array($data['models'])) {
    foreach ($data['models'] as $m) {
        if (isset($m['name'])) $models[] = $m['name'];
    }
}
echo json_encode(['models' => $models]);
