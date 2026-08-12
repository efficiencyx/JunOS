<?php
// Backend for the dev HUD. how much VRAM and RAM the loaded model takes, from
// Ollama /api/ps, plus host memory. the HUD asks every few seconds while it is
// open so keep this cheap and Never fatal, if something upstream hiccups we
// give back the half we got and not an error page.
require_once __DIR__ . '/_lib.php';

header('Content-Type: application/json');
header('Cache-Control: no-store');

require_user();
rate_limit('stats', 60, 60);

$out = ['models' => [], 'vram_bytes' => 0, 'ram_model_bytes' => 0, 'host' => null];

// /api/ps is an Ollama thing. with any other chat provider there is nobody to
// ask, and no reason to pay the connect timeout on every HUD poll, so we just
// report host memory.
$res = false;
if (ai_provider() === 'ollama') {
    $ollamaUrl = rtrim(env_str('OLLAMA_URL', 'http://localhost:11434'), '/');
    $ch = curl_init($ollamaUrl . '/api/ps');
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_CONNECTTIMEOUT, 3);
    curl_setopt($ch, CURLOPT_TIMEOUT, 5);
    $res = curl_exec($ch);
    curl_close($ch);
}

if ($res !== false) {
    $data = json_decode($res, true);
    if (is_array($data) && isset($data['models']) && is_array($data['models'])) {
        foreach ($data['models'] as $m) {
            $size = (int)($m['size'] ?? 0);
            $vram = (int)($m['size_vram'] ?? 0);
            $out['vram_bytes'] += $vram;
            $out['ram_model_bytes'] += max(0, $size - $vram);
            $out['models'][] = [
                'name'    => (string)($m['name'] ?? ''),
                'size'    => $size,
                'vram'    => $vram,
                'quant'   => (string)($m['details']['quantization_level'] ?? ''),
                'params'  => (string)($m['details']['parameter_size'] ?? ''),
                'context' => (int)($m['context_length'] ?? 0),
            ];
        }
    }
}

// Host or container memory out of /proc/meminfo, in kB. with no cgroup memory
// cap this is the host box, which is what "system RAM" means when you run it
// yourself.
$meminfo = @file_get_contents('/proc/meminfo');
if ($meminfo !== false) {
    $kv = [];
    foreach (explode("\n", $meminfo) as $line) {
        if (preg_match('/^(\w+):\s+(\d+)/', $line, $mm)) $kv[$mm[1]] = (int)$mm[2] * 1024;
    }
    if (isset($kv['MemTotal'])) {
        $total = $kv['MemTotal'];
        $avail = $kv['MemAvailable'] ?? ($kv['MemFree'] ?? 0);
        $out['host'] = ['total' => $total, 'used' => max(0, $total - $avail), 'avail' => $avail];
    }
}

echo json_encode($out);
