# Jun OS architecture

This document is the long-form reference for the system. For a quick orientation see the README.

---

## Component diagram

```
                          ┌─────────────────────────────────────────────────┐
                          │  Docker network: omega_default                  │
                          │                                                 │
  ┌──────────┐  HTTP/SSE  │  ┌─────────┐  FastCGI  ┌──────────┐             │
  │          │ ────────── │─▶│  nginx  │ ─────────▶│ php-fpm  │             │
  │ Browser  │            │  │ :80/443 │           │   :9000  │             │
  │          │◀────────── │──│         │           └────┬─────┘             │
  └──────────┘            │  │  static │                 │  HTTP            │
                          │  │  files  │                 ├──────────────── ▶│ ollama :11434
                          │  └─────────┘                 │                  │
                          │                              ├──────────────── ▶│ tts :8001
                          │                              └──────────────── ▶│ karaoke :8001
                          └─────────────────────────────────────────────────┘

  Volumes: ollama_data, llamacpp_cache, tts_cache, karaoke_cache, omega_state, letsencrypt, certbot_webroot
  Optional (profile=karaoke): karaoke sidecar for stem separation
  Optional (profile=prod): certbot sidecar for Let's Encrypt issuance + renewal
```

nginx serves static files from `/var/www/omega/` and FastCGI-proxies `*.php` requests to the php-fpm container. Ollama and the audio sidecars are internal-only; their ports are not published to the host. The voice sidecar on `:8001` fronts two swappable engines, Kokoro-82M (default) and kyutai pocket-tts, selected per request. Under Docker the `tts` service always runs - there is no compose `voice` profile; the `VOICE=on/off` env var only gates the bare-metal Windows launcher (`start.ps1`), which skips spawning the sidecar process when it's off. php and the frontend degrade gracefully to text-only whenever the sidecar is absent or unhealthy.

Karaoke stem separation runs the *same* `tts/server.py` in a second container (`profiles: [karaoke]`, `SIDECAR_ROLE=karaoke`) built from `docker/karaoke.Dockerfile`: demucs and a CUDA/ROCm torch, no Kokoro or pocket-tts. The split exists so the two can want different hardware - separation is minutes on CPU versus seconds on a GPU, while voice synthesis is real-time on CPU and a GPU copy would only take VRAM away from the LLM. Each image installs only its own dependencies, and `server.py`'s `_stt_available()`/`_sep_available()` probes turn a missing one into a 503 rather than a crash, so the shared file is safe in both roles. Bare-metal installs (Windows, Colab) run a single process that serves both, which is why `api/karaoke.php` falls back to `TTS_URL` when `KARAOKE_URL` is unset.

On a multi-GPU host the launcher decides which card the model server gets: `start.sh` orders the GPUs by VRAM and passes that order down as `CUDA_VISIBLE_DEVICES` (or the ROCm/Vulkan equivalents), so the largest card is device 0, and `TENSOR_PARALLEL=on` additionally lets one model span every card. See [configuration.md](configuration.md) §9 for the full set of knobs and the derived variables.

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
       │  order, question first then the block, so it is not free to swap
       │
       │  curl CURLOPT_WRITEFUNCTION ──────── NDJSON stream ──────▶ ollama /api/chat
       │  (per-chunk callback)                                       (HTTP/1.1, streaming)
       │
       │  for each NDJSON chunk:
       │    extract token from JSON
       │    echo 'data: {"token":"..."}\n\n'
       │    flush()
       │
       │  after the stream ends: parse the hidden relationship bookkeeping tag
       │  from the full reply, clamp+apply its affection/trust/tension deltas to
       │  the user's row, and strip the tag so it never reaches the browser
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

Reasoning effort (`low`/`medium`/`high`/`auto` → `route_reasoning()`) is forwarded upstream only for OpenRouter, as a `reasoning.effort` field on the request; Ollama gets `think`/`reasoning_effort` options instead, and llama.cpp gets neither (its context is fixed server-side).

llama.cpp tool support is gated by `LLAMACPP_TOOLS` (`provider_tools_enabled()` in `providers.php`) since not every chat template handles tool calling. Independent of that flag, `chat.php` has a runtime fallback: if the first streamed round comes back as an HTTP 4xx from an OpenAI-style provider, it strips `tools` from the payload and retries the same round once before giving up - this is what recovers automatically from a llama-server template that rejects the `tools` field.

---

## Action extraction state machine

`makeStreamBuffer` in `webapp/js/app.js` is a streaming state machine that intercepts action tags before they reach the chat renderer. Two syntaxes are recognized: the compact `[A:name|value|value]` form the prompt now asks for (positional values, mapped to kwargs via the `POS_KEYS` table in `actions.js`, with omitted kwargs filled from `DEFAULTS`), and the legacy `[ACTION:name|key=value|...]` form still present in stored history and the fine-tune's training data.

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

Malformed or unrecognised tags are logged to the debug panel and silently dropped.

### Name templating stage

The clean text emerging from the action buffer passes through a second streaming filter, `makeNameFilter` in `webapp/js/app.js`, before it reaches the chat renderer and TTS. It resolves `{f_playerName}` / `{f_botName}` placeholders to the user's chosen names (via `webapp/js/names.js`). Like the action marker holdback, it buffers a trailing *partial* placeholder across token chunks, so a split like `"{f_play"` + `"erName}"` substitutes cleanly and never flashes its raw form in the chat or gets read aloud by TTS.

---

## Live2D engine internals

`webapp/js/live2d.js` wraps `pixi-live2d-display` with direct parameter control.

### Disabling internal updaters

pixi-live2d-display ships motion, expression, breath, eyeBlink, physics, pose, and focusController subsystems. All are disabled after model load:

```js
model.internalModel.motionManager.destroy();
model.internalModel.expressionManager.destroy();
// ... etc.
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

The language picker also has an **Auto-detect** option (the default), which routes each reply to the right pocket-tts language while keeping reloads rare and off the critical path. On send, `js/tts.js` runs a dependency-free stopword detector over **Anon's message** to predict the reply's language, falling back to the *previous* conversation language (not English) when the message is too short or ambiguous to call. That prediction drives three things in parallel: `app.js` fires `POST /api/tts.php?action=warm` → the sidecar's `/warm` (which preloads that language's checkpoint and voice state off-thread, so the reload overlaps LLM generation instead of stalling the first audio chunk); `chat.php` appends a one-line "reply in {language}" instruction to the trailing live-context message (non-English only - English is Jun's default and needs none); and the client locks the reply to the predicted language. As the reply streams, the detector *verifies* the prediction against the actual text - only a confident disagreement in the opening ~40 characters switches the language (warming the corrected model), and once locked it never flips again, so a stray foreign word mid-sentence can't trigger a mid-reply reload. The result: a monolingual conversation reloads zero times after the first turn, a genuine language switch reloads once (hidden behind generation), and the system-prompt instruction is only a nudge - the TTS router always trusts the reply text over it. Detection is purely client-side; the sidecar only ever sees a concrete language id.

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

`webapp/js/voice.js` captures 16 kHz mono PCM through an `AudioWorklet`, calibrates a noise floor, and sends complete turns as WAV uploads to `/api/stt.php`. The voice sidecar transcribes those uploads with faster-whisper. Automatic gain control stays disabled because it would make the calibrated voice-activity threshold drift during silence.

When barge-in is enabled, browser echo cancellation removes most of Jun's playback from the microphone, while the client also raises its speech threshold in proportion to the current TTS output and confirms a detected interruption before stopping playback. This protects against speaker echo. Audio routed away from the default output device, loud or distorted speakers, Bluetooth latency, and clock drift can still trigger false detections. Use headphones or turn off barge-in for a fully half-duplex conversation.

---

## Security layers

### nginx layer

Rate-limit zones defined in `docker/nginx/templates/omega.conf.template`:

```nginx
limit_req_zone $binary_remote_addr zone=api:10m rate=10r/s;
limit_conn_zone $binary_remote_addr zone=conns:10m;
```

The `/api/chat.php` location uses `limit_req zone=api burst=20 nodelay;`. Requests that exceed the burst return 429 immediately (no queuing delay).

Security headers applied to all responses:

```nginx
add_header X-Content-Type-Options "nosniff" always;
add_header X-Frame-Options "DENY" always;
add_header Referrer-Policy "strict-origin-when-cross-origin" always;
add_header Permissions-Policy "microphone=(), camera=(), geolocation=()" always;
add_header Content-Security-Policy "..." always;
server_tokens off;
```

The CSP allows scripts only from `'self'`, `cdn.jsdelivr.net`, and `cubism.live2d.com` (CDN sources for PIXI and the Cubism SDK). `worker-src blob:` is required by PIXI's internal web workers. `'unsafe-inline'` for styles is required by pixi-live2d-display's canvas tinting.

HSTS (`Strict-Transport-Security: max-age=31536000`) is added only when `TLS_MODE=on`.

### PHP layer

`webapp/api/_lib.php` provides:

- **`omega_read_body($maxBytes)`**: checks `Content-Length` before reading and rejects oversized requests with 413 before touching `php://input`. Reads at most `$maxBytes + 1` bytes and rejects if longer, protecting against streams that lie about their size.
- **`omega_rate_limit($bucket, $maxPerWindow, $windowSec)`**: flat-file token bucket under `/var/lib/omega/rl/`. Files are locked with `flock(LOCK_EX)` to prevent race conditions. Returns 429 + `Retry-After` header on miss. The state directory is mounted as the `omega_state` named volume so limits persist across container restarts.
- **`omega_json_error($code, $machineMsg)`**: emits `{error, code, request_id}`. Never echoes `curl_error` output, exception messages, or file paths. Real errors are logged to stderr via `omega_log` and surfaced through `docker logs`.

Endpoint-specific caps:
- `chat.php`: body ≤ 256 KB, messages ≤ 80, each content ≤ 16 KB, rate limit 30/min
- `tts.php`: body ≤ 8 KB, text ≤ 2000 chars, rate limit 60/min
- `models.php`: rate limit 30/min, `Cache-Control: public, max-age=10`

### Accounts and roles

`users.role` has existed since `001_init.sql` but nothing read it until now. `require_admin()` in `_lib.php` sits next to `require_user()`: same session lookup, plus a 403 `forbidden` when the row's role is not `admin`. What it gates:

- `stats.php` - the whole endpoint (model list, VRAM, host readings).
- `relationship.php` `PUT` - the absolute-value override. `GET` stays open to the session owner; see [Relationship state](#relationship-state).
- `memory.php` `DELETE` - both the single-note and `{"all":true}` forms.
- `chat.php`'s debug SSE frame - it carries the fully assembled system prompt and live context, so it is only emitted to an admin session. The dev HUD is its only consumer.
- `consolidate.php?action=welcome` preview parameters (`preview`, `away`, `tier`, `hour`); the plain welcome read stays open to everyone.
- `api/review.php`, the local dataset triage UI (untracked, dev boxes only).

Promotion is a POST to `auth.php?action=promote` with `{"key": …}`, compared against `OMEGA_ADMIN_KEY` with `hash_equals` and rate-limited to 5 attempts an hour; success and failure both log an event. An empty key disables promotion entirely. `auth.php`'s `me`, `signup` and `login` responses all carry `role`, and the frontend uses it only to decide what to draw - `applyRoleGates()` in `js/app/settings.js` hides the Developer tab, the delete-all-memories button and the DEV badge, and `app.js` leaves `js/devhud.js` out of the lazy script list entirely for a non-admin, which is what stops `Ctrl+Shift+D` from doing anything. None of that is a security boundary: every gate above is enforced server-side, and the role must never be sourced from preferences or local storage.

Signup takes a `registration_key` matched against `OMEGA_REGISTRATION_KEY` for every account, including the first. An empty/absent variable intentionally enables public signup. `auth.php?action=signup_info` is the unauthenticated read that returns `{registration_key_required}` so the signup form can show the field when needed.

`auth.php?action=factory_reset` (POST, 3/hour) is the user's own wipe, and needs no role: inside one transaction it deletes the caller's rows from `messages` (via their conversations), `conversations`, `preferences`, `relationship`, `memory_consolidation`, `user_bans`, `wardrobe_presets` and `welcome_queue`, plus every session but the current one; then `memory_wipe_user()` in `_lib.php` removes the per-user memory directory, the legacy flat files and their `.migrated` copies. The `users` row, its role and the live session survive, so the account comes back empty rather than gone. A failure on either half returns `factory_reset_incomplete`.

### Sidecar/Ollama isolation

Neither service publishes a port to the host. The audio sidecar additionally enforces `CORS_ORIGIN` via FastAPI `CORSMiddleware`; the browser never talks to the sidecar directly; all requests go through `webapp/api/tts.php` / `stt.php`.

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

### Lore RAG (`## World facts (canon)`)

The fine-tune gives Jun her voice but blurs or invents specific world details, so
canon facts are retrieved instead of baked in.

The corpus is `tools/lore_dataset.jsonl`: curated game-lore Q&A in neutral wiki
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

- `search_recent_chats(query, limit)` - a `content LIKE '%query%'` scan over the
  user's messages, newest first, up to 8 hits. Each hit comes back as date,
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

`chat.php` offers its tools via `tool_catalog()` with no keyword pre-filter. The durable-memory tool is `memory_write(memory, category)`, which calls `memory_note_add()` and converges notes on the categories `preferences`, `work`, `health`, `family`, `plans`, `boundaries`, and `events`. The streamed-response salvage path accepts the fine-tune's legacy `[A:memory_write|...]` form and sends it through the same helper.

Chat tool calls run in a bounded loop of up to 3 rounds. Each result is appended as a `tool`-role message before the model continues. `search_recent_chats`/`list_recent_chats` query the user's own `messages`/`conversations` tables with the current conversation excluded.

`web_search` is offered only when the latest user message begins with `/search `. The server ignores the model's query argument and transmits the exact user-approved text after that prefix, once. It then goes through `web_search_public()` → DuckDuckGo's HTML results page, parsed for result links/snippets. It and redirect hops (`web_fetch_public()`, up to 3 redirects, 512 KB cap) are guarded by `resolve_public_http_url()`: DNS A/AAAA records must all be public, userinfo and non-standard ports are rejected, and only `http`/`https` are allowed.

Durable memories live under `MEMORY_DIR` (default `<state dir>/memory`, i.e. `/var/lib/omega/memory`) in an Obsidian-compatible per-user directory:

```text
user-{id}/
  preferences.md
  work.md
  journal.md
  meta.json
```

Each category file has a Markdown heading and one bullet per fact. PHP appends a stable five-character `^blockid` to every bullet; optional `[[category]]` wikilinks become cross-category graph edges. `meta.json` maps block ids to created/updated timestamps so note files remain clean and hand-editable. Mutations serialize through a per-user write lock, and each file replacement uses backup → temporary file → rename. A separately locked lazy migration triggers when either legacy artifact exists, groups former `user-{id}.jsonl` entries into category files, preserves their timestamps, moves the journal, and renames the legacy files to `*.migrated`.

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

1. **Inject.** On each `/api/chat.php` request, `relationship_directives()` turns the three scores into plain-language behavior guidance (e.g. affection toward 0 → cold, irritated, withhold warmth, skip affectionate actions; ~50 → normal warm-girlfriend; toward 100 → deeply smitten, initiates closeness). This is appended to the **trailing live-context message**, not the static system prefix, so the KV prompt cache still holds across turns. The prompt tells her to interpolate her own warmth/trust/fear from the numbers, never to recite them, and never to reveal her feelings are scored.
2. **Update.** Jun's reply carries a hidden relationship bookkeeping tag with per-score *deltas*. After the stream completes, `chat.php` parses it, `relationship_apply` adds the deltas onto the current row and clamps to 0–100, and the tag is stripped so it never reaches the browser (nor TTS).
3. **Dev override.** `webapp/api/relationship.php` exposes `GET` (current scores) and `PUT` (set absolute values, clamped), so a state can be forced without playing through the conversation.

`GET` needs only a valid session (rate-limited 60/min) - the state is the user's own. `PUT` is admin-only and has no UI left: the mood switcher's sliders are gone. What the Settings → Memory panel shows now is three read-only meters (value, phrase and fill, no input), loaded by `loadMood()` when that panel opens, because the gauges are hers to move. Forcing a value is an admin doing it by hand against the endpoint.

---

## Android app

`android/` is a second implementation of the same app, not a client for this one: a Ktor server inside the phone (`server/LocalServer.kt`) answers the same `/api/*` shapes the webapp already speaks, `inference/ChatEngine.kt` replaces `chat.php`, and inference runs on-device through LiteRT-LM. The browser assets are the same `webapp/` files, so anything the frontend expects from an endpoint has to exist on both sides.

Three parity decisions are worth carrying, because each of them looks like a bug from the other side:

- **The tool markers.** `system_prompt.txt` wraps its tool paragraph in `<!--tools-->` / `<!--/tools-->`, and php strips either the markers or the whole block per request depending on whether the provider offers tools. Android always offers them, so `ChatEngine` only ever removes the marker lines.
- **Audio turns are refused.** `ChatRequest` carries `audio`, and `validate()` fails it with `audio_unsupported` before anything is written down. LiteRT has no audio input here, and the webapp reads that refusal as "record it again through whisper" rather than answering an empty turn.
- **Memory dates.** `memory/MemoryDates.kt` is `memory_note_render()` / `memory_note_stamp()` from `_lib.php` ported to Kotlin, used by `MemoryStore.recentContext()` under the same `## Durable memory notes` header, word for word. The two prompts have to say the same thing, so they change together.

**The context ordering is deliberately the opposite of the webapp's, and must not be "fixed".** php puts Anon's question first and the live-context block after it, because `tools/build_dataset_v6.py` trains every row that way. `ChatEngine` puts the block *before* the question: the phone runs a 2B int4 model that answers whatever it read most recently, and with the context glued after the question it kept replying to the memories instead of to Anon. Both orders are load-bearing where they are.

`LocalServer`'s `me` reports `role: admin`. There is one account and whoever holds the phone owns the install, so the Developer tab, the HUD and the memory tools stay unlocked - the role gates in [Accounts and roles](#accounts-and-roles) exist to separate accounts on a shared server, and there are none here.
