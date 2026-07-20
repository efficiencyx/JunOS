<?php
// Dev HUD backend: loaded-model VRAM/RAM footprint (Ollama /api/ps) + host memory.
// Polled every few seconds while the HUD is open, so keep it cheap and never fatal -
// any upstream hiccup returns the half we could gather, not an error page.
require_once __DIR__ . '/_lib.php';

header('Content-Type: application/json');
header('Cache-Control: no-store');

require_user();
rate_limit('stats', 60, 60);

$out = ['models' => [], 'vram_bytes' => 0, 'ram_model_bytes' => 0, 'host' => null];

// /api/ps is Ollama-specific; with a non-Ollama chat provider there's nothing
// to ask (and no point paying the connect timeout on every HUD poll) - report
// host memory only.
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

// Host/container memory from /proc/meminfo (kB). Without a cgroup memory cap this
// reflects the host box, which is what "system RAM" means for a self-hosted setup.
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
