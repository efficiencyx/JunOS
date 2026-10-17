<?php

// CLI only, same reason as consolidation-worker.php. one HTTP hit
// would park an fpm child in here for up to half an hour.
if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }

require_once __DIR__ . '/lib/bootstrap.php';

// load her NOW so the first message doesn't sit through the cold
// load (~2 min on a 12B). it lives here and not in the ollama
// entrypoint because only php knows the num_ctx (context window
// size) chat will send, and ollama treats a different num_ctx as
// a different runner. so a warm at the wrong one gets thrown out
// and reloaded on the first message anyway. worse than nothing.
//
// safe to run twice at once (php-entrypoint.sh and start.sh both
// do on a staged boot). ollama loads once and the second call
// just waits for it. once she's loaded it comes back instantly.

const PREWARM_PULL_WAIT_S = 900;
const PREWARM_LOAD_TIMEOUT_S = 900;

function prewarm_say(string $line): void {
    fwrite(STDOUT, "[prewarm] $line\n");
}

function prewarm_model_pulled(string $model): bool {
    foreach ((ollama_api_json('/api/tags')['models'] ?? []) as $entry) {
        if (ollama_model_name((string)($entry['name'] ?? '')) === ollama_model_name($model)) return true;
    }
    return false;
}

// a failed load comes back as {"error": ...} with a 500, a
// timeout as nothing at all. only done:true means she's in.
function prewarm_load(string $model, int $ctx): string {
    prewarm_say("loading $model at num_ctx $ctx...");
    $res = ollama_api_json('/api/generate', [
        'model' => $model,
        'prompt' => '',
        'stream' => false,
        'keep_alive' => -1,
        'options' => ['num_ctx' => $ctx],
    ], PREWARM_LOAD_TIMEOUT_S);
    if (!empty($res['done'])) return '';
    return (string)($res['error'] ?? 'no answer from ollama within ' . PREWARM_LOAD_TIMEOUT_S . 's');
}

// llama.cpp gets preloaded by start.sh / start.ps1, openrouter has
// nothing to load
if (ai_provider() !== 'ollama') exit(0);

$model = default_chat_model();

// on a first boot the entrypoint is still pulling (8 GB for the
// 12B) and with MTP on, jun-mtp only exists once the drafter is
// in too. default_num_ctx() also needs the weights listed or it
// sizes the context off RAM instead of VRAM and we warm the
// wrong runner again.
// a drafter pull that failed means jun-mtp never shows up, and
// chat falls back to the base model on the 404 it gets instead.
$deadline = time() + PREWARM_PULL_WAIT_S;
$said = false;
while (!prewarm_model_pulled($model)) {
    if (time() >= $deadline) {
        $fallback = ollama_mtp_fallback_model($model);
        if ($fallback !== '' && prewarm_model_pulled($fallback)) {
            prewarm_say("$model never showed up, warming $fallback instead");
            $model = $fallback;
            break;
        }
        prewarm_say("gave up, $model still isn't in ollama after " . PREWARM_PULL_WAIT_S . "s. she loads on the first message instead");
        exit(1);
    }
    if (!$said) {
        prewarm_say("waiting for $model to finish pulling...");
        $said = true;
    }
    sleep(5);
}

$ctx = default_num_ctx();
$err = prewarm_load($model, $ctx);

// the drafter's CUDA buffer is the first thing to fail on a
// crowded card, and chat.php falls back to the base model when
// that happens. so warm what chat is going to end up on.
$fallback = $err !== '' ? ollama_mtp_fallback_model($model) : '';
if ($fallback !== '') {
    prewarm_say("$model failed ($err), trying $fallback");
    $model = $fallback;
    $err = prewarm_load($model, $ctx);
}

if ($err !== '') {
    prewarm_say("failed: $err");
    exit(1);
}
prewarm_say("$model loaded");
