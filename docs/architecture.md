# Jun OS architecture

This document is the long-form reference for the system. For a quick orientation see the README.

---

## Component diagram

```
                          ┌─────────────────────────────────────────────────┐
                          │  Docker network: omega                          │
                          │                                                 │
  ┌──────────┐  HTTP/SSE  │  ┌─────────┐  FastCGI  ┌──────────┐             │
  │          │ ────────── │─▶│  nginx  │ ─────────▶│ php-fpm  │             │
  │ Browser  │            │  │ :80/443 │           │   :9000  │             │
  │          │◀────────── │──│         │           └────┬─────┘             │
  └──────────┘            │  │  static │                 │  HTTP            │
                          │  │  files  │                 ├──────────────── ▶│ ollama :11434  (profile=ollama)
                          │  └─────────┘                 ├──────────────── ▶│ llamacpp :8080 (profile=llamacpp)
                          │                              ├──────────────── ▶│ tts :8001      (profile=voice)
                          │                              └──────────────── ▶│ karaoke :8001  (profile=karaoke)
                          └─────────────────────────────────────────────────┘

  Volumes: ollama_data, llamacpp_cache, tts_cache, karaoke_cache, omega_state, letsencrypt, certbot_webroot, selfsigned
  Profiles are derived by start.sh from .env: AI_PROVIDER picks ollama or llamacpp (unless OLLAMA_URL /
  LLAMACPP_URL point at a server of your own, or AI_PROVIDER is openrouter / vllm), VOICE=on adds voice,
  KARAOKE=on adds karaoke. An ollama/llamacpp in .env's COMPOSE_PROFILES is ignored for that reason.
  Optional (profile=prod): certbot sidecar for Let's Encrypt issuance + renewal
```

nginx serves static files from `/var/www/omega/` and FastCGI-proxies `*.php` requests to the php-fpm container. The php-fpm pool is `pm = ondemand` with `pm.max_children = 16` (`docker/php.Dockerfile`): chat streams, TTS calls and karaoke splits each hold a worker for as long as they run, and the stock 5-worker pool let karaoke plus voice mode queue every other API call behind them. The model servers and the audio sidecars are internal-only; their ports are not published to the host. The voice sidecar on `:8001` fronts two swappable engines, Kokoro-82M (default) and kyutai pocket-tts, selected per request. `VOICE=off` drops the `voice` compose profile so the `tts` container is never started; on bare-metal Windows the same variable stops `start.ps1` spawning the sidecar process. Either way php and the frontend degrade gracefully to text-only whenever the sidecar is absent or unhealthy.

Karaoke stem separation runs the *same* `tts/server.py` in a second container (`profiles: [karaoke]`, `SIDECAR_ROLE=karaoke`) built from `docker/karaoke.Dockerfile`: demucs and a CUDA/ROCm torch, no Kokoro or pocket-tts. The split exists so the two can want different hardware - separation is minutes on CPU versus seconds on a GPU, while voice synthesis is real-time on CPU and a GPU copy would only take VRAM away from the LLM. Each image installs only its own dependencies, and the `stt_available()`/`sep_available()` probes in `tts/sidecar/stt.py` and `tts/sidecar/karaoke.py` turn a missing one into a 503 rather than a crash, so the shared code is safe in both roles. Bare-metal installs (Windows, Colab) run a single process that serves both, which is why `api/karaoke.php` falls back to `TTS_URL` when `KARAOKE_URL` is unset.

The browser side has no build step: `webapp/js` is plain ES modules, every import carrying a `?v=` cache-buster, with the vendored libraries as classic scripts. On the chat page `js/app.js` is only the auth gate. Signed out, it draws the login screen from a handful of modules. Signed in, it loads the vendor scripts and `js/app/main.js` side by side and calls `boot()`. The date, wardrobe and karaoke pages have their own entries (`date.js`, `wardrobe.js`, `karaoke-page.js`) and share the feature folders: `core/`, `live2d/`, `outfit/`, `wardrobe/` (the shop UI, which only `wardrobe.html` loads), `mods/`, `voice/`, `karaoke/` and `trip/`.

On a multi-GPU host the launcher decides which card the model server gets: `start.sh` orders the GPUs by VRAM and passes that order down as `CUDA_VISIBLE_DEVICES` (or the ROCm/Vulkan equivalents), so the largest card is device 0, and `TENSOR_PARALLEL=on` additionally lets one model span every card. See [configuration.md](configuration.md) §8 for the full set of knobs and the derived variables.

---

## Streaming pipeline

```
Browser
  POST /api/chat.php
       │
       ▼
  chat.php (php-fpm)
       │  injects system_prompt.txt (static, byte-identical every turn)
       │  strips client system role
       │  appends the "live context" inside the LAST user turn, after the
       │  question itself (clock, lore facts, story so far, memory notes,
       │  wardrobe, gauges) so the static prefix + history stay in Ollama's KV
       │  prompt cache between turns. tools/build_dataset_v6.py trains this exact
       │  order, question first then the block, so it is not free to swap.
       │  dead last, after everything: "\n\n<think:LEVEL>" (low/med/high), the
       │  reasoning budget token tools/build_dataset_v7.py trained. nothing may
       │  be appended to the user turn past it
       │
       │  curl CURLOPT_WRITEFUNCTION ──────── NDJSON stream ──────▶ ollama /api/chat
       │  (per-chunk callback)                                       (HTTP/1.1, streaming)
       │
       │  for each NDJSON chunk:
       │    extract token from JSON
       │    echo 'data: {"token":"..."}\n\n'
       │    flush()
       │
       │  a tool call ends the round: run it server-side, append the result as
       │  a tool message, stream another round (3 max)
       │
       │  after the stream ends: parse the hidden [A:mood_shift|...] tag from
       │  the full reply, clamp+apply its affection/trust/tension deltas to the
       │  user's row, and strip the tag before the message is stored (on the
       │  wire it is an action tag like any other, and actions.js drops it
       │  before it can render)
       │
       ▼
  nginx (proxy_buffering off, fastcgi_buffering off, X-Accel-Buffering: no)
       │
       ▼  text/event-stream, Transfer-Encoding: chunked
  Browser SSE
```

### NDJSON to SSE conversion

The PHP `CURLOPT_WRITEFUNCTION` callback receives raw bytes from the Ollama HTTP response. These arrive as newline-delimited JSON objects, one per `ollama` token batch. The callback buffers incomplete lines, then for each complete line decodes the JSON, extracts `message.content`, and emits one SSE frame.

The three critical headers that ensure tokens arrive incrementally rather than buffered:

- **`proxy_buffering off`**: prevents nginx from accumulating the FastCGI response
- **`fastcgi_buffering off`**: prevents nginx's FastCGI module from buffering the upstream
- **`X-Accel-Buffering: no`**: hint consumed by nginx and some CDN layers

Without all three, tokens may arrive in one batch at end-of-message even though the server is streaming them correctly.

---

## AI providers

`chat.php` serves one SSE contract to the browser regardless of backend. `webapp/api/lib/providers/` owns the upstream request and streaming dialect selected by `AI_PROVIDER`:

- **`ollama`** (default): Ollama's native `/api/chat`, NDJSON stream, one JSON object per line.
- **`openrouter`** / **`llamacpp`** / **`vllm`**: an OpenAI-compatible `/chat/completions` endpoint with `data: {...}` SSE lines. `vllm` exists for TPUs, which Ollama and llama.cpp can't drive; it takes the same `chat_template_kwargs.enable_thinking` switch as llama.cpp and gets its context window from the `max_model_len` in `/v1/models` (`webapp/api/lib/providers/vllm.php`). Unlike Ollama and llama.cpp, which stop when the window fills, vLLM rejects a request whose `max_tokens` plus prompt exceeds `max_model_len`, so `vllm_fit_max_tokens()` clamps it on both the streaming and the one-shot path, counting the prompt at 3 bytes a token to stay on the safe side.

`provider_stream_round()` parses either upstream shape and returns normalized content, tool calls, usage, completion state, and errors. It emits normalized `token` and `thinking` events through the callback supplied by `chat.php`, so conversation orchestration does not depend on either wire format.

`webapp/api/models.php` lists models from whichever provider is active: Ollama's `/api/tags`, or an OpenAI-style `/models` call for OpenRouter/llama.cpp/vLLM (minus the title model). OpenRouter's catalog (~1-2 MB) is disk-cached for 1 hour (`state_dir()/openrouter_models.json`) and served stale on upstream errors rather than failing the boot-time poll.

### Model server on another machine

`OLLAMA_URL`, `LLAMACPP_URL` and `VLLM_URL` can point off this box. `model_server_is_remote()` (`providers/config.php`) treats anything but loopback, the compose service names and `host.docker.internal` as remote, and three things change: `gpu_ctx_headroom_mb()` returns 0 because `OMEGA_GPU_VRAM_MB` describes this machine's card (so Ollama's `num_ctx` comes from `OMEGA_NUM_CTX` or the RAM tiers), the partial-offload refit doesn't run, and karaoke doesn't evict her before demucs, since her VRAM isn't the card demucs is about to use. `start.sh` adds no model server profile and `start.ps1` skips installing, starting and pulling Ollama. `OLLAMA_API_KEY` / `VLLM_API_KEY` go out as `Authorization: Bearer` on every call, `ollama_api_json()` included.

`colab.ipynb` in inference-only mode is the main user of this. On the notebook side the model server (Ollama on a GPU, vLLM on a TPU) stays on loopback. `tools/inference-gate.py` sits in front of it on `:8003`: a stdlib reverse proxy that checks the bearer token in constant time, allows only the read and chat endpoints (no `/api/pull`, `/api/delete`, `/api/create`), caps bodies at 32 MiB, and re-streams the response chunked with `Cache-Control: no-transform` so Cloudflare doesn't compress and hold the NDJSON until the reply ends. A `cloudflared` quick tunnel (pinned release, sha256-checked) exposes the gate on a `*.trycloudflare.com` URL. The token is 64 hex characters from `secrets.token_hex`, new each time Step 3 runs, passed to the gate through the environment rather than argv. Kaggle has no equivalent of Colab's `proxyPort`, so there the notebook is always inference-only.

Because the tunnel URL and token change on every run, the launchers check the link before booting. `start.sh` (`check_cloud_link()`) and `start.ps1` (`Get-CloudLink`/`Test-CloudLink`) take `VLLM_URL` with `AI_PROVIDER=vllm`, or an `OLLAMA_URL` that isn't loopback or a compose name, and send `GET /v1/models` or `/api/tags` with the bearer key, 8 s timeout. When that fails (dead tunnel: DNS error or Cloudflare 530; stale key: the gate's 401), or `AI_PROVIDER=vllm` has no URL at all, they read the lines Step 3 printed from the terminal and write them to `.env`. Only the nine names the notebook prints get in (`AI_PROVIDER`, `OLLAMA_URL`, `OLLAMA_API_KEY`, `OLLAMA_MODELS_TO_PULL`, `TITLE_MODEL`, `OMEGA_NUM_CTX`, `VLLM_URL`, `VLLM_API_KEY`, `VLLM_MODEL`); the same list is in `install.sh`, `install.ps1`, `installer-gui.ps1` and `jun-manager.ps1`. Without a terminal (the installer piping `start.sh`, the manager running `start.ps1` hidden) they only warn. The manager does the check itself before Start, shows a paste box, and sets `JUN_LINK_CHECKED=1` so `start.ps1` doesn't probe again. `start.sh link` / `start.ps1 link` and the manager's **Notebook link** button take new lines without a probe, which is how an install that runs her locally switches over.

The installers' third mode, **Cloud** (`JUN_CLOUD=1`), is Express without a model: it asks for the same lines, writes `AI_PROVIDER` and `COMPOSE_PROFILES=` with no model server profile, skips the model, tensor parallel and MTP questions, clears `OLLAMA_MTP` (a remote Ollama has no `jun-mtp`), and still asks about voice and karaoke. With no lines yet it writes `AI_PROVIDER=vllm` with an empty `VLLM_URL`, which starts nothing, rather than `ollama` with the compose default, which would pull her into a local Ollama. It refuses to hand off to a checkout whose installer doesn't mention `JUN_CLOUD`, since an older one would read the `JUN_YES=1` it inherits as plain Express.

On a TPU the notebook installs `vllm-tpu` into its own venv (it pins its own jax and torch, which would break the kernel's), picks the repo (`TPU_Model` `auto`: the bf16 12B from 24 GiB of HBM up, else the compressed-tensors INT8 W8A8 build), checks the safetensors size against the TPU memory jax reports before downloading, and serves the repo as `--served-model-name jun` with the `gemma4` reasoning and tool-call parsers and multimodal inputs disabled. Tensor parallelism is the chip count when that is 1, 2, 4 or 8. On a 16 GB chip (v5e-1) it adds `--gpu-memory-utilization 0.985 --kv-cache-dtype fp8 --max-num-seqs 4`, measured to be the only band where the 12.1 GiB of INT8 weights, a 6144-token cache and the compiled step all fit: 0.98 leaves the cache short of 6144, 0.99 leaves no room to load the step. The 12B safetensors repos carry `vision_config.num_soft_tokens` (280) because vLLM 0.30's `gemma4_unified` reads it and no transformers release defines it, and they keep the pre-5.17 config layout because transformers 5.17 writes a `per_layer_config` vLLM 0.30 can't read.

### Reasoning

The Settings drawer has a reasoning level (`auto`/`low`/`medium`/`high`) and a "Think" toggle that turns the chain of thought on and streams it to the thought pane. Under `auto` the toggle is ignored and `route_reasoning()` decides both per message from cheap surface signals (analytical verbs, arithmetic or "how many" phrasing, two or more questions, 25+ words): no signal is `low` without thinking, one is `medium`, two or 60+ words is `high`; idle nudges are always `low`. The settled level reaches the model two ways at once: as the `<think:LEVEL>` token appended dead last to the user turn (`medium` is spelled `med` there, because that is what `tools/build_dataset_v7.py` trained), and as a provider option - `reasoning.effort` for OpenRouter, `options.reasoning_effort` for Ollama, nothing extra for llama.cpp.

The Ollama branch has a trap: **thinking is requested by omitting `think`, never by sending `think: true`.** The Jun GGUFs advertise only `tools` and `completion`, so an explicit `think: true` fails Ollama's capability check with HTTP 400 before rendering; with `reasoning_effort` set alone the model thinks fine and returns a populated `message.thinking`. `think: false` is only ever added to *suppress* reasoning. Not every quant splits its reasoning out either - `Jun-LoRA-v4-12B-GGUF:Q4_K_M` streams literal `<think>…</think>` inside `content` - so `provider_route_think_token()` re-routes anything inside a `<think>` block to the `thinking` event in both stream parsers, holding a partial tag across chunks, so storage, action parsing and TTS only ever see dialogue. Generation is capped at `THINK_MAX_TOKENS` (16384) for a thinking turn and `PLAIN_MAX_TOKENS` (512) for a plain one on every provider. The plain cap is that high because the v7 fine-tunes write a trace on every turn, even at `<think:low>` (~115 tokens median, ~165 max). `think: false` only makes Ollama discard it; the tokens still count against `num_predict`, and under the old 128 she often never reached the reply (`reply_truncated_in_thinking`). She also sometimes writes the whole reply inside the thought channel and stops without closing it; the gemma4 parser files it all as thinking, `think: false` drops it, and the round comes back empty with `done_reason: stop`. `chat.php` re-rolls such a round once on think-off turns (`empty_round_reroll` in the log), since nothing reached the browser yet. On Ollama the `gemma4-large` pin on `jun-mtp` (see MTP below) stops it at the source, the re-roll stays for llama.cpp and for the round after a tool result, where no renderer adds the empty block. Omitting `think` to rescue the text is not an option, it adds `<|think|>` to the prompt.

### Stream ceilings

`provider_stream_round()` bounds every upstream call: one wall-clock deadline per request (`OMEGA_TURN_TIMEOUT_S`, default 900, floor 30 - each tool round gets what is left), an idle hangup when nothing arrives for `OMEGA_STREAM_IDLE_S` (default 300, floor 10, generous because a cold CPU load is minutes of silence), and byte caps that abort the transfer: 1 MiB pending frame or 4 MiB of content (`upstream_overflow`), 64 KiB of error body (`upstream_error`). A browser that disconnects mid-stream aborts the upstream transfer too.

### Failure handling and MTP

llama.cpp tool support is gated by `LLAMACPP_TOOLS` (`provider_tools_enabled()` in `lib/providers/config.php`) since not every chat template handles tool calling. Independent of that flag, `chat.php` has a runtime fallback: if the first streamed round comes back as an HTTP 4xx from an OpenAI-style provider, it strips `tools` from the payload and retries the same round once before giving up - this is what recovers automatically from a llama-server template that rejects the `tools` field.

Multi-token prediction (MTP) runs the chat model with a small Gemma 4 drafter that proposes the next few tokens for the main model to verify in one pass; output is unchanged, only the timing. With Ollama, `docker/ollama-entrypoint.sh` pulls the drafter named by `OLLAMA_MTP` and builds a derived model (`OLLAMA_MTP_MODEL`, default `jun-mtp`) from a Modelfile with a `DRAFT` layer and `draft_num_predict` (`OLLAMA_MTP_N_MAX`) baked in; `default_chat_model()` then serves that twin. For a 12B/26B/31B base the Modelfile also pins `RENDERER gemma4-large`. Ollama sizes the gemma4 renderer off the model name first (`e2b`/`e4b` small, `12b`/`26b`/`31b` large) and only then off the parameter count with a 12B cutoff, so `jun-mtp`, with no size in its name and 11.9B on paper, got `gemma4-small` while the `hf.co` model it's built from gets large. The two render byte-identically except that large ends a think-off prompt on an already-closed empty `<|channel>thought\n<channel|>`. Under small she opened the thought channel herself on think-off turns and now and then never closed it, which left an empty reply. On the 250 held-out v8 eval questions at think-off, large took empty replies from 7.6% to 0 and mean output from 134 to 50 tokens, but she calls a needed tool less often (24/117 vs 41/117) since the hidden trace she wrote under small carried the `Tool check:` line, and v8 has only 7 think-off rows with a call. E2B/E4B bases get no line and keep Ollama's own choice. `mtp-autotune.sh`/`.ps1` apply the same rule. With llama.cpp, `docker/llamacpp-entrypoint.sh` (or `start.ps1`) writes `spec-type = draft-mtp`, `spec-draft-hf` and `spec-draft-n-max` into the default model's router preset when `LLAMACPP_MTP` is set; a blank value is simply a line it doesn't write, which is what the old `docker-compose.llamacpp-mtp.yml` overlay existed to fake. `mtp-autotune.sh`/`.ps1` measures depths 1-4 against plain decoding with the real system prompt and writes the winner, stamping `MTP_TUNED_GPU` so the launchers re-tune after a GPU change. Because the drafter's own CUDA buffer can fail to allocate on a crowded card, Ollama HTTP errors are handled in the same round loop as the OpenAI ones: `ollama_mtp_fallback_model()` returns the base model when the failing model is the MTP twin, and chat.php, titling, compaction and consolidation (via `provider_post_chat()`) all retry once against it before surfacing an error.

### Pre-warm

`webapp/api/prewarm.php` (CLI only, 404s over HTTP like the consolidation worker) loads the default chat model before the first message, so nobody waits through the cold load. It sits in php and not in the Ollama entrypoint because Ollama treats a different `num_ctx` as a different runner, and only php knows the value chat sends (`default_num_ctx()`: `OMEGA_NUM_CTX`, else VRAM headroom, else RAM tiers). A warm at any other context gets thrown out and reloaded by the first message. The script waits up to 15 min for `default_chat_model()` to show up in `/api/tags` (the entrypoint may still be pulling, and `jun-mtp` only exists once the drafter is in), then sends an empty `/api/generate` with `keep_alive: -1` and that `num_ctx`. It follows chat's MTP fallback: when the twin fails to load, or never appears, it warms the base model instead. It exits non-zero on failure and prints `[prewarm]` lines. `docker/php-entrypoint.sh` starts it in the background on every php container start (output in `docker logs omega-php`), `start.sh` runs it in the foreground on a staged boot so karaoke's CUDA torch only starts once she is on the card, `install.sh` runs it as a visible step once `docker/ollama-entrypoint.sh` prints `models ready`, `start.ps1` starts it as the tracked `prewarm` process (`runtime\logs\prewarm.log`) and Colab writes `/content/prewarm.log`. Two runs at once are harmless: Ollama loads once and the second request waits for it. llama.cpp is preloaded by `start.sh`/`start.ps1` instead, and the script exits 0 for any provider other than Ollama.

### llama.cpp in router mode

The managed `llama-server` runs in router mode: one server, a preset file, every model loaded on demand as its own child process. `docker/llamacpp-entrypoint.sh` (Docker) and `Write-LlamacppPresets` in `start.ps1` (Windows) write the same INI from `.env` on every start: one section per `LLAMACPP_MODEL_HF` entry (or the `LLAMACPP_MODEL_FILE` alias), plus the `TITLE_MODEL` on the CPU (`n-gpu-layers = 0`, `ctx-size = 2048`), with `--models-max 2`. Chat presets carry `override-kv = gemma4.context_length=int:16384`, `fit-ctx = 6144` and `fit-target = 2048` instead of a `ctx-size`, because llama.cpp's `--fit` only adjusts what is left unset: a pinned context makes it push layers onto the CPU, an unset one under a 16k ceiling makes it shrink the context first, which matches Ollama's VRAM tiers. `OMEGA_NUM_CTX` turns into a plain `ctx-size`. This llama.cpp build caches `-hf` downloads in the HF hub layout under `HF_HOME`, which compose points inside the `llamacpp_cache` volume because the container's root is read-only.

`webapp/api/lib/providers/llamacpp.php` talks to the router's management endpoints: `/v1/models` for each model's `loaded`/`loading`/`unloaded` state, `/props?model=` for the real `n_ctx` (`llamacpp_window_tokens()`, capped at 16384 or `OMEGA_NUM_CTX`) and `modalities.audio` (asking about an unloaded model loads it), `/models/unload` before switching chat models and before karaoke separation, and `llamacpp_title()` for chat titles. Thinking uses `chat_template_kwargs.enable_thinking` set to the same `$think` Ollama gets as `think`; the GGUF jinja with `enable_thinking: X` renders byte-identically to Ollama's `gemma4-small` renderer with `think: X` (checked against the real Ollama 0.32.6 renderer), and `provider_stream_round()` drops `reasoning_content` on turns that asked for none, as Ollama does. `start.sh` loads the default model right after `up` (`load_llamacpp`), waits for it before starting karaoke, and reports the backend's devices from `llama-server --list-devices`.

`ollama_evict_if_partially_offloaded()` runs before each chat payload is built: if `/api/ps` shows the pinned model with less than 90% of its weights in VRAM it evicts it (once per 600 s) so the next load can re-fit, but only when `gpu_ctx_headroom_mb()` says the weights could fit at all.

---

## Action extraction state machine

`makeStreamBuffer` in `webapp/js/app/stream-filters.js` (driven by `runChat` in `app/chat.js`) is a streaming state machine that intercepts action tags before they reach the chat renderer. Two syntaxes are recognized: the compact `[A:name|value|value]` form the prompt now asks for (positional values, mapped to kwargs via the `POS_KEYS` table in `live2d/actions.js`, with omitted kwargs filled from `DEFAULTS`), and the legacy `[ACTION:name|key=value|...]` form still present in stored history and the fine-tune's training data.

### States

```
PASSTHROUGH ──── sees '[' ──────▶ MAYBE_ACTION
                                       │
                          partial '[A:' (or legacy '[ACTION:') matched ──▶ IN_MARKER
                                       │
                          partial does not match ──▶ flush held bytes, PASSTHROUGH
                                                          │
                          IN_MARKER: sees ']' ──▶ parse + dispatch, PASSTHROUGH
                          IN_MARKER: no ']' but buffer growing ──▶ stay in IN_MARKER
```

### Partial marker holdback

The marker is `[A:` (or the legacy `[ACTION:` / `[ACTIONS:`). While in `PASSTHROUGH`, any trailing bytes that could be the start of a marker are held in a lookahead buffer rather than emitted. This means:

- A lone `[` at the end of a token chunk is held until the next token confirms or denies it.
- If the next token continues into `A:` / `ACTION:`, the machine transitions to `IN_MARKER` and the held bytes are discarded (never shown to the user).
- If the next token does not continue the marker pattern, the held bytes are flushed to the chat renderer.

This gives zero false positives in the rendered text: action tags never appear as visible characters.

### Dispatch timing

When a closing `]` is received, the bracketed text is immediately passed to `Actions.parseActions`. The return value is an array of resolved action objects. Each is dispatched to `Live2D.setTarget` / `playSequence` / `startLoop` **before the rest of the message has finished streaming**. This is what makes the character react in sync with words being generated.

Tags are transient. `applyAction` holds every param a tag set for `HOLD_MS[name]` (default 6 s, 2 to 4 s for glances, tilts and gestures, 8 s for `breath`), and when the hold runs out idle eases the param back to the mood baseline. Before 2026-10-16 a tag stuck until something else overwrote it, so one `[A:look|away]` early in a reply left her staring sideways for the rest of the chat. `outfit`, `skirt_up`, `panties_aside`, `handhold` and `mood` stay where they are put. `[A:idle]` releases every hold at once.

Malformed or unrecognised tags are logged to the debug panel and silently dropped. `mood_shift` is dropped on purpose: `actions.js` returns null for it because `chat.php` owns that tag (see [Relationship state](#relationship-state)).

### Name templating stage

The clean text emerging from the action buffer passes through a second streaming filter, `makeNameFilter` in the same `stream-filters.js`, before it reaches the chat renderer and TTS. It resolves `{f_playerName}` / `{f_botName}` placeholders to the user's chosen names (via `webapp/js/core/names.js`). Like the action marker holdback, it buffers a trailing *partial* placeholder across token chunks, so a split like `"{f_play"` + `"erName}"` substitutes cleanly and never flashes its raw form in the chat or gets read aloud by TTS.

---

## Live2D engine internals

`webapp/js/live2d/live2d.js` wraps `pixi-live2d-display` with direct parameter control.

### Placeholder when the rig is missing

The rig is gitignored game art, so a fresh clone or a skipped extraction has no `webapp/assets/`. Before it creates the PIXI application, `init()` calls `GET /api/assets.php?probe`. That request is session-gated like the rest of `assets.php` and returns `{"model": bool}`, which is true only when `interaction_model.moc3` and `texture_00..02.png` are all on disk. On `model: false` no WebGL context is created and the four asset URLs are never requested. Instead `live2d/placeholder.js` mounts `webapp/placeholder/jun.svg`: a muted lavender character in glasses, a hoodie, skirt and trainers, with checker textures and dashed outlines. Her hoodie reads "Placeholder", "404", "Assets not extracted" and "Chat still works". It is mounted in `#stage`, in the same box `fitModel()` would use (0.92 margin, the 26% desktop offset on the chat page) and with the same face framing for `setCameraPreset('face')`. `init()` returns `{ paramIds: [], placeholder: true }`.

Every other entry point is a no-op from there on. The param maps are empty, so `setTarget`/`startLoop` return false. Missing-param reports are suppressed while `raw` is null. Drawable, tint and texture calls already return early without a model. `faceAnchor()` falls back to the SVG's drawn rect, so the face bubble, the date speech card and the karaoke mic still find her head and mouth. `hasModel()` gates the asset fetches that sit outside the rig: the stocking and glasses composites, the baked-tile manifest, and the wardrobe variant thumbs, which show a `?` tile instead of a broken image. Any probe answer other than an explicit `false` (a 401, a 500, a network error) falls through to the normal load, so a broken server still shows the real error.

### Disabling internal updaters

pixi-live2d-display ships motion, expression, breath, eyeBlink, physics, pose, and focusController subsystems. All are disabled after model load:

```js
model.internalModel.motionManager.destroy();
model.internalModel.expressionManager.destroy();
```

This prevents those systems from overwriting `coreModel.parameters.values` between ticks. Without this, a physics subsystem with a 1-frame lag would undo every parameter write from the action system.

### Per-frame tick order

The `tick()` function runs on every PIXI `app.ticker` frame. Order matters:

1. **Fire pending sequences**: any `{param, value, fire_at_ms}` entry whose deadline has passed is written into `targetParams`.
2. **Release expired holds**: a param whose hold has run out gets its target set back to the idle baseline (or the rig default), and a loop on it goes back to the baseline loop or fades out.
3. **Spring**: each param in `targetParams` moves its `currentValues` entry with a critically damped spring (the closed form from *Game Programming Gems 4*, the same as Unity's `SmoothDamp`), keeping a per-param velocity in `velocities`. Unlike the exponential lerp it replaced, it starts slowly instead of at full speed, and a target that changes mid-flight keeps the velocity it already had, so there is no kink. Smoothing time depends on the param: eyeballs 0.07 s, the rest of the face 0.1 s, head 0.16 s, arms and legs 0.2 s, body 0.24 s, everything else 0.12 s. Frame dt is capped at 100 ms.
4. **Write to raw params**: `raw.parameters.values[idx] = clamp(current)`.
5. **Add loops**: sine loops are *added* on top of the smoothed value, so a tremble or a breath layers over a held pose instead of replacing it. Phase is integrated (`phase += dt / period`), amplitude and period ease toward a new request over ~400 ms, and an envelope fades the loop in (450 ms) and out (600 ms).
6. **Add idle drift**: two incommensurate sines per param on `ParamHeadX/Y/Z` (at most 0.07 of -1..1), so she is never perfectly still. Head only: `ParamBodyZ` slides the whole body on this rig (0.04 is already a visible side-to-side rock, 1 is off screen). It fades in with `startIdle()` and out when idle stops or fidgets are disabled.
7. **Add head wander**: every 2.5 to 7 s idle picks a new resting head angle (`ParamHeadX` up to ±0.32, `HeadY` -0.16..0.1, a roll of `-0.3 * x` ±0.09, or near center 30% of the time) and moves there on its own critically damped spring (0.45 s). The eyes jump toward it first and come back to center as the head arrives. Additive, so a held head param only gets a third of it, and it returns to center when idle stops or fidgets are off. This replaced the old fidgets that swept `HeadX`/`HeadY` through one full sine and back.
8. **Tail and hair**: the nine `Param_Angle_Rotation_N_TailMain` params are written from a resting S-curve (`TAIL_REST`, root swung out, tip curled up, so the tail shows past her shoulder instead of standing straight up behind her torso), mirrored by a side that the `tail_side` fidget flips over ~0.7 s, plus a sine travelling root to tip. The wag strength follows a smoothed envelope of `ParamTailWiggle` (80 ms up, 900 ms down) rather than its raw absolute value, which pumped the wag twice per loop period with a kink at every zero crossing. The three `ParamHairPhysics*` sway outputs come from a spring chain anchored at `0.5 * (HeadZ + 0.3 HeadX + BodyZ) - 0.3 * d(HeadZ + HeadX)/dt`, so the hair lags a head move and swings past.
9. **Overwrite `ParamMouthOpen` for lipsync**: if `setMouthOverride` has been called (TTS audio playing), the mouth value is set from the RMS measurement, bypassing the spring so the lip track stays tight. The spring's velocity is zeroed so release starts from rest.
10. **Blink**: pulls `ParamEyeOpen` from wherever it is toward shut (75 ms ease-in close, 40 ms hold, 150 ms ease-out open). It is multiplicative on the live value, so a sleepy or squinting face blinks and comes back to the same lid height. Blinks are skipped while a sequence owns the eyes or the lids are already less than 30% open.
11. **Re-stamp forced part opacities**: the `forcedPartOpacity` Map (partId → opacity) is written straight into `raw.parts.opacities` every tick. The rig otherwise reasserts its own part opacity each frame, so a one-shot write would be clobbered; re-stamping is how the wardrobe force-shows/hides parts (e.g. the alt dress `dress1`, which has no enable param and is hidden by opacity 0 in the rig).

### Wardrobe: parts, tint, and variants

`webapp/js/outfit/` drives the wardrobe (the tables are in `catalog.js`, `apply.js` puts them on the rig, and the shop UI on top is `webapp/js/wardrobe/`) by three mechanisms, none of which touch the LLM (the current state is injected into the system prompt server-side so Jun knows what she's wearing):

- **Enable params**: most items are a param-backed boolean (`ParamShirtEnabled`, `ParamSkirtEnabled`, …) with `excludes` that force conflicting items off.
- **Forced opacity**: items with no enable param (the alt dress) are shown/hidden through the `forcedPartOpacity` re-stamp step above.
- **Recolor**: Live2D's texture sampler is wrapped at load time by injecting an `omegaTint()` helper into the fragment shader (`texture2D(s_texture0, …)` → `omegaTint(texture2D(...))`), so drawables matching a color group's patterns are tinted live without editing textures. The three base textures (`assets/texture_00..02.png`) are loaded as straight-alpha data URLs; the `variants/` PNGs (miniskirt, socks, stockings) swap in as alternate pieces.

### Loop parameters

`startLoop(paramId, amplitude, period_ms)` stores an entry in the `loops` Map. Each tick the value written is:

```
base + amplitude * sin(2π * elapsed_ms / period_ms)
```

`stopLoop(paramId)` removes the entry; the param reverts to its `targetParams` value on the next lerp tick.

### Sequence scheduling

`scheduleSequence(steps)` takes an array of `{params, dt_ms}` steps, computes an absolute `fire_at_ms` for each value and pushes them into `pendingSequences`; the tick loop fires them in order. A new sequence first drops any pending steps for the params it touches, and so does `setTarget`, so a half-played nod can no longer yank a param back after something newer set it. It returns `param -> ms until its last step`. `playSequence(steps)` (anim.js) schedules and then holds each param until its last step plus 300 ms; tags and fidgets use it, so a sequence ends by easing back to the idle baseline instead of parking on its last absolute value.

### Idle animation

`startIdle()` writes the mood baseline and starts the blink and fidget timers:

- **Baseline**: `applyMoodBaseline()` derives brows, ears, eye opening, blush, mouth form and the `ParamBodyY` breathing loop from the relationship gauges and the time of day. It records what it wants in `baseTargets` / `baseLoops` and only writes params nobody is holding; a held param goes to its baseline when the hold ends.
- **Blink**: a `setTimeout` chain, every 2.2 to 6.2 s, sometimes doubled. See step 10 above.
- **Fidget**: a `setTimeout` chain, every 1.4 to 6 s depending on mood tier and time of day, that makes a weighted pick from `FIDGETS` (`weight`, default 1, doubled for entries limited by `moods:` or `parts:`). Kinds: `loop` (a short additive oscillation, held for its duration), `pose` (a held target: leg weight shifts, shoulder rolls, single ear twitches), `seq` (via `playSequence`: a sigh, the mood and time-of-day ones), `glance` (a saccade: the eyes jump to a random point and the head follows about a fifth of the way on its slower spring) and `tail_side`. A fidget whose params a tag is still holding is skipped. `ParamArmLUp`/`ArmRUp` only appear in the happy wave (weight 0.03, a few times an hour of happy idle at most) and the morning stretch: on this rig 0.25 already swings the arm out at hip height and reads as a wave starting.
- **Wander**: step 7 above.
- **Drift**: step 6 above.

`resetIdle()` drops every hold and pending step, sets every non-wardrobe target back to the rig default and fades the loops out. It does not restart idle; callers that want idle to resume must follow with `startIdle()`.

### Rig parameter ranges

The interaction model does not use the stock Cubism ranges, and values outside a range are silently clamped. `ParamEyeOpen` is -1 (shut) to 0 (open), so writing 1 for "open" and 0 for "closed" leaves the eyes open either way, which is how `close_eyes`, `sleepy`, the yawn and the night droop did nothing until 2026-10-16. `ParamHeadX/Y/Z` are -1..1 (`HeadZ` -1 is a roll of about 25 degrees, and the face deforms visibly past about 0.5), `ParamBrowLRot/RRot` are -30..30, `ParamMouthOpen` is -1..2, `ParamBlush` 0..2, `ParamArmL/RGesture` 1..3. There is no `ParamAngleX/Y/Z` or `ParamBodyAngleX`. `Live2D.debugParam(id)` prints a param's min, max, default, target, live value, velocity and remaining hold.

### `getRaw` quirk

The pixi-live2d-display wrapper exposes the Cubism core model in different shapes depending on the SDK version loaded. `getRaw(model)` probes three locations (`coreModel`, `coreModel._model`, and arbitrary keys) to find the object with `.parts.ids`. This probe must not be replaced with a direct property access.

---

## TTS pipeline

`webapp/js/voice/tts.js` accumulates tokens from the stream's `onCleanText` callback (action tags have already been stripped before this callback fires) and builds a sentence queue.

### Sentence accumulation

Tokens are appended to a buffer. When a sentence-ending character (`.`, `!`, `?`, `\n`) is seen and the accumulated text is non-trivial, the sentence is pushed to the synthesis queue and the buffer is reset.

### Parallel synthesis, ordered playback

Each queued sentence triggers an immediate `fetch POST /api/tts.php`. The PHP endpoint validates the request (text ≤ 2000 chars, voice pattern, speed range, engine) and forwards it to the voice sidecar. Responses arrive out-of-order since synthesis time varies by sentence length.

The sidecar (`tts/server.py`, code under `tts/sidecar/`) fronts two engines chosen per request by the `engine` field: **kokoro** (Kokoro-82M, default, ~27 EN voices, needs espeak-ng) and **pockettts** (kyutai pocket-tts, ~100M, CPU-friendly, English + 5 languages). For pocket-tts the language is a separate axis from the voice: it's baked into the model weights, so the request's `lang` field (english, french_24l, german_24l, italian, portuguese, spanish_24l) selects a different checkpoint that actually pronounces that language and resolves the chosen voice to that language's embedding. Only one pocket-tts language stays resident; switching `lang` reloads (a full checkpoint load, a few seconds off HF_HOME-cached weights), which is the cost the auto-language path below is built to hide. `TTS_DEVICE` (`cpu`|`cuda`|`auto`) picks the torch device; Kokoro pre-warms one utterance at startup while pocket-tts loads lazily on its first request. `GET /voices` exposes both engines' voice lists and defaults, plus pocket-tts's selectable languages, so the UI can offer an engine + voice + language picker.

The language picker also has an **Auto-detect** option (the default), which routes each reply to the right pocket-tts language while keeping reloads rare and off the critical path. On send, `js/voice/tts.js` runs a dependency-free stopword detector over **Anon's message** to predict the reply's language, falling back to the *previous* conversation language (not English) when the message is too short or ambiguous to call. That prediction drives two things in parallel: `app.js` fires `POST /api/tts.php?action=warm` → the sidecar's `/warm` (which preloads that language's checkpoint and voice state off-thread, so the reload overlaps LLM generation instead of stalling the first audio chunk), and the client locks the reply to the predicted language. As the reply streams, the detector *verifies* the prediction against the actual text - only a confident disagreement in the opening ~40 characters switches the language (warming the corrected model), and once locked it never flips again, so a stray foreign word mid-sentence can't trigger a mid-reply reload. The result: a monolingual conversation reloads zero times after the first turn, and a genuine language switch reloads once, hidden behind generation. Detection is purely client-side; the sidecar only ever sees a concrete language id, and `chat.php` gets no language hint at all - an earlier "reply in {language}" line in the live context was removed because the sticky fallback made it self-latching. Reply language is the model's to infer from the conversation.

Results are decoded into `AudioBuffer`s and inserted into a `Map` keyed by submission index. A playback cursor advances only when the buffer at the current index is ready, ensuring sentences always play in the order they were generated even if a later sentence finishes synthesis faster.

### Audio graph

```
AudioBufferSourceNode ──▶ AnalyserNode ──▶ AudioContext.destination
                              │
                              └──▶ rAF loop reads RMS
                                    maps: pow(min(rms * 3.5, 1), 0.7)
                                    calls: Live2D.setMouthOverride(v)
```

The analyser uses FFT size 1024 and smoothing constant 0.4. The RMS-to-mouth mapping compresses the dynamic range so that both quiet and loud speech produce visible mouth movement, while the power curve (0.7) keeps the mouth from snapping fully open on every syllable.

`TTS.stop()` aborts in-flight fetches via `AbortController`, halts the active `AudioBufferSourceNode`, and calls `Live2D.setMouthOverride(null)` to release the mouth override.

---

## Voice input and barge-in

`webapp/js/voice/voice.js` captures 16 kHz mono PCM through an `AudioWorklet` and calibrates a noise floor. Complete WAV turns go to `chat.php` as base64 audio when the model supports audio input: Ollama's `/api/show` capabilities, or `modalities.audio` in llama.cpp's `/props?model=` (the Jun GGUF repos ship an mmproj and `-hf` loads it automatically). Ollama gets the WAV in `images`; for llama.cpp `llamacpp_audio_parts()` turns that into OpenAI `input_audio` parts, audio before text like Ollama's media tag. When available, faster-whisper transcribes the same turn through `/api/stt.php` in parallel; the transcript replaces the client and stored `<audio>` placeholder through `conversations.php?action=set_audio_text`. The first audio refusal switches to text turns for the rest of the page, reusing the pending transcription. If neither direct audio nor speech-to-text works, the turn fails with a visible error. Microphone controls require browser support, not an available STT sidecar. Automatic gain control stays disabled because it would make the calibrated voice-activity threshold drift during silence.

When barge-in is enabled, browser echo cancellation removes most of Jun's playback from the microphone, while the client also raises its speech threshold in proportion to the current TTS output and confirms a detected interruption before stopping playback. This protects against speaker echo. Audio routed away from the default output device, loud or distorted speakers, Bluetooth latency, and clock drift can still trigger false detections. Use headphones or turn off barge-in for a fully half-duplex conversation.

---

## Security layers

### nginx layer

Rate-limit zones defined in `docker/nginx/templates/omega.conf.template`:

```nginx
limit_req_zone  $binary_remote_addr zone=api:10m rate=10r/s;
limit_req_zone  $binary_remote_addr zone=api_other:10m rate=10r/s;
limit_conn_zone $binary_remote_addr zone=conns:10m;
limit_conn_status 429;
limit_req_status  429;
```

Each API location layers its own burst and open-connection cap on top: `/api/chat.php` gets `limit_req zone=api burst=20 nodelay;` and `limit_conn conns 2;` (two live streams per IP), `/api/tts.php` `burst=10` / `conns 4`, `/api/stt.php` `burst=5` / `conns 1`, `/api/karaoke.php` `burst=5` / `conns 2` (the karaoke page fetches both stems in parallel). Those four use `nodelay`: requests over the burst return 429 immediately, no queuing. Every other `/api/*.php` sits in its own `api_other` bucket with `burst=20 delay=10`: the first 10 requests over the rate are served at once (a page load fires about 8 in parallel), the next 10 queue at 10r/s, and anything past that is a 429. It gets its own bucket because a page's burst of small calls would otherwise spend the `burst=5` that `stt.php` and `karaoke.php` get hit with right after. `limit_req_status 429` matters: nginx's default for `limit_req` is 503. `client_max_body_size` is 16k everywhere except the locations that take a body (chat, STT, karaoke), which override it.

Security headers live in `docker/nginx/snippets/security-headers.conf` and are `include`d by the server block:

```nginx
add_header X-Content-Type-Options "nosniff" always;
add_header X-Frame-Options "DENY" always;
add_header Referrer-Policy "strict-origin-when-cross-origin" always;
add_header Permissions-Policy "microphone=(self), camera=(), geolocation=()" always;
add_header Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; ..." always;
server_tokens off;
```

The CSP is `script-src 'self'` and nothing else: every third-party script (PIXI, Cubism core, pixi-live2d-display, marked, DOMPurify) is vendored under `webapp/vendor/`, so no external origin is trusted to execute code and the app boots without internet. `'unsafe-eval'` is gone too - pixi.js 6.5.10 compiled its uniform-sync functions with `new Function`, and the vendored `@pixi/unsafe-eval` plugin (loaded right after `pixi.min.js` on every page that creates a renderer) replaces that with a table-driven sync. `worker-src 'self' blob:` is required by PIXI's internal web workers; `'unsafe-inline'` for styles by pixi-live2d-display's canvas tinting. Bare metal (`tools/php-router.php`) sends the same CSP, `'unsafe-eval'` included in the removal. Because nginx's `add_header` does not inherit into a location that sets its own header, any new location that adds one must `include` the snippet or it ships with no CSP at all.

HSTS (`Strict-Transport-Security: max-age=31536000`) is added only when `TLS_MODE=on`.

With `TLS_MODE=off` (the default) the app is only served on `:443`, on the cert `10-pick-config.sh` keeps in the `selfsigned` volume. That cert is signed by a per-install CA in the same volume, so trusting the CA once (`./start.sh trust`, offered by both installers) covers every leaf minted after it, including the new one a changed LAN address brings. The CA's critical `nameConstraints` limit it to local names and private address ranges, plus the hosts in the SAN when it was made, so trusting it can't vouch for a public site. A host outside them fails `openssl verify` and gets a new CA. The `:80` server has the same `server_name` list, answers `/health` for the container healthcheck and 301s the rest to `https://$host$request_uri`, so a login form is never served over plain HTTP, on loopback or on the LAN. Bare-metal Windows gets the same shape from Caddy: `start.ps1` binds `php -S` to `127.0.0.1:JUN_PHP_PORT` and puts Caddy on `BIND_ADDR:JUN_PORT` with a cert and CA from `tools/local-cert.php` (`start.ps1` puts the CA in the current user's Root store when the install said yes, and swaps it there when it changes), `flush_interval -1` so the SSE stream isn't buffered, and the `http_redirect` listener wrapper so plain HTTP on that port gets a 308. Colab is untouched: `php -S` there sits behind Colab's own HTTPS proxy.

With `TLS_MODE=on` the TLS template never points at the Let's Encrypt files directly. It reads `/etc/nginx/tls/{fullchain,privkey}.pem`, two symlinks that `docker/nginx/tls-link.sh` aims at `/etc/letsencrypt/live/$DOMAIN/` when a certificate is there and at the local-CA placeholder in the `selfsigned` volume when it is not. That breaks the first-boot deadlock: nginx needs a certificate to start, and certbot needs nginx answering the ACME challenge on `:80` to get one. `10-pick-config.sh` sets the links at boot, and `30-cert-watch.sh` keeps a background loop in the nginx container that compares the certificate's SHA-256 every 60 s while on the placeholder and hourly after that, repoints the links and runs `nginx -s reload` when it changes. The reload is also what makes renewals take effect, since nginx only reads certificates at start or reload. On its side, the certbot container waits for nginx to be healthy (`depends_on: service_healthy`), and retries a failed first issuance after 1, 4 and 16 minutes and then hourly (at most 4 failed validations an hour, under Let's Encrypt's limit of 5 per hostname) before it starts the 12-hour `certbot renew` loop. The container healthcheck calls `http://127.0.0.1/health`, so the TLS template answers `/health` on the port-80 default server too. `.github/scripts/smoke-stack.sh` boots the image with `TLS_MODE=on` on an empty volume, checks `/health` and the challenge path on `:80`, then writes a certificate into the volume and waits for nginx to serve it.

### PHP layer

Every endpoint requires `webapp/api/lib/bootstrap.php`, which loads the helpers in `webapp/api/lib/` (one file per concern) and runs the host and origin checks. nginx and `tools/php-router.php` both 404 anything under `/api/lib/`, so no helper runs as an endpoint. The helpers include:

- **`read_body($maxBytes)`**: checks `Content-Length` before reading and rejects oversized requests with 413 before touching `php://input`. Reads at most `$maxBytes + 1` bytes and rejects if longer, protecting against streams that lie about their size.
- **`rate_limit($bucket, $maxPerWindow, $windowSec)`**: flat-file token bucket under `/var/lib/omega/rl/`, keyed on `client_ip()`. Files are locked with `flock(LOCK_EX)` to prevent race conditions. Returns 429 + `Retry-After` header on miss. The state directory is mounted as the `omega_state` named volume so limits persist across container restarts. If the directory is unwritable the request fails with `503 state_unavailable` rather than passing unlimited; `db()` fails closed the same way instead of falling back to a SQLite file in `/tmp`.
- **`client_ip()`**: `REMOTE_ADDR`, ignoring `X-Forwarded-For` unless `TRUST_PROXY=1`, in which case the *last* hop (the one your proxy appended) is used. Without that rule a rotating header would mint a fresh bucket per request and neutralize the login lockout.
- **`require_same_origin()`** / **`require_allowed_host()`**: run on every request from the bottom of `lib/bootstrap.php`, so no endpoint can forget them. Writes must carry `Sec-Fetch-Site: same-origin` or an `Origin` matching this host (or `OMEGA_ALLOWED_ORIGINS`).
- **`fail($code, $key)`**: emits `{error, code, request_id}`. Never echoes `curl_error` output, exception messages, or file paths. Real errors are logged to stderr via `log_event()` and surfaced through `docker logs`.
- **`json_out()`** / **`read_json_body()`** / **`require_method()`**: every endpoint answers through the first, and every JSON write goes through the second, which is 415 without `Content-Type: application/json`, 413 past the size cap, and 400 unless the body decodes to an object or array.
- **`sidecar_call()`** / **`sidecar_check()`** / **`sidecar_relay()`** in `lib/sidecar.php`: the one path to the TTS and karaoke sidecars. A sidecar that is down or answers 5xx becomes a `502` with a named error (`tts_unreachable`, `stt_failed`, `separate_failed`, ...) through `fail()`, so it carries a `request_id` like every other error.

Endpoint-specific caps:
- `chat.php`: nginx caps the body at 4 MB (a spoken turn ships its WAV base64'd inside the JSON; PHP's own `read_body` ceiling is 6 MB and the decoded WAV ≤ 4 MB), each message content ≤ 16 KB, past 160 messages the oldest are dropped rather than the turn rejected, rate limit 90/min (the card table is one turn per move), `fastcgi_read_timeout` 600 s
- `tts.php`: body ≤ 8 KB, text ≤ 2000 chars, rate limit 60/min
- `stt.php`: body ≤ 4 MB, 30/min; `karaoke.php`: uploads ≤ 30 MB, 30/min, 900 s read timeout for separation
- `models.php`: rate limit 30/min, `Cache-Control: public, max-age=10` (5 min for the OpenRouter catalog)

### Accounts and roles

`users.role` has existed since `001_init.sql` but nothing read it until now. `require_admin()` in `lib/session.php` sits next to `require_user()`: same session lookup, plus a 403 `forbidden` when the row's role is not `admin`. What it gates:

- `stats.php` - the whole endpoint (model list, VRAM, host readings).
- `relationship.php` `PUT` - the absolute-value override. `GET` stays open to the session owner; see [Relationship state](#relationship-state).
- `memory.php` `DELETE` - both the single-note and `{"all":true}` forms.
- `chat.php`'s debug SSE frame - it carries the fully assembled system prompt and live context, so it is only emitted to an admin session. The dev HUD is its only consumer.
- `consolidate.php?action=welcome` preview parameters (`preview`, `away`, `tier`); the plain welcome read, `hour` included, stays open to everyone.
- `api/review.php`, the local dataset triage UI (dev boxes only, not in the public repo; `sync-webapp.sh` leaves it out unless `SYNC_REVIEW=1`).

`OMEGA_DEV_KEY` optionally grants developer access. The frontend hides developer controls from other accounts, while every privileged endpoint independently enforces the role server-side.

Signup takes a `registration_key` matched against `OMEGA_REGISTRATION_KEY`, except for the very first account on an empty `users` table while `BIND_ADDR` is loopback (`first_signup_keyless()` in `lib/db.php`), which is the installer's own owner claiming the instance. Off loopback the first signup needs the key too, so nobody on the LAN can claim an unclaimed install. A login with an unknown email still runs one `password_hash()` before its 401, so it takes as long as a wrong password for a real account. An empty/absent variable intentionally enables public signup. `auth.php?action=signup_info` is the unauthenticated read that returns `{registration_key_required}` so the signup form can show the field when needed.

`auth.php?action=factory_reset` (POST, 3/hour) is the user's own wipe, and needs no role: inside one transaction it deletes the caller's rows from `messages` (via their conversations), `conversations`, `preferences`, `relationship`, `memory_consolidation`, `user_bans`, `wardrobe_presets`, `wardrobe_state`, `welcome_queue`, `trips`, `achievement_stats` and `achievement_seen`, plus every session but the current one; then `memory_wipe_user()` in `lib/memory.php` removes the per-user memory directory, the legacy flat files and their `.migrated` copies. The `users` row, its role and the live session survive, so the account comes back empty rather than gone. A failure on either half returns `factory_reset_incomplete`.

### Account encryption and recovery

The PHP backend requires sodium. Each account has a random 32-byte data key;
`users.wrapped_dek` wraps it under Argon2id(password, `kdf_salt`) and
`recovery_wrapped_dek` under a hash of the recovery code. `enc()` and `dec()`
store/open `v1:` + base64(nonce + secretbox ciphertext) for messages, titles,
summaries, preferences, welcome messages and memory files. Account IDs, timestamps and the
literal `<audio>` placeholder remain plain. See [the security boundary](../SECURITY.md#encryption-and-recovery).

Migration 016 removes old sessions. Login creates missing keys or unwraps the
existing key, binds it, then calls `crypt_encrypt_backlog()` before starting a
session. Every password login scans rows and files, skipping prefixed values,
so a failed pass is retried even when the key was saved already. Rows are updated
in a transaction; memory files are handled afterwards under the user lock.
This adds a backlog scan to each login and does not scrub old disk remnants.

`start_session()` sends `omega_session` and `omega_key` as HttpOnly,
SameSite=Strict cookies. `current_user()` rejects a session without a usable
data-key cookie. Signup and the first legacy-account login show a recovery code
once. `auth.php?action=recover` accepts email, recovery code and a new password,
rewraps the same data key, deletes existing sessions and starts a new one; the
recovery code stays valid. Losing both password and code leaves encrypted
content inaccessible from the state backup alone.

The consolidation worker has no browser cookie. `consolidation_touch()` calls
`key_push()` to send the key over `127.0.0.1:OMEGA_KEY_PORT` (default 9099).
The worker binds it for each user's run and drops its stored copy after success.
Users without a key are skipped until a subsequent activity touch supplies one.

### Sidecar/Ollama isolation

Neither service publishes a port to the host. The audio sidecar additionally requires the `X-Sidecar-Secret` header whenever `SIDECAR_SECRET` is set (the launchers mint it into `.env`; an empty value turns this one check off and the sidecar warns at startup), checks the `Host` header against `SIDECAR_ALLOWED_HOSTS`, refuses any request carrying `Origin` or `Sec-Fetch-Site`, and enforces the expected content type, all before reading a body. The browser never talks to the sidecar directly; all requests go through `webapp/api/tts.php` / `stt.php` / `karaoke.php`, which hold the session check and the rate limiter.

---

## RAG

Character voice is handled by the fine-tuned model itself, so there is no voice
RAG. Nothing in the pipeline uses embeddings; both retrieval paths are plain
lexical matching over SQLite and a text corpus:

- **Lore RAG** (`lore_retrieve` → `lore_search` in `webapp/api/lib/lore.php`): grounds
  replies in curated game canon via keyword/IDF matching. It runs on every turn
  and appends its block to the trailing live-context message (not the system
  prompt, which stays static so Ollama's KV prompt cache holds across turns).
- **Cross-conversation recall**: not a retriever at all - the model asks for it,
  by calling the `search_recent_chats` / `list_recent_chats` tools described
  under [Tool calling and durable memory](#tool-calling-and-durable-memory).
- **`search_lore(query, limit)`**: the same `lore_search()` exposed as a tool,
  because the automatic block only scores the *current* message - a follow-up
  pronoun turn loses the fact the previous turn established, and this lets her
  re-fetch it by name. The prompt frames it as remembering, never as a lookup.

### Lore RAG (`## World facts (canon)`)

The fine-tune gives Jun her voice but blurs or invents specific world details, so
canon facts are retrieved instead of baked in.

The corpus is `tools/lore_dataset.jsonl` (kept local, not in the repo): curated game-lore Q&A in neutral wiki
voice, with out-of-universe meta (developer, platform, version, etc.) filtered out
so Jun never breaks the fourth wall. `tools/build_lore_index.php` flattens each
Q&A into a question→answer pair and writes `webapp/lore_corpus.txt` (the answers,
one per line).

**Retrieval is a heuristic keyword match, not an embedding search.** The earlier
cosine version silently broke: the offline index and the live query path went
through two *different* `nomic-embed-text` pulls (bare-metal build vs. the docker
Ollama), so common words still matched but proper nouns like "Annalie" embedded
inconsistently and name lookups returned nothing. Plain term overlap sidesteps all
of it: exact on names, deterministic, and needing no Ollama, no `.bin` index, no
rebuild.

`lore_search` (in `lib/lore.php`) builds a cached keyword index over the corpus (per-doc
term counts, IDF, a proper-noun set mined from the corpus's own capitalization) and
scores the user message against it:

1. Tokenize to lowercase stems (≥2 chars, plural `s` stripped), dropping an explicit
   stopword list of ordinary chat filler ("morning", "coffee", "love") that is rare
   *in the lore* and would otherwise score high on IDF alone.
2. Score each doc by IDF-weighted term overlap, with a ×2 boost for terms that are
   proper nouns in the corpus. A Levenshtein fallback fuzzy-matches distinctive
   (high-IDF) names so typos still land ("Annallie" → Annalie).
3. Keep up to `LORE_MAX_INJECT` (5) **distinct** hits above the `LORE_FLOOR` (3.0),
   collapsing candidates that share too much vocabulary (Jaccard ≥ 0.5). Chit-chat
   scores ~0 and injects nothing; a single distinctive lore term clears the floor.
4. The surviving answers become the `## World facts (canon)` block, framed as
   established truths to weave in, not to recite.

```
 user message ──tokenize/stopword──▶ IDF-weighted overlap vs keyword index
                                              │   (+proper-noun boost, fuzzy names)
                                       top-5 distinct, score ≥ 3.0
                                              │
                                       inject the ANSWERS as canon facts
```

The index rebuilds itself from the corpus on demand (cached via APCu when
available); a missing corpus degrades gracefully (block omitted).

### Cross-conversation recall

There is no automatic recall pass on the request path. Reaching into other
conversations is something the model decides to do, as a tool call, and both
tools are ordinary SQLite queries scoped to the calling user with the current
conversation excluded:

- `search_recent_chats(query, limit)` - reads the user's messages newest first,
  decrypts each and stops at up to 8 hits. SQL `LIKE` cannot search the stored
  ciphertext. A message hits when the whole query appears at a word start, or
  failing that when every non-stopword query term (`lore_tokens()`) does, in any
  order. Each hit comes back as date, conversation id, title, role, and the
  message collapsed to one line, cut to 500 characters around the first hit.
  Word matching is still blind to paraphrase; the model is expected to pick the
  query terms, and to retry with different ones when a search comes back empty.
- `list_recent_chats(limit)` - the user's most recently updated titled
  conversations, each with a short tail snippet (last few turns, action tags
  stripped, 160 characters per line). This is the "what have we been talking
  about lately" path, used when there is no specific term to search for.

Results are returned as JSON into the tool round, so recalled material enters
the context as a tool message rather than as an injected block.

---

## Tool calling and durable memory

`chat.php` offers its tools via `tool_catalog()` with no keyword pre-filter: `search_recent_chats`, `list_recent_chats`, `search_lore`, `memory_write`, `change_outfit`, `stay_silent`, `flee`, the four outing tools `enter_shop`, `enter_karaoke`, `play_cards` and `go_out_to_eat`, and `web_search` when the message earns it. The persona file only *names* the three lookup tools, inside `<!--tools-->` markers that `prompt_apply_tool_gate()` strips (or removes the whole paragraph when the provider offers no tools - with `LLAMACPP_TOOLS=off` she otherwise printed raw `<|tool_call>` blobs into the reply on 10/50 turns). The durable-memory tool is `memory_write(memory, category)`, which calls `memory_note_add()` and converges notes on the categories `preferences`, `work`, `health`, `family`, `plans`, `boundaries`, and `events`. The streamed-response salvage path accepts the fine-tune's legacy `[A:memory_write|...]` form and sends it through the same helper.

`change_outfit(put_on, take_off, look)` exists because an action tag is write-only: `[A:outfit|...]` gave her no way to tell "no such item" from "already on" from "done", so she narrated the change she intended in all three cases. The server holds the worn state (the browser PUTs it to `api/outfit.php` on every change, saved looks live in `wardrobe_presets`), so `wardrobe_tool_change()` in `lib/wardrobe.php` decides against reality and reports `put_on` / `took_off` / `already_like_that` / `unknown` / `wearing` back to her, and a separate `outfit` SSE frame carries the result to the browser. Modded item names reach the server only as the `mod_items` list sent with that turn (≤ 60 names, ≤ 80 chars each), never stored. `stay_silent(reason, overheard)` ends the turn with no message; on a spoken turn (`audio` field or `voice: true`) `overheard=true` means Anon was talking to someone else in the room, and chat.php then deletes the user row it stored before streaming and sends `silence: {overheard: true}` so the client drops the bubble too. Spoken turns get a `## Who he is talking to` block at the top of the live context that asks for exactly that call, unless the request carries `hear_all: true` (the "Hear everything" voice setting / overlay button), which skips the judgement for that turn; the unparsed text forms `stay_silent{...}` / `stay_silent(...)` are salvaged like the `[A:stay_silent]` tag. `flee` is described under [Relationship state](#relationship-state). The outing tools are described under [Outings](#outings).

Chat tool calls run in a bounded loop of up to 3 rounds. Each result is appended as a `tool`-role message before the model continues, and on Ollama the call turn is re-sent with the `thinking` she streamed in that round (`provider_stream_round()` accumulates it), because the v8 dataset trains the trace on the call turn and Ollama's gemma4 renderer prints it back; the OpenAI-protocol providers get the call turn without it (`change_outfit`, `stay_silent`, `flee` and the outing tools run inside that loop rather than in `run_tool_call()` because they need to emit SSE frames themselves). `search_recent_chats`/`list_recent_chats` query the user's own `messages`/`conversations` tables with the current conversation excluded.

`web_search` is offered only when the latest user message begins with `/search `. The server ignores the model's query argument and transmits the exact user-approved text after that prefix, once. It then goes through `web_search_public()` → DuckDuckGo's HTML results page, parsed for result links/snippets. It and redirect hops (`web_fetch_public()`, up to 3 redirects, 512 KB cap) are guarded by `resolve_public_http_url()`: DNS A/AAAA records must all be public, userinfo and non-standard ports are rejected, and only `http`/`https` are allowed.

Durable memories live under `MEMORY_DIR` (default `<state dir>/memory`, i.e. `/var/lib/omega/memory`) in a per-user directory whose filenames retain the Markdown/JSON layout:

```text
user-{id}/
  preferences.md
  work.md
  journal.md
  meta.json
```

After decryption, each category file has a Markdown heading and one bullet per fact. PHP appends a stable five-character `^blockid` to every bullet; optional `[[category]]` wikilinks become cross-category graph edges. `meta.json` maps block ids to created/updated timestamps without adding dates to each fact. These files are encrypted on disk; use the memory API to edit them. Mutations serialize through a per-user write lock, and each file replacement uses backup → temporary file → rename. A separately locked lazy migration triggers when either legacy artifact exists, groups former `user-{id}.jsonl` entries into category files, preserves their timestamps, moves the journal, and renames the legacy files to `*.migrated`.

A scored karaoke take also posts an `events` note through `memory.php`, containing the song, artist when available, singing mode, score, matched-word count and a spelled-out date. This makes the take available to later chat context; an unscored take adds no note.

`memory_recent_context()` renders the compacted note set under category headings and unwraps wikilinks. When the set passes 2500 characters it keeps the 3 most recently updated notes plus whichever share the most words with the current message (IDF-weighted over the notes), packing whole bullets only. It remains in the trailing live-context message, preserving the static prompt prefix and Ollama KV-cache reuse.

`webapp/api/memory.php` returns category summaries, stable-id facts, parsed journal entries, and their original dates. `POST` adds a fact; `DELETE {"id":"abc12"}` removes one; `DELETE {"all":true}` wipes the user's directory and migrated backups. The Settings → Memory panel renders the payload as a dependency-free Canvas 2D constellation: category and journal hubs anchor fact/date leaves, wikilinks draw cross-edges, and a visually hidden list mirrors the canvas for assistive technology.

Idle consolidation in `lib/consolidation/` is a bounded tool-calling agent rather than a document-regeneration pass. The notes phase can save, revise, forget, or recategorize one stable id at a time; untouched bullets are never rewritten. The journal phase upserts or revises named dates and then re-renders server-side age buckets. `provider_complete_tools()` supports Ollama and OpenAI-compatible responses. When native tools are disabled with `LLAMACPP_TOOLS=off`, the same executor consumes a JSON operation array instead. A per-run guard refuses note deletions beyond 40% of the starting set, while a zero-operation run is a valid successful consolidation. Both phases run inside `consolidation_run_locked()` under the consolidation lock. An idle run then writes the welcome batch after the lock is released (see below).

### Welcome back

When Anon comes back after at least `WELCOME_MIN_AWAY` (60 s), the chat page shows him pulling his phone out in front of his door, with the texts she sent while he was gone waiting on it. The server side is `lib/consolidation/welcome.php`.

**Writing the texts.** `consolidation-worker.php` runs consolidation for users idle for 180 s and passes `$idleBefore`. Only those idle runs write a welcome batch: a manual `POST consolidate.php` run writes none. `consolidation_run()` calls `consolidation_write_welcome()` once `consolidation_run_locked()` has returned and the lock is gone, because the lock keeps the composer disabled and the pass is five model calls, which take minutes on a CPU box. There is no `welcome` lock phase. The pass makes one `provider_complete_once()` call (400 max tokens) per tier in `WELCOME_MILESTONES`, in order: missed, ached, panicked, unravelled, hollow. Each call gets the run's conversation lines, a first-person register for that tier, and every text already "sent" at the earlier tiers, so she escalates instead of repeating herself. The reply is a JSON array of strings (`welcome_parse_lines()`), cut to the tier's text cap. A tier that fails or comes back empty is skipped. `last_activity` is compared with the worker's idle cutoff (`$idleBefore`) before each call and before the write: if he came back at any point since the run started, during the locked notes and journal phases included, the whole batch is thrown away (`welcome_queue_came_back` in the log), so texts written for an absence that already ended never show on the next one.

The batch is one encrypted row in `welcome_queue`, `{"v":2,"tiers":{"missed":[...],...}}`, each text trimmed to `WELCOME_MAX_CHARS` (240). A row in the old flat-list shape is read as `missed`.

**Milestones.** The model writes the words, PHP sets every count and timestamp (the local model can't bucket by date). A milestone starts at `left_at` plus the tier's `after` in `WELCOME_TIERS`. Its missed calls come first, then its texts, and every item's time is clamped to now:

| Tier | After | Texts | Missed calls | Seconds between texts | Seconds between calls |
|---|---|---|---|---|---|
| `missed` | 2 h | 2 | 0 | 260 | - |
| `ached` | 8 h | 3 | 1 | 340 | 120 |
| `panicked` | 24 h | 6 | 3 | 18 | 210 |
| `unravelled` | 3 d | 3 | 1 | 900 | 600 |
| `hollow` | 14 d | 1 | 0 | - | - |

The `none` tier (60 s to 2 h) has no milestone, only the live lines. A tier with no generated texts gets a random set from `WELCOME_FALLBACK_TEXTS`, which are written as mid-absence texts. The `WELCOME_TIERS` lines can't stand in for them, since they say "you were gone {d}" and only make sense once he's back.

**The payload.** `GET consolidate.php?action=welcome` is read before the client reports activity, or the absence would already be overwritten with "just now". It returns:

- `show`, `away` (seconds), `tier`, `left_at` (his old `last_activity`), `mood_changed`, and `preview: true` on an admin preview.
- `history`: up to the last 4 user/assistant turns of his most recent conversation as `{role, text, at}`. The content goes through `dec()` and `spoken_text()`, so action tags and the bookkeeping tag never reach the phone. Each text is cut to 280 characters, and `<audio>` rows (voice turns whisper never filled) are skipped.
- `milestones`: `{tier, at, items: [{kind: 'call'|'text', at, text?}]}` for every tier whose `after` is within the absence, oldest first.
- `live`: a greeting (the hour-of-day pools on warm tiers, `WELCOME_GREETINGS_COLD` on cold ones) and the tier line with `{d}` replaced by the exact duration.

Under 60 s the answer is `{show: false}` and the queue is left for the next absence. A `none` return (60 s to 2 h) shows only the live lines and also leaves the queue alone. From `missed` up, the fetch drains the queue. Any return over 60 s applies the tier's gauge deltas through `relationship_apply()` and closes the absence with `consolidation_touch()`. All of that happens on the fetch, not when he reads anything, so closing the phone straight away keeps the consequences. An admin preview (`preview`, `away`, `tier`) builds the same payload from the queue without draining it or touching the gauges.

**The scene.** `js/app/welcome.js` and `css/welcome.css` play it on the chat page once `dismissBoot()` has hidden the boot overlay, and never on the way back from an outing. The room is `scene/hallway.svg`: his door `407` in a narrow, dingy recess off the game's stairwell, the view the game's stairwell 360 has behind you when you face the stairs. The side walls close in, there's damp low on the walls and one cheap bulkhead lamp over the door in the tier colour, and the stairwell window's warm light barely reaches it. It's original art in the game's palette with brush streaks as plain clipped paths, no `<filter>`, because the panicked lamp flicker would re-rasterise a filtered room every frame. It doesn't read the sky, nothing outside is visible. The phone is HTML (a `role="dialog"`) held between `scene/hand-back.svg` and `scene/hand-front.svg`, all three inlined through `trip/scene.js` like the outing rooms. It comes up on a lock screen with her grouped notifications (new messages with the latest text as preview, missed calls); after about 1.6 s the thumb taps it (tapping it yourself skips the wait) and the chat opens with the unread divider at the top: the `history` turns above it, each missed milestone below under its own time divider with its missed-call rows and texts. Nothing scrolls by itself and nothing new arrives on the phone. The home button, a click outside the phone or Esc puts it away and fades into the room; the door doesn't swing. Only then does she react: the `live` lines through her face bubble and TTS, paced by the voice, with the tier's expression sequence and loops on the normal camera (no zoom), and the reaction stops if he reaches for the chat box. A reply typed in the phone's composer is sent as his first turn and stored like any other, and then her real answer replaces the scripted reaction. With no milestones (a return under 2 h) there's no phone at all, she just reacts. The texts are never stored. Under `prefers-reduced-motion` there's no lock screen and no slide, the chat opens at the unread divider.

---

### Outings

Going somewhere is Jun's decision. `TRIP_TOOLS` in `lib/chat/tools.php` maps `enter_shop` -> `shop`, `enter_karaoke` -> `karaoke`, `go_out_to_eat` -> `date` and `play_cards` -> `cards`. Each call sends a `go` SSE frame; the browser waits for the reply to finish streaming and for TTS to drain, then navigates to `wardrobe.html`, `karaoke.html` or `date.html`, or opens the blackjack table (`js/app/cards.js`) over the chat page. All four refuse idle turns (`not_available_on_idle`), and `enter_karaoke` checks the sidecar's `/health` for `sep: true` at call time, telling her the room is closed instead of sending the frame when it is not.

The three pages are gated by a per-user `trips` row (migration 017). The tool writes it before the `go` frame (`trip_set()`; cards is played at home and writes none), the pages redirect to `index.html` without one, and `trip.php?action=home` clears it: `date.js` calls it when you leave, and `index.html` calls it on every load while a grant is still open, so going back to the chat page by any route spends the grant. For a restaurant trip that call also writes an `events` memory note naming the meal and both dishes, because every turn on the date page is ephemeral and she would otherwise come home with no record of it. `FREE_ROAM=on` removes the redirect. Settings > Dates has an **Ask her** button per outing and a **Force her** button that writes the grant through `trip.php?action=go`; Force her is shown to admins, or to everyone under `FREE_ROAM=on`.

**Ask her** sends a normal chat turn with an `invite` field. On an invite turn the live context is cut down to the feelings block plus one OOC (out-of-character) stage direction naming the tool to call if she agrees; clock, notes, lore, wardrobe and the save check are dropped. A longer "you MUST call X" rule did not get small models to call the tool on `<think:low>`; the one-line direction did.

Typed invitations get the same treatment. When a turn arrives without `invite` (and is neither idle nor ephemeral), `trip_guess_invite()` in `lib/chat/tools.php` fills it in from the text: either the message names exactly one outing (`TRIP_WORDS`: shop, karaoke, a meal, cards) next to an invite phrase ("wanna", "let's", "how about", ...), or it is a short yes (80 characters or less) right after a reply of hers that asked a question and named exactly one outing. Anything with a no-word in it ("not", "later", "tomorrow", but not "why not" or "can't wait") guesses nothing. It is an English keyword match; a false hit costs one turn of trimmed live context, and she can still refuse.

If she then says yes in prose and never calls the tool, `chat.php` sends the trip for her: on an invite turn with no error, no flee, no silence and no trip already sent, a reply that `trip_reply_accepts()` reads as a plain yes runs the matching `TRIP_TOOLS` entry after the stream (`trip_inferred` in the log). This is also the only way trips work at all with `LLAMACPP_TOOLS=off`.

On a normal turn with tools offered, 1 in 12 replies and 1 in 3 idle nudges (`INITIATIVE_ODDS_REPLY` / `INITIATIVE_ODDS_IDLE`) get a `## Take the initiative` block asking her to ask Anon for something herself, with the outing tools named but not to be called until he agrees.

**Ephemeral turns** (`ephemeral: true`) are the date page, the card table and touch reactions. They store neither the user message nor the reply, skip bookkeeping, and force `reasoning=low` with thinking off whatever the picker says, since a hit or a stand that waits 20 s on a trace makes the game unplayable. `date.js` picks one of three restaurants from the trip's start timestamp, so reloading keeps the same room. Jun picks her own dish by ending a line with `ORDER: <dish>`, which the page matches against the menu and strips before display. The food is not instant: the waiter turn starts a client-side kitchen timer, the slower of the two dishes' cook times (the fifth column of `MENU`, 30 s for a drink up to 230 s for the risotto) times a random 0.85-1.15. A ticket above the composer counts it down, the plates and **Ask for the bill** appear only when it runs out, and that arrival is its own ephemeral turn. If nobody has spoken for 40 s during the wait she breaks the silence, at most twice per meal. Admins, and everyone under `FREE_ROAM=on` (the page reads `can_force` from `trip.php`), get a **Skip the wait** button.

**Rooms and sky.** The rooms are SVGs under `webapp/scene/` (`boutique`, `lounge` + `lounge-front`, the three `diner-*` restaurants, `table`, `cardroom`, plus `hallway` and the two `hand-*` layers for the [welcome back](#welcome-back) scene), with reusable props under `scene/props/`. (`curtain.svg` is only a CSS background in the wardrobe page.) `trip/scene.js` inlines them into the page rather than using `<img>`, because an `<img>` SVG is its own document and cannot read the page's CSS custom properties. A room can leave `<g data-prop="name">` slots, which `scene.js` fills from `scene/props/name.svg`; the slot owns the transform, the prop file only its own local box. `trip/skybox.js` picks one of seven phases (night, dawn, morning, midday, afternoon, golden, dusk) from the local clock and a fixed mid-latitude day-length curve (no geolocation), sets `--sky-*`, `--key-warm`, `--key-level`, `--city-shade` and `--city-lit` on `<html>`, and re-checks every 5 minutes and on tab focus. Every room but the hallway reads those: the window gradient, the building colour, the city's window lights, and the room's own key light. Room and prop URLs carry a `?v=` like everything else, since nginx serves `.svg` as immutable; props filled into a slot are fetched without one, so bumping the room's `?v=` does not refetch them and a browser that already has a slot prop keeps its old copy.

## Relationship state

Jun keeps a hidden, per-user relationship that colours her mood and drifts with how she's treated. State lives in the `relationship` table: one row per user, three integer scores clamped to 0–100:

| Score | Default | Meaning |
|---|---|---|
| `affection` | 60 | warmth ↔ coldness |
| `trust` | 50 | openness ↔ guardedness |
| `tension` | 20 | tension/fear in the room |

Helpers live in `webapp/api/lib/relationship.php` (`relationship_get` / `relationship_set` / `relationship_apply`, shared with `relationship.php`). It's a closed loop across a chat turn:

1. **Inject.** On each `/api/chat.php` request, `relationship_directives()` renders the three scores as bare readings (`- Affection: 60/100` and so on) under the `## YOUR FEELINGS TOWARD ANON RIGHT NOW` header of the **trailing live-context message**, not the static system prefix, so the KV prompt cache still holds across turns. What each gauge does to her (low affection → colder, low trust → skeptical, high tension → nervous and defensive) is one short paragraph in the static persona file plus the training data, not per-turn prose.
2. **Update.** Jun's reply carries a hidden `[A:mood_shift|affection=±N|trust=±N|tension=±N]` tag. After the stream completes, `chat.php` parses it, `relationship_apply` clamps each delta to ±50 (the persona file asks for 0-5 per turn; the cap only exists to bound a model that invents drama), adds it onto the current row, clamps to 0–100, and strips the tag before the message is stored. On the wire it streams like any action tag, and `actions.js` returns null for `mood_shift` so it never renders or reaches TTS.
3. **Dev override.** `webapp/api/relationship.php` exposes `GET` (current scores) and `PUT` (set absolute values, clamped), so a state can be forced without playing through the conversation.

`GET` needs only a valid session (rate-limited 60/min) - the state is the user's own. `PUT` is admin-only. The Settings → Memory panel shows three read-only meters (value, phrase and fill, no input), loaded by `loadMood()` when that panel opens, because the gauges are hers to move. The Developer tab has a "Relationship override" block with the same three gauges as sliders: `setMoodEditingEnabled(isAdmin)` in `settings.js` leaves them disabled for everyone else, and a change `PUT`s the absolute values through `pushMood()` in `mood.js` (debounced 300 ms, re-reads on failure).

### Walking out

The `flee(reason, destination)` tool is how she leaves a scene, and the tag form `[A:flee|...]` in a streamed reply goes down the same path. Neither is taken at face value: `flee_adjudicate()` makes a second, non-persona call to the same model as a neutral referee (reasoning `high`, thinking on) with the recent turns and her stated reason, and only a `{"can_leave": true}` verdict counts. The referee says no when she is physically restrained in the fiction, when leaving is just a mood escalation, or when the reason is out-of-character ("Anon asked me to test the tool"). A refused flee returns a note telling her to stay in the scene; an approved one ends the turn with a `fled` frame and, with `FLEE_BANS=on` (the default), `ban_apply()` writes a `user_bans` row: 5 minutes, doubling per strike up to 30, strikes resetting after a day without one. The stored reason goes through `enc()` like any other text with his words in it (migration 018 nulled the plaintext ones), and `ban_active()` keeps the ban when it can't decrypt the reason, it just shows an empty one. The `flee_adjudication` log line carries the verdict only, never the reason or the referee's `why`. While it stands, `chat.php` answers every turn with an SSE `user_fled` error carrying the countdown and `consolidate.php` skips the user; the frontend shows the lockout. `FLEE_BANS=off` keeps the walkout and drops the lockout. v8 saw too few flee examples to reach for it on her own, so chat.php nudges her: every applied `mood_shift` is logged to `mood_log` (migration 020, newest 10 per user), and when the last 3 shifts, no older than 30 minutes, hold at least 5 wrong-way gauge moves (tension up, trust down, affection down, out of 9 possible) `chat_live_context()` adds one flat OOC line telling her to consider invoking `flee`. Typed and spoken turns only, not idle or ephemeral ones, and the referee still decides. An approved flee clears the log.

## Achievements

25 collectibles, four tiers each (bronze, silver, gold, diamond). They grant nothing. The catalog (ids, names, thresholds, which ones are hidden, which count down) is `ACH_CATALOG` in `webapp/api/lib/achievements.php`, the only copy.

**Counting.** Every counter is a row in `achievement_stats` (migration 019), written through `ach_add` (sum), `ach_max` (peak) or `ach_min` (low point). All three catch their own errors, so a failed write never costs a reply. The hooks sit where the event already happens:

| Stat | Where |
| --- | --- |
| messages, days, streak, night (02:00-04:59), voice, longest + short (typed only) | `ach_on_user_message()` after `chat.php` stores the user row (never idle or ephemeral turns) |
| tts | `chat.php` after a non-silent reply, when the request carried `tts: true` (the browser's TTS toggle) |
| silent, fled | `chat.php`, on a non-overheard `stay_silent` and on an approved walkout |
| affection/trust/tension peak, tension low, gauge_moved | `relationship_apply()` via `ach_on_relationship()`, after clamping, so the admin override `PUT` never counts |
| notes, lore, searches, outfits | `run_tool_call()` / `chat_run_tool()` / the `memory_write` tag. Outfits count only a real change: `ach_worn_changed()` compares stored items + variants before and after (a saved look she already wears counts nothing), mod items count off the tool's `changed`, and an `outfit.php` `PUT` counts the same way |
| chats, dates, shops, songs | `conversations.php?action=create`, `trip.php?action=home` for a date or shop trip, a successful `karaoke.php?action=separate` |
| bj_won, bj_lost | the browser, `POST achievements.php?action=bump` from `cards.js` (the table is client-side). Only stats in `ACH_CLIENT_STATS` are accepted |

Day boundaries and the night window use the browser's offset, sent as `tz` (minutes east of UTC) on each chat request. Days and streaks claim the day with a compare-and-swap on `day_last`, so two messages at once can't both count a new day; a day that goes backwards (timezone change) is ignored.

**Reading.** `GET achievements.php` returns the list with each tier computed on the fly, plus `fresh`: tiers above what `achievement_seen` records. The client toasts those and `POST`s `?action=seen` back. Because "seen" lives on the server, an unlock on the date or karaoke page toasts when the chat page next checks (on boot and after every reply). A hidden achievement comes back with name, description, thresholds and value nulled until its first tier.

**Dev override.** Admin accounts get the hidden achievements unredacted (`GET` passes `is_admin`, the response carries `dev: true`) and `POST achievements.php?action=set {id, value}` (admin only, 403 otherwise) writes the stat directly; `value: null` deletes it. `ach_set()` also lowers `achievement_seen` to the new tier, so raising it again re-fires the toast.

**UI.** `js/achievements/emblems.js` draws the four tier emblems (plus the empty and locked socket) as inline SVG, with per-call gradient ids. `js/achievements/achievements.js` owns the panel (sidebar button), the unlock toasts and `check()`/`bump()`. The panel is built on the Settings drawer's own classes (`settings-drawer`, `settings-nav`, `settings-navitem`, `set-row`...), so it gets the same frame, nav and phone layout; the nav filters by the catalog's `group` (chat, outings, feelings, habits). Each row shows only the emblem of the tier reached, and rows sort best first: highest tier, then furthest toward the next one, the redacted ??? rows last. For admins every row also gets -/+ buttons that jump to the previous/next tier threshold and a box for an exact value. Styles in `css/achievements.css`.

---

## Android app

`android/` is a second implementation of the same app, not a client for this one: a Ktor server inside the phone (`server/LocalServer.kt`) answers the same `/api/*` shapes the webapp already speaks, `inference/ChatEngine.kt` replaces `chat.php`, and inference runs on-device through LiteRT-LM. The browser assets are the same `webapp/` files, so anything the frontend expects from an endpoint has to exist on both sides.

These parity decisions are worth carrying, because each of them looks like a bug from the other side:

- **The tool markers.** `system_prompt.txt` wraps its tool paragraph in `<!--tools-->` / `<!--/tools-->`, and php strips either the markers or the whole block per request depending on whether the provider offers tools. Android always offers them, so `ChatEngine` only ever removes the marker lines.
- **Audio turns are refused.** `ChatRequest` carries `audio`, and `validate()` fails it with `audio_unsupported` before anything is written down. LiteRT has no audio input here, and the webapp reads that refusal as "transcribe the same recording through whisper when available" rather than answering an empty turn.
- **Memory dates.** `memory/MemoryDates.kt` is `memory_note_render()` / `memory_note_stamp()` from `lib/memory.php` ported to Kotlin, used by `MemoryStore.recentContext()` under the same `## Durable memory notes` header, word for word. The two prompts have to say the same thing, so they change together.
- **The wardrobe.** `wardrobe/Wardrobe.kt` is `lib/wardrobe.php` ported to Kotlin: the same item/variant/conflict/alias tables in the same order, `canonicalState()` returning null where php `fail()`s with `invalid_wardrobe`, and `toolChange()` producing the same `change_outfit` reply keys and note strings byte for byte, because the model reads them. `LocalServer` serves `api/outfit.php` (GET/PUT) off a one-row `wardrobe_state` table, and `ChatEngine` runs `change_outfit` beside the other tools and emits the same `outfit` SSE frame. Two things are deliberately not ported: the per-asset check against the worn state (the phone serves `/assets/` ungated, so the `assets` list is only echoed back to the browser, never enforced) and the 2/s rate limit on the PUT (the browser already throttles itself to one write per 500ms). `_wardrobe.php` and `Wardrobe.kt` change together, same as the memory dates.
- **Achievements are not ported.** `LocalServer` has no `achievements.php`, so `main.js` hides the sidebar button and never wires the module when the provider is `litertlm-android`, and `bump()` stays a no-op there.
- **No welcome back.** The phone runs no idle consolidation, and `LocalServer` answers `consolidate.php?action=welcome` with a stub that has no `show`, so the chat page never plays the [welcome back](#welcome-back) scene there.

**The context ordering is deliberately the opposite of the webapp's, and must not be "fixed".** php puts Anon's question first and the live-context block after it, because `tools/build_dataset_v6.py` trains every row that way. `ChatEngine` puts the block *before* the question: the phone runs a 2B int4 model that answers whatever it read most recently, and with the context glued after the question it kept replying to the memories instead of to Anon. Both orders are load-bearing where they are.

`LocalServer`'s `me` reports `role: admin`. There is one account and whoever holds the phone owns the install, so the Developer tab, the HUD and the memory tools stay unlocked - the role gates in [Accounts and roles](#accounts-and-roles) exist to separate accounts on a shared server, and there are none here.
