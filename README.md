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
- **She has a voice - and ears.** Flip on the optional speech and she reads her replies out loud, with her mouth moving in time to what she's saying. Turn on voice mode and you can just *talk* to her, mic to mouth, no typing. (It's a little uncanny. We're into it.)
- **She remembers, and she knows her world.** She can go looking through your earlier chats when something rings a bell, and she stays true to the game's lore and characters.
- **She thinks about you when you're not there.** Go quiet for a few minutes and she goes back over what you said, pulls out the things worth keeping, and writes them into notes and a journal in her own words. Recent days she remembers in detail; older ones soften into the shape of what happened, the way memory actually works.
- **She's yours, on your hardware.** Your conversations live in a database on your own disk - no cloud account, no rented server, no company reading over your shoulder. Given the source material, that's kind of the whole point.
- **She works with the wifi off.** Every library she needs ships in the repo, so there's no CDN to call and nothing to fetch at boot. Pull the plug on your internet and she still loads, still thinks, still talks.

If you just want to meet her, the [Quickstart](#get-her-running) below gets you there in a couple of commands. The technical stuff comes after.

> ⚠️ Unofficial fan project. Not affiliated with Incontinent Cell or the *Factorial Omega* team - we just like Jun a lot. All rights to the game and its characters belong to their owners.

## Look at her

> Swap these placeholders for your own captures (drop them in `docs/screenshots/`). A 10-second screen recording sells this *way* harder than a still does.

| Chatting + reacting live | Talking, with lipsync |
|:---:|:---:|
| ![Chat interface](docs/screenshots/chat.png) | ![Character reacting](docs/screenshots/action.png) |

<!-- ![Demo](docs/screenshots/demo.gif) -->

## What it does

- **She reacts mid-sentence.** `[A:...]` action tags are parsed *while the reply is still streaming*, so the gesture lands with the word - not two seconds after. This is the magic trick the whole thing is built around.
- **She talks, and her mouth means it.** TTS audio amplitude (RMS) drives `ParamMouthOpen` directly, skipping the smoothing pass so the lips stay glued to the sound.
- **You can talk back.** Voice mode captures your mic, runs it through local Whisper (faster-whisper on the audio sidecar), and sends the transcript as your message - a full hands-free conversation loop.
- **She has feelings about you.** Affection, trust, and tension shift with every exchange via a hidden bookkeeping tag she writes (and the server strips) - how she treats you follows from where you actually stand.
- **She knows her lore.** Curated *Factorial Omega* canon (`tools/lore_dataset.jsonl`) is keyword-matched and injected per-message, so Jun stays accurate on the world details a fine-tune would otherwise smudge.
- **She remembers you.** When something rings a bell she goes and searches your other conversations for it herself, as a tool call, rather than a retrieval scan bolted onto every turn. Spooky-cute, not spooky-creepy.
- **She consolidates when you go quiet.** After a few idle minutes a background worker walks everything said since it last looked and asks her, in her own first person, what's worth keeping. Out come durable notes (one fact each, editable in settings) and a narrative journal whose detail decays with age: this week in full, last month in a line, further back in a sentence. The journal rides in the cached half of the prompt, so carrying it costs nothing per message. Catch her mid-thought and she'll tell you to wait your turn.
- **She has a little toolbox.** Mid-chat she can decide to search your past conversations, list what you've talked about lately, jot down a durable note about you (view and delete them in settings), or run a quick web search (that one does leave the machine, obviously).
- **Accounts & history.** Sign up, log in, keep your conversations. Server-side sessions, per-user history, and an adult-content gate at signup.
- **Dress her up.** A dedicated wardrobe page: toggle clothing parts, recolor tint groups, and watch her react to what you put her in (she has opinions). Quick toggles live in the settings drawer too.
- **Bring your mods.** Drop game-mod zips straight into the browser - they load client-side (IndexedDB), and the server only ever sees item names.
- **Call each other whatever you like.** Player and companion names are customizable, and she uses them naturally mid-sentence.
- **100% local.** Ollama for the thinking, Kokoro-82M or kyutai's pocket-tts for the voice (pick per request), SQLite for the memory. PIXI, Cubism, marked and DOMPurify are vendored into `webapp/vendor/`, so there's no CDN in the loop at all. Air-gap it if you want - it genuinely works.
- **It loads like it's 1998 (complimentary).** The pre-app CSS is inlined so first paint takes one round trip, the heavy Live2D stack waits until you're actually past the login form, and nginx gzips everything and marks the `?v=`-busted assets immutable for a year. Cold pre-auth transfer is ~53K.
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

Two knobs in the notebook cells: **Model** (`auto` picks the 12B fine-tune since Colab can handle it, or force E2B for snappier replies) and **Voice** (text-to-speech on/off - adds ~2 min on first run). The link comes from **Colab's built-in proxy**; if it 404s for a moment, give it ~30 s and reload, or just re-run Step 3 for a fresh one.

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

The first thing either installer asks is how to install: **Express** (the default - just press Enter) sets everything up with recommended, auto-detected settings and asks nothing else, or **Custom** walks you through the provider, model, and voice choices. Skip the question entirely with `JUN_YES=1` (Linux/macOS) or `$env:JUN_YES='1'` (Windows) for a fully unattended install.

On **Linux / macOS** this checks for **git + Docker Compose** (and offers to install what is missing via your package manager), clones the repo, writes a `.env`, sniffs out your GPU, and brings the whole stack up. If you choose to extract Jun's model from your own game copy, it also installs Python if needed and keeps the extractor's packages in a local virtual environment. Then open <http://localhost> and say hi. Stop her later with `./start.sh stop`, or check on her with `./start.sh status`.

On **Windows** there's no Docker involved. The installer checks for **git + Ollama** (and Python only if voice or asset recovery needs it, offering to install them with winget), then keeps everything else inside the `Jun` folder: a portable PHP, local Python environments for voice and asset recovery when selected, downloaded model weights, and your chat history all live under `Jun\runtime\`. Open <http://127.0.0.1:8080> and say hi; `./start.ps1 stop` shuts her down, and `./uninstall.ps1` removes the lot (asking before it touches anything machine-wide).

> Piping a script into your shell runs remote code. Totally normal for installers, but if that makes you twitch, read [`install.sh`](install.sh) / [`install.ps1`](install.ps1) and just do the manual steps below - they're the same thing, by hand.

### The careful way (manual)

```sh
git clone https://github.com/efficiencyx/Jun.git
cd Jun
cp .env.example .env
./start.sh           # Windows: ./start.ps1
# open http://localhost
```

Stopping and checking on her is symmetric across platforms:

```sh
./start.sh stop      # Windows: ./start.ps1 stop
./start.sh status    # Windows: ./start.ps1 status
./start.sh restart
```

On Linux/macOS, `start.sh` detects your GPU (NVIDIA / AMD / none) and brings everything up with the right config - see [GPU support](#picking-your-gpu). The same script stops and inspects the stack too: `./start.sh stop` (or `down`), `./start.sh status`, `./start.sh restart`, `./start.sh logs [service]`. Want to skip the launcher? `docker compose up -d` works too and runs on CPU.

On Windows, `start.ps1` runs bare metal: it starts (or reuses) Ollama natively - which uses your GPU on its own, no overlays needed - plus the web server and the optional voice sidecar, then opens <http://127.0.0.1:8080>. Note the manual path still needs `install.ps1` to have run once (it downloads the portable PHP and sets up the voice venv).

> **Her body isn't in this repo.** The Live2D model and textures belong to *My Dystopian Robot Girlfriend* and aren't redistributed here. Rebuild them from your own copy of the game before first launch:
>
> Answer **yes** when the installer asks to extract them. It installs Python if necessary, creates a local `runtime/asset-recovery-venv`, installs UnityPy and Pillow there, and runs the recovery script. No global `pip install` needed.
>
> If you skipped that prompt, re-run the installer with `JUN_EXTRACT=1` (Linux/macOS) or `$env:JUN_EXTRACT=1; .\install.ps1` (Windows). When automatic detection misses the game, the interactive installer lets you paste its folder or drag the game executable into the terminal. For scripted installs, set `JUN_GAME_DIR` to the game folder.
>
> This writes `webapp/assets/` locally, including a `variants/game_items.json`
> catalog of every packed item layer and color index plus the native hair-strand
> overlays. Those files are **for your own use** - please don't republish them (commit them to a public fork, ship them in a release, mirror them). `webapp/assets/` is in `.gitignore` so it won't get pushed by accident. See the NOTICE in [`LICENSE`](LICENSE).

> **Windows:** if PowerShell slaps down the script, run it once as `powershell -ExecutionPolicy Bypass -File start.ps1` (the `irm | iex` installer already handles this for you).

On first boot Ollama pulls whatever's in `OLLAMA_MODELS_TO_PULL` - by default just the CPU-friendly `hf.co/efficiencyx/Jun-LoRA-v4-E2B-GGUF:Q4_K_M`. Watch it crawl in with `docker compose logs -f ollama` (on Windows the pull runs right in your terminal).

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

## Choosing an AI provider

Jun defaults to **Ollama** (local, fully managed), but both installers ask which backend you want:

| Provider | What it is | Non-interactive install |
|---|---|---|
| **Ollama** (default) | Local inference, models pulled and pre-warmed for you | `JUN_YES=1 ./install.sh` |
| **OpenRouter** | Cloud API - any model on [openrouter.ai](https://openrouter.ai); needs an API key, **your chats leave the machine** | `JUN_PROVIDER=openrouter OPENROUTER_API_KEY=sk-... OPENROUTER_MODEL=openrouter/auto ./install.sh` |
| **llama.cpp** | A local [`llama-server`](https://github.com/ggml-org/llama.cpp) - managed for you (Docker service / winget install), or point at one you already run | `JUN_PROVIDER=llamacpp ./install.sh` (managed) · add `LLAMACPP_URL=http://host:8080` for your own server |

The same knobs work with `install.ps1` on Windows (`$env:JUN_PROVIDER='openrouter'; ...`).

**No second model needed:** lore lookup and cross-chat recall are both plain text matching (keyword/IDF over the corpus, `LIKE` over your history), so picking OpenRouter or llama.cpp doesn't cost you any features and doesn't drag a local Ollama along for the ride.

**A tiny privacy note:** the installer asks (default yes) whether to share anonymized chats, usage stats and thumbs so we can train better Jun models. A random install id keeps it detached from you; set `TELEMETRY=off` in `.env` anytime to opt out. 🌸

**Running compose by hand?** The model-server containers are profile-gated: `./start.sh` derives `COMPOSE_PROFILES` from your `.env`, but a bare `docker compose up -d` needs `COMPOSE_PROFILES=ollama` (or `llamacpp`) set in `.env` or the shell.

## Knobs to turn

Everything's environment variables (see `.env.example`; the full reference lives in [`docs/configuration.md`](docs/configuration.md)):

| Variable | What it does | Default |
|---|---|---|
| `DOMAIN` | Public hostname for nginx `server_name` and certbot | `localhost` |
| `EMAIL` | Contact email for Let's Encrypt | `admin@localhost` |
| `TLS_MODE` | `on` = HTTPS + certbot profile; `off` = plain HTTP | `off` |
| `AI_PROVIDER` | Chat backend: `ollama` \| `openrouter` \| `llamacpp` | `ollama` |
| `OLLAMA_URL` | Where PHP finds Ollama | `http://ollama:11434` |
| `OLLAMA_MODELS_TO_PULL` | Models pulled on first boot | `hf.co/efficiencyx/Jun-LoRA-v4-E2B-GGUF:Q4_K_M` |
| `OPENROUTER_API_KEY` / `OPENROUTER_MODEL` | OpenRouter credentials + default model | - / `openrouter/auto` |
| `LLAMACPP_URL` | Where PHP finds llama-server (custom URL skips the managed one) | `http://llamacpp:8080` |
| `LLAMACPP_MODEL_HF` | HF `repo:quant` the managed llama-server loads (`-hf` syntax) | `efficiencyx/Jun-LoRA-v4-E2B-GGUF:Q4_K_M` |
| `COMPOSE_PROFILES` | Which model-server containers run (`ollama`, `llamacpp`) | `ollama` |
| `TTS_URL` | Where the PHP TTS/STT proxies find the voice sidecar (legacy name `KOKORO_URL` still works) | `http://tts:8001` |
| `TTS_DEVICE` | `cpu` \| `cuda` \| `auto` for voice synthesis. Both engines are real-time on CPU, and `cuda` parks ~2 GB of VRAM that your LLM almost certainly wants more | `cpu` |
| `OMEGA_NUM_CTX` | Context window. Auto-detected from system RAM, which is only a proxy for the VRAM that actually bounds the KV cache - set it by hand if the model crowds your GPU | *(auto)* |
| `TELEMETRY` | `on`/`off` - the anonymized sharing described [above](#choosing-an-ai-provider) | `on` |
| `CORS_ORIGIN` | `Access-Control-Allow-Origin` for the voice sidecar | `http://nginx` |

## Under the hood

```
Browser ──HTTP/SSE──▶ nginx ──FastCGI──▶ php-fpm ──HTTP──▶ ollama :11434
                        │                    │
                        │                    └──────────────▶ tts :8001 (TTS + STT)
                        │
                        └── serves /var/www/omega/ (static assets, JS, Live2D model)
```

**The stack:** PHP 8.2 (the Ollama SSE proxy + RAG) · Python FastAPI + Kokoro-82M / pocket-tts + faster-whisper (the voice and the ears) · plain HTML/JS/CSS up front with PIXI.js + pixi-live2d-display + the Cubism 4 SDK, all served from `webapp/vendor/` · SQLite · nginx + php-fpm. No build step, no bundler, no node_modules black hole.

Want the gory details - token streaming, the ACTION stream buffer, the Live2D tick loop, the TTS pipeline? It's all in [`docs/architecture.md`](docs/architecture.md).

### What happens when you hit send

1. The browser `POST`s your conversation to `/api/chat.php`.
2. PHP assembles the prompt in two halves. The cached half - `system_prompt.txt`, the standing rubrics, and her journal - stays byte-identical between turns, so Ollama's prompt cache keeps hitting. Everything that actually moves goes in a trailing live-context block: the current time, the closest canon lore facts (keyword-matched), her durable notes, what she's wearing, and the current relationship gauges.
3. Ollama streams NDJSON back; PHP re-frames it as `data: {"token":"..."}` SSE events and flushes each one immediately.
4. `js/app.js` watches the stream for `[A:` markers (the legacy `[ACTION:` form still parses too), hides any half-typed marker so it never renders, and fires each action the instant its closing `]` shows up.
5. `js/actions.js` resolves that action against `action_map.json`; `js/live2d.js` lerps the model's parameters toward the new pose every frame.
6. If the voice is on, `js/tts.js` splits the clean text into sentences, fetches audio per sentence from `/api/tts.php`, plays them in order, and drives `ParamMouthOpen` from the analyser's RMS.
7. Bookkeeping happens only *after* `[DONE]` goes out, so none of it can delay a single token. Wander off for a few minutes and the consolidation worker wakes up and rewrites her notes and journal.

## Make her your own

### Rebuild the lore index

The corpus comes from `tools/lore_dataset.jsonl` (curated *Factorial Omega* Q&A, one JSON object per line). Regenerate it whenever you edit that dataset:

```sh
docker compose exec php php tools/build_lore_index.php
```

This flattens each Q&A into question→answer pairs and writes `webapp/lore_corpus.txt` (the answers, one per line) - that's the whole index. Retrieval is a keyword/IDF match done at request time (see [`docs/architecture.md`](docs/architecture.md)), so no embeddings and no Ollama needed. Add `--dry-run` to just count pairs. A missing corpus is fine - retrieval just gets skipped and chat carries on.

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

Everything Jun ships is served from her own origin, so a clean install shouldn't produce these at all - if you're seeing them, something you added is reaching for a third-party host. Whitelist that specific origin under `Content-Security-Policy` (`script-src` / `style-src`) in `docker/nginx/templates/omega.conf.template`, and don't widen it to `*`. Note the policy also forbids inline event handlers, which is why the async-CSS trick in `boot-gate.js` looks the way it does.

Nginx templates are baked into the image, so this one needs `docker compose build nginx` (or `./start.sh --build`) - `sync-webapp.sh` won't pick it up.
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

Check `docker compose logs tts`. The first run downloads ~300 MB of weights. From inside the stack, `docker compose exec nginx wget -qO- http://tts:8001/health` should return `{"ok":true}`. The sidecar's port is intentionally not exposed to the host.
</details>

<details>
<summary><b>Model's taking forever to load</b></summary>

Watch `docker compose logs ollama`. The entrypoint pre-warms the **first** model in `OLLAMA_MODELS_TO_PULL` with an empty prompt to pull weights into VRAM, so if you keep a hand-edited list, make sure the chat model leads it. A `pre-warm failed` line is non-fatal - she'll load on your first real message.
</details>

<details>
<summary><b>She's not broken, just slow</b></summary>

Check GPU residency before anything else: `docker exec omega-ollama ollama ps`. Anything short of 100% GPU means something is elbowing the model out of VRAM, and the usual culprits are `TTS_DEVICE=cuda` (worth ~2 GB for a speedup you won't hear) or a `num_ctx` that RAM-based auto-detection sized too generously - pin it with `OMEGA_NUM_CTX`.

The same command's `UNTIL` column should read `Forever`. A five-minute expiry means the keep-alive pin didn't take, so the next quiet stretch unloads her and the following message eats a 10-16 s reload plus a full re-prefill instead of a cache hit.
</details>

## Where everything lives

```
.
├── docker/                    Dockerfiles, nginx templates, entrypoints
├── tts/                       Audio sidecar: TTS (Kokoro / pocket-tts) + STT (FastAPI, server.py)
├── tools/                     Lore-corpus builder + dataset, critical-CSS inliner, chat-index compaction, asset recovery
├── docs/                      architecture.md, configuration.md + screenshots/
├── webapp/                    Everything served by nginx / php-fpm
│   ├── api/                   chat.php, auth.php, conversations.php, memory.php, consolidate.php, relationship.php, stt.php, tts.php, migrations/, …
│   ├── js/                    app.js, live2d.js, actions.js, voice.js, wardrobe.js, mods.js, tts.js, loader.js, boot-gate.js, ui.js, …
│   ├── vendor/                PIXI, Cubism core, pixi-live2d-display, marked, DOMPurify (no CDN)
│   ├── assets/                Live2D model files (*.moc3, *.physics3.json, *.png)
│   ├── boot.css               Critical CSS, inlined into index.html at sync time
│   ├── action_map.json        Semantic action → Live2D parameter map
│   ├── system_prompt.txt      Jun's persona + ACTION syntax (read server-side)
│   └── index.html             Single-page app entry point
├── install.sh / install.ps1   One-line bootstrap (Linux: Docker · Windows: bare metal)
├── start.sh / start.ps1       Launchers (start.sh: GPU autodetect + compose · start.ps1: native processes)
├── sync-webapp.sh             Dev loop: push webapp/ into the running containers
├── colab.ipynb                The free-GPU notebook
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
- [pocket-tts](https://github.com/kyutai-labs/pocket-tts) - kyutai's 100M CPU voice, her other set of vocal cords
- [faster-whisper](https://github.com/SYSTRAN/faster-whisper) - the local STT that lets her hear you
- [marked](https://github.com/markedjs/marked) + [DOMPurify](https://github.com/cure53/DOMPurify) - markdown rendering that can't bite
- [Ollama](https://ollama.com/) - local LLM inference
- And of course [**Factorial Omega**](https://itch.io/profile/incontinentcell), for giving us Jun in the first place. 💛

## License

MIT - see [LICENSE](LICENSE). This is an unofficial, non-commercial fan project; all *Factorial Omega* rights belong to their respective owners.
