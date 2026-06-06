<div align="center">

# Jun OS

**A *Factorial Omega* fan project — give Jun a face, a voice, and a mind of her own, all running on your own machine.**

<!-- Drop a banner or hero shot here once you have one (recommended: docs/screenshots/hero.png). -->
<!-- ![Jun OS](docs/screenshots/hero.png) -->

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![PHP](https://img.shields.io/badge/PHP-8.2-777BB4?logo=php&logoColor=white)
![Python](https://img.shields.io/badge/Python-3.10%2B-3776AB?logo=python&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-compose-2496ED?logo=docker&logoColor=white)
![Live2D](https://img.shields.io/badge/Live2D-Cubism%204-ff7096)
![Ollama](https://img.shields.io/badge/LLM-Ollama-black)
![Platforms](https://img.shields.io/badge/platforms-Linux%20%7C%20macOS%20%7C%20Windows-informational)
![No build step](https://img.shields.io/badge/frontend-no%20build%20step-success)
![Made by fans](https://img.shields.io/badge/made%20by-fans-ff7096)

[Features](#what-it-does) · [Quickstart](#get-her-running) · [The models](#the-models) · [Architecture](#under-the-hood) · [Troubleshooting](#when-things-go-sideways)

</div>

---

## So what is this?

Jun OS is a fan-made tribute to **Jun**, the robot girlfriend from the game *!Ω Factorial Omega: My Dystopian Robot Girlfriend* (by Incontinent Cell). It's a little chat app where you can actually *talk* to her — and she talks back, with a face that moves and a voice you can hear. The whole thing runs on your own computer, so it's just you and her.

> 🔞 **Heads up — this is built on an adult (18+) game.** *Factorial Omega* is a mature, NSFW dating sim, and Jun OS carries that DNA: there's an adult-content gate at signup, and how spicy things get is up to you. Keep it on your own machine, keep it to consenting adults. If you're under 18 or that's not your thing, this isn't for you.

Here's what makes her feel alive:

- **She reacts as she talks.** Jun doesn't just type words at you — she tilts her head, glances away, smiles, or pouts *while she's saying them*. The expressions land with the words, not a beat late.
- **She has a voice.** Flip on the optional speech and she reads her replies out loud, with her mouth moving in time to what she's saying. (It's a little uncanny. We're into it.)
- **She remembers, and she knows her world.** She can bring up things from earlier chats, and she stays true to the game's lore and characters.
- **It's all private.** Nothing you say to her ever leaves your computer — no accounts in the cloud, no servers, no company reading along. Given the source material, that's kind of the whole point.

If you just want to meet her, the [Quickstart](#get-her-running) below gets you there in a couple of commands. The technical stuff comes after.

> ⚠️ Unofficial fan project. Not affiliated with Incontinent Cell or the *Factorial Omega* team — we just like Jun a lot. All rights to the game and its characters belong to their owners.

## Look at her

> Swap these placeholders for your own captures (drop them in `docs/screenshots/`). A 10-second screen recording sells this *way* harder than a still does.

| Chatting + reacting live | Talking, with lipsync |
|:---:|:---:|
| ![Chat interface](docs/screenshots/chat.png) | ![Character reacting](docs/screenshots/action.png) |

<!-- ![Demo](docs/screenshots/demo.gif) -->

## What it does

- **She reacts mid-sentence.** `[ACTION:...]` tags are parsed *while the reply is still streaming*, so the gesture lands with the word — not two seconds after. This is the magic trick the whole thing is built around.
- **She talks, and her mouth means it.** TTS audio amplitude (RMS) drives `ParamMouthOpen` directly, skipping the smoothing pass so the lips stay glued to the sound.
- **She knows her lore.** Curated *Factorial Omega* canon (`tools/lore_dataset.jsonl`) is embedded and retrieved per-message, so Jun stays accurate on the world details a fine-tune would otherwise smudge.
- **She remembers you.** Past messages get embedded and recalled by similarity, so she can bring up things you said in earlier chats. Spooky-cute, not spooky-creepy.
- **Accounts & history.** Sign up, log in, keep your conversations. Server-side sessions, per-user history, and an adult-content gate at signup.
- **Dress her up.** Toggle clothing parts and recolor tint groups live, right from the settings drawer.
- **100% local.** Ollama for the thinking, Kokoro for the voice, SQLite for the memory. Air-gap it if you want.
- **Use your GPU (or don't).** NVIDIA, AMD, or plain CPU — the launcher figures out which and configures itself.
- **Grown-up infra under the cute exterior.** Optional TLS via certbot, two-layer rate limiting, the works.

## Get her running

You need **Docker** (with Compose) and **git**. That's genuinely it.

### The lazy way (one line)

**Linux / macOS / WSL**

```sh
curl -fsSL https://raw.githubusercontent.com/efficiencyx/Jun/main/install.sh | bash
```

**Windows (PowerShell)**

```powershell
irm https://raw.githubusercontent.com/efficiencyx/Jun/main/install.ps1 | iex
```

This checks for **git + Docker** (and offers to install them if they're missing — winget on Windows, your package manager elsewhere), clones the repo, writes a `.env`, sniffs out your GPU, and brings the whole stack up. If it has to install Docker from scratch it'll start the daemon and carry on by itself — on Windows it pops a fresh window, waits for Docker, and finishes there. Then open <http://localhost> and say hi.

> Piping a script into your shell runs remote code. Totally normal for installers, but if that makes you twitch, read [`install.sh`](install.sh) / [`install.ps1`](install.ps1) and just do the manual steps below — they're the same thing, by hand.

### The careful way (manual)

```sh
git clone https://github.com/efficiencyx/Jun.git
cd Jun
cp .env.example .env
./start.sh           # Windows: ./start.ps1
# open http://localhost
```

`start.sh` / `start.ps1` detects your GPU (NVIDIA / AMD / none) and brings everything up with the right config — see [GPU support](#picking-your-gpu). Want to skip the launcher? `docker compose up -d` works too and runs on CPU.

> **Windows:** if PowerShell slaps down the script, run it once as `powershell -ExecutionPolicy Bypass -File start.ps1` (the `irm | iex` installer already handles this for you).

On first boot Ollama pulls whatever's in `OLLAMA_MODELS_TO_PULL` — by default `hf.co/efficiencyx/Jun-14B:Q4_K_M` and `nomic-embed-text`, roughly 6 GB. Watch it crawl in with `docker compose logs -f ollama`.

She's ready the moment `docker compose ps` says everything's healthy — usually 30–90 seconds, faster if the weights are already cached in the `ollama_data` volume.

### Putting her on the internet (TLS)

Got a domain pointed at your server's public IP, with ports 80 and 443 open?

```sh
DOMAIN=yourdomain.com EMAIL=you@yourdomain.com TLS_MODE=on COMPOSE_PROFILES=prod ./start.sh
```

`COMPOSE_PROFILES=prod` flips on the `certbot` sidecar (GPU detection still applies). It runs `certbot certonly --webroot` on start, then loops `certbot renew` every 12 hours. Certs land in the `letsencrypt` volume, nginx mounts it at `/etc/letsencrypt`, and you get 443 with HSTS once they're issued.

> **Mind the Let's Encrypt rate limits:** 5 duplicate issuances per domain per week. While testing, point `DOMAIN` at a staging subdomain or drop `--staging` into `docker/certbot-entrypoint.sh`.

## The models

Jun's brain is a pair of fine-tunes we trained and published on Hugging Face. The launcher picks one for you based on your VRAM, but here they are if you want to poke at them directly:

| Model | Size | Who it's for | Link |
|---|---|---|---|
| **Jun-14B** | 14B params | ≥12 GB VRAM — the smarter, more in-character one | [efficiencyx/Jun-14B](https://huggingface.co/efficiencyx/Jun-14B) |
| **Jun** | 7B params | Everything smaller — lighter, still very much Jun | [efficiencyx/Jun](https://huggingface.co/efficiencyx/Jun) |

`docker/ollama-entrypoint.sh` reads your total GPU VRAM on first boot and grabs the one that fits (**≥12 GB → 14B**, otherwise **7B**), plus `nomic-embed-text` for the lore/memory embeddings. Override the auto-pick with an explicit `OLLAMA_MODELS_TO_PULL` list, or force one with `JUN_MODEL=...`. The frontend lists whatever Ollama actually has and picks a sensible default, so it adapts to whichever one landed.

## Knobs to turn

Everything's environment variables (see `.env.example`):

| Variable | What it does | Default |
|---|---|---|
| `DOMAIN` | Public hostname for nginx `server_name` and certbot | `localhost` |
| `EMAIL` | Contact email for Let's Encrypt | `admin@localhost` |
| `TLS_MODE` | `on` = HTTPS + certbot profile; `off` = plain HTTP | `off` |
| `OLLAMA_URL` | Where PHP finds Ollama | `http://ollama:11434` |
| `OLLAMA_MODELS_TO_PULL` | Models pulled on first boot | `hf.co/efficiencyx/Jun-14B:Q4_K_M,nomic-embed-text` |
| `KOKORO_URL` | Where the PHP TTS proxy finds the voice sidecar | `http://kokoro:8001` |
| `CORS_ORIGIN` | `Access-Control-Allow-Origin` for the voice sidecar | `http://nginx` |

## Under the hood

```
Browser ──HTTP/SSE──▶ nginx ──FastCGI──▶ php-fpm ──HTTP──▶ ollama :11434
                        │                    │
                        │                    └──────────────▶ kokoro :8001 (TTS)
                        │
                        └── serves /var/www/omega/ (static assets, JS, Live2D model)
```

**The stack:** PHP 8.2 (the Ollama SSE proxy + RAG) · Python FastAPI + Kokoro-82M (the voice) · plain HTML/JS/CSS up front with PIXI.js + pixi-live2d-display + the Cubism 4 SDK from CDN · SQLite · nginx + php-fpm. No build step, no bundler, no node_modules black hole.

Want the gory details — token streaming, the ACTION stream buffer, the Live2D tick loop, the TTS pipeline? It's all in [`docs/architecture.md`](docs/architecture.md).

### What happens when you hit send

1. The browser `POST`s your conversation to `/api/chat.php`.
2. PHP assembles the system prompt fresh: `system_prompt.txt` (read every request), the current time, the closest canon lore facts, and any recalled bits from past chats (all cosine-ranked).
3. Ollama streams NDJSON back; PHP re-frames it as `data: {"token":"..."}` SSE events and flushes each one immediately.
4. `js/app.js` watches the stream for `[ACTION:` markers, hides any half-typed marker so it never renders, and fires each action the instant its closing `]` shows up.
5. `js/actions.js` resolves that action against `action_map.json`; `js/live2d.js` lerps the model's parameters toward the new pose every frame.
6. If the voice is on, `js/tts.js` splits the clean text into sentences, fetches audio per sentence from `/api/tts.php`, plays them in order, and drives `ParamMouthOpen` from the analyser's RMS.

## Make her your own

### Rebuild the lore index

The index comes from `tools/lore_dataset.jsonl` (curated *Factorial Omega* Q&A, one JSON object per line). Regenerate it whenever you edit that dataset:

```sh
docker compose exec -e OLLAMA_URL=http://ollama:11434 php \
  php tools/build_lore_index.php
```

This flattens each Q&A into a question→answer pair, embeds the questions with `nomic-embed-text`, and writes `webapp/lore_index.bin` (packed float32), `webapp/lore_corpus.txt` (the answers), and `webapp/lore_meta.json`. Add `--dry-run` to count pairs without touching Ollama. A missing index is fine — retrieval just gets skipped and chat carries on.

### Picking your GPU

`./start.sh` auto-detects your GPU and grabs the matching compose overlay. The base `docker-compose.yml` is CPU-only and runs anywhere; acceleration layers on top.

| Backend | How `start.sh` spots it | What it does |
|---|---|---|
| **NVIDIA** | `nvidia-smi` works, or `/proc/driver/nvidia` exists | Adds `docker-compose.nvidia.yml`. Needs [nvidia-container-toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html). |
| **AMD** | `/dev/kfd` + `/dev/dri/renderD*` present | Adds `docker-compose.amd.yml` (Ollama from `ollama/ollama:rocm`, passes `/dev/kfd` + `/dev/dri`, joins the host `video`/`render` groups). Needs the `amdgpu` driver. |
| **CPU** | nothing else matched | Base compose only. |

Force a backend with `GPU=nvidia|amd|cpu ./start.sh`. To do it by hand:

```sh
# NVIDIA
docker compose -f docker-compose.yml -f docker-compose.nvidia.yml up -d
# AMD (start.sh fills these in for you)
VIDEO_GID=$(getent group video | cut -d: -f3) \
RENDER_GID=$(stat -c '%g' /dev/dri/renderD128) \
  docker compose -f docker-compose.yml -f docker-compose.amd.yml up -d
```

**AMD consumer cards:** if ROCm doesn't officially list your GPU, set `HSA_OVERRIDE_GFX_VERSION` (e.g. `11.0.0` for RDNA3, `10.3.0` for RDNA2) — `start.sh` passes it through:

```sh
HSA_OVERRIDE_GFX_VERSION=11.0.0 ./start.sh
```

**Intel GPUs (Arc / iGPU):** the upstream `ollama/ollama` image has no Intel acceleration, so `start.sh` falls back to CPU on Intel-only machines. For GPU offload you'd swap the `ollama` service for Intel's [IPEX-LLM](https://github.com/intel-analytics/ipex-llm) Ollama build (same API on `:11434`, needs `/dev/dri` + oneAPI level-zero). It's a heavier, separate setup and isn't wired in here.

## When things go sideways

<details>
<summary><b>Replies arrive all at once instead of streaming</b></summary>

Something's buffering the SSE. Make sure the `/api/chat.php` location has `proxy_buffering off;` and `fastcgi_buffering off;`, and that `X-Accel-Buffering: no` is set. A load balancer in front of nginx can sneak buffering back in.
</details>

<details>
<summary><b>CSP violations spamming the console</b></summary>

A CDN URL is getting blocked. Whitelist the specific origin under `Content-Security-Policy` (`script-src` / `style-src`) in `docker/nginx/templates/omega.conf.template`. Don't widen it to `*`.
</details>

<details>
<summary><b>Jun is invisible</b></summary>

Open the console — a missing texture shows up as a 404. Confirm `webapp/assets/*.png` exist and the nginx root points at `/var/www/omega/`.
</details>

<details>
<summary><b>Getting 429s while chatting</b></summary>

The rate limiter tripped. Raise *both* layers: `limit_req_zone` in the nginx template and `rate_limit('chat', 30, 60)` in `webapp/api/chat.php`. The stricter one wins.
</details>

<details>
<summary><b>No voice</b></summary>

Check `docker compose logs kokoro`. The first run downloads ~300 MB of weights. From inside the stack, `docker compose exec nginx wget -qO- http://kokoro:8001/health` should return `{"ok":true}`. The Kokoro port is intentionally not exposed to the host.
</details>

<details>
<summary><b>Model's taking forever to load</b></summary>

Watch `docker compose logs ollama`. The entrypoint pre-warms the first non-embedding model with an empty prompt to pull weights into VRAM. A `pre-warm failed` line is non-fatal — she'll load on your first real message.
</details>

## Where everything lives

```
.
├── docker/                    Dockerfiles, nginx templates, entrypoints
├── tts/                       Kokoro voice sidecar (FastAPI, server.py)
├── tools/                     Lore-index builder + dataset, chat-index compaction, admin scripts
├── docs/                      architecture.md + screenshots/
├── webapp/                    Everything served by nginx / php-fpm
│   ├── api/                   chat.php, auth.php, conversations.php, prefs.php, tts.php, models.php, _lib.php
│   ├── js/                    app.js, live2d.js, actions.js, ollama.js, tts.js, outfit.js, ui.js, …
│   ├── assets/                Live2D model files (*.moc3, *.physics3.json, *.png)
│   ├── action_map.json        Semantic action → Live2D parameter map
│   ├── system_prompt.txt      Jun's persona + ACTION syntax (read server-side)
│   └── index.html             Single-page app entry point
├── install.sh / install.ps1   One-line bootstrap (clone + start)
├── start.sh / start.ps1       Launcher with GPU autodetect (Linux / Windows)
├── docker-compose.yml         Base stack (CPU)
├── docker-compose.nvidia.yml  NVIDIA overlay
├── docker-compose.amd.yml     AMD ROCm overlay
└── .env.example
```

## Standing on the shoulders of

- [PIXI.js](https://pixijs.com/) — WebGL 2D renderer
- [pixi-live2d-display](https://github.com/guansss/pixi-live2d-display) — Live2D integration for PIXI
- [Live2D Cubism SDK](https://www.live2d.com/en/sdk/about/) — the character model runtime
- [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) — the lightweight TTS that gives her a voice
- [Ollama](https://ollama.com/) — local LLM inference
- And of course [**Factorial Omega**](), for giving us Jun in the first place. 💛

## License

MIT — see [LICENSE](LICENSE). This is an unofficial, non-commercial fan project; all *Factorial Omega* rights belong to their respective owners.
