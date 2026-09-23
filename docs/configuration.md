# Configuration reference

All runtime configuration is environment variables. Under Docker, `docker compose`
reads `.env` in the repo root and interpolates `${VAR:-default}` into each
service's `environment:` block in `docker-compose.yml` (and the `.nvidia`/`.amd`
overlays) - a var only reaches a container if that container's block lists it.
The bare-metal Windows launcher (`start.ps1`) also parses `.env` directly
(loading `KEY=VALUE` lines as process env vars unless already set), but it
skips anything that looks like a Docker-internal hostname:

```powershell
# start.ps1: Docker hostname filter
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
| `BIND_ADDR` | `127.0.0.1` | `docker compose` port mapping (`docker-compose.yml`), `start.sh`, `start.ps1` (`php -S`) | Address nginx publishes `:80`/`:443` on, and the address bare-metal Windows binds `php -S` to. Loopback means this machine only; `0.0.0.0` exposes it to everything that can reach the host, is required before Let's Encrypt can answer the HTTP-01 challenge, and is what LAN access from a phone needs. Public binding is refused while TLS is off unless `OMEGA_ALLOW_INSECURE_PUBLIC_HTTP=1`; bare metal has no TLS at all, so there the override is the only way. On Windows, `start.ps1` also adds a Private-profile inbound firewall rule `Jun OS (<port>)` when elevated, and prints the command when not. |
| `DOMAIN` | `localhost` | `nginx`, `certbot` services (`docker-compose.yml`) | Public hostname nginx serves and certbot requests a cert for. |
| `EMAIL` | `admin@localhost` | `certbot` service | Contact address for Let's Encrypt issuance. Only meaningful when `TLS_MODE=on`. |
| `TLS_MODE` | `off` | `nginx` service, nginx config templates | `on` enables HTTPS via certbot (requires a public `DOMAIN`) and adds HSTS; `off` serves plain HTTP on `:80` plus a self-signed HTTPS on `:443` (`docker/nginx/10-pick-config.sh` mints the cert into the `selfsigned` volume on first boot), so both `http://localhost` and `https://localhost` answer, the latter with a browser warning. |
| `OMEGA_EXTRA_HOSTS` | *(empty)* | `start.sh`, `start.ps1`, nginx `server_name` (both templates), `OMEGA_ALLOWED_HOSTS` for `php` | Extra `Host` values this install answers to, beyond `DOMAIN`, `localhost` and `127.0.0.1`. An unknown Host is a 444 at nginx and a 421 at `require_allowed_host()` in `webapp/api/lib/guards.php`. When `BIND_ADDR` is off loopback, `start.sh` appends the host's own RFC1918 IPv4 addresses (docker bridges excluded) and prints them as `reachable as:`, so a LAN client normally needs nothing here. `start.ps1` does the same with `Get-NetIPAddress`, skipping the Hyper-V/WSL/VirtualBox/VMware adapters. Space or comma separated; `start.sh` normalizes commas to spaces because `server_name` does not accept them. |
| `OMEGA_ALLOWED_HOSTS` | `localhost,127.0.0.1,::1` | `webapp/api/lib/guards.php`, `tools/php-router.php` | The allowlist itself, assembled from `DOMAIN` and `OMEGA_EXTRA_HOSTS` by `docker-compose.yml`. Set it directly only for a bare-metal install with no compose. |
| `OMEGA_ALLOW_INSECURE_PUBLIC_HTTP` | *(empty)* | `start.sh`, `start.ps1`, `nginx` startup | Set to `1` only to override the public-HTTP refusal. This deliberately allows unencrypted credentials, sessions and chats and should not be used on the internet. |
| `COMPOSE_PROFILES` | `ollama` | `docker compose` itself (not forwarded into any container) | Picks which optional containers run: `ollama`, `llamacpp`, `voice`, `karaoke`, `prod` (certbot). `start.sh` merges whatever is set here with what it derives from `AI_PROVIDER`, `VOICE` and `KARAOKE`, so by hand you only ever need it for `prod`; `install.sh` writes it for you. |

## 1b. Accounts & access

| Variable | Default | Consumed by | What it does |
|---|---|---|---|
| `OMEGA_REGISTRATION_KEY` | *(empty)* | `php` service, `webapp/api/auth.php` (`signup`, `signup_info`) | Key every new account after the first must present (the first signup on an empty `users` table skips it) (`hash_equals`, so a wrong one is a 403 `invalid_registration_key`; a missing one is `registration_closed`). Empty or unset means public signup, and `auth.php?action=signup_info` tells the login page whether to show the field. Both installers generate and print a key. |
| `OMEGA_DEV_KEY` | *(empty)* | `php` service, `webapp/api/auth.php` | Optional developer access key. |
| `OMEGA_TURN_TIMEOUT_S` | `900` | `webapp/api/lib/providers/stream.php` (`stream_turn_deadline()`) | Wall-clock ceiling for one chat turn against the model server, every tool round included. Each round gets what is left of it as its curl timeout. Floor 30. |
| `OMEGA_STREAM_IDLE_S` | `300` | `webapp/api/lib/providers/stream.php` | Hang up on an upstream stream that has sent nothing for this long (curl low-speed limit, 1 byte/s). Has to cover a cold model load plus prompt eval on a large context. Floor 10. The per-stream byte caps next to it (`STREAM_ERROR_BODY_MAX` 64 KiB, `STREAM_PENDING_MAX` 1 MiB, `STREAM_CONTENT_MAX` 4 MiB) are constants, not env. |
| `FLEE_BANS` | `on` | `php` service, `webapp/api/lib/relationship.php` (`flee_bans_enabled()`), `webapp/api/chat.php` | When the referee approves a `flee`, `on` writes a `user_bans` row that locks that account out of chat: 5 minutes, doubling per strike up to 30, strikes reset after a day without one. `off` keeps the walkout and skips the lockout. See [architecture.md](architecture.md#walking-out). |
| `FREE_ROAM` | `off` | `php` service, `webapp/api/lib/trips.php` (`free_roam_enabled()`), `webapp/api/trip.php` | Outings are Jun's decision: `wardrobe.html`, `karaoke.html` and `date.html` redirect to `index.html` unless a `trips` row says she agreed (written by her `enter_shop` / `enter_karaoke` / `go_out_to_eat` tool call, cleared when the chat page loads). `on` removes the redirect and shows the "Force her" buttons in Settings > Dates to every account instead of admins only. |

Both installers generate a random hex `OMEGA_REGISTRATION_KEY` when the line is
absent from `.env` (`ensure_key`/`gen_key` in `install.sh`,
`Add-EnvKeyIfMissing`/`New-AccessKey` in `install.ps1`) and print it in the
closing summary. An **empty** value is left alone: that is the operator saying
"off", and every upgrade run goes back through the same code.

## 2. AI provider

| Variable | Default | Consumed by | What it does |
|---|---|---|---|
| `AI_PROVIDER` | `ollama` | `webapp/api/lib/providers/config.php` (`ai_provider()`) | Selects the chat backend: `ollama` (native NDJSON API) \| `openrouter` \| `llamacpp` (both OpenAI-compatible). Invalid values fall back to `ollama`. |
| `OLLAMA_URL` | `http://ollama:11434` (Docker) / `http://localhost:11434` (PHP fallback) | `webapp/api/lib/providers/config.php`, `models.php` | Base URL of the Ollama instance backing chat (when `AI_PROVIDER=ollama`). |
| `OLLAMA_MODELS_TO_PULL` | `hf.co/efficiencyx/Jun-LoRA-E2B-GGUF:Q4_K_M` | `ollama` and `php` services | Comma-separated models pulled on first boot; the first one is the backend default for background completions. |
| `TITLE_MODEL` | `hf.co/efficiencyx/Titlewen-GGUF:F16` | `ollama` and `php` services, `webapp/api/lib/providers/complete.php` (`generate_chat_title()`) | Small dedicated model used to auto-title new conversations from the first user message. Pinned to CPU (`num_gpu: 0`) and kept resident (`keep_alive: -1`) so it never competes with the chat model for VRAM; the entrypoint pulls and pins it on boot. Set empty to disable and fall back to truncating that message; only used when `AI_PROVIDER=ollama`. |
| `OPENROUTER_API_KEY` | *(empty)* | `webapp/api/lib/providers/config.php` (`chat_request_headers()`) | Bearer key for OpenRouter. **Required when `AI_PROVIDER=openrouter`.** |
| `OPENROUTER_MODEL` | `openrouter/auto` | `webapp/api/lib/providers/config.php` (`default_chat_model()`) | Default chat model id sent to OpenRouter. |
| `LLAMACPP_URL` | `http://llamacpp:8080` (Docker) / `http://127.0.0.1:8081` (PHP fallback) | `webapp/api/lib/providers/config.php` (`chat_api_base()`) | Base URL of the llama.cpp `llama-server`. Point it at your own server to skip the managed `llamacpp` container. |
| `LLAMACPP_MODEL_HF` | `efficiencyx/Jun-LoRA-E2B-GGUF:Q4_K_M` | `llamacpp` service (`LLAMA_ARG_HF_REPO`), `webapp/api/lib/providers/config.php` (cosmetic default model id) | HF `repo:quant` the managed `llama-server` downloads and loads (`llama-server -hf` syntax, no `hf.co/` prefix). |
| `LLAMACPP_MODELS_DIR` / `LLAMACPP_MODEL_FILE` | `./models` / *(empty)* | `start.sh` (layers `docker-compose.llamacpp-local.yml`) | Docker only. Serve a GGUF already on disk instead of pulling `LLAMACPP_MODEL_HF`: set `MODEL_FILE` to a filename inside `MODELS_DIR`; `start.sh` mounts that directory read-only at `/models` and refuses to start when the file is missing. A separate overlay because llama.cpp takes `--hf-repo` whenever it sees both and refuses an empty file argument, so the local settings have to be absent, not blank. `start.ps1` ignores both. |
| `LLAMACPP_MODEL_ALIAS` | `jun-local` | `docker-compose.llamacpp-local.yml` (`LLAMA_ARG_ALIAS`) | The model id `llama-server` reports for a disk-served GGUF, which is what the picker in Settings shows. Only used with `LLAMACPP_MODEL_FILE`. |
| `OLLAMA_MTP` | *(empty)* | `docker/ollama-entrypoint.sh`, `webapp/api/lib/providers/config.php` (`default_chat_model()`) | HF repo of the Gemma 4 MTP assistant model matching the Gemma 4 size Jun was fine-tuned from. Set it and the entrypoint pulls the drafter, then derives a model (`OLLAMA_MTP_MODEL`) whose Modelfile carries it as a `DRAFT` layer; `default_chat_model()` switches to that name. Empty leaves speculative decoding off, which is still the shipped default because the payoff is hardware-dependent. The installer offers it as an experimental option and, on `auto`, runs `./mtp-autotune.sh` to pick the depth by measurement. Measured on a 3060 with the 12B Q4_K_M and the matching QAT drafter, in-character prose with the real system prompt: 36.1 tok/s with no drafter, **45.3 at depth 1 (+25%)**, 42.0 at depth 2, 38.2 at depth 3, 35.4 at depth 4 — i.e. below baseline by depth 4. Both installers turn it on under Express (and with `JUN_YES=1`); Custom asks, default off. |
| `OLLAMA_MTP_N_MAX` | `4` (installer writes `1`) | `docker/ollama-entrypoint.sh` (`PARAMETER draft_num_predict`) | Tokens the drafter proposes per pass. Baked into the derived model because Ollama zeroes `draft_num_predict` — silently disabling MTP — for any model that does not name it explicitly. Must be a number — the entrypoint falls back to `1` for anything else, so `auto` here is not a value, it is a question `./mtp-autotune.sh` answers. Depth costs: each extra token in the verify batch adds roughly 10ms on a 3060, near-linearly, which is why deeper is not better. |
| `OLLAMA_MTP_MODEL` | `jun-mtp` | `docker/ollama-entrypoint.sh`, `webapp/api/lib/providers/config.php` | Name of the derived MTP model. Both sides default to the same literal; change it in one place only and chat talks to a model that does not exist. |
| `LLAMACPP_MTP` | *(empty)* | `start.sh` (layers `docker-compose.llamacpp-mtp.yml`), `start.ps1` (`--spec-type draft-mtp -hfd`) | HF repo of the Gemma 4 MTP assistant model for the same Gemma 4 size `LLAMACPP_MODEL_HF` was fine-tuned from (e.g. `amaranus/Gemma-4-E2B-it-qat-assistant-MTP-Q8_0-GGUF` for the default E2B build). Set it and llama.cpp drafts tokens ahead with the small model and verifies them against the real one in a single pass; empty leaves speculative decoding off entirely. Gemma 4 only, and the drafter needs its own VRAM. |
| `LLAMACPP_MTP_N_MAX` | `4` (installer writes `1`) | `docker-compose.llamacpp-mtp.yml` (`LLAMA_ARG_SPEC_DRAFT_N_MAX`), `start.ps1` | How many tokens the drafter proposes per pass. Ignored unless `LLAMACPP_MTP` is set. Shallower usually wins: on a 3060 depth 1 beat depth 4 by 28%. `./mtp-autotune.sh` measures it, restarting `llama-server` once per depth because llama.cpp takes this as a startup flag. |
| `MTP_TUNED_GPU` | *(empty)* | `mtp-autotune.sh`/`.ps1` (writes it), `start.sh`/`start.ps1` (compares it) | The GPU the current draft depth was measured on, written only by a tune that completed: vendor, then each card's name and VRAM, biggest first (`nvidia:NVIDIA GeForce RTX 3060:12288`). Not a hand-edited value. The start scripts recompute the same string at boot and re-run the tuner when it no longer matches, because a depth measured on a card that has left the machine describes nothing. Empty on AMD under Windows bare metal, where there is no `rocm-smi` to ask. |
| `MTP_AUTOTUNE` | `on` | `start.sh`, `start.ps1` | `off` stops the start scripts re-measuring the draft depth after a GPU change; the stale depth in `.env` then stays as it is until you run the tuner yourself. Worth setting when boot time matters more than throughput: the llama.cpp sweep restarts `llama-server` once per depth. |
| `LLAMACPP_TOOLS` | `on` | `webapp/api/lib/providers/config.php` (`provider_tools_enabled()`) | Set `off` when the loaded chat template cannot do native tool calling. Chat stops offering tools, while memory consolidation falls back to model-produced JSON operation arrays executed by the same guarded tool loop. |

## 3. Audio sidecars

Two containers off one `tts/server.py`: `tts` (voice, always CPU, `voice`
profile) and `karaoke` (stem separation, GPU by default, `karaoke` profile).
Bare-metal installs run a single process in both roles.

| Variable | Default | Consumed by | What it does |
|---|---|---|---|
| `VOICE` | `on` | `start.sh` (adds the `voice` compose profile), `start.ps1` | `off` skips the voice sidecar: under Docker the `tts` service sits behind `profiles: [voice]` and is never started, on bare-metal Windows the TTS/STT process is not launched. `php`/frontend degrade to text-only when it's absent, unreachable or unhealthy. |
| `TTS_URL` | `http://tts:8001` (Docker) / `http://localhost:8001` (PHP fallback) | `webapp/api/tts.php`, `stt.php` | Base URL of the voice sidecar. The pre-rename name `KOKORO_URL` is still honored as a fallback for existing `.env` files. |
| `TTS_DEVICE` | `cpu` | `start.sh`, `docker/tts.Dockerfile` ENV → `tts/sidecar/devices.py` | `cpu` \| `cuda` \| `auto`. Torch device for TTS synthesis. The image ships a CPU torch, so `auto` resolves to CPU there and `cuda` only means something on bare metal or after a `TTS_TORCH_INDEX` override. Both engines are real-time on CPU; GPU TTS holds ~2GB VRAM, which costs more in LLM layer offload than it buys in synthesis speed. |
| `TTS_TORCH_INDEX` | `https://download.pytorch.org/whl/cpu` | `docker-compose.yml` → `docker/tts.Dockerfile` | Advanced override for the PyTorch wheel index the voice image builds against. No GPU overlay touches it any more - that plumbing moved to `KARAOKE_TORCH_INDEX`. Normally leave this unset. |
| `KARAOKE` | `on` | `install.sh` writes it, `start.sh` reads it | `on` adds the `karaoke` compose profile, which builds and runs the separation sidecar (a few GB: demucs plus a CUDA/ROCm torch). `off` leaves the container out entirely; `api/karaoke.php` then can't reach it and the webapp greys the karaoke button out. `start.sh` prints `karaoke: off` when the profile is absent, since an `.env` predating this split has no `KARAOKE` key. |
| `KARAOKE_URL` | `http://karaoke:8001` (Docker) / falls back to `TTS_URL` | `webapp/api/karaoke.php` | Base URL of the separation sidecar. The fallback chain is `KARAOKE_URL` → `TTS_URL` → `KOKORO_URL` → `http://localhost:8001`, so bare-metal installs serving both roles from one process need no extra config. |
| `SEP_DEVICE` | `auto` (`cuda` or `cpu` as chosen at install) | `start.sh`, `docker/karaoke.Dockerfile` ENV → `tts/sidecar/devices.py` | `cpu` \| `cuda` \| `auto`. Torch device for demucs. Unlike `TTS_DEVICE` this one is worth the VRAM - a 4-minute song is minutes on CPU and seconds on a card - and `api/karaoke.php` evicts the chat model from Ollama before each job so the two don't fight. A per-job CUDA failure (OOM, bad kernel) retries on CPU instead of failing the song. |
| `KARAOKE_TORCH_INDEX` | CUDA/ROCm on the GPU overlays, CPU otherwise | `start.sh`, `docker-compose.*.yml` | Advanced override for the karaoke image's PyTorch wheel index. `start.sh` pins the CPU index when `SEP_DEVICE=cpu`, so declining GPU separation doesn't download a multi-GB GPU wheel. |
| `STT_MODEL` | `base` | `tts/sidecar/stt.py` (both sidecars) | faster-whisper model. Karaoke uses the same model for the timed lyric track. Default `base` is multilingual; the `.en` builds (`tiny.en`, `base.en`, `small.en`) are English-only and slightly faster/sharper on English. Size up the multilingual model (`small`, `medium`, `large-v3`) for better non-English accuracy. Must agree with `STT_LANG`. |
| `STT_LANG` | `""` (auto-detect) | `tts/sidecar/config.py` (`STT_LANG` env) | Whisper language code. In `docker-compose.yml` this is wired as `STT_LANG: "${STT_LANG-}"` (bash-style *unset*-only default, note the missing `:`) - so an unset var and an explicitly empty `STT_LANG=` both pass through as `""`, and `server.py` treats an empty string as `None`, i.e. whisper auto-detects the language per utterance/song. Pin a code (`en`, `it`, `es`, ...) when you know the language to skip the detection pass. |
| `STT_DEVICE` | `cpu` | `tts/sidecar/stt.py` | `cpu` \| `cuda`. Separate from `TTS_DEVICE` by design - whisper runs on CTranslate2, which needs different CUDA/cuDNN support than the torch wheel ships. |
| `STT_MAX_DURATION_S` / `STT_MAX_CONCURRENT` | `120` / `1` | `tts/sidecar/config.py` | Maximum decoded utterance duration and simultaneous STT jobs. The decoded limit applies regardless of compressed upload size. |
| `SEP_MAX_DURATION_S` / `SEP_MAX_CONCURRENT` | `900` / `1` | `tts/sidecar/config.py` | Maximum decoded song duration and simultaneous separation jobs. |
| `SEP_MAX_JOBS` | `4` | `tts/sidecar/config.py` | Separated songs kept on disk waiting for their stems to be fetched; past this the oldest job is deleted. |
| `TTS_MAX_CONCURRENT` / `TTS_MAX_QUEUE` / `TTS_QUEUE_WAIT_S` | `2` / `8` / `30` | `tts/sidecar/config.py` | Simultaneous synthesis jobs, how many more may wait for a slot, and for how long. Anything past the queue gets a 429 straight away. |
| `SIDECAR_SECRET` | random, written to `.env` by `start.sh` / `install.ps1` | `tts/sidecar/gate.py`, `webapp/api/lib/sidecar.php` (`sidecar_headers()`) | Shared secret PHP sends the tts/karaoke sidecars in `X-Sidecar-Secret`. The sidecar refuses every request without it except `/health`. Empty means the sidecar runs on `SIDECAR_ALLOWED_HOSTS` alone and warns at startup. Colab mints one per run. |
| `SIDECAR_ALLOWED_HOSTS` | `localhost,127.0.0.1,::1,tts,karaoke` | `tts/sidecar/gate.py` | Host header allowlist for the sidecar (port ignored). Requests carrying `Origin` or `Sec-Fetch-Site` are refused regardless: browsers go through PHP, never straight to the sidecar. |
| `STT_LOG_TRANSCRIPTS` | unset | `tts/sidecar/stt.py` | `1` logs the recognised text of every `/stt` call at INFO. Off by default: container logs outlive a factory reset. |

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
| `OMEGA_NUM_CTX` | *(auto)* | `php` service, `webapp/api/lib/providers/context.php` (`default_num_ctx()`) | Context window sent as `num_ctx`. Auto-sized from the VRAM left after the model weights and a 2 GiB reserve (`VRAM_RESERVE_MB`), at 0.2 MiB per token (`KV_MIB_PER_TOKEN`), rounded down to one of `6144 / 8192 / 12288 / 16384` (`CTX_TIERS`). Under 4 GiB of headroom, or with no card size known, it falls back to tiers off `MemTotal` instead (<=17 GiB RAM: 6144, <=25: 8192, <=33: 12288, else 16384). A hand-set value skips both. llama.cpp always gets 16384. |
| `OMEGA_GPU_VRAM_MB` | probed | `start.sh` (probes and exports), `php` service, `webapp/api/lib/providers/context.php` (`gpu_ctx_headroom_mb()`) | Card size in MiB. `start.sh` reads it from `nvidia-smi` / `rocm-smi` (or the kernel on AMD) and hands it to php; a value in `.env` always wins over the probe. Set it only to report *less* than the card really has, e.g. when another app permanently owns part of the VRAM. Besides the context sizing above it gates the partial-offload refit (`ollama_evict_if_partially_offloaded()`), which only evicts when the weights could fit at all. `start.ps1` does not probe; on bare metal it is unset unless you set it. |

## 4b. Request origin & proxies

| Variable | Default | Consumed by | What it does |
|---|---|---|---|
| `OMEGA_ALLOWED_ORIGINS` | *(empty)* | `webapp/api/lib/guards.php` (`allowed_origins()`) | Extra origins accepted on writes, comma-separated, scheme included, no trailing slash (`https://jun.example.com`). Only needed behind a proxy whose public origin differs from `DOMAIN`. Docker derives the allowed Host set from `DOMAIN` and rejects every other Host before PHP. |
| `TRUST_PROXY` | *(unset)* | `webapp/api/lib/http.php` (`client_ip()`), forwarded by `docker-compose.yml` | `1` makes rate limiting read the **last** entry of `X-Forwarded-For` (the one your proxy appended) instead of the socket address. Set it **only** behind a proxy you control that appends or overwrites the header - otherwise any caller can pick their own rate-limit bucket. |

## 4c. Container resource ceilings

Every service has a `mem_limit` and `cpus` in `docker-compose.yml`, so a runaway
container can't take the host down. Raise a model limit if you deliberately serve
a larger model; don't remove the ceiling on a network-reachable deployment.

| Variable | Default | Service |
|---|---|---|
| `NGINX_MEMORY_LIMIT` / `NGINX_CPU_LIMIT` | `256m` / `1.0` | `nginx` |
| `PHP_MEMORY_LIMIT` / `PHP_CPU_LIMIT` | `1g` / `2.0` | `php` |
| `OLLAMA_MEMORY_LIMIT` / `OLLAMA_CPU_LIMIT` | `16g` / `8.0` | `ollama` |
| `LLAMACPP_MEMORY_LIMIT` / `LLAMACPP_CPU_LIMIT` | `16g` / `8.0` | `llamacpp` |
| `TTS_MEMORY_LIMIT` / `TTS_CPU_LIMIT` | `8g` / `4.0` | `tts` |
| `KARAOKE_MEMORY_LIMIT` / `KARAOKE_CPU_LIMIT` | `12g` / `6.0` | `karaoke` |
| `CERTBOT_MEMORY_LIMIT` / `CERTBOT_CPU_LIMIT` | `512m` / `1.0` | `certbot` |

`mem_limit` is RAM, not VRAM: a 12B on the CPU path needs the Ollama ceiling
raised, a 12B on the card does not.

## 5. State & persistence

| Variable | Default | Consumed by | What it does |
|---|---|---|---|
| `OMEGA_STATE_DIR` | `/var/lib/omega` | `webapp/api/lib/env.php` (`state_dir()`) | Directory for the SQLite DB and rate-limit flat files. Under Docker this is fixed at the default (mounted as the `omega_state` named volume) - the var is not forwarded into the `php` container's environment, so this is effectively **bare-metal only** (`start.ps1` points it at `runtime\state`). |
| `MEMORY_DIR` | `<state dir>/memory` (i.e. `/var/lib/omega/memory` under Docker) | `webapp/api/lib/memory.php` (`memory_dir()`, `memory_user_dir()`) | Root for per-user encrypted memory directories (`user-{id}/*.md` plus `meta.json`). Legacy `user-{id}.jsonl` and journal files migrate lazily and are retained as `*.migrated`. Same Docker/bare-metal split as `OMEGA_STATE_DIR` above. **Older-default note:** builds before 2026-07 used `/var/lib/jun/memory`, which was not mounted under Docker and did not survive container recreation; the current default is inside the persisted `omega_state` volume. |
| `OMEGA_KEY_PORT` | `9099` | `webapp/api/lib/crypto.php` (`key_push_port()`), `consolidation-worker.php` | Loopback TCP port used to pass per-user data keys to the consolidation worker. Both PHP and the worker must use the same value. Useful for a bare-metal port conflict; Compose does not forward this variable, so Docker uses the internal default. |

Memory filenames retain `.md` and `.json` extensions, but encrypted contents cannot be edited directly. Backups need the account password or recovery code to unlock encrypted content; see [encryption and recovery](../SECURITY.md#encryption-and-recovery).

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

## 7b. Multi-token prediction (experimental)

A small drafter model guesses the next few tokens and Jun checks the whole batch
in one pass; the guesses she agrees with came almost free. Nothing is said that
she would not have said anyway — rejected guesses are discarded, so output is
unchanged, only the timing moves.

Both installers offer it (`JUN_MTP=on|off` non-interactively, on under Express)
and then ask how many tokens to draft ahead: `auto`, or a fixed `1`–`4`
(`JUN_MTP_DEPTH`). The drafter repo is chosen from the model you picked, keyed
by Gemma 4 size **and** QAT branch — `Janvitos/gemma-4-12B-it-qat-assistant-MTP-Q8_0-GGUF`
for the 12B, `amaranus/Gemma-4-E4B…` / `…E2B-it-qat-assistant-MTP-Q8_0-GGUF` for
the small ones. A drafter off the wrong branch loads and drafts perfectly happily
and simply guesses wrong far more often (2.10 accepted tokens per pass against
2.74), with nothing in any log to say so.

`auto` writes a provisional depth of `1` and then runs `./mtp-autotune.sh`
(`mtp-autotune.ps1` on Windows) once the stack is up and the models are pulled,
because every row of it is a real generation. The tuner measures no-drafter plus
depths 1–4 on in-character prose **with the real `webapp/system_prompt.txt` in
front**, then writes the winner into `.env` and, for Ollama, rebuilds
`OLLAMA_MTP_MODEL` at that depth.

Left empty, the drafter is derived from the chat model instead of being asked
for: same repo with `-MTP` in the name, so `Jun-LoRA-12B-GGUF:Q4_K_M` drafts off
`Jun-LoRA-12B-MTP-GGUF:Q4_K_M`. The tuner pulls it, and writes it into
`OLLAMA_MTP` / `LLAMACPP_MTP` once it is there. A drafter that lives somewhere
else still goes in `.env` by hand, an explicit value is never overwritten.

Two details it depends on:

* The system prompt is not decoration. Measured bare, depth 2 came out on top by
  1%; with the prompt in place depth 1 won by 6% — same box, same drafter, same
  afternoon. Tuning without it optimizes for a regime the app never runs in.
* A deeper draft has to beat the incumbent by 2% to take the slot. Below that it
  is noise, and the shallower depth holds up better once VRAM gets tight.

If nothing beats plain decoding the tuner turns MTP back off and says so rather
than shipping a slower default.

**After a GPU change the start scripts re-run it for you.** A tune that finishes
stamps `MTP_TUNED_GPU` with the card it measured on — vendor, then every GPU's
name and VRAM, sorted biggest first so re-seating cards in different slots is not
a change. `start.sh` and `start.ps1` recompute that string at boot, and when it
differs from the stamp they wait for the model server and the drafter to be
ready, then run the tuner before handing you the app. Only a completed tune
writes the stamp, so a run that died measured nothing and claims nothing. A
machine that never tuned has no stamp at all and is never nagged, and neither is
one with MTP switched off — there is no depth to re-measure. Pointing
`OLLAMA_URL` / `LLAMACPP_URL` at a model server of your own skips it as well:
the tuner drives our container, and there is none of ours to wait for or
restart. Set `MTP_AUTOTUNE=off` in `.env` to skip the check entirely; the
llama.cpp sweep in particular restarts `llama-server` once per depth, so it is
not a quick boot.

VRAM: budget the model, the drafter, **and about 1.5GB for the browser drawing
Live2D on the same card**. The installer warns when those three do not fit. That
is not a reason to skip MTP — when layers spill to the CPU each target pass gets
more expensive, so avoiding one is worth more: +31% measured at 80% GPU / 20% CPU
against +21% with everything resident.

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
`webapp/api/lib/providers/config.php`, `tts.php`, and `stt.php` (used when a var is unset
and nothing overrides it) instead target `localhost`
(`http://localhost:11434`, `http://127.0.0.1:8081` for llama.cpp,
`http://localhost:8001` for the audio sidecar) - the bare-metal case. In
practice `start.ps1` never relies on those PHP fallbacks: it sets its own
`127.0.0.1`-based env vars explicitly before launching PHP.
