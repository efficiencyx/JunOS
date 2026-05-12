<?php
header('Content-Type: application/json');
header('Cache-Control: no-cache');

$ollamaUrl = rtrim(getenv('OLLAMA_URL') ?: 'http://localhost:11434', '/');
$ch = curl_init($ollamaUrl . '/api/tags');
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
curl_setopt($ch, CURLOPT_CONNECTTIMEOUT, 5);
curl_setopt($ch, CURLOPT_TIMEOUT, 10);
$res = curl_exec($ch);
if ($res === false) {
    http_response_code(502);
    echo json_encode(['error' => 'ollama unreachable: ' . curl_error($ch)]);
    curl_close($ch);
    exit;
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
