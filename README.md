# Jun OS

**A Live2D character that streams from your local LLM**

Jun OS is a browser-based companion chat where the language model doesn't just generate text — it drives a real-time animated character. The LLM emits `[ACTION:name|k=v]` tags inline with its dialogue; the frontend extracts them as they stream and applies them to Live2D Cubism 4 model parameters, so expressions, gestures, and gaze shifts happen in sync with the words being typed.

Optional Kokoro-82M TTS adds voice: each sentence is synthesised in parallel, played in order, and the mouth tracks audio amplitude via RMS lipsync so the character's lips move with her speech.

**Stack:** PHP 8.2 (Ollama SSE proxy + RAG voice exemplars), Python FastAPI + Kokoro-82M TTS sidecar, plain HTML/JS/CSS frontend (no build step) using PIXI.js + pixi-live2d-display + Cubism 4 SDK from CDN, served through nginx + php-fpm. One `docker compose up -d` gets everything running.

---

## Screenshots

![Chat interface](docs/screenshots/chat.png)
![Character reacting](docs/screenshots/action.png)

---

## Features

- **Real-time `[ACTION:...]` extraction** — LLM-emitted tags are parsed mid-stream; the character reacts before the message finishes, with no perceptible lag
- **Audio-driven lipsync** — TTS RMS amplitude maps directly to `ParamMouthOpen`, bypassing lerp smoothing so the mouth tracks audio tightly
- **Outfit and color customization** — toggle clothing parts and apply tint groups live via the settings drawer
- **RAG-anchored voice style** — `nomic-embed-text` embeddings rank voice exemplars from `bot_lines.txt` and inject the closest matches into every system prompt, keeping the character's speech style consistent
- **GPU passthrough for Ollama** — NVIDIA container toolkit wired in `docker-compose.yml`; comment it out for CPU-only
- **Optional TLS** — certbot profile with Let's Encrypt auto-issuance and 12-hour renewal loop
- **Dual-layer rate limiting** — nginx `limit_req_zone` (10 r/s per IP) + PHP-side `omega_rate_limit()` per endpoint, with `Retry-After` on 429s

---

## Quickstart (local, no TLS)

```sh
git clone <repo-url>
cd factorial-omega-extract
cp .env.example .env
docker compose up -d
# open http://localhost
```

On first boot, Ollama pulls the models listed in `OLLAMA_MODELS_TO_PULL`. The default includes `hf.co/efficiencyx/Jun-14B:Q4_K_M` and `nomic-embed-text` — roughly 6 GB download. Progress is visible in `docker compose logs ollama`.

The chat is usable as soon as `docker compose ps` shows all services healthy (usually 30–90 seconds depending on whether models are already cached in the `ollama_data` volume).

---

## Production deploy (with TLS)

**Prerequisites:** a domain with an A record pointing to your server's public IP, ports 80 and 443 open.

```sh
DOMAIN=yourdomain.com EMAIL=you@yourdomain.com TLS_MODE=on \
  docker compose --profile prod up -d
```

This adds a `certbot` sidecar that runs `certbot certonly --webroot` on start, then sleeps 12 hours and runs `certbot renew` in a loop. The certificate is written into the `letsencrypt` named volume, which nginx mounts at `/etc/letsencrypt`.

> **Let's Encrypt rate limits:** there is a limit of 5 duplicate certificate issuances per week per domain. During testing, point `DOMAIN` at a staging subdomain or use the `--staging` flag (edit `docker/certbot-entrypoint.sh` to add it). Once certs are issued, nginx serves on port 443 with HSTS.

---

## Environment variables

| Variable | Description | Default |
|---|---|---|
| `DOMAIN` | Public hostname for nginx server_name and certbot | `localhost` |
| `EMAIL` | Contact email for Let's Encrypt registration | `admin@localhost` |
| `TLS_MODE` | `on` enables HTTPS + certbot profile; `off` serves plain HTTP | `off` |
| `OLLAMA_URL` | Base URL the PHP container uses to reach Ollama | `http://ollama:11434` |
| `OLLAMA_MODELS_TO_PULL` | Comma-separated list of models to pull on first boot | `hf.co/efficiencyx/Jun-14B:Q4_K_M,nomic-embed-text` |
| `KOKORO_URL` | URL the PHP TTS proxy uses to reach the Kokoro sidecar | `http://kokoro:8001` |
| `CORS_ORIGIN` | `Access-Control-Allow-Origin` value for the Kokoro sidecar | `http://nginx` |

---

## Architecture

```
Browser ──HTTP/SSE──▶ nginx ──FastCGI──▶ php-fpm ──HTTP──▶ ollama :11434
                        │                    │
                        │                    └──────────────▶ kokoro :8001 (TTS)
                        │
                        └── serves /var/www/omega/ (static assets, JS, Live2D model)
```

### Chat lifecycle

1. **User sends a message** → `POST /api/chat.php` with a JSON body containing the conversation history.
2. **PHP proxy** injects `system_prompt.txt` (read fresh every request), strips any client-supplied system role, embeds the user message via `nomic-embed-text`, cosine-ranks the voice corpus, and prepends the 8 most relevant exemplar lines as a "Voice Reference" block.
3. **Ollama streams NDJSON** back to the PHP process via `curl`'s `CURLOPT_WRITEFUNCTION` callback, which converts each token to `data: {"token":"..."}` SSE events and flushes them immediately (`proxy_buffering off`, `fastcgi_buffering off`).
4. **`js/ollama.js`** consumes the SSE stream, calling `onToken` for each token.
5. **`makeStreamBuffer` in `js/app.js`** watches for `[ACTION:` in the token stream, holds back any partial marker suffix so it never appears in the rendered chat, and when a closing `]` arrives it calls `Actions.parseActions` and dispatches the action _immediately_ — before the rest of the message finishes.
6. **`js/actions.js`** resolves each action against `webapp/action_map.json` and calls `Live2D.setTarget`, `Live2D.scheduleSequence`, or `Live2D.startLoop` to write Live2D parameter targets.
7. **`js/live2d.js` tick loop** lerps `currentValues` toward `targetParams` (τ = 150 ms), writes to `coreModel.parameters.values`, then overwrites with any active sin loops and blink phase. The character animates each frame.
8. **TTS path** (optional): `js/tts.js` accumulates tokens from an `onCleanText` callback (action tags already stripped) and splits on sentence boundaries (`.!?\n`). Each sentence is `fetch`ed against `POST /api/tts.php` (PHP validates + forwards to Kokoro), decoded into an `AudioBuffer`, and played in order through a shared `AudioContext → AnalyserNode`. An `rAF` loop reads RMS from the analyser and calls `Live2D.setMouthOverride(v)` each frame.

---

## Adding a new ACTION

1. Add a node to `webapp/action_map.json`. The key becomes the action name; nested keys are navigated via kwargs (`dir`, `target`, `emotion`, etc.). See the existing entries for patterns: direct `Param*` values, `_sequence`, `_loop_param`, `_compose`, and `_param`/`_scale`.
2. Update `webapp/system_prompt.txt` with the new action's syntax so the LLM knows when and how to use it.

No rebuild is needed. The PHP backend reads `system_prompt.txt` fresh on every request. The action map is fetched by the browser at page load; hit the "reload system prompt" button in the UI or just reload the page to pick up changes.

At boot, `validateActionMap` in `app.js` walks the JSON and logs any `Param*` keys that are missing from the loaded model to the "Parametri mancanti" debug panel.

---

## Rebuilding the voice RAG index

The voice index is built from `tools/bot_lines.txt` (one `Bot: ...` line per example). To rebuild after editing that file:

```sh
docker compose exec -e OLLAMA_URL=http://ollama:11434 php \
  php tools/build_voice_index.php
```

This embeds every line with `nomic-embed-text`, writes packed float32 vectors to `webapp/voice_index.bin`, and updates `webapp/voice_corpus.txt`. The chat endpoint uses both files on every request; a missing or stale index is handled gracefully (retrieval is silently skipped, the chat still works).

---

## GPU passthrough

The `ollama` service in `docker-compose.yml` includes:

```yaml
deploy:
  resources:
    reservations:
      devices:
        - driver: nvidia
          count: all
          capabilities: [gpu]
```

This requires [nvidia-container-toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html) on the host. If you don't have it, comment out or remove the `deploy.resources` block — Ollama will run on CPU.

---

## Troubleshooting

**SSE appears buffered / responses arrive all at once**
Confirm that the nginx config has `proxy_buffering off;` and `fastcgi_buffering off;` on the `/api/chat.php` location, and that the `X-Accel-Buffering: no` header is being set. Some reverse proxies (e.g. a load balancer in front of nginx) may re-introduce buffering.

**CSP violations in the browser console**
A CDN URL is being blocked. Whitelist it in `docker/nginx/templates/omega.conf.template` under the `Content-Security-Policy` `script-src` or `style-src` directive. Do not widen to `*` — add the specific origin.

**Live2D character is invisible**
Open the browser console. A missing texture file shows up as a 404. Confirm that `webapp/assets/*.png` files are present and that the nginx root is correctly set to `/var/www/omega/`.

**429s on chat**
The rate limiter is being tripped. To increase the limit: adjust `limit_req_zone` in the nginx template (nginx-layer) and the `omega_rate_limit('chat', 30, 60)` call in `webapp/api/chat.php` (PHP-layer). Both values must be raised; the tighter of the two governs.

**Kokoro TTS not working**
Check `docker compose logs kokoro`. On first run it downloads model weights (~300 MB); wait until you see a startup confirmation. From inside the stack, `docker compose exec nginx wget -qO- http://kokoro:8001/health` should return `{"status":"ok"}`. The Kokoro port is intentionally not exposed to the host.

**Ollama model still loading**
Watch `docker compose logs ollama`. The entrypoint pre-warms the first non-embedding model by sending an empty prompt — this loads weights into VRAM so the first real message doesn't pay the cold-start cost. If you see `pre-warm failed`, it's non-fatal; the model loads on the first chat.

---

## Project layout

```
.
├── docker/                    Dockerfiles + nginx config + entrypoints
│   ├── nginx/
│   │   └── templates/         nginx config templates (envsubst at boot)
│   ├── nginx.Dockerfile
│   ├── php.Dockerfile
│   ├── ollama.Dockerfile
│   ├── ollama-entrypoint.sh
│   ├── kokoro.Dockerfile
│   └── certbot-entrypoint.sh
├── tools/
│   ├── build_voice_index.php  Rebuild voice RAG index
│   └── bot_lines.txt          Voice exemplars (one Bot: line per row)
├── tts/                       Kokoro TTS Python sidecar
│   └── server.py              FastAPI server wrapping Kokoro-82M
├── webapp/                    Everything served by nginx / php-fpm
│   ├── api/
│   │   ├── _lib.php           Shared helpers (rate limit, body read, logging)
│   │   ├── chat.php           SSE proxy + RAG injection
│   │   ├── tts.php            TTS proxy (validates + forwards to Kokoro)
│   │   └── models.php         Ollama model list proxy
│   ├── js/
│   │   ├── app.js             Main UI wiring + makeStreamBuffer + ACTION dispatch
│   │   ├── live2d.js          Live2D engine (lerp, loops, sequences, blink, lipsync hook)
│   │   ├── actions.js         ACTION resolver (action_map.json → Live2D calls)
│   │   ├── ollama.js          SSE consumer (chat() with onToken/onDone/onError)
│   │   ├── tts.js             TTS sentence accumulator + ordered AudioBuffer playback
│   │   ├── outfit.js          Outfit toggles + color tinting
│   │   └── ui.js              Toast, status pill, drawer helpers
│   ├── assets/                Live2D model files (*.moc3, *.physics3.json, *.png)
│   ├── action_map.json        Semantic action → Live2D parameter map
│   ├── system_prompt.txt      Character persona + ACTION syntax (read server-side)
│   ├── voice_corpus.txt       Cleaned voice exemplars (generated)
│   ├── voice_index.bin        Packed float32 embedding vectors (generated)
│   └── index.html             Single-page app entry point
├── docker-compose.yml
├── .env.example
└── README.md
```

---

## Credits

- [PIXI.js](https://pixijs.com/) — WebGL 2D renderer
- [pixi-live2d-display](https://github.com/guansss/pixi-live2d-display) — Live2D model integration for PIXI
- [Live2D Cubism SDK](https://www.live2d.com/en/sdk/about/) — character model runtime
- [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) — lightweight TTS model
- [Ollama](https://ollama.com/) — local LLM inference server

---

## License

MIT — see [LICENSE](LICENSE).
