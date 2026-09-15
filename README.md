<div align="center">

<img src="docs/screenshots/hero.png" alt="Jun OS" width="1024">

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![PHP](https://img.shields.io/badge/PHP-8.2-777BB4?logo=php&logoColor=white)
![Python](https://img.shields.io/badge/Python-3.10%2B-3776AB?logo=python&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-compose-2496ED?logo=docker&logoColor=white)
![Live2D](https://img.shields.io/badge/Live2D-Cubism%204-ff7096)
![LLM](https://img.shields.io/badge/LLM-Ollama%20%C2%B7%20llama.cpp-black)
![Platforms](https://img.shields.io/badge/platforms-Linux%20%7C%20macOS%20%7C%20Windows-informational)
![No build step](https://img.shields.io/badge/frontend-no%20build%20step-success)

[What she does](#what-she-does) · [Quickstart](#meet-her-in-five-minutes) · [Colab](#no-gpu-no-problem) · [Models](#her-brains) · [Config](#knobs-to-turn) · [Architecture](#under-the-hood) · [Help](#when-things-go-sideways)

</div>

---

## So what is this?

Jun OS is a fan-made webapp to **Jun** from *!Ω Factorial Omega: My Dystopian Robot Girlfriend*. It's a little chat app where you can actually *talk* to her - and she talks back, with a face that moves while she says it. The whole thing runs on your computer. No account, no cloud, no one else in the room.

In short it's an AI wrapper

> 🔞 **Heads up - this is built on an adult (18+) game.** *Factorial Omega* is a mature, NSFW dating sim, and Jun OS carries that DNA: there's an adult-content gate at signup, and how spicy things get is up to you. Keep it on your own machine, keep it to consenting adults.

> ⚠️ Unofficial fan project. Not affiliated with Incontinent Cell or the *Factorial Omega* team - we just like Jun a lot. All rights to the game and its characters belong to their owners.
## Look at her
<details>
<summary>Images</summary>

| <img src="docs/screenshots/chat.png" alt="Chat Interface" width="512"> | <img src="docs/screenshots/wardrobe.png" alt="Chat Interface" width="512"> |
|:---:|:---:|
| <img src="docs/screenshots/welcomeback.png" alt="Welcomeback Reaction" width="512"> | <img src="docs/screenshots/voicemode.png" alt="Voice Mode" width="512"> |

</details>
<details>
<summary>Videos</summary>

**Karaoke** (ignore the user singing)

https://github.com/user-attachments/assets/f27859ad-9fee-467b-84a8-4f7630d2e2b6

</details>


## What she does

- **She reacts as she talks.** Gestures and expressions land on the word, not two seconds later.
- **She has a voice**, and her mouth actually follows it.
- **You can talk back.** Turn on the mic and it's a hands-free conversation.
- **She has feelings about you.** Affection, trust and tension move with every exchange, and she treats you accordingly. Push her far enough and she goes quiet, or walks out - and the door stays shut for a few minutes.
- **She can think before she answers.** A reasoning knob (auto / low / medium / high) and a toggle to watch the chain of thought stream by.
- **She remembers.** She'll bring up things you said in other chats, and quietly keeps notes and a journal between sessions.
- **She knows her lore.** Ask her about the game's world and she stays in canon.
- **She'll sing with you.** 🎤 Load a song, get timed lyrics, and see how close you got.
- **Dress her up.** A whole wardrobe to toggle and recolor - she'll tell you what she thinks of it.
- **Bring your mods.** Game-mod zips load straight into the browser.
- **It's yours.** She runs on your machine. No account, no cloud inference, no analytics, nothing reporting back to us - the only things that leave your box are the ones you ask for: a model download, a lyrics lookup, a web search she runs for you, and OpenRouter if you *choose* that provider. [The full list](SECURITY.md#what-talks-to-the-internet).

Curious how any of it works? [Under the hood](#under-the-hood).

## Meet her in five minutes

You don't need to know how any of this works. You copy one line, paste it into a black window, and wait. That line installs whatever your computer is missing, downloads her brain, rebuilds her body from your own copy of the game, and starts her up.

**The black window.**
On Windows Press the Start button, type `Command Prompt`, hit Enter.
On Linux you already know. Paste with `Ctrl + Shift + V`, then hit Enter.

> ⚠️ **Before you paste anything, anywhere.** The commands below download a script off the internet and run it on your computer. That's a lot of trust to hand a stranger, and the habit of doing it without looking is how people get malware. If you don't understand a command, don't run it - paste it into ChatGPT or Claude and ask what it does. Same goes for the next person's "just run this", not only ours.
>
> Want to read our script first? Good. 👀 Grab it without running it:
>
> - **Windows:** `powershell irm https://raw.githubusercontent.com/efficiencyx/JunOS/main/install.ps1 -OutFile install.ps1` - then open `install.ps1` in **Notepad**.
> - **Linux / macOS:** `curl -fsSL https://raw.githubusercontent.com/efficiencyx/JunOS/main/install.sh | less` - press `q` to quit when you're done reading.

### 🪟 On Windows

She runs directly on Windows, no Docker (Docker on Windows is a pain). Pick **one** of these two lines - both do the same install, they just look different while they work.

With a window and buttons:

```powershell
powershell irm https://raw.githubusercontent.com/efficiencyx/JunOS/main/installer-gui.ps1 -OutFile installer-gui.ps1; powershell -ExecutionPolicy Bypass -File .\installer-gui.ps1
```

Or plain text scrolling by:

```powershell
powershell irm https://raw.githubusercontent.com/efficiencyx/JunOS/main/install.ps1 -OutFile install.ps1; powershell -ExecutionPolicy Bypass -File .\install.ps1
```

### 🐧 On Linux, macOS or WSL

Needs `git` and Docker. Don't have them? The script installs them for you.

```sh
curl -fsSL https://raw.githubusercontent.com/efficiencyx/JunOS/main/install.sh | bash
```

### Doing it manually without the installer

The step-by-step commands for it, every provider, and the manual compose invocations live in the **[wiki](https://github.com/efficiencyx/JunOS/wiki)**.

### What it asks you

Exactly one question: **Express** or **Custom**.

- **Express** - press Enter and forget about it. It figures out your hardware on its own and rebuilds her Live2D model from your game copy. The only thing it might still ask is *where* the game is, and only if it can't find it by itself.
- **Custom** - walks you through which provider, which model, which voice, and whether to turn on [MTP](#faster-tokens-mtp).

Installing on a machine you can't sit in front of? `JUN_YES=1` (on Windows, `$env:JUN_YES='1'`) skips the question entirely.

### Then say hi 🎉

Open your browser at **<https://localhost>** - or **<http://127.0.0.1:8080>** if you're on Windows (bare metal, no TLS).

### Managing Her

Windows: 
Start her: `powershell .\Jun\start.ps1`
Stop her: `powershell .\Jun\start.ps1 stop`

Linux:
Start her: `./Jun/start.sh`
Stop her: `./Jun/start.sh stop`

### Why the first start is slow

The very first boot downloads her brain - whatever model is listed in `OLLAMA_MODELS_TO_PULL`, by default `hf.co/efficiencyx/Jun-LoRA-E2B-GGUF:Q4_K_M`, which is the one that runs fine without a fancy graphics card. It's a big file. On Ollama it also grabs the tiny model that names your chats (`TITLE_MODEL`, ~1.2 GB, lives on the CPU) and, if you said yes to MTP, the drafter. Watch it all crawl in with `./start.sh logs ollama`.

She's ready once everything reports **healthy**. After that first download it's usually 30-90 seconds. 💤


> ### Her body isn't in this repo
>
> The Live2D model and textures belong to *My Dystopian Robot Girlfriend* and aren't redistributed here - you rebuild them from your own copy of the game. Express does this for you; under Custom, answer **yes** when the installer offers. Either way it sets up a local `runtime/asset-recovery-venv` (UnityPy + Pillow, no global `pip install`) and runs the recovery script. 🔧
>
> Can't find the game? It'll ask you to paste the folder or drag the game onto the terminal - Express included, press Enter to skip. No game on that machine at all? Nothing breaks, she just wears the placeholders and the install carries on. Want it later, or don't want it at all? `JUN_EXTRACT=1` re-runs it, `JUN_EXTRACT=0` tells Express to leave it alone (`$env:JUN_EXTRACT='1'; .\install.ps1` on Windows). If auto-detection misses the game, paste its folder when asked, or set `JUN_GAME_DIR` for scripted installs.
>
> The result lands in `webapp/assets/` and is **for your own use** - please don't republish it. It's gitignored so it can't get pushed by accident. See the NOTICE in [`LICENSE`](LICENSE).

### No GPU or you just want to test the waters? No problem

Run the whole stack on a **free Colab T4** - nothing installed, nothing on your machine, just a Google account.

[![Open In Colab](https://colab.research.google.com/assets/colab-badge.svg)](https://colab.research.google.com/github/efficiencyx/JunOS/blob/main/colab.ipynb)

1. Open [`colab.ipynb`](colab.ipynb) with the badge.
2. **Runtime → Change runtime type → T4 GPU → Save.**
3. **Runtime → Run all**, wait for the ✅s (first run downloads a few GB, ~3–6 min).
4. Click the public link printed at **Step 3**.

Two knobs in the cells: **Model** (`auto` takes the 12B since Colab can hold it) and **Voice** (adds ~2 min on first run). The link comes from Colab's own proxy - if it 404s briefly, wait 30 s and reload.

> ⚠️ **It's a disposable demo.** Colab wipes the session when it ends: accounts, chat history and weights don't survive. Run her locally for anything persistent.

### Putting her on the internet [NOT RECOMMENDED]

> ⚠️ **Warning:** Do **not** publicly expose an installation that contains the original game assets.
>
> If you know what you're doing and have made sure **no copyrighted game assets are publicly accessible**, you can expose the application.

Domain pointed at your server?
Ports **80** and **443** open?

Then you're ready to configure the reverse proxy.


```sh
BIND_ADDR=0.0.0.0 DOMAIN=yourdomain.com EMAIL=you@yourdomain.com TLS_MODE=on COMPOSE_PROFILES=prod ./start.sh
```

`BIND_ADDR` is the deliberate step: out of the box nginx publishes on `127.0.0.1` only, so a fresh install isn't reachable from the next machine on the wifi. Opening it up is a thing you type, not a default you inherit. Let's Encrypt also can't reach the challenge until you do.

### 📱 Just want her on your phone, on your own wifi?

You don't need a domain or a certificate for that. Set two lines in `.env` and restart:

```sh
BIND_ADDR=0.0.0.0
OMEGA_ALLOW_INSECURE_PUBLIC_HTTP=1
```

The launcher works out this machine's address on the network by itself and prints it - `reachable as: 192.168.X.X` on Linux, `on your phone: http://192.168.X.X:8080` on Windows - and that's the URL you type into the phone. On Windows it also adds a firewall rule for the port on **private** networks only (it needs an admin PowerShell to do it, otherwise it prints the one-liner for you to run). One request at a time on Windows, so the phone and the desktop take turns.

The second line is not decoration: there's no TLS here, so your password and every word she says cross the wifi in the clear. Fine on your own network, **never** on one you don't control, and never port-forwarded to the internet - that's what the certbot setup above is for. 🔒 DHCP moves addresses around, so if she stops answering after a few days, restart the launcher and read the new one.

The `prod` profile adds the certbot sidecar: `certbot certonly --webroot` on start, then `certbot renew` every 12 hours, certs in the `letsencrypt` volume, nginx serving 443 with HSTS. Mind Let's Encrypt's 5-duplicate-issuances-per-week limit while testing.

> **Hosting her for other people?** Their chats now live on *your* box and *you're* responsible for them. Encrypt the machine and its backups, don't hand the database around, and edit [`webapp/privacy.html`](webapp/privacy.html) to say what you actually store. In the EU that also makes you a *deployer* under the AI Act (art. 50 transparency, in force since 2 August 2026) - Jun ships the disclosure side already (age gate, permanent `AI` badge, provenance metadata on generated speech), so please don't strip it out of your fork. 

## Her brains

The fine-tune comes in 12B, E4B and E2B on Hugging Face. The installer picks a conservative quant for your VRAM; move a column right when the rest of your workload leaves room.

| VRAM | Default | Higher quality |
|---:|---|---|
| 4 GB | E2B Q4_K_M | E2B Q6_K |
| 6 GB | E2B Q6_K | E2B Q8_0 |
| 8 GB | E4B Q4_K_M | E4B Q8_0 |
| 10 GB | E4B Q8_0 | 12B Q4_K_M |
| 12 GB | 12B Q4_K_M | 12B Q6_K |
| 16 GB | 12B Q6_K | 12B Q8_0 |
| 24 GB | 12B Q8_0 | - |

`JUN_MODEL=12b|e4b|e2b` picks a family at Q4_K_M; a full Ollama reference picks an exact quant. The frontend lists whatever's actually installed.

### Faster tokens: MTP

Gemma 4 ships a tiny *drafter* that guesses the next few tokens; Jun checks the whole batch in one pass and keeps the ones she agrees with, so those came almost free. Nothing she says changes - rejected guesses are thrown away - only the speed does. The installer offers it (`JUN_MTP=on|off`, on under Express) and then runs `./mtp-autotune.sh` (`mtp-autotune.ps1` on Windows) once she's up, measuring depths 1-4 against plain decoding *with the real system prompt in front* and writing the winner into `.env`. If nothing beats plain decoding it turns MTP back off and says so. Swap the GPU and the launcher notices (`MTP_TUNED_GPU`) and re-tunes on the next start; `MTP_AUTOTUNE=off` skips that. Budget the model, the drafter, *and* ~1.5 GB for the browser drawing Live2D on the same card. Knobs and the measurements behind the defaults: [`docs/configuration.md`](docs/configuration.md#7b-multi-token-prediction-experimental).

### Where the thinking happens

| Provider | What it is | Non-interactive install |
|---|---|---|
| **Ollama** *(default)* | Local inference, models pulled and pre-warmed for you | `JUN_YES=1 ./install.sh` |
| **llama.cpp** | A local [`llama-server`](https://github.com/ggml-org/llama.cpp) - managed for you, or point at one you already run | `JUN_PROVIDER=llamacpp ./install.sh` |
| **OpenRouter** | Any cloud model; needs a key, and **your chats leave the machine** | `JUN_PROVIDER=openrouter OPENROUTER_API_KEY=sk-... ./install.sh` |

llama.cpp can also serve a GGUF straight off your disk (`LLAMACPP_MODELS_DIR` + `LLAMACPP_MODEL_FILE`), and `LLAMACPP_TOOLS=off` exists for fine-tunes whose tool-call syntax llama-server can't parse.

**No retrieval model:** lore lookup and cross-chat recall are plain text matching - keyword/IDF over the corpus, SQL `LIKE` over your history - so a non-Ollama provider costs you no features and drags no embedder along. The only extra model in the stack is the Ollama-only chat titler (`TITLE_MODEL`, a 0.6B fine-tune pinned to the CPU so it never fights her for VRAM; set it empty and titles fall back to your first message).

### Picking your GPU

| Backend | How `start.sh` spots it | What it does |
|---|---|---|
| **NVIDIA** | `nvidia-smi` works, or `/proc/driver/nvidia` exists | Adds `docker-compose.nvidia.yml`. Needs [nvidia-container-toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html). |
| **AMD** | `/dev/kfd` + `/dev/dri/renderD*` present | Adds `docker-compose.amd.yml` (ROCm image, device passthrough, host `video`/`render` groups). Needs `amdgpu`. |
| **CPU** | nothing else matched | Base compose only - runs anywhere. |
| **Intel** | Not implemented | Do you have an Intel GPU? Contact me! |
| **Apple Silicon** | Not implemented | Do you have Apple Silicon? Contact me! |


Force it with `GPU=nvidia|amd|cpu ./start.sh`. **Two cards?** They're sorted by VRAM and the biggest is pinned as device 0, so she loads onto the one that can hold her; `GPU_DEVICES` overrides the list and `TENSOR_PARALLEL=on` spreads one model across all of them (slower per token - worth it only when nothing fits alone). **AMD consumer cards** that ROCm doesn't officially list may need `HSA_OVERRIDE_GFX_VERSION=11.0.0` (RDNA3) or `10.3.0` (RDNA2).

## Knobs to turn

Everything is environment variables in `.env` - the full reference is [`docs/configuration.md`](docs/configuration.md).

| Variable | What it does | Default |
|---|---|---|
| `DOMAIN` / `EMAIL` / `TLS_MODE` | Hostname, Let's Encrypt contact, HTTPS on/off | `localhost` · `admin@localhost` · `off` |
| `BIND_ADDR` | Where nginx listens. Public addresses require TLS unless you explicitly accept insecure HTTP | `127.0.0.1` |
| `AI_PROVIDER` | `ollama` \| `llamacpp` \| `openrouter` | `ollama` |
| `OLLAMA_MODELS_TO_PULL` | Pulled on first boot; the **first** one is pre-warmed | `hf.co/efficiencyx/Jun-LoRA-E2B-GGUF:Q4_K_M` |
| `LLAMACPP_MODEL_HF` / `LLAMACPP_MODEL_FILE` | Model for the managed llama-server: pull from HF, or serve one off disk | `efficiencyx/Jun-LoRA-E2B-GGUF:Q4_K_M` |
| `TITLE_MODEL` | Ollama only. The little CPU-pinned model that names new chats; empty disables it | `hf.co/efficiencyx/Titlewen-GGUF:F16` |
| `OLLAMA_MTP` / `LLAMACPP_MTP` | HF repo of the [MTP](#faster-tokens-mtp) drafter; empty = off. `MTP_AUTOTUNE=off` stops the re-tune after a GPU change | *(empty)* · `on` |
| `COMPOSE_PROFILES` | Optional containers: `ollama`, `llamacpp`, `voice`, `karaoke`, `prod`. `start.sh` derives them from the knobs below, you only set this by hand for `prod` | `ollama` |
| `VOICE` | `off` skips the voice sidecar: the `tts` container under Docker (`voice` profile), the sidecar process on bare-metal Windows. Chat degrades to text-only | `on` |
| `FLEE_BANS` | When she walks out of a scene, `on` locks that account out of chat for 5 min, doubling per repeat up to 30. `off` lets her leave without the lockout | `on` |
| `TTS_DEVICE` | Voice synthesis device. Keep it on CPU: both engines are real-time there, and a GPU copy parks ~2 GB your LLM wants more | `cpu` |
| `KARAOKE` / `SEP_DEVICE` | Karaoke sidecar on/off, and where stem separation runs. *This* is the audio job that wants a GPU - minutes on CPU, seconds on a card, VRAM handed back after | `on` · `auto` |
| `STT_MODEL` / `STT_LANG` | Whisper size and language; blank lang = per-utterance auto-detect | `base` · *(auto)* |
| `OMEGA_NUM_CTX` | Context window. Auto-sized from leftover VRAM (falling back to RAM) - pin it if she's crowding your card | *(auto)* |
| `OMEGA_STATE_DIR` / `MEMORY_DIR` | Where the database, rate-limit state and memory notes live | `/var/lib/omega` |
| `OMEGA_REGISTRATION_KEY` | Sign-ups need this key. The installer generates one for you; empty it to let anyone in | *(generated)* |
| `OMEGA_DEV_KEY` | Optional developer access key | *(unset)* |

### Who gets in 🔑

**The registration key** is written into `.env` by the installer and printed when it finishes. The very first account on a fresh install skips it (it's your box, you just ran the installer); every account after that has to type it, so nobody who reaches the page later can make themselves a login. Don't want the lock? Empty the value (`OMEGA_REGISTRATION_KEY=`) and sign-ups are open to whoever can reach the page. 🔑 Lost it? It's sitting in plain text in your own `.env` - read it back, or change it to whatever you like and restart.

Normal accounts get **Factory Reset** in the same panel - one button that erases every conversation, memory and setting and hands the account back the way it came.

## Under the hood

```
Browser ──HTTP/SSE──▶ nginx ──FastCGI──▶ php-fpm ──HTTP──▶ ollama / llama-server
                        │                   │
                        │                   ├──────────────▶ tts :8001      (TTS + STT, CPU)
                        │                   └──────────────▶ karaoke :8001  (demucs, GPU)
                        └── serves /var/www/omega/ (static assets, JS, Live2D model)
```

**The stack:** PHP 8.2 for the SSE proxy and retrieval · Python FastAPI + Kokoro-82M / pocket-tts / faster-whisper / demucs for the ears, voice and karaoke · plain HTML/CSS/ES modules up front with PIXI.js + pixi-live2d-display + Cubism 4, all vendored · SQLite · nginx + php-fpm. No bundler, no `node_modules`, no build step.

**What happens when you hit send:**

1. The browser `POST`s to `/api/chat.php`.
2. PHP assembles the prompt in two halves. The cached half - `system_prompt.txt` and her journal - stays byte-identical between turns so the KV prompt cache keeps hitting. Everything that moves goes in a live-context block glued *after* your question in the last user turn: clock, matched lore facts, durable notes, outfit, relationship gauges. Dead last comes a `<think:low|med|high>` marker telling her how hard to think this turn.
3. The model streams back (NDJSON from Ollama, OpenAI-style SSE from the others); `providers.php` normalizes both and PHP re-frames each token as an SSE event and flushes it immediately. If she reaches for a tool (search her notes, change outfit, look something up, walk out) PHP runs it and streams another round, up to three.
4. `js/app/stream-filters.js` watches the stream for `[A:` markers, holds back any half-typed marker so it never renders, and fires the action the instant its `]` arrives.
5. `js/live2d.js` lerps the model toward the new pose; if voice is on, `js/tts.js` fetches audio per sentence and drives `ParamMouthOpen` from the analyser's RMS.
6. Bookkeeping happens only *after* `[DONE]`, so nothing can delay a token: her hidden `[A:mood_shift|...]` tag moves the gauges, a new chat gets its title. Wander off and the consolidation worker rewrites her notes and journal.

The gory version - the action state machine, the tick loop, the memory pipeline - is in [`docs/architecture.md`](docs/architecture.md).

### Contributing or Tweaking her?

> 📦 **How this repo gets updated.** Day-to-day work happens in a development repo - that's where the extracted Live2D art lives, plus the dataset tooling and a pile of half-finished experiments nobody needs to see. What lands here is snapshots: working states, pushed when something's actually done, reviewed and CI passes. So the commits are chunky and the timestamps come in bursts.

> 🎨 **Her art isn't in here** and won't be - see the NOTICE in [LICENSE](LICENSE). `tools/recover_assets.py` rebuilds `webapp/assets/` from your own copy of the game, which is the only way it's allowed to work. Fresh clone looks a bit naked until you run it.

The house rules, the invariants you can break without noticing, and what CI checks are in [`CONTRIBUTING.md`](CONTRIBUTING.md). Stuck rather than hacking? [`SUPPORT.md`](SUPPORT.md). Found a hole? [`SECURITY.md`](SECURITY.md).

Editing anything under `webapp/`? Run **`./sync-webapp.sh`** - it pushes the files into the running containers and restarts php-fpm (opcache won't notice otherwise). `-s` for static-only.

Lore datamine from LLMs lives in `tools/lore_dataset.jsonl` (kept local, not in the repo); rebuild the index after editing it:

```sh
docker compose exec php php tools/build_lore_index.php
```

That flattens each Q&A into `webapp/lore_corpus.txt` - one answer per line, matched at request time by keyword/IDF. No embeddings, no second model. A missing corpus is fine; retrieval just gets skipped.

## When things go sideways

<details>
<summary><b>Replies arrive all at once instead of streaming</b></summary>

Something's buffering the SSE. The `/api/chat.php` location needs `proxy_buffering off;`, `fastcgi_buffering off;` and `X-Accel-Buffering: no`. A load balancer in front of nginx can sneak buffering back in.
</details>

<details>
<summary><b>She's not broken, just slow</b></summary>

Check GPU residency first: `docker exec omega-ollama ollama ps`. Anything short of 100% GPU means something is elbowing her out of VRAM - usually `TTS_DEVICE=cuda` (~2 GB for a speedup you won't hear) or a too-generous `num_ctx`; pin it with `OMEGA_NUM_CTX`. The `UNTIL` column should read `Forever`; a five-minute expiry means the keep-alive pin didn't take and the next quiet stretch costs you a full reload plus re-prefill.
</details>

<details>
<summary><b>Jun is invisible</b></summary>

Open the console - a missing texture shows up as a 404. Confirm `webapp/assets/*.png` exist (see [her body isn't in this repo](#her-body-isnt-in-this-repo)) and that nginx's root points at `/var/www/omega/`.
</details>

<details>
<summary><b>No voice</b></summary>

First check `VOICE` in `.env` - `off` means the `tts` container was never started (`./start.sh` lists the compose profiles it resolved). Then `./start.sh logs tts`. The first run downloads ~300 MB of weights. From inside the stack, `docker compose exec nginx wget -qO- http://tts:8001/health` should return `{"ok":true}` - the sidecar's port is deliberately not published to the host, and everything but `/health` wants the `X-Sidecar-Secret` header PHP adds.
</details>

<details>
<summary><b>She walked out and now every message is refused</b></summary>

That's the flee lockout, not a bug: the stream answers `user_fled` with a countdown, and the chat UI shows it. 5 minutes the first time, doubling per repeat up to 30, reset after a day of good behaviour. `FLEE_BANS=off` in `.env` lets her leave a scene without locking the account. A referee pass has to agree she could physically leave and had a reason, so "I told her to test the flee tool" doesn't count.
</details>

<details>
<summary><b>The karaoke button is greyed out</b></summary>

Karaoke is its own container, so it needs `KARAOKE=on` in `.env` (`./start.sh` prints `karaoke: off` when it isn't). Check `./start.sh logs karaoke` and `docker compose exec nginx wget -qO- http://karaoke:8001/health` - `"sep":true` means separation is ready and `"device"` says whether it got the GPU.
</details>

<details>
<summary><b>Getting 429s while chatting</b></summary>

The rate limiter tripped, and there are two layers: `limit_req` / `limit_conn` per location in the nginx template (`/api/chat.php` allows 2 open streams per IP) and `rate_limit('chat', 30, 60)` in `webapp/api/chat.php`. The stricter one wins, so raise both.
</details>

<details>
<summary><b>CSP violations in the console</b></summary>

Everything ships from her own origin, so a clean install produces none - if you see them, something you added is reaching for a third-party host. Whitelist that specific origin in `docker/nginx/templates/omega.conf.template`, never `*`. Nginx templates are baked into the image, so this needs `./start.sh --build`; `sync-webapp.sh` won't pick it up.
</details>

<details>
<summary><b>Running compose by hand and nothing starts</b></summary>

The model-server and voice containers are profile-gated. `./start.sh` derives `COMPOSE_PROFILES` from your `.env`; a bare `docker compose up -d` needs `COMPOSE_PROFILES=ollama,voice` (or `llamacpp,voice`, plus `karaoke` if you want it) set in `.env` or the shell.
</details>

## Where everything lives

```
.
├── docker/           Dockerfiles, nginx templates + security-headers snippet, entrypoints
├── tts/              Audio sidecar: TTS + STT + karaoke separation (FastAPI, server.py)
├── tools/            Lore builder, critical-CSS inliner, asset recovery, the bare-metal php router
├── docs/             architecture.md, configuration.md, wiki/ (the GitHub wiki source), screenshots/
├── android/          Same webapp on a phone: Ktor server + LiteRT-LM on-device, its own Gradle project
├── webapp/           Everything nginx and php-fpm serve
│   ├── api/          chat.php, providers.php, auth.php, memory.php, outfit.php, karaoke.php, migrations/, …
│   ├── js/           app/, live2d/, actions.js, voice.js, wardrobe.js, mods.js, karaoke.js, …
│   ├── css/          base, shell, chat, stage, sidebar, settings, widgets, responsive
│   ├── vendor/       PIXI, Cubism core, pixi-live2d-display, marked, DOMPurify (no CDN)
│   ├── assets/       Live2D model files - you generate these, gitignored
│   ├── boot.css      Critical CSS, inlined into index.html at sync time
│   └── system_prompt.txt
├── install.sh · install.ps1     One-line bootstrap (Docker · bare metal)
├── installer-gui.ps1            The Windows click-through window (ships as JunSetup.exe)
├── uninstall.ps1                Takes her off a Windows box again
├── start.sh · start.ps1         Launchers, and the stop/status/logs control panel
├── mtp-autotune.sh · .ps1       Measures the MTP draft depth and writes the winner to .env
├── sync-webapp.sh               The dev loop
├── colab.ipynb                  The free-GPU notebook
├── .github/workflows/           CI (syntax, stream-buffer tests, a chat turn against a fake Ollama) + the JunSetup.exe release
└── docker-compose*.yml          Base (CPU) + nvidia / amd overlays, llamacpp-local / llamacpp-mtp add-ons
```

## Standing on the shoulders of

[PIXI.js](https://pixijs.com/) · [pixi-live2d-display](https://github.com/guansss/pixi-live2d-display) · [Live2D Cubism SDK](https://www.live2d.com/en/sdk/about/) · [Ollama](https://ollama.com/) · [llama.cpp](https://github.com/ggml-org/llama.cpp) · [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) · [pocket-tts](https://github.com/kyutai-labs/pocket-tts) · [faster-whisper](https://github.com/SYSTRAN/faster-whisper) · [demucs](https://github.com/adefossez/demucs) · [marked](https://github.com/markedjs/marked) + [DOMPurify](https://github.com/cure53/DOMPurify)

And of course [**Incontinent Cell**](https://itch.io/profile/incontinentcell), for giving us Jun in the first place.

## License

MIT - see [LICENSE](LICENSE). Unofficial, non-commercial fan project; all *Factorial Omega* rights belong to their respective owners.
