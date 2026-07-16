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
                          │                              └──────────────── ▶│ tts :8001
                          └─────────────────────────────────────────────────┘

  Volumes: ollama_data, llamacpp_cache, tts_cache, omega_state, letsencrypt, certbot_webroot
  Optional (profile=prod): certbot sidecar for Let's Encrypt issuance + renewal
```

nginx serves static files from `/var/www/omega/` and FastCGI-proxies `*.php` requests to the php-fpm container. Ollama and the voice sidecar are internal-only; their ports are not published to the host. The voice sidecar on `:8001` fronts two swappable engines, Kokoro-82M (default) and kyutai pocket-tts, selected per request. Under Docker the `tts` service always runs — there is no compose `voice` profile; the `VOICE=on/off` env var only gates the bare-metal Windows launcher (`start.ps1`), which skips spawning the sidecar process when it's off. php and the frontend degrade gracefully to text-only whenever the sidecar is absent or unhealthy.

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
       │  appends a trailing "live context" system message AFTER the history
       │  (clock, lore facts, recalled prior context, wardrobe, gauges) so the
       │  static prefix + history stay in Ollama's KV prompt cache between turns
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

Embeddings for RAG/recall always go to Ollama's `nomic-embed-text`, independent of the chat provider — `embeddings_base_url()` defaults to `OLLAMA_URL` but can be pointed elsewhere via `EMBEDDINGS_URL`; `EMBEDDINGS` (on/off) gates the feature and defaults to on only when `AI_PROVIDER=ollama`.

Reasoning effort (`low`/`medium`/`high`/`auto` → `route_reasoning()`) is forwarded upstream only for OpenRouter, as a `reasoning.effort` field on the request; Ollama gets `think`/`reasoning_effort` options instead, and llama.cpp gets neither (its context is fixed server-side).

llama.cpp tool support is gated by `LLAMACPP_TOOLS` (`provider_tools_enabled()` in `providers.php`) since not every chat template handles tool calling. Independent of that flag, `chat.php` has a runtime fallback: if the first streamed round comes back as an HTTP 4xx from an OpenAI-style provider, it strips `tools` from the payload and retries the same round once before giving up — this is what recovers automatically from a llama-server template that rejects the `tools` field.

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

The sidecar (`tts/server.py`) fronts two engines chosen per request by the `engine` field: **kokoro** (Kokoro-82M, default, ~27 EN voices, needs espeak-ng) and **pockettts** (kyutai pocket-tts, ~100M, CPU-friendly, English + 5 languages). `TTS_DEVICE` (`cpu`|`cuda`|`auto`) picks the torch device; Kokoro pre-warms one utterance at startup while pocket-tts loads lazily on its first request. `GET /voices` exposes both engines' voice lists and defaults so the UI can offer an engine + voice picker.

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

### Sidecar/Ollama isolation

Neither service publishes a port to the host. The audio sidecar additionally enforces `CORS_ORIGIN` via FastAPI `CORSMiddleware`; the browser never talks to the sidecar directly; all requests go through `webapp/api/tts.php` / `stt.php`.

---

## RAG

Character voice is handled by the fine-tuned model itself, so there is no voice
RAG. Two retrievers remain, driven from `webapp/api/chat.php`, each appending its
own block to the trailing live-context message (not the system prompt, which stays
static so Ollama's KV prompt cache holds across turns):

- **Lore RAG** (`lore_retrieve` → `lore_search` in `webapp/api/lore.php`): grounds
  replies in curated game canon via keyword matching.
- **Cross-conversation recall** (`chat_history_retrieve`): recalls this user's
  own past conversations via embeddings.

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

### Cross-conversation recall (`## Recalled prior context`)

Factual recall across the user's past conversations, in `chat_history_retrieve`.

On every `/api/chat.php` request:

1. The user's latest message is embedded with `nomic-embed-text` via `POST ollama:11434/api/embeddings`. The same vector is reused for retrieval and stored in `message_embeddings` for future lookups.
2. It is cosine-compared against this user's stored message embeddings from **other** conversations (most recent 5000), and the top-5 hits are kept above a 0.45 similarity floor.
3. Each hit is widened into a window of surrounding turns (1 before, 3 after) so a match lands with its context; overlapping windows in the same conversation are merged.
4. The resulting excerpts are formatted as a "Recalled prior context" block and appended to the live-context message, for factual recall only; the model is told not to repeat or paraphrase Jun's prior lines.

The retrieval is wrapped in a `try/catch`; if Ollama can't embed or the query is empty, the block is omitted and the chat continues normally. Embeddings missed at write time (e.g. Ollama was briefly down) are backfilled by `tools/compact_chat_index.php`.

---

## Tool calling and durable memory

`chat.php` offers the model up to four tools via `tool_catalog()`, always offered together (no keyword pre-filter — an earlier version silently blocked most natural asks): `search_recent_chats`, `list_recent_chats`, `memory_write`, and `web_search`. The model is instructed (`tool_context_block()`) to speak a short in-character lead line before any tool call, so a call is never emitted with empty visible content.

Tool calls run in a bounded loop of up to 3 rounds (initial reply, one tool-informed continuation, one retry round) — `run_tool_call()` executes each of up to 4 calls per round and the result is appended as a `tool`-role message before re-streaming. `search_recent_chats`/`list_recent_chats` query the user's own `messages`/`conversations` tables (excluding the current conversation); `memory_write` calls the shared `memory_append()` helper (below).

`web_search` goes through `web_search_public()` → DuckDuckGo's HTML results page, parsed with regex for result links/snippets. Both it and any redirect hops it follows (`web_fetch_public()`, up to 3 redirects, 512 KB cap) are guarded by `resolve_public_http_url()`: an SSRF guard that resolves the target host's DNS A/AAAA records and rejects the request if any resolved IP is private/reserved (`FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE`), rejects userinfo-in-URL and non-standard ports, and restricts to `http`/`https`.

Durable memories are per-user JSONL files, one line per fact, written by `memory_append()` in `webapp/api/_lib.php` under `memory_file_path()`. They live at `MEMORY_DIR` (default `<state dir>/memory`, i.e. `/var/lib/omega/memory`), inside the persisted `omega_state` Docker volume so they survive container recreation. Each request re-reads the file (`memory_recent_context()` in `chat.php`, last 20 entries) and injects it as a `## Durable memory notes` block in the live context. `webapp/api/memory.php` exposes `GET` (list), `POST` (append), and `DELETE` (remove one entry by index+timestamp, or wipe with `{"all":true}`) for the settings-drawer memory panel in the frontend.

---

## Relationship state

Jun keeps a hidden, per-user relationship that colours her mood and drifts with how she's treated. State lives in the `relationship` table: one row per user, three integer scores clamped to 0–100:

| Score | Default | Meaning |
|---|---|---|
| `affection` | 50 | warmth ↔ coldness |
| `trust` | 50 | openness ↔ guardedness |
| `tension` | 30 | tension/fear in the room |

Helpers live in `webapp/api/_lib.php` (`relationship_get` / `relationship_set` / `relationship_apply`, shared with `relationship.php`). It's a closed loop across a chat turn:

1. **Inject.** On each `/api/chat.php` request, `relationship_directives()` turns the three scores into plain-language behavior guidance (e.g. affection toward 0 → cold, irritated, withhold warmth, skip affectionate actions; ~50 → normal warm-girlfriend; toward 100 → deeply smitten, initiates closeness). This is appended to the **trailing live-context message**, not the static system prefix, so the KV prompt cache still holds across turns. The prompt tells her to interpolate her own warmth/trust/fear from the numbers, never to recite them, and never to reveal her feelings are scored.
2. **Update.** Jun's reply carries a hidden relationship bookkeeping tag with per-score *deltas*. After the stream completes, `chat.php` parses it, `relationship_apply` adds the deltas onto the current row and clamps to 0–100, and the tag is stripped so it never reaches the browser (nor TTS).
3. **Dev override.** `webapp/api/relationship.php` exposes `GET` (current scores) and `PUT` (set absolute values, clamped): the developer "mood switcher" wired to the debug HUD (`webapp/js/devhud.js`), so a state can be forced without playing through the conversation.

Because the state is the user's own, `relationship.php` needs only a valid session (rate-limited 60/min), no extra role gate.
