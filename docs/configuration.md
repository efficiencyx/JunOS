# Configuration reference

All runtime configuration is environment variables. Under Docker, `docker compose`
reads `.env` in the repo root and interpolates `${VAR:-default}` into each
service's `environment:` block in `docker-compose.yml` (and the `.nvidia`/`.amd`
overlays) - a var only reaches a container if that container's block lists it.
The bare-metal Windows launcher (`start.ps1`) also parses `.env` directly
(loading `KEY=VALUE` lines as process env vars unless already set), but it
skips anything that looks like a Docker-internal hostname:

```powershell
# start.ps1 ~line 47-48
if ($v -match '://(ollama|tts|kokoro|nginx|php|llamacpp)\b') { continue }
```

so values like `OLLAMA_URL=http://ollama:11434` from `.env.example` are ignored
on Windows and the script's own `127.0.0.1:*` defaults are used instead.

**Nothing is required.** Every variable has a working default; the one
conditional requirement is `OPENROUTER_API_KEY`, needed only when
`AI_PROVIDER=openrouter`.

`install.sh` / `install.ps1` write most of these into `.env` interactively;
`.env.example` is the copy-and-edit starting point.

---

## 1. Core / site

| Variable | Default | Consumed by | What it does |
|---|---|---|---|
| `BIND_ADDR` | `127.0.0.1` | `docker compose` port mapping (`docker-compose.yml`), echoed by `start.sh` | Address nginx publishes `:80`/`:443` on. Loopback means this machine only; `0.0.0.0` exposes it to everything that can reach the host, and is required before Let's Encrypt can answer the HTTP-01 challenge. |
| `DOMAIN` | `localhost` | `nginx`, `certbot` services (`docker-compose.yml`) | Public hostname nginx serves and certbot requests a cert for. |
| `EMAIL` | `admin@localhost` | `certbot` service | Contact address for Let's Encrypt issuance. Only meaningful when `TLS_MODE=on`. |
| `TLS_MODE` | `off` | `nginx` service, nginx config templates | `on` enables HTTPS via certbot (requires a public `DOMAIN`) and adds HSTS; `off` serves plain HTTP on `:80`. |
| `COMPOSE_PROFILES` | `ollama` | `docker compose` itself (not forwarded into any container) | Picks which model-server containers run: `ollama`, `llamacpp`, `prod` (certbot). `start.sh` derives it from `AI_PROVIDER` when unset; `install.sh` writes it for you. |

## 2. AI provider

| Variable | Default | Consumed by | What it does |
|---|---|---|---|
| `AI_PROVIDER` | `ollama` | `webapp/api/providers.php` (`ai_provider()`) | Selects the chat backend: `ollama` (native NDJSON API) \| `openrouter` \| `llamacpp` (both OpenAI-compatible). Invalid values fall back to `ollama`. |
| `OLLAMA_URL` | `http://ollama:11434` (Docker) / `http://localhost:11434` (PHP fallback) | `providers.php`, `models.php` | Base URL of the Ollama instance backing chat (when `AI_PROVIDER=ollama`). |
| `OLLAMA_MODELS_TO_PULL` | `hf.co/efficiencyx/Jun-LoRA-v4-E2B-GGUF:Q4_K_M` | `ollama` and `php` services | Comma-separated models pulled on first boot; the first one is the backend default for background completions. |
| `TITLE_MODEL` | `hf.co/efficiencyx/Titlewen-GGUF:F16` | `ollama` and `php` services, `providers.php` (`generate_chat_title()`) | Small dedicated model used to auto-title new conversations from the first user message. Pinned to CPU (`num_gpu: 0`) and kept resident (`keep_alive: -1`) so it never competes with the chat model for VRAM; the entrypoint pulls and pins it on boot. Set empty to disable and fall back to truncating that message; only used when `AI_PROVIDER=ollama`. |
| `OPENROUTER_API_KEY` | *(empty)* | `providers.php` (`chat_request_headers()`) | Bearer key for OpenRouter. **Required when `AI_PROVIDER=openrouter`.** |
| `OPENROUTER_MODEL` | `openrouter/auto` | `providers.php` (`default_chat_model()`) | Default chat model id sent to OpenRouter. |
| `LLAMACPP_URL` | `http://llamacpp:8080` (Docker) / `http://127.0.0.1:8081` (PHP fallback) | `providers.php` (`chat_api_base()`) | Base URL of the llama.cpp `llama-server`. Point it at your own server to skip the managed `llamacpp` container. |
| `LLAMACPP_MODEL_HF` | `efficiencyx/Jun-LoRA-v4-E2B-GGUF:Q4_K_M` | `llamacpp` service (`LLAMA_ARG_HF_REPO`), `providers.php` (cosmetic default model id) | HF `repo:quant` the managed `llama-server` downloads and loads (`llama-server -hf` syntax, no `hf.co/` prefix). |
| `LLAMACPP_TOOLS` | `on` | `providers.php` (`provider_tools_enabled()`) | Set `off` when the loaded chat template cannot do native tool calling. Chat stops offering tools, while memory consolidation falls back to model-produced JSON operation arrays executed by the same guarded tool loop. |

## 3. Audio sidecars

Two containers off one `tts/server.py`: `tts` (voice, always CPU) and `karaoke`
(stem separation, GPU by default, profile-gated). Bare-metal installs run a
single process in both roles.

| Variable | Default | Consumed by | What it does |
|---|---|---|---|
| `VOICE` | `on` | `start.ps1` only | **Bare-metal Windows only.** `off` skips launching the TTS/STT sidecar process. Under Docker the `tts` service always runs (no compose `voice` profile exists); `php`/frontend degrade to text-only when it's unreachable or unhealthy. |
| `TTS_URL` | `http://tts:8001` (Docker) / `http://localhost:8001` (PHP fallback) | `webapp/api/tts.php`, `stt.php` | Base URL of the voice sidecar. The pre-rename name `KOKORO_URL` is still honored as a fallback for existing `.env` files. |
| `TTS_DEVICE` | `cpu` | `start.sh`, `docker/tts.Dockerfile` ENV → `tts/server.py` | `cpu` \| `cuda` \| `auto`. Torch device for TTS synthesis. The image ships a CPU torch, so `auto` resolves to CPU there and `cuda` only means something on bare metal or after a `TTS_TORCH_INDEX` override. Both engines are real-time on CPU; GPU TTS holds ~2GB VRAM, which costs more in LLM layer offload than it buys in synthesis speed. |
| `TTS_TORCH_INDEX` | `https://download.pytorch.org/whl/cpu` | `docker-compose.yml` → `docker/tts.Dockerfile` | Advanced override for the PyTorch wheel index the voice image builds against. No GPU overlay touches it any more - that plumbing moved to `KARAOKE_TORCH_INDEX`. Normally leave this unset. |
| `KARAOKE` | `on` | `install.sh` writes it, `start.sh` reads it | `on` adds the `karaoke` compose profile, which builds and runs the separation sidecar (a few GB: demucs plus a CUDA/ROCm torch). `off` leaves the container out entirely; `api/karaoke.php` then can't reach it and the webapp greys the karaoke button out. `start.sh` prints `karaoke: off` when the profile is absent, since an `.env` predating this split has no `KARAOKE` key. |
| `KARAOKE_URL` | `http://karaoke:8001` (Docker) / falls back to `TTS_URL` | `webapp/api/karaoke.php` | Base URL of the separation sidecar. The fallback chain is `KARAOKE_URL` → `TTS_URL` → `KOKORO_URL` → `http://localhost:8001`, so bare-metal installs serving both roles from one process need no extra config. |
| `SEP_DEVICE` | `auto` (`cuda` or `cpu` as chosen at install) | `start.sh`, `docker/karaoke.Dockerfile` ENV → `tts/server.py` | `cpu` \| `cuda` \| `auto`. Torch device for demucs. Unlike `TTS_DEVICE` this one is worth the VRAM - a 4-minute song is minutes on CPU and seconds on a card - and `api/karaoke.php` evicts the chat model from Ollama before each job so the two don't fight. A per-job CUDA failure (OOM, bad kernel) retries on CPU instead of failing the song. |
| `KARAOKE_TORCH_INDEX` | CUDA/ROCm on the GPU overlays, CPU otherwise | `start.sh`, `docker-compose.*.yml` | Advanced override for the karaoke image's PyTorch wheel index. `start.sh` pins the CPU index when `SEP_DEVICE=cpu`, so declining GPU separation doesn't download a multi-GB GPU wheel. |
| `STT_MODEL` | `base` | `tts/server.py` (both sidecars) | faster-whisper model. Karaoke uses the same model for the timed lyric track. Default `base` is multilingual; the `.en` builds (`tiny.en`, `base.en`, `small.en`) are English-only and slightly faster/sharper on English. Size up the multilingual model (`small`, `medium`, `large-v3`) for better non-English accuracy. Must agree with `STT_LANG`. |
| `STT_LANG` | `""` (auto-detect) | `tts/server.py` (`STT_LANG` env) | Whisper language code. In `docker-compose.yml` this is wired as `STT_LANG: "${STT_LANG-}"` (bash-style *unset*-only default, note the missing `:`) - so an unset var and an explicitly empty `STT_LANG=` both pass through as `""`, and `server.py` treats an empty string as `None`, i.e. whisper auto-detects the language per utterance/song. Pin a code (`en`, `it`, `es`, ...) when you know the language to skip the detection pass. |
| `STT_DEVICE` | `cpu` | `tts/server.py` | `cpu` \| `cuda`. Separate from `TTS_DEVICE` by design - whisper runs on CTranslate2, which needs different CUDA/cuDNN support than the torch wheel ships. |
| `CORS_ORIGIN` | `http://nginx` (Docker) | `tts/server.py` (FastAPI `CORSMiddleware`) | Allowed browser origin for the sidecar's own HTTP API. Should match wherever nginx serves the frontend from; `start.ps1` sets it to the bare-metal site URL. |

`TTS_HOST`, `TTS_PORT`, `STT_COMPUTE`, and `SIDECAR_ROLE` also exist as `ENV`
defaults baked into `docker/tts.Dockerfile` / `docker/karaoke.Dockerfile`
(`0.0.0.0`, `8001`, `int8`, and `tts`/`karaoke` respectively), but they are not
exposed as `.env` knobs in `docker-compose.yml` - they're internal to the
sidecar images (bare-metal `start.ps1` does override `TTS_HOST`/`TTS_PORT`
directly as process env when launching the venv). `SIDECAR_ROLE` only decides
whether the Kokoro pre-warm runs at startup and what `/health` advertises; every
route stays mounted in both roles.

## 4. Ollama tuning

| Variable | Default | Consumed by | What it does |
|---|---|---|---|
| `OLLAMA_FLASH_ATTENTION` | `1` | `ollama` service | Enables flash attention; required for `OLLAMA_KV_CACHE_TYPE` quantization to take effect (otherwise Ollama warns and falls back to `f16`). |
| `OLLAMA_KV_CACHE_TYPE` | `q8_0` | `ollama` service | KV cache quantization. `q8_0` roughly halves KV memory at 16k context with negligible quality loss; `f16` opts out, `q4_0` goes smaller with a noticeable quality cost on long contexts. |
| `OLLAMA_NUM_PARALLEL` | `1` | `ollama` service | Concurrent request slots. Left at the default, RAM stays bounded; raising it multiplies KV cache usage per slot. |
| `OLLAMA_MAX_LOADED_MODELS` | `3` | `ollama` service | Cap on simultaneously loaded models. One slot is permanently held by the pinned `TITLE_MODEL`, leaving headroom to switch chat models without evicting on every swap. |
| `OLLAMA_KEEP_ALIVE` | `5m` | `ollama` service | How long an idle model stays loaded before unloading. |

## 4b. Request origin & proxies

| Variable | Default | Consumed by | What it does |
|---|---|---|---|
| `OMEGA_ALLOWED_ORIGINS` | *(empty)* | `webapp/api/_lib.php` (`allowed_origins()`) | Extra origins accepted on writes, comma-separated, scheme included, no trailing slash (`https://jun.example.com`). Only needed behind a proxy that rewrites `Host` so the browser's `Origin` no longer matches it. Requests whose `Sec-Fetch-Site` is `same-origin` pass without this. |
| `TRUST_PROXY` | *(unset)* | `webapp/api/_lib.php` (`client_ip()`) | `1` makes rate limiting read the first entry of `X-Forwarded-For` instead of the socket address. Set it **only** behind a proxy you control that overwrites the header - otherwise any caller can pick their own rate-limit bucket. |

## 5. State & persistence

| Variable | Default | Consumed by | What it does |
|---|---|---|---|
| `OMEGA_STATE_DIR` | `/var/lib/omega` | `webapp/api/_lib.php` (`state_dir()`) | Directory for the SQLite DB and rate-limit flat files. Under Docker this is fixed at the default (mounted as the `omega_state` named volume) - the var is not forwarded into the `php` container's environment, so this is effectively **bare-metal only** (`start.ps1` points it at `runtime\state`). |
| `MEMORY_DIR` | `<state dir>/memory` (i.e. `/var/lib/omega/memory` under Docker) | `webapp/api/_lib.php` (`memory_dir()`, `memory_user_dir()`) | Root for per-user Markdown memory directories (`user-{id}/*.md` plus `meta.json`). Legacy `user-{id}.jsonl` and journal files migrate lazily and are retained as `*.migrated`. Same Docker/bare-metal split as `OMEGA_STATE_DIR` above. **Older-default note:** builds before 2026-07 used `/var/lib/jun/memory`, which was not mounted under Docker and did not survive container recreation; the current default is inside the persisted `omega_state` volume. |

## 6. Bare-metal Windows only

| Variable | Default | Consumed by | What it does |
|---|---|---|---|
| `JUN_PORT` | `8080` | `start.ps1` | Port PHP's built-in server serves the web UI on. |
| `LLAMACPP_PORT` | `8081` | `start.ps1`, `install.ps1` | Port the bare-metal managed `llama-server` listens on. `8080` is avoided because it collides with `JUN_PORT`. |

## 7. GPU overlays

| Variable | Default | Consumed by | What it does |
|---|---|---|---|
| `VIDEO_GID` | the literal group name `video` (compose fallback) | `docker-compose.amd.yml` | GID the `tts`/`ollama`/`llamacpp` containers join so they can access `/dev/dri` render nodes. `start.sh` fills in the host's numeric gid on AMD detection. |
| `RENDER_GID` | the literal group name `render` (compose fallback) | `docker-compose.amd.yml` | Same, for the `render` group; `start.sh` reads it off `/dev/dri/renderD128`. |
| `HSA_OVERRIDE_GFX_VERSION` | unset | `docker-compose.amd.yml` (passed through to ROCm) | Consumer-card ROCm override, e.g. `11.0.0` for RDNA3, `10.3.0` for RDNA2. |

## 8. Multi-GPU

Two knobs you set, plus the vars `start.sh` / `start.ps1` derive from them. On a
single-GPU machine none of this changes anything.

| Variable | Default | Consumed by | What it does |
|---|---|---|---|
| `GPU_DEVICES` | `auto` | `start.sh`, `start.ps1` | `auto` orders your cards by VRAM, largest first, so the biggest one becomes device 0 for the model server. `all` leaves the driver's own order alone. Anything else is taken as an explicit comma-separated list of GPU UUIDs (NVIDIA) or indices (AMD) and passed through verbatim. |
| `TENSOR_PARALLEL` | `off` | `start.sh`, `start.ps1`, both installers | `on` splits one model across every GPU instead of fitting it on one. Usually *slower* per token on a mismatched pair - worth it only when the model you want doesn't fit on the biggest card alone. `install.sh` / `install.ps1` offer it when they detect 2+ GPUs, and size their model recommendation off the combined VRAM when you accept. |

| Derived variable | Set by | Reaches | What it does |
|---|---|---|---|
| `CUDA_VISIBLE_DEVICES` | `start.sh` (nvidia), `start.ps1` | `ollama`, `llamacpp` | The resolved device list, as UUIDs. UUIDs and not indices because `nvidia-smi` enumerates by PCI bus order while CUDA defaults to `FASTEST_FIRST` - index `1` means different cards to the two of them. Only exported when non-empty: an *empty* `CUDA_VISIBLE_DEVICES` means zero GPUs, not all of them. |
| `HIP_VISIBLE_DEVICES`, `ROCR_VISIBLE_DEVICES`, `GGML_VK_VISIBLE_DEVICES` | `start.sh` (amd) | `ollama`, `llamacpp` | Same list, ROCm/Vulkan spellings. Indices here, not UUIDs. |
| `NVIDIA_GPU_COUNT` | `start.sh` (nvidia) | `docker-compose.nvidia.yml` (`deploy.…devices.count`) | How many GPUs to reserve for the containers. The overlay asks for this number rather than `count: all`, because `all` resolves through the host's CDI spec (`/etc/cdi/nvidia.yaml`) - generated once and stale after you add a card, at which point it silently hands the container a *subset* of your GPUs. Falls back to `all` when `nvidia-smi` isn't available. |
| `OLLAMA_SCHED_SPREAD` | `start.sh`, `start.ps1` when `TENSOR_PARALLEL=on` | `ollama` | Ollama's "always schedule model across all GPUs". Ollama has no true tensor parallelism; this spreads layers, which is the closest thing it offers. |
| `LLAMA_ARG_SPLIT_MODE` | `start.sh` when `TENSOR_PARALLEL=on` **and** the GPU is NVIDIA; `-sm row` on the `llama-server` command line on Windows | `llamacpp` | `row` = real row/tensor split. CUDA-only, so it is deliberately not set on the AMD overlay (which runs the Vulkan llama.cpp image). |
| `LLAMA_ARG_TENSOR_SPLIT`, `LLAMA_ARG_MAIN_GPU` | you, by hand | `llamacpp` | Passed through by both overlays if you set them, for uneven splits (`3,1`) or a different primary card. Nothing in the repo sets them. |

A pre-existing Ollama that the launcher merely reuses - the Windows desktop app's,
or a host instance on `:11434` - has its own environment, so none of the above
applies to it. `start.ps1` says so when it takes that branch.

---

## Defaults differ by deployment mode

Compose injects Docker-internal hostnames as defaults: `http://ollama:11434`,
`http://llamacpp:8080`, `http://tts:8001`. The PHP-side fallbacks baked into
`webapp/api/providers.php`, `tts.php`, and `stt.php` (used when a var is unset
and nothing overrides it) instead target `localhost`
(`http://localhost:11434`, `http://127.0.0.1:8081` for llama.cpp,
`http://localhost:8001` for the audio sidecar) - the bare-metal case. In
practice `start.ps1` never relies on those PHP fallbacks: it sets its own
`127.0.0.1`-based env vars explicitly before launching PHP.
