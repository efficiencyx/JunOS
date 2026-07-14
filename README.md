<div align="center">

# Jun OS

**A *Factorial Omega* fan project - give Jun a face, a voice, and a mind of her own, all running on your own machine.**

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

[Features](#what-it-does) · [Quickstart](#get-her-running) · [Colab](#try-her-free-on-google-colab) · [The models](#the-models) · [Architecture](#under-the-hood) · [Troubleshooting](#when-things-go-sideways)

</div>

---

## So what is this?

Jun OS is a fan-made tribute to **Jun**, the robot girlfriend from the game *!Ω Factorial Omega: My Dystopian Robot Girlfriend* (by Incontinent Cell). It's a little chat app where you can actually *talk* to her - and she talks back, with a face that moves and a voice you can hear. The whole thing runs on your own computer, so it's just you and her.

> 🔞 **Heads up - this is built on an adult (18+) game.** *Factorial Omega* is a mature, NSFW dating sim, and Jun OS carries that DNA: there's an adult-content gate at signup, and how spicy things get is up to you. Keep it on your own machine, keep it to consenting adults. If you're under 18 or that's not your thing, this isn't for you.

Here's what makes her feel alive:

- **She reacts as she talks.** Jun doesn't just type words at you - she tilts her head, glances away, smiles, or pouts *while she's saying them*. The expressions land with the words, not a beat late.
- **She has a voice.** Flip on the optional speech and she reads her replies out loud, with her mouth moving in time to what she's saying. (It's a little uncanny. We're into it.)
- **She remembers, and she knows her world.** She can bring up things from earlier chats, and she stays true to the game's lore and characters.
- **It's all private.** Nothing you say to her ever leaves your computer - no accounts in the cloud, no servers, no company reading along. Given the source material, that's kind of the whole point.

If you just want to meet her, the [Quickstart](#get-her-running) below gets you there in a couple of commands. The technical stuff comes after.

> ⚠️ Unofficial fan project. Not affiliated with Incontinent Cell or the *Factorial Omega* team - we just like Jun a lot. All rights to the game and its characters belong to their owners.

## Look at her

> Swap these placeholders for your own captures (drop them in `docs/screenshots/`). A 10-second screen recording sells this *way* harder than a still does.

| Chatting + reacting live | Talking, with lipsync |
|:---:|:---:|
| ![Chat interface](docs/screenshots/chat.png) | ![Character reacting](docs/screenshots/action.png) |

<!-- ![Demo](docs/screenshots/demo.gif) -->

## What it does

- **She reacts mid-sentence.** `[ACTION:...]` tags are parsed *while the reply is still streaming*, so the gesture lands with the word - not two seconds after. This is the magic trick the whole thing is built around.
- **She talks, and her mouth means it.** TTS audio amplitude (RMS) drives `ParamMouthOpen` directly, skipping the smoothing pass so the lips stay glued to the sound.
- **She knows her lore.** Curated *Factorial Omega* canon (`tools/lore_dataset.jsonl`) is embedded and retrieved per-message, so Jun stays accurate on the world details a fine-tune would otherwise smudge.
- **She remembers you.** Past messages get embedded and recalled by similarity, so she can bring up things you said in earlier chats. Spooky-cute, not spooky-creepy.
- **Accounts & history.** Sign up, log in, keep your conversations. Server-side sessions, per-user history, and an adult-content gate at signup.
- **Dress her up.** Toggle clothing parts and recolor tint groups live, right from the settings drawer.
- **100% local.** Ollama for the thinking, Kokoro for the voice, SQLite for the memory. Air-gap it if you want.
- **Use your GPU (or don't).** NVIDIA, AMD, or plain CPU - the launcher figures out which and configures itself.
- **Grown-up infra under the cute exterior.** Optional TLS via certbot, two-layer rate limiting, the works.

## Get her running

No GPU, no Docker, nothing to install? Skip straight to the [Colab Quickstart](#try-her-free-on-google-colab) and meet her in your browser. Otherwise, to run her on your own machine: on **Linux / macOS** you need **Docker** (with Compose) and **git** - that's genuinely it. On **Windows** she runs **bare metal, no Docker at all**: the installer sets up Ollama + a portable PHP + an optional voice engine, and keeps everything in one folder so uninstalling is just `./uninstall.ps1`.


## Try her free on Google Colab

Don't have a GPU (or just want to kick the tyres before committing)? Run the whole stack on a **free Colab T4** - no Docker, no install, nothing on your machine. You just need a Google account.

[![Open In Colab](https://colab.research.google.com/assets/colab-badge.svg)](https://colab.research.google.com/github/efficiencyx/Jun/blob/main/colab.ipynb)

1. Click the badge above to open [`colab.ipynb`](colab.ipynb) in Colab.
2. Turn on the GPU: **Runtime → Change runtime type → T4 GPU → Save** (if it already says *Connect T4*, you're set).
3. **Runtime → Run all**, then wait for the ✅ on each step - the slow bit is the first run downloading the model (a few GB, ~3–6 min).
4. Scroll to **Step 3** and click the public link it prints. Say hi. 🎉

Two knobs in the notebook cells: **Model** (`auto` picks the 14B since Colab can handle it, or force 7B for snappier replies) and **Voice** (text-to-speech on/off - adds ~2 min on first run). The link is a free **Cloudflare tunnel** (no signup); if it 404s for a moment, give it ~30 s and reload, or just re-run Step 3 for a fresh one.

> ⚠️ **It's a disposable demo.** Colab wipes the session when it ends, so accounts, chat history, and downloaded weights don't survive between runs. For something persistent, run her [locally](#get-her-running).

### The lazy way (one line)

**Linux / macOS / WSL**

```sh
curl -fsSL https://raw.githubusercontent.com/efficiencyx/Jun/main/install.sh | bash
```

**Windows (PowerShell)**

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://raw.githubusercontent.com/efficiencyx/Jun/main/install.ps1 | iex"
```

On **Linux / macOS** this checks for **git + Docker** (and offers to install them via your package manager), clones the repo, writes a `.env`, sniffs out your GPU, and brings the whole stack up. Then open <http://localhost> and say hi.

On **Windows** there's no Docker involved. The installer checks for **git + Ollama** (offering to winget them - those two are the *only* machine-wide installs, each with a normal uninstaller in Settings > Apps), then keeps everything else inside the `Jun` folder: a portable PHP, the voice engine's Python venv, downloaded model weights, and your chat history all live under `Jun\runtime\`. No stray folders. Open <http://127.0.0.1:8080> and say hi; `./start.ps1 stop` shuts her down, and `./uninstall.ps1` removes the lot (asking before it touches anything machine-wide).

> Piping a script into your shell runs remote code. Totally normal for installers, but if that makes you twitch, read [`install.sh`](install.sh) / [`install.ps1`](install.ps1) and just do the manual steps below - they're the same thing, by hand.

### The careful way (manual)

```sh
git clone https://github.com/efficiencyx/Jun.git
cd Jun
cp .env.example .env
./start.sh           # Windows: ./start.ps1
# open http://localhost
```

On Linux/macOS, `start.sh` detects your GPU (NVIDIA / AMD / none) and brings everything up with the right config - see [GPU support](#picking-your-gpu). Want to skip the launcher? `docker compose up -d` works too and runs on CPU.

On Windows, `start.ps1` runs bare metal: it starts (or reuses) Ollama natively - which uses your GPU on its own, no overlays needed - plus the web server and the optional voice sidecar, then opens <http://127.0.0.1:8080>. Note the manual path still needs `install.ps1` to have run once (it downloads the portable PHP and sets up the voice venv).

> **Her body isn't in this repo.** The Live2D model and textures belong to *My Dystopian Robot Girlfriend* and aren't redistributed here. Rebuild them from your own copy of the game before first launch:
>
> ```sh
> pip install UnityPy Pillow
> python3 tools/recover_assets.py --game /path/to/your/game/install
> ```
>
> This writes `webapp/assets/` locally, including a `variants/game_items.json`
> catalog of every packed item layer and color index plus the native hair-strand
> overlays. Those files are **for your own use** - please don't republish them (commit them to a public fork, ship them in a release, mirror them). `webapp/assets/` is in `.gitignore` so it won't get pushed by accident. See the NOTICE in [`LICENSE`](LICENSE).

> **Windows:** if PowerShell slaps down the script, run it once as `powershell -ExecutionPolicy Bypass -File start.ps1` (the `irm | iex` installer already handles this for you).

On first boot Ollama pulls whatever's in `OLLAMA_MODELS_TO_PULL` - by default the CPU-friendly `hf.co/efficiencyx/Jun-LoRA-v3-E2B-GGUF:Q4_K_M` and `nomic-embed-text`. Watch it crawl in with `docker compose logs -f ollama` (on Windows the pull runs right in your terminal).

She's ready the moment `docker compose ps` says everything's healthy - usually 30–90 seconds, faster if the weights are already cached in the `ollama_data` volume.

### Putting her on the internet (TLS)

Got a domain pointed at your server's public IP, with ports 80 and 443 open?

```sh
DOMAIN=yourdomain.com EMAIL=you@yourdomain.com TLS_MODE=on COMPOSE_PROFILES=prod ./start.sh
```

`COMPOSE_PROFILES=prod` flips on the `certbot` sidecar (GPU detection still applies). It runs `certbot certonly --webroot` on start, then loops `certbot renew` every 12 hours. Certs land in the `letsencrypt` volume, nginx mounts it at `/etc/letsencrypt`, and you get 443 with HSTS once they're issued.

> **Mind the Let's Encrypt rate limits:** 5 duplicate issuances per domain per week. While testing, point `DOMAIN` at a staging subdomain or drop `--staging` into `docker/certbot-entrypoint.sh`.

## The models

Jun's brain is available in 12B, E4B, and E2B fine-tunes on Hugging Face. The installer picks a conservative quant for your VRAM; use the next option in a row when the rest of your workload leaves enough room.

| VRAM | Default | Higher-quality alternative |
|---:|---|---|
| 4 GB | E2B Q4_K_M | E2B Q6_K |
| 6 GB | E2B Q6_K | E2B Q8_0 |
| 8 GB | E4B Q4_K_M | E4B Q6_K |
| 10 GB | E4B Q6_K | E4B Q8_0 |
| 12 GB | E4B Q8_0 | 12B Q4_K_M |
| 16 GB | 12B Q6_K | 12B Q8_0 |

Use `JUN_MODEL=12b`, `JUN_MODEL=e4b`, or `JUN_MODEL=e2b` to select a family at its Q4_K_M quant, or pass a complete Ollama reference to choose an exact quant. The frontend lists whatever Ollama actually has and picks a sensible default.

## Knobs to turn

Everything's environment variables (see `.env.example`):

| Variable | What it does | Default |
|---|---|---|
| `DOMAIN` | Public hostname for nginx `server_name` and certbot | `localhost` |
| `EMAIL` | Contact email for Let's Encrypt | `admin@localhost` |
| `TLS_MODE` | `on` = HTTPS + certbot profile; `off` = plain HTTP | `off` |
| `OLLAMA_URL` | Where PHP finds Ollama | `http://ollama:11434` |
| `OLLAMA_MODELS_TO_PULL` | Models pulled on first boot | `hf.co/efficiencyx/Jun-LoRA-v3-E2B-GGUF:Q4_K_M,nomic-embed-text` |
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

Want the gory details - token streaming, the ACTION stream buffer, the Live2D tick loop, the TTS pipeline? It's all in [`docs/architecture.md`](docs/architecture.md).

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

This flattens each Q&A into a question→answer pair, embeds the questions with `nomic-embed-text`, and writes `webapp/lore_index.bin` (packed float32), `webapp/lore_corpus.txt` (the answers), and `webapp/lore_meta.json`. Add `--dry-run` to count pairs without touching Ollama. A missing index is fine - retrieval just gets skipped and chat carries on.

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

**AMD consumer cards:** if ROCm doesn't officially list your GPU, set `HSA_OVERRIDE_GFX_VERSION` (e.g. `11.0.0` for RDNA3, `10.3.0` for RDNA2) - `start.sh` passes it through:

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

Open the console - a missing texture shows up as a 404. Confirm `webapp/assets/*.png` exist and the nginx root points at `/var/www/omega/`.
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

Watch `docker compose logs ollama`. The entrypoint pre-warms the first non-embedding model with an empty prompt to pull weights into VRAM. A `pre-warm failed` line is non-fatal - she'll load on your first real message.
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
├── install.sh / install.ps1   One-line bootstrap (Linux: Docker · Windows: bare metal)
├── start.sh / start.ps1       Launchers (start.sh: GPU autodetect + compose · start.ps1: native processes)
├── uninstall.ps1              Windows uninstaller (stops everything, deletes the folder)
├── docker-compose.yml         Base stack (CPU)
├── docker-compose.nvidia.yml  NVIDIA overlay
├── docker-compose.amd.yml     AMD ROCm overlay
└── .env.example
```

## Standing on the shoulders of

- [PIXI.js](https://pixijs.com/) - WebGL 2D renderer
- [pixi-live2d-display](https://github.com/guansss/pixi-live2d-display) - Live2D integration for PIXI
- [Live2D Cubism SDK](https://www.live2d.com/en/sdk/about/) - the character model runtime
- [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) - the lightweight TTS that gives her a voice
- [Ollama](https://ollama.com/) - local LLM inference
- And of course [**Factorial Omega**](), for giving us Jun in the first place. 💛

## License

MIT - see [LICENSE](LICENSE). This is an unofficial, non-commercial fan project; all *Factorial Omega* rights belong to their respective owners.
