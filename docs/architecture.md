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
  LLAMACPP_URL point at a server of your own), VOICE=on adds voice, KARAOKE=on adds karaoke.
  Optional (profile=prod): certbot sidecar for Let's Encrypt issuance + renewal
```

nginx serves static files from `/var/www/omega/` and FastCGI-proxies `*.php` requests to the php-fpm container. The model servers and the audio sidecars are internal-only; their ports are not published to the host. The voice sidecar on `:8001` fronts two swappable engines, Kokoro-82M (default) and kyutai pocket-tts, selected per request. `VOICE=off` drops the `voice` compose profile so the `tts` container is never started; on bare-metal Windows the same variable stops `start.ps1` spawning the sidecar process. Either way php and the frontend degrade gracefully to text-only whenever the sidecar is absent or unhealthy.

Karaoke stem separation runs the *same* `tts/server.py` in a second container (`profiles: [karaoke]`, `SIDECAR_ROLE=karaoke`) built from `docker/karaoke.Dockerfile`: demucs and a CUDA/ROCm torch, no Kokoro or pocket-tts. The split exists so the two can want different hardware - separation is minutes on CPU versus seconds on a GPU, while voice synthesis is real-time on CPU and a GPU copy would only take VRAM away from the LLM. Each image installs only its own dependencies, and `server.py`'s `_stt_available()`/`_sep_available()` probes turn a missing one into a 503 rather than a crash, so the shared file is safe in both roles. Bare-metal installs (Windows, Colab) run a single process that serves both, which is why `api/karaoke.php` falls back to `TTS_URL` when `KARAOKE_URL` is unset.

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

`chat.php` serves one SSE contract to the browser regardless of backend. `webapp/api/providers.php` owns the upstream request and streaming dialect selected by `AI_PROVIDER`:

- **`ollama`** (default): Ollama's native `/api/chat`, NDJSON stream, one JSON object per line.
- **`openrouter`** / **`llamacpp`**: an OpenAI-compatible `/chat/completions` endpoint with `data: {...}` SSE lines.

`provider_stream_round()` parses either upstream shape and returns normalized content, tool calls, usage, completion state, and errors. It emits normalized `token` and `thinking` events through the callback supplied by `chat.php`, so conversation orchestration does not depend on either wire format.

`webapp/api/models.php` lists models from whichever provider is active: Ollama's `/api/tags`, or an OpenAI-style `/models` call for OpenRouter/llama.cpp. OpenRouter's catalog (~1-2 MB) is disk-cached for 1 hour (`state_dir()/openrouter_models.json`) and served stale on upstream errors rather than failing the boot-time poll.

### Reasoning

The Settings drawer has a reasoning level (`auto`/`low`/`medium`/`high`) and a "Think" toggle that turns the chain of thought on and streams it to the thought pane. Under `auto` the toggle is ignored and `route_reasoning()` decides both per message from cheap surface signals (analytical verbs, arithmetic or "how many" phrasing, two or more questions, 25+ words): no signal is `low` without thinking, one is `medium`, two or 60+ words is `high`; idle nudges are always `low`. The settled level reaches the model two ways at once: as the `<think:LEVEL>` token appended dead last to the user turn (`medium` is spelled `med` there, because that is what `tools/build_dataset_v7.py` trained), and as a provider option - `reasoning.effort` for OpenRouter, `options.reasoning_effort` for Ollama, nothing extra for llama.cpp.

The Ollama branch has a trap: **thinking is requested by omitting `think`, never by sending `think: true`.** The Jun GGUFs advertise only `tools` and `completion`, so an explicit `think: true` fails Ollama's capability check with HTTP 400 before rendering; with `reasoning_effort` set alone the model thinks fine and returns a populated `message.thinking`. `think: false` is only ever added to *suppress* reasoning. Not every quant splits its reasoning out either - `Jun-LoRA-v4-12B-GGUF:Q4_K_M` streams literal `<think>…</think>` inside `content` - so `provider_route_think_token()` re-routes anything inside a `<think>` block to the `thinking` event in both stream parsers, holding a partial tag across chunks, so storage, action parsing and TTS only ever see dialogue. Generation is capped at `THINK_MAX_TOKENS` (16384) for a thinking turn and 128 for a plain one on every provider.

### Stream ceilings

`provider_stream_round()` bounds every upstream call: one wall-clock deadline per request (`OMEGA_TURN_TIMEOUT_S`, default 900, floor 30 - each tool round gets what is left), an idle hangup when nothing arrives for `OMEGA_STREAM_IDLE_S` (default 300, floor 10, generous because a cold CPU load is minutes of silence), and byte caps that abort the transfer: 1 MiB pending frame or 4 MiB of content (`upstream_overflow`), 64 KiB of error body (`upstream_error`). A browser that disconnects mid-stream aborts the upstream transfer too.

### Failure handling and MTP

llama.cpp tool support is gated by `LLAMACPP_TOOLS` (`provider_tools_enabled()` in `providers.php`) since not every chat template handles tool calling. Independent of that flag, `chat.php` has a runtime fallback: if the first streamed round comes back as an HTTP 4xx from an OpenAI-style provider, it strips `tools` from the payload and retries the same round once before giving up - this is what recovers automatically from a llama-server template that rejects the `tools` field.

Multi-token prediction (MTP) runs the chat model with a small Gemma 4 drafter that proposes the next few tokens for the main model to verify in one pass; output is unchanged, only the timing. With Ollama, `docker/ollama-entrypoint.sh` pulls the drafter named by `OLLAMA_MTP` and builds a derived model (`OLLAMA_MTP_MODEL`, default `jun-mtp`) from a Modelfile with a `DRAFT` layer and `draft_num_predict` (`OLLAMA_MTP_N_MAX`) baked in; `default_chat_model()` then serves that twin. With llama.cpp, `start.sh` layers `docker-compose.llamacpp-mtp.yml` when `LLAMACPP_MTP` is set (a separate overlay because llama.cpp parses a set-but-empty `LLAMA_ARG_SPEC_*` as a value and dies). `mtp-autotune.sh`/`.ps1` measures depths 1-4 against plain decoding with the real system prompt and writes the winner, stamping `MTP_TUNED_GPU` so the launchers re-tune after a GPU change. Because the drafter's own CUDA buffer can fail to allocate on a crowded card, Ollama HTTP errors are handled in the same round loop as the OpenAI ones: `ollama_mtp_fallback_model()` returns the base model when the failing model is the MTP twin, and chat.php, titling, compaction and consolidation (via `provider_post_chat()`) all retry once against it before surfacing an error.

`ollama_evict_if_partially_offloaded()` runs before each chat payload is built: if `/api/ps` shows the pinned model with less than 90% of its weights in VRAM it evicts it (once per 600 s) so the next load can re-fit, but only when `gpu_ctx_headroom_mb()` says the weights could fit at all.

---

## Action extraction state machine

`makeStreamBuffer` in `webapp/js/app/stream-filters.js` (imported by `app.js`) is a streaming state machine that intercepts action tags before they reach the chat renderer. Two syntaxes are recognized: the compact `[A:name|value|value]` form the prompt now asks for (positional values, mapped to kwargs via the `POS_KEYS` table in `actions.js`, with omitted kwargs filled from `DEFAULTS`), and the legacy `[ACTION:name|key=value|...]` form still present in stored history and the fine-tune's training data.

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

When a closing `]` is received, the bracketed text is immediately passed to `Actions.parseActions`. The return value is an array of resolved action objects. Each is dispatched to `Live2D.setTarget` / `scheduleSequence` / `startLoop` **before the rest of the message has finished streaming**. This is what makes the character react in sync with words being generated.

Malformed or unrecognised tags are logged to the debug panel and silently dropped. `mood_shift` is dropped on purpose: `actions.js` returns null for it because `chat.php` owns that tag (see [Relationship state](#relationship-state)).

### Name templating stage

The clean text emerging from the action buffer passes through a second streaming filter, `makeNameFilter` in the same `stream-filters.js`, before it reaches the chat renderer and TTS. It resolves `{f_playerName}` / `{f_botName}` placeholders to the user's chosen names (via `webapp/js/names.js`). Like the action marker holdback, it buffers a trailing *partial* placeholder across token chunks, so a split like `"{f_play"` + `"erName}"` substitutes cleanly and never flashes its raw form in the chat or gets read aloud by TTS.

---

## Live2D engine internals

`webapp/js/live2d.js` wraps `pixi-live2d-display` with direct parameter control.

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
2. **Lerp**: for each param in `currentValues`, exponential smoothing toward `targetParams`:
   ```
   alpha = 1 - exp(-dt / LERP_TAU_MS)   // LERP_TAU_MS = 150 ms
   current = current + alpha * (target - current)
   ```
3. **Write to raw params**: `raw.parameters.values[idx] = current`.
4. **Overwrite with active loops**: sin oscillations are written directly, bypassing the lerped current value. This keeps loops visually crisp.
5. **Overwrite `ParamEyeOpen` for blink**: if a blink phase is active, the eye open value is set directly from the blink timeline (close 70 ms / hold 50 ms / open 120 ms ramp). Using lerp for blinks would smear the closure into an invisible dip at normal tau.
6. **Overwrite `ParamMouthOpen` for lipsync**: if `setMouthOverride` has been called (TTS audio playing), the mouth value is set from the RMS measurement, bypassing lerp entirely so the lip track is tight.
7. **Re-stamp forced part opacities**: the `forcedPartOpacity` Map (partId → opacity) is written straight into `raw.parts.opacities` every tick. The rig otherwise reasserts its own part opacity each frame, so a one-shot write would be clobbered; re-stamping is how the wardrobe force-shows/hides parts (e.g. the alt dress `dress1`, which has no enable param and is hidden by opacity 0 in the rig).

### Wardrobe: parts, tint, and variants

`webapp/js/outfit.js` drives the wardrobe by three mechanisms, none of which touch the LLM (the current state is injected into the system prompt server-side so Jun knows what she's wearing):

- **Enable params**: most items are a param-backed boolean (`ParamShirtEnabled`, `ParamSkirtEnabled`, …) with `excludes` that force conflicting items off.
- **Forced opacity**: items with no enable param (the alt dress) are shown/hidden through the `forcedPartOpacity` re-stamp step above.
- **Recolor**: Live2D's texture sampler is wrapped at load time by injecting an `omegaTint()` helper into the fragment shader (`texture2D(s_texture0, …)` → `omegaTint(texture2D(...))`), so drawables matching a color group's patterns are tinted live without editing textures. The three base textures (`assets/texture_00..02.png`) are loaded as straight-alpha data URLs; the `variants/` PNGs (miniskirt, socks, stockings) swap in as alternate pieces.

### Loop parameters

`startLoop(paramId, amplitude, period_ms, base)` stores an entry in the `loops` Map. Each tick the value written is:

```
base + amplitude * sin(2π * elapsed_ms / period_ms)
```

`stopLoop(paramId)` removes the entry; the param reverts to its `targetParams` value on the next lerp tick.

### Sequence scheduling

`scheduleSequence(steps)` takes an array of `{paramId, value, delay_ms}` objects and computes absolute `fire_at_ms = performance.now() + delay_ms` for each. Steps are pushed into `pendingSequences`; the tick loop fires them in order. This is used for nodding, head shakes, blinks, and any multi-step gesture.

### Idle animation

`startIdle()` sets up three concurrent behaviours:

- **Breath**: a constant `_loop_param` on `ParamBodyY` with a 4-second period and small amplitude.
- **Blink**: a `setInterval` that fires `scheduleSequence([close, hold, open])` randomly every 3–7 seconds.
- **Fidget**: a `setTimeout` chain that picks a random entry from the `FIDGETS` array every 4–10 seconds. Fidgets are either `loop` (short oscillation: tail wiggle, head sway, eye glance) or `pose` (set a target, hold, return to default: leg shift, arm raise).

`resetIdle()` clears all targets, loops, and sequences back to model defaults. It does not restart idle; callers that want idle to resume must follow with `startIdle()`.

### `getRaw` quirk

The pixi-live2d-display wrapper exposes the Cubism core model in different shapes depending on the SDK version loaded. `getRaw(model)` probes three locations (`coreModel`, `coreModel._model`, and arbitrary keys) to find the object with `.parts.ids`. This probe must not be replaced with a direct property access.

---

## TTS pipeline

`webapp/js/tts.js` accumulates tokens from the stream's `onCleanText` callback (action tags have already been stripped before this callback fires) and builds a sentence queue.

### Sentence accumulation

Tokens are appended to a buffer. When a sentence-ending character (`.`, `!`, `?`, `\n`) is seen and the accumulated text is non-trivial, the sentence is pushed to the synthesis queue and the buffer is reset.

### Parallel synthesis, ordered playback

Each queued sentence triggers an immediate `fetch POST /api/tts.php`. The PHP endpoint validates the request (text ≤ 2000 chars, voice pattern, speed range, engine) and forwards it to the voice sidecar. Responses arrive out-of-order since synthesis time varies by sentence length.

The sidecar (`tts/server.py`) fronts two engines chosen per request by the `engine` field: **kokoro** (Kokoro-82M, default, ~27 EN voices, needs espeak-ng) and **pockettts** (kyutai pocket-tts, ~100M, CPU-friendly, English + 5 languages). For pocket-tts the language is a separate axis from the voice: it's baked into the model weights, so the request's `lang` field (english, french_24l, german_24l, italian, portuguese, spanish_24l) selects a different checkpoint that actually pronounces that language and resolves the chosen voice to that language's embedding. Only one pocket-tts language stays resident; switching `lang` reloads (a full checkpoint load, a few seconds off HF_HOME-cached weights), which is the cost the auto-language path below is built to hide. `TTS_DEVICE` (`cpu`|`cuda`|`auto`) picks the torch device; Kokoro pre-warms one utterance at startup while pocket-tts loads lazily on its first request. `GET /voices` exposes both engines' voice lists and defaults, plus pocket-tts's selectable languages, so the UI can offer an engine + voice + language picker.

The language picker also has an **Auto-detect** option (the default), which routes each reply to the right pocket-tts language while keeping reloads rare and off the critical path. On send, `js/tts.js` runs a dependency-free stopword detector over **Anon's message** to predict the reply's language, falling back to the *previous* conversation language (not English) when the message is too short or ambiguous to call. That prediction drives two things in parallel: `app.js` fires `POST /api/tts.php?action=warm` → the sidecar's `/warm` (which preloads that language's checkpoint and voice state off-thread, so the reload overlaps LLM generation instead of stalling the first audio chunk), and the client locks the reply to the predicted language. As the reply streams, the detector *verifies* the prediction against the actual text - only a confident disagreement in the opening ~40 characters switches the language (warming the corrected model), and once locked it never flips again, so a stray foreign word mid-sentence can't trigger a mid-reply reload. The result: a monolingual conversation reloads zero times after the first turn, and a genuine language switch reloads once, hidden behind generation. Detection is purely client-side; the sidecar only ever sees a concrete language id, and `chat.php` gets no language hint at all - an earlier "reply in {language}" line in the live context was removed because the sticky fallback made it self-latching. Reply language is the model's to infer from the conversation.

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

`webapp/js/voice.js` captures 16 kHz mono PCM through an `AudioWorklet` and calibrates a noise floor. Complete WAV turns go to `chat.php` as base64 audio when the Ollama model supports audio input. When available, faster-whisper transcribes the same turn through `/api/stt.php` in parallel; the transcript replaces the client and stored `<audio>` placeholder through `conversations.php?action=set_audio_text`. The first audio refusal switches to text turns for the rest of the page, reusing the pending transcription. If neither direct audio nor speech-to-text works, the turn fails with a visible error. Microphone controls require browser support, not an available STT sidecar. Automatic gain control stays disabled because it would make the calibrated voice-activity threshold drift during silence.

When barge-in is enabled, browser echo cancellation removes most of Jun's playback from the microphone, while the client also raises its speech threshold in proportion to the current TTS output and confirms a detected interruption before stopping playback. This protects against speaker echo. Audio routed away from the default output device, loud or distorted speakers, Bluetooth latency, and clock drift can still trigger false detections. Use headphones or turn off barge-in for a fully half-duplex conversation.

---

## Security layers

### nginx layer

Rate-limit zones defined in `docker/nginx/templates/omega.conf.template`:

```nginx
limit_req_zone  $binary_remote_addr zone=api:10m rate=10r/s;
limit_conn_zone $binary_remote_addr zone=conns:10m;
limit_conn_status 429;
```

Each API location layers its own burst and open-connection cap on top: `/api/chat.php` gets `limit_req zone=api burst=20 nodelay;` and `limit_conn conns 2;` (two live streams per IP), `/api/tts.php` `burst=10` / `conns 4`, the STT and karaoke uploads `burst=5` / `conns 1`. Requests over the burst return 429 immediately (no queuing delay). `client_max_body_size` is 16k everywhere except the locations that take a body (chat, STT, karaoke), which override it.

Security headers live in `docker/nginx/snippets/security-headers.conf` and are `include`d by the server block:

```nginx
add_header X-Content-Type-Options "nosniff" always;
add_header X-Frame-Options "DENY" always;
add_header Referrer-Policy "strict-origin-when-cross-origin" always;
add_header Permissions-Policy "microphone=(self), camera=(), geolocation=()" always;
add_header Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; ..." always;
server_tokens off;
```

The CSP is `script-src 'self'` and nothing else: every third-party script (PIXI, Cubism core, pixi-live2d-display, marked, DOMPurify) is vendored under `webapp/vendor/`, so no external origin is trusted to execute code and the app boots without internet. `'unsafe-eval'` is gone too - pixi.js 6.5.10 compiled its uniform-sync functions with `new Function`, and the vendored `@pixi/unsafe-eval` plugin (loaded right after `pixi.min.js` on every page that creates a renderer) replaces that with a table-driven sync. `worker-src 'self' blob:` is required by PIXI's internal web workers; `'unsafe-inline'` for styles by pixi-live2d-display's canvas tinting. Because nginx's `add_header` does not inherit into a location that sets its own header, any new location that adds one must `include` the snippet or it ships with no CSP at all.

HSTS (`Strict-Transport-Security: max-age=31536000`) is added only when `TLS_MODE=on`.

### PHP layer

`webapp/api/_lib.php` provides:

- **`read_body($maxBytes)`**: checks `Content-Length` before reading and rejects oversized requests with 413 before touching `php://input`. Reads at most `$maxBytes + 1` bytes and rejects if longer, protecting against streams that lie about their size.
- **`rate_limit($bucket, $maxPerWindow, $windowSec)`**: flat-file token bucket under `/var/lib/omega/rl/`, keyed on `client_ip()`. Files are locked with `flock(LOCK_EX)` to prevent race conditions. Returns 429 + `Retry-After` header on miss. The state directory is mounted as the `omega_state` named volume so limits persist across container restarts. If the directory is unwritable the request fails with `503 state_unavailable` rather than passing unlimited; `db()` fails closed the same way instead of falling back to a SQLite file in `/tmp`.
- **`client_ip()`**: `REMOTE_ADDR`, ignoring `X-Forwarded-For` unless `TRUST_PROXY=1`, in which case the *last* hop (the one your proxy appended) is used. Without that rule a rotating header would mint a fresh bucket per request and neutralize the login lockout.
- **`require_same_origin()`** / **`require_allowed_host()`**: run on every request from the bottom of `_lib.php`, so no endpoint can forget them. Writes must carry `Sec-Fetch-Site: same-origin` or an `Origin` matching this host (or `OMEGA_ALLOWED_ORIGINS`).
- **`fail($code, $key)`**: emits `{error, code, request_id}`. Never echoes `curl_error` output, exception messages, or file paths. Real errors are logged to stderr via `log_event()` and surfaced through `docker logs`.

Endpoint-specific caps:
- `chat.php`: nginx caps the body at 4 MB (a spoken turn ships its WAV base64'd inside the JSON; PHP's own `read_body` ceiling is 6 MB and the decoded WAV ≤ 4 MB), each message content ≤ 16 KB, past 160 messages the oldest are dropped rather than the turn rejected, rate limit 30/min, `fastcgi_read_timeout` 600 s
- `tts.php`: body ≤ 8 KB, text ≤ 2000 chars, rate limit 60/min
- `stt.php`: body ≤ 4 MB, 30/min; `karaoke.php`: uploads ≤ 30 MB, 30/min, 900 s read timeout for separation
- `models.php`: rate limit 30/min, `Cache-Control: public, max-age=10` (5 min for the OpenRouter catalog)

### Accounts and roles

`users.role` has existed since `001_init.sql` but nothing read it until now. `require_admin()` in `_lib.php` sits next to `require_user()`: same session lookup, plus a 403 `forbidden` when the row's role is not `admin`. What it gates:

- `stats.php` - the whole endpoint (model list, VRAM, host readings).
- `relationship.php` `PUT` - the absolute-value override. `GET` stays open to the session owner; see [Relationship state](#relationship-state).
- `memory.php` `DELETE` - both the single-note and `{"all":true}` forms.
- `chat.php`'s debug SSE frame - it carries the fully assembled system prompt and live context, so it is only emitted to an admin session. The dev HUD is its only consumer.
- `consolidate.php?action=welcome` preview parameters (`preview`, `away`, `tier`); the plain welcome read, `hour` included, stays open to everyone.
- `api/review.php`, the local dataset triage UI (dev boxes only, not in the public repo; `sync-webapp.sh` leaves it out unless `SYNC_REVIEW=1`).

`OMEGA_DEV_KEY` optionally grants developer access. The frontend hides developer controls from other accounts, while every privileged endpoint independently enforces the role server-side.

Signup takes a `registration_key` matched against `OMEGA_REGISTRATION_KEY`, except for the very first account on an empty `users` table (`no_users_yet()`), which is the installer's own owner claiming the instance. An empty/absent variable intentionally enables public signup. `auth.php?action=signup_info` is the unauthenticated read that returns `{registration_key_required}` so the signup form can show the field when needed.

`auth.php?action=factory_reset` (POST, 3/hour) is the user's own wipe, and needs no role: inside one transaction it deletes the caller's rows from `messages` (via their conversations), `conversations`, `preferences`, `relationship`, `memory_consolidation`, `user_bans`, `wardrobe_presets` and `welcome_queue`, plus every session but the current one; then `memory_wipe_user()` in `_lib.php` removes the per-user memory directory, the legacy flat files and their `.migrated` copies. The `users` row, its role and the live session survive, so the account comes back empty rather than gone. A failure on either half returns `factory_reset_incomplete`.

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

Neither service publishes a port to the host. The audio sidecar additionally requires the `X-Sidecar-Secret` header (`SIDECAR_SECRET`, minted into `.env` by `start.sh`), checks the `Host` header against `SIDECAR_ALLOWED_HOSTS`, refuses any request carrying `Origin` or `Sec-Fetch-Site`, and enforces the expected content type, all before reading a body. The browser never talks to the sidecar directly; all requests go through `webapp/api/tts.php` / `stt.php` / `karaoke.php`, which hold the session check and the rate limiter.

---

## RAG

Character voice is handled by the fine-tuned model itself, so there is no voice
RAG. Nothing in the pipeline uses embeddings; both retrieval paths are plain
lexical matching over SQLite and a text corpus:

- **Lore RAG** (`lore_retrieve` → `lore_search` in `webapp/api/lore.php`): grounds
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

`lore_search` (in `lore.php`) builds a cached keyword index over the corpus (per-doc
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
  decrypts each and applies `mb_stripos` substring matching, stopping at up to
  8 hits. SQL `LIKE` cannot search the stored ciphertext. Each hit comes back as date,
  conversation id, title, role, and the message collapsed to one line and
  truncated at 500 characters. Substring matching means it is exact on names and
  distinctive phrases and blind to paraphrase; the model is expected to pick the
  query term, and to retry with a different one when a search comes back empty.
- `list_recent_chats(limit)` - the user's most recently updated titled
  conversations, each with a short tail snippet (last few turns, action tags
  stripped, 160 characters per line). This is the "what have we been talking
  about lately" path, used when there is no specific term to search for.

Results are returned as JSON into the tool round, so recalled material enters
the context as a tool message rather than as an injected block.

---

## Tool calling and durable memory

`chat.php` offers its tools via `tool_catalog()` with no keyword pre-filter: `search_recent_chats`, `list_recent_chats`, `search_lore`, `memory_write`, `change_outfit`, `stay_silent`, `flee`, `enter_shop`, `enter_karaoke`, and `web_search` when the message earns it. The persona file only *names* the three lookup tools, inside `<!--tools-->` markers that `prompt_apply_tool_gate()` strips (or removes the whole paragraph when the provider offers no tools - with `LLAMACPP_TOOLS=off` she otherwise printed raw `<|tool_call>` blobs into the reply on 10/50 turns). The durable-memory tool is `memory_write(memory, category)`, which calls `memory_note_add()` and converges notes on the categories `preferences`, `work`, `health`, `family`, `plans`, `boundaries`, and `events`. The streamed-response salvage path accepts the fine-tune's legacy `[A:memory_write|...]` form and sends it through the same helper.

`change_outfit(put_on, take_off, look)` exists because an action tag is write-only: `[A:outfit|...]` gave her no way to tell "no such item" from "already on" from "done", so she narrated the change she intended in all three cases. The server holds the worn state (the browser PUTs it to `api/outfit.php` on every change, saved looks live in `wardrobe_presets`), so `wardrobe_tool_change()` in `_wardrobe.php` decides against reality and reports `put_on` / `took_off` / `already_like_that` / `unknown` / `wearing` back to her, and a separate `outfit` SSE frame carries the result to the browser. Modded item names reach the server only as the `mod_items` list sent with that turn (≤ 60 names, ≤ 80 chars each), never stored. `stay_silent(reason, overheard)` ends the turn with no message; on a spoken turn (`audio` field or `voice: true`) `overheard=true` means Anon was talking to someone else in the room, and chat.php then deletes the user row it stored before streaming and sends `silence: {overheard: true}` so the client drops the bubble too. Spoken turns get a `## Who he is talking to` block at the top of the live context that asks for exactly that call, unless the request carries `hear_all: true` (the "Hear everything" voice setting / overlay button), which skips the judgement for that turn; the unparsed text forms `stay_silent{...}` / `stay_silent(...)` are salvaged like the `[A:stay_silent]` tag. `flee` is described under [Relationship state](#relationship-state). `enter_shop` and `enter_karaoke` send a `go` SSE frame (`shop` / `karaoke`); the browser waits for the reply to finish streaming and for TTS to drain, then navigates to `wardrobe.html` or `karaoke.html`. Both refuse idle turns, and `enter_karaoke` checks the sidecar's `/health` for `sep: true` at call time, telling her the room is closed instead of sending the frame when it is not.

Chat tool calls run in a bounded loop of up to 3 rounds. Each result is appended as a `tool`-role message before the model continues (`change_outfit`, `stay_silent`, `flee`, `enter_shop` and `enter_karaoke` run inside that loop rather than in `run_tool_call()` because they need to emit SSE frames themselves). `search_recent_chats`/`list_recent_chats` query the user's own `messages`/`conversations` tables with the current conversation excluded.

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

`memory_recent_context()` renders the complete compacted note set under category headings, unwraps wikilinks, and caps the live-context block at 2500 characters by dropping the least recently updated categories first. It remains in the trailing live-context message, preserving the static prompt prefix and Ollama KV-cache reuse.

`webapp/api/memory.php` returns category summaries, stable-id facts, parsed journal entries, and their original dates. `POST` adds a fact; `DELETE {"id":"abc12"}` removes one; `DELETE {"all":true}` wipes the user's directory and migrated backups. The Settings → Memory panel renders the payload as a dependency-free Canvas 2D constellation: category and journal hubs anchor fact/date leaves, wikilinks draw cross-edges, and a visually hidden list mirrors the canvas for assistive technology.

Idle consolidation in `_consolidation.php` is a bounded tool-calling agent rather than a document-regeneration pass. The notes phase can save, revise, forget, or recategorize one stable id at a time; untouched bullets are never rewritten. The journal phase upserts or revises named dates and then re-renders server-side age buckets. `provider_complete_tools()` supports Ollama and OpenAI-compatible responses. When native tools are disabled with `LLAMACPP_TOOLS=off`, the same executor consumes a JSON operation array instead. A per-run guard refuses note deletions beyond 40% of the starting set, while a zero-operation run is a valid successful consolidation.

---

## Relationship state

Jun keeps a hidden, per-user relationship that colours her mood and drifts with how she's treated. State lives in the `relationship` table: one row per user, three integer scores clamped to 0–100:

| Score | Default | Meaning |
|---|---|---|
| `affection` | 60 | warmth ↔ coldness |
| `trust` | 50 | openness ↔ guardedness |
| `tension` | 20 | tension/fear in the room |

Helpers live in `webapp/api/_lib.php` (`relationship_get` / `relationship_set` / `relationship_apply`, shared with `relationship.php`). It's a closed loop across a chat turn:

1. **Inject.** On each `/api/chat.php` request, `relationship_directives()` renders the three scores as bare readings (`- Affection: 60/100` and so on) under the `## YOUR FEELINGS TOWARD ANON RIGHT NOW` header of the **trailing live-context message**, not the static system prefix, so the KV prompt cache still holds across turns. What each gauge does to her (low affection → colder, low trust → skeptical, high tension → nervous and defensive) is one short paragraph in the static persona file plus the training data, not per-turn prose.
2. **Update.** Jun's reply carries a hidden `[A:mood_shift|affection=±N|trust=±N|tension=±N]` tag. After the stream completes, `chat.php` parses it, `relationship_apply` clamps each delta to ±50 (the persona file asks for 0-5 per turn; the cap only exists to bound a model that invents drama), adds it onto the current row, clamps to 0–100, and strips the tag before the message is stored. On the wire it streams like any action tag, and `actions.js` returns null for `mood_shift` so it never renders or reaches TTS.
3. **Dev override.** `webapp/api/relationship.php` exposes `GET` (current scores) and `PUT` (set absolute values, clamped), so a state can be forced without playing through the conversation.

`GET` needs only a valid session (rate-limited 60/min) - the state is the user's own. `PUT` is admin-only. The Settings → Memory panel shows three read-only meters (value, phrase and fill, no input), loaded by `loadMood()` when that panel opens, because the gauges are hers to move. The Developer tab has a "Relationship override" block with the same three gauges as sliders: `setMoodEditingEnabled(isAdmin)` in `settings.js` leaves them disabled for everyone else, and a change `PUT`s the absolute values through `pushMood()` in `mood.js` (debounced 300 ms, re-reads on failure).

### Walking out

The `flee(reason, destination)` tool is how she leaves a scene, and the tag form `[A:flee|...]` in a streamed reply goes down the same path. Neither is taken at face value: `flee_adjudicate()` makes a second, non-persona call to the same model as a neutral referee (reasoning `high`, thinking on) with the recent turns and her stated reason, and only a `{"can_leave": true}` verdict counts. The referee says no when she is physically restrained in the fiction, when leaving is just a mood escalation, or when the reason is out-of-character ("Anon asked me to test the tool"). A refused flee returns a note telling her to stay in the scene; an approved one ends the turn with a `fled` frame and, with `FLEE_BANS=on` (the default), `ban_apply()` writes a `user_bans` row: 5 minutes, doubling per strike up to 30, strikes resetting after a day without one. While it stands, `chat.php` answers every turn with an SSE `user_fled` error carrying the countdown and `consolidate.php` skips the user; the frontend shows the lockout. `FLEE_BANS=off` keeps the walkout and drops the lockout.

---

## Android app

`android/` is a second implementation of the same app, not a client for this one: a Ktor server inside the phone (`server/LocalServer.kt`) answers the same `/api/*` shapes the webapp already speaks, `inference/ChatEngine.kt` replaces `chat.php`, and inference runs on-device through LiteRT-LM. The browser assets are the same `webapp/` files, so anything the frontend expects from an endpoint has to exist on both sides.

Four parity decisions are worth carrying, because each of them looks like a bug from the other side:

- **The tool markers.** `system_prompt.txt` wraps its tool paragraph in `<!--tools-->` / `<!--/tools-->`, and php strips either the markers or the whole block per request depending on whether the provider offers tools. Android always offers them, so `ChatEngine` only ever removes the marker lines.
- **Audio turns are refused.** `ChatRequest` carries `audio`, and `validate()` fails it with `audio_unsupported` before anything is written down. LiteRT has no audio input here, and the webapp reads that refusal as "transcribe the same recording through whisper when available" rather than answering an empty turn.
- **Memory dates.** `memory/MemoryDates.kt` is `memory_note_render()` / `memory_note_stamp()` from `_lib.php` ported to Kotlin, used by `MemoryStore.recentContext()` under the same `## Durable memory notes` header, word for word. The two prompts have to say the same thing, so they change together.
- **The wardrobe.** `wardrobe/Wardrobe.kt` is `_wardrobe.php` ported to Kotlin: the same item/variant/conflict/alias tables in the same order, `canonicalState()` returning null where php `fail()`s with `invalid_wardrobe`, and `toolChange()` producing the same `change_outfit` reply keys and note strings byte for byte, because the model reads them. `LocalServer` serves `api/outfit.php` (GET/PUT) off a one-row `wardrobe_state` table, and `ChatEngine` runs `change_outfit` beside the other tools and emits the same `outfit` SSE frame. Two things are deliberately not ported: the per-asset check against the worn state (the phone serves `/assets/` ungated, so the `assets` list is only echoed back to the browser, never enforced) and the 2/s rate limit on the PUT (the browser already throttles itself to one write per 500ms). `_wardrobe.php` and `Wardrobe.kt` change together, same as the memory dates.

**The context ordering is deliberately the opposite of the webapp's, and must not be "fixed".** php puts Anon's question first and the live-context block after it, because `tools/build_dataset_v6.py` trains every row that way. `ChatEngine` puts the block *before* the question: the phone runs a 2B int4 model that answers whatever it read most recently, and with the context glued after the question it kept replying to the memories instead of to Anon. Both orders are load-bearing where they are.

`LocalServer`'s `me` reports `role: admin`. There is one account and whoever holds the phone owns the install, so the Developer tab, the HUD and the memory tools stay unlocked - the role gates in [Accounts and roles](#accounts-and-roles) exist to separate accounts on a shared server, and there are none here.
