# Jun OS — Architecture

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
                          │                              └──────────────── ▶│ kokoro :8001
                          └─────────────────────────────────────────────────┘

  Volumes: ollama_data, kokoro_cache, omega_state, letsencrypt, certbot_webroot
  Optional (profile=prod): certbot sidecar for Let's Encrypt issuance + renewal
```

nginx serves static files from `/var/www/omega/` and FastCGI-proxies `*.php` requests to the php-fpm container. Ollama and Kokoro are internal-only — their ports are not published to the host.

---

## Streaming pipeline

```
Browser
  POST /api/chat.php
       │
       ▼
  chat.php (php-fpm)
       │  injects system_prompt.txt
       │  strips client system role
       │  appends lore facts + recalled prior context (RAG)
       │
       │  curl CURLOPT_WRITEFUNCTION ──────── NDJSON stream ──────▶ ollama /api/chat
       │  (per-chunk callback)                                       (HTTP/1.1, streaming)
       │
       │  for each NDJSON chunk:
       │    extract token from JSON
       │    echo 'data: {"token":"..."}\n\n'
       │    flush()
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

- **`proxy_buffering off`** — prevents nginx from accumulating the FastCGI response
- **`fastcgi_buffering off`** — prevents nginx's FastCGI module from buffering the upstream
- **`X-Accel-Buffering: no`** — hint consumed by nginx and some CDN layers

Without all three, tokens may arrive in one batch at end-of-message even though the server is streaming them correctly.

---

## Action extraction state machine

`makeStreamBuffer` in `webapp/js/app.js` is a streaming state machine that intercepts `[ACTION:...]` tags before they reach the chat renderer.

### States

```
PASSTHROUGH ──── sees '[' ──────▶ MAYBE_ACTION
                                       │
                          partial '[ACTION:' matched ──▶ IN_MARKER
                                       │
                          partial does not match ──▶ flush held bytes, PASSTHROUGH
                                                          │
                          IN_MARKER: sees ']' ──▶ parse + dispatch, PASSTHROUGH
                          IN_MARKER: no ']' but buffer growing ──▶ stay in IN_MARKER
```

### Partial marker holdback

The marker `[ACTION:` is 8 bytes. While in `PASSTHROUGH`, any trailing bytes that could be the start of `[ACTION:` are held in a lookahead buffer rather than emitted. This means:

- A lone `[` at the end of a token chunk is held until the next token confirms or denies it.
- If the next token begins with `ACTION:`, the machine transitions to `IN_MARKER` and the held bytes are discarded (never shown to the user).
- If the next token does not continue the marker pattern, the held bytes are flushed to the chat renderer.

This gives zero false positives in the rendered text: action tags never appear as visible characters.

### Dispatch timing

When a closing `]` is received, the bracketed text is immediately passed to `Actions.parseActions`. The return value is an array of resolved action objects. Each is dispatched to `Live2D.setTarget` / `scheduleSequence` / `startLoop` **before the rest of the message has finished streaming**. This is what makes the character react in sync with words being generated.

Malformed or unrecognised tags are logged to the debug panel and silently dropped.

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

1. **Fire pending sequences** — any `{param, value, fire_at_ms}` entry whose deadline has passed is written into `targetParams`.
2. **Lerp** — for each param in `currentValues`, exponential smoothing toward `targetParams`:
   ```
   alpha = 1 - exp(-dt / LERP_TAU_MS)   // LERP_TAU_MS = 150 ms
   current = current + alpha * (target - current)
   ```
3. **Write to raw params** — `raw.parameters.values[idx] = current`.
4. **Overwrite with active loops** — sin oscillations are written directly, bypassing the lerped current value. This keeps loops visually crisp.
5. **Overwrite `ParamEyeOpen` for blink** — if a blink phase is active, the eye open value is set directly from the blink timeline (close 70 ms / hold 50 ms / open 120 ms ramp). Using lerp for blinks would smear the closure into an invisible dip at normal tau.
6. **Overwrite `ParamMouthOpen` for lipsync** — if `setMouthOverride` has been called (TTS audio playing), the mouth value is set from the RMS measurement, bypassing lerp entirely so the lip track is tight.

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

- **Breath** — a constant `_loop_param` on `ParamBodyY` with a 4-second period and small amplitude.
- **Blink** — a `setInterval` that fires `scheduleSequence([close, hold, open])` randomly every 3–7 seconds.
- **Fidget** — a `setTimeout` chain that picks a random entry from the `FIDGETS` array every 4–10 seconds. Fidgets are either `loop` (short oscillation: tail wiggle, head sway, eye glance) or `pose` (set a target, hold, return to default: leg shift, arm raise).

`resetIdle()` clears all targets, loops, and sequences back to model defaults. It does not restart idle; callers that want idle to resume must follow with `startIdle()`.

### `getRaw` quirk

The pixi-live2d-display wrapper exposes the Cubism core model in different shapes depending on the SDK version loaded. `getRaw(model)` probes three locations (`coreModel`, `coreModel._model`, and arbitrary keys) to find the object with `.parts.ids`. This probe must not be replaced with a direct property access.

---

## TTS pipeline

`webapp/js/tts.js` accumulates tokens from the stream's `onCleanText` callback (action tags have already been stripped before this callback fires) and builds a sentence queue.

### Sentence accumulation

Tokens are appended to a buffer. When a sentence-ending character (`.`, `!`, `?`, `\n`) is seen and the accumulated text is non-trivial, the sentence is pushed to the synthesis queue and the buffer is reset.

### Parallel synthesis, ordered playback

Each queued sentence triggers an immediate `fetch POST /api/tts.php`. The PHP endpoint validates the request (text ≤ 2000 chars, voice pattern, speed range) and forwards it to the Kokoro sidecar. Responses arrive out-of-order since synthesis time varies by sentence length.

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

- **`omega_read_body($maxBytes)`** — checks `Content-Length` before reading and rejects oversized requests with 413 before touching `php://input`. Reads at most `$maxBytes + 1` bytes and rejects if longer, protecting against streams that lie about their size.
- **`omega_rate_limit($bucket, $maxPerWindow, $windowSec)`** — flat-file token bucket under `/var/lib/omega/rl/`. Files are locked with `flock(LOCK_EX)` to prevent race conditions. Returns 429 + `Retry-After` header on miss. The state directory is mounted as the `omega_state` named volume so limits persist across container restarts.
- **`omega_json_error($code, $machineMsg)`** — emits `{error, code, request_id}`. Never echoes `curl_error` output, exception messages, or file paths. Real errors are logged to stderr via `omega_log` and surfaced through `docker logs`.

Endpoint-specific caps:
- `chat.php`: body ≤ 256 KB, messages ≤ 80, each content ≤ 16 KB, rate limit 30/min
- `tts.php`: body ≤ 8 KB, text ≤ 2000 chars, rate limit 60/min
- `models.php`: rate limit 30/min, `Cache-Control: public, max-age=10`

### Kokoro/Ollama isolation

Neither service publishes a port to the host. The Kokoro sidecar additionally enforces `CORS_ORIGIN` via FastAPI `CORSMiddleware` — the browser never talks to Kokoro directly; all requests go through `webapp/api/tts.php`.

---

## RAG

Character voice is handled by the fine-tuned model itself, so there is no voice
RAG. Two retrievers remain, both in `webapp/api/chat.php`, each appending its own
block to the system prompt:

- **Lore RAG** (`lore_retrieve`) — grounds replies in curated game canon.
- **Cross-conversation recall** (`chat_history_retrieve`) — recalls this user's
  own past conversations.

### Lore RAG (`## World facts (canon)`)

The fine-tune gives Jun her voice but blurs or invents specific world details, so
canon facts are retrieved instead of baked in.

The corpus is `tools/lore_dataset.jsonl` — curated game-lore Q&A in neutral wiki
voice, with out-of-universe meta (developer, platform, version, etc.) filtered out
so Jun never breaks the fourth wall. `tools/build_lore_index.php` flattens each
Q&A into a question→answer pair and embeds **the question** as `search_document`,
writing `webapp/lore_index.bin` (packed float32), `webapp/lore_corpus.txt` (the
answers, row-aligned) and `webapp/lore_meta.json`.

At request time:

1. The live message is embedded as `search_query` (the matching nomic prefix — a dedicated embedding, separate from the prefix-free vector used below).
2. Cosine-ranked against the question vectors; the top-4 are kept above a 0.6 floor. Below that the user isn't really asking about lore, so nothing is injected.
3. The answers for the surviving hits become the `## World facts (canon)` block, framed as established truths to weave in — not to recite.

```
 user message ──embed(search_query)──▶ cosine vs question vectors
                                              │
                                       top-4, score ≥ 0.6
                                              │
                                       inject the ANSWERS as canon facts
```

Keying on the question (not the answer) keeps retrieval symmetric: a real user
question matches the closest canon question. The index is regenerated only when
the dataset changes; a missing index degrades gracefully (block omitted).

### Cross-conversation recall (`## Recalled prior context`)

Factual recall across the user's past conversations, in `chat_history_retrieve`.

On every `/api/chat.php` request:

1. The user's latest message is embedded with `nomic-embed-text` via `POST ollama:11434/api/embeddings`. The same vector is reused for retrieval and stored in `message_embeddings` for future lookups.
2. It is cosine-compared against this user's stored message embeddings from **other** conversations (most recent 5000), and the top-5 hits are kept above a 0.45 similarity floor.
3. Each hit is widened into a window of surrounding turns (1 before, 3 after) so a match lands with its context; overlapping windows in the same conversation are merged.
4. The resulting excerpts are formatted as a "Recalled prior context" block and appended to the system prompt, for factual recall only — the model is told not to repeat or paraphrase Jun's prior lines.

The retrieval is wrapped in a `try/catch`; if Ollama can't embed or the query is empty, the block is simply omitted and the chat continues normally. Embeddings missed at write time (e.g. Ollama was briefly down) are backfilled by `tools/compact_chat_index.php`.
