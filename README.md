<div align="center">

# Jun OS

**A Live2D character that streams, speaks, and reacts — driven entirely by your local LLM.**

<!-- Drop a banner or hero shot here once you have one (recommended: docs/screenshots/hero.png). -->
<!-- ![Jun OS](docs/screenshots/hero.png) -->

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![PHP](https://img.shields.io/badge/PHP-8.2-777BB4?logo=php&logoColor=white)
![Python](https://img.shields.io/badge/Python-3.10%2B-3776AB?logo=python&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-compose-2496ED?logo=docker&logoColor=white)
![Live2D](https://img.shields.io/badge/Live2D-Cubism%204-ff7096)
![Ollama](https://img.shields.io/badge/LLM-Ollama-black)
![No build step](https://img.shields.io/badge/frontend-no%20build%20step-success)

[Features](#features) · [Quickstart](#quickstart) · [Architecture](#architecture) · [Configuration](#configuration) · [Troubleshooting](#troubleshooting)

</div>

---

## Overview

Jun OS is a browser-based companion chat where the language model doesn't just type — it *performs*. The LLM emits `[ACTION:name|k=v]` tags inline with its dialogue; the frontend pulls them out as they stream and applies them to Live2D Cubism 4 parameters, so expressions, gestures, and gaze shifts land in sync with the words appearing on screen.

Add the optional Kokoro-82M TTS sidecar and she gets a voice too: each sentence is synthesised in parallel, played back in order, and the mouth tracks audio amplitude through RMS lipsync.

Everything runs locally. One `docker compose up -d` brings up the LLM, the TTS, and the web app.

## Media

> Replace the placeholders below with your own captures. Suggested location: `docs/screenshots/`.

| Chat + live reactions | TTS lipsync |
|:---:|:---:|
| ![Chat interface](docs/screenshots/chat.png) | ![Character reacting](docs/screenshots/action.png) |

<!-- A short screen recording sells this far better than stills: -->
<!-- ![Demo](docs/screenshots/demo.gif) -->

## Features

- **Mid-stream `[ACTION:...]` extraction** — tags are parsed while the response is still streaming, so the character reacts before the sentence even finishes, with no perceptible lag.
- **Audio-driven lipsync** — TTS RMS amplitude maps straight onto `ParamMouthOpen`, bypassing the lerp smoothing so the mouth stays tight to the audio.
- **Voice style via RAG** — `nomic-embed-text` ranks voice exemplars from `bot_lines.txt` and injects the closest matches into every prompt, keeping her phrasing in character.
- **Cross-conversation memory** — past messages are embedded and recalled by similarity, so she can reference things said in earlier chats.
- **Accounts & history** — signup/login with server-side sessions, per-user conversation list, and an adult-content gate at signup.
- **Outfit & color customization** — toggle clothing parts and apply tint groups live from the settings drawer.
- **Runs fully local** — Ollama for inference, Kokoro for speech, SQLite for storage. Nothing leaves the box.
- **GPU passthrough** — NVIDIA container toolkit wired into `docker-compose.yml`; drop one block to fall back to CPU.
- **Optional TLS** — certbot profile with Let's Encrypt issuance and a 12-hour renewal loop.
- **Two-layer rate limiting** — nginx `limit_req_zone` plus a per-endpoint `rate_limit()` in PHP, with `Retry-After` on 429s.

## Quickstart

Local, no TLS:

```sh
git clone https://github.com/efficiencyx/Jun.git
cd Jun
cp .env.example .env
docker compose up -d
# open http://localhost
```

On first boot Ollama pulls whatever is listed in `OLLAMA_MODELS_TO_PULL` — by default `hf.co/efficiencyx/Jun-14B:Q4_K_M` and `nomic-embed-text`, roughly 6 GB. Follow along with `docker compose logs -f ollama`.

The chat is usable as soon as `docker compose ps` reports every service healthy — typically 30–90 seconds, less if the weights are already cached in the `ollama_data` volume.

### Production (with TLS)

You'll need a domain whose A record points at the server's public IP, with ports 80 and 443 open.

```sh
DOMAIN=yourdomain.com EMAIL=you@yourdomain.com TLS_MODE=on \
  docker compose --profile prod up -d
```

This adds a `certbot` sidecar that runs `certbot certonly --webroot` on start, then loops on `certbot renew` every 12 hours. Certificates land in the `letsencrypt` volume, which nginx mounts at `/etc/letsencrypt`, and it serves 443 with HSTS once they're issued.

> **Heads up on Let's Encrypt rate limits:** 5 duplicate issuances per domain per week. While testing, point `DOMAIN` at a staging subdomain or add `--staging` in `docker/certbot-entrypoint.sh`.

## Configuration

All configuration is environment variables (see `.env.example`):

| Variable | Description | Default |
|---|---|---|
| `DOMAIN` | Public hostname for nginx `server_name` and certbot | `localhost` |
| `EMAIL` | Contact email for Let's Encrypt registration | `admin@localhost` |
| `TLS_MODE` | `on` enables HTTPS + the certbot profile; `off` serves plain HTTP | `off` |
| `OLLAMA_URL` | Base URL the PHP container uses to reach Ollama | `http://ollama:11434` |
| `OLLAMA_MODELS_TO_PULL` | Comma-separated models pulled on first boot | `hf.co/efficiencyx/Jun-14B:Q4_K_M,nomic-embed-text` |
| `KOKORO_URL` | URL the PHP TTS proxy uses to reach the Kokoro sidecar | `http://kokoro:8001` |
| `CORS_ORIGIN` | `Access-Control-Allow-Origin` for the Kokoro sidecar | `http://nginx` |

## Architecture

```
Browser ──HTTP/SSE──▶ nginx ──FastCGI──▶ php-fpm ──HTTP──▶ ollama :11434
                        │                    │
                        │                    └──────────────▶ kokoro :8001 (TTS)
                        │
                        └── serves /var/www/omega/ (static assets, JS, Live2D model)
```

**Stack:** PHP 8.2 (Ollama SSE proxy + RAG) · Python FastAPI + Kokoro-82M (TTS sidecar) · plain HTML/JS/CSS frontend with PIXI.js + pixi-live2d-display + Cubism 4 SDK from CDN · SQLite · nginx + php-fpm.

For the full request walkthrough — token streaming, the ACTION stream buffer, the Live2D tick loop, and the TTS pipeline — see [`docs/architecture.md`](docs/architecture.md).

### Chat lifecycle (short version)

1. The browser `POST`s the conversation to `/api/chat.php`.
2. PHP builds the system prompt: `system_prompt.txt` (read fresh each request), the current time, the top voice exemplars (cosine-ranked), and any recalled context from past conversations.
3. Ollama streams NDJSON, which PHP re-frames as `data: {"token":"..."}` SSE events and flushes immediately.
4. `js/app.js` watches the stream for `[ACTION:` markers, holds back partial markers so they never render, and dispatches each action the moment its closing `]` arrives.
5. `js/actions.js` resolves the action against `action_map.json`; `js/live2d.js` lerps the model's parameters toward the new targets every frame.
6. Optionally, `js/tts.js` splits the clean text into sentences, fetches audio per sentence from `/api/tts.php`, plays them in order, and drives `ParamMouthOpen` from the analyser's RMS.

## Extending

### Add a new ACTION

1. Add a node to `webapp/action_map.json`. The key is the action name; nested keys are navigated via kwargs (`dir`, `target`, `emotion`, …). The existing entries cover the patterns: direct `Param*` values, `_sequence`, `_loop_param`, `_compose`, and `_param`/`_scale`.
2. Document the new action's syntax in `webapp/system_prompt.txt` so the model knows when to use it.

No rebuild needed — the backend reads `system_prompt.txt` on every request and the browser fetches the action map at load. On boot, `validateActionMap` in `app.js` logs any `Param*` keys missing from the loaded model.

### Rebuild the voice RAG index

The index is built from `tools/bot_lines.txt` (one `Bot: ...` line per example):

```sh
docker compose exec -e OLLAMA_URL=http://ollama:11434 php \
  php tools/build_voice_index.php
```

This embeds each line with `nomic-embed-text`, writes packed float32 vectors to `webapp/voice_index.bin`, and refreshes `webapp/voice_corpus.txt`. A missing or stale index is handled gracefully — retrieval is skipped and chat still works.

### GPU passthrough

The `ollama` service reserves an NVIDIA device:

```yaml
deploy:
  resources:
    reservations:
      devices:
        - driver: nvidia
          count: all
          capabilities: [gpu]
```

This needs [nvidia-container-toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html) on the host. Without it, delete that block and Ollama runs on CPU.

## Troubleshooting

<details>
<summary><b>SSE looks buffered — responses arrive all at once</b></summary>

Check that the `/api/chat.php` location has `proxy_buffering off;` and `fastcgi_buffering off;`, and that `X-Accel-Buffering: no` is set. A load balancer in front of nginx can re-introduce buffering.
</details>

<details>
<summary><b>CSP violations in the console</b></summary>

A CDN URL is being blocked. Whitelist the specific origin under `Content-Security-Policy` (`script-src` / `style-src`) in `docker/nginx/templates/omega.conf.template`. Don't widen to `*`.
</details>

<details>
<summary><b>Live2D character is invisible</b></summary>

Open the console — a missing texture shows as a 404. Confirm `webapp/assets/*.png` exist and the nginx root points at `/var/www/omega/`.
</details>

<details>
<summary><b>429s on chat</b></summary>

The rate limiter tripped. Raise both layers: `limit_req_zone` in the nginx template and `rate_limit('chat', 30, 60)` in `webapp/api/chat.php`. The tighter of the two wins.
</details>

<details>
<summary><b>Kokoro TTS not working</b></summary>

Check `docker compose logs kokoro`. The first run downloads ~300 MB of weights. From inside the stack, `docker compose exec nginx wget -qO- http://kokoro:8001/health` should return `{"ok":true}`. The Kokoro port is intentionally not exposed to the host.
</details>

<details>
<summary><b>Ollama model still loading</b></summary>

Watch `docker compose logs ollama`. The entrypoint pre-warms the first non-embedding model with an empty prompt to load weights into VRAM. A `pre-warm failed` line is non-fatal — the model loads on the first real message.
</details>

## Project layout

```
.
├── docker/                    Dockerfiles, nginx templates, entrypoints
├── tts/                       Kokoro TTS sidecar (FastAPI, server.py)
├── tools/                     Voice-index builder, chat-index compaction, admin scripts
├── docs/                      architecture.md + screenshots/
├── webapp/                    Everything served by nginx / php-fpm
│   ├── api/                   chat.php, auth.php, conversations.php, prefs.php, tts.php, models.php, _lib.php
│   ├── js/                    app.js, live2d.js, actions.js, ollama.js, tts.js, outfit.js, ui.js, …
│   ├── assets/                Live2D model files (*.moc3, *.physics3.json, *.png)
│   ├── action_map.json        Semantic action → Live2D parameter map
│   ├── system_prompt.txt      Character persona + ACTION syntax (read server-side)
│   └── index.html             Single-page app entry point
├── docker-compose.yml
└── .env.example
```

## Credits

- [PIXI.js](https://pixijs.com/) — WebGL 2D renderer
- [pixi-live2d-display](https://github.com/guansss/pixi-live2d-display) — Live2D integration for PIXI
- [Live2D Cubism SDK](https://www.live2d.com/en/sdk/about/) — character model runtime
- [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) — lightweight TTS model
- [Ollama](https://ollama.com/) — local LLM inference

## License

Released under the MIT License — see [LICENSE](LICENSE).
