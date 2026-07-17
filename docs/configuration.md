# Configuration reference

All runtime configuration is environment variables. Under Docker, `docker compose`
reads `.env` in the repo root and interpolates `${VAR:-default}` into each
service's `environment:` block in `docker-compose.yml` (and the `.nvidia`/`.amd`
overlays) — a var only reaches a container if that container's block lists it.
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
| `DOMAIN` | `localhost` | `nginx`, `certbot` services (`docker-compose.yml`) | Public hostname nginx serves and certbot requests a cert for. |
| `EMAIL` | `admin@localhost` | `certbot` service | Contact address for Let's Encrypt issuance. Only meaningful when `TLS_MODE=on`. |
| `TLS_MODE` | `off` | `nginx` service, nginx config templates | `on` enables HTTPS via certbot (requires a public `DOMAIN`) and adds HSTS; `off` serves plain HTTP on `:80`. |
| `COMPOSE_PROFILES` | `ollama` | `docker compose` itself (not forwarded into any container) | Picks which model-server containers run: `ollama`, `llamacpp`, `prod` (certbot). `start.sh` derives it from `AI_PROVIDER` when unset; `install.sh` writes it for you. |

## 2. AI provider

| Variable | Default | Consumed by | What it does |
|---|---|---|---|
| `AI_PROVIDER` | `ollama` | `webapp/api/providers.php` (`ai_provider()`) | Selects the chat backend: `ollama` (native NDJSON API) \| `openrouter` \| `llamacpp` (both OpenAI-compatible). Invalid values fall back to `ollama`. |
| `OLLAMA_URL` | `http://ollama:11434` (Docker) / `http://localhost:11434` (PHP fallback) | `providers.php`, `models.php` | Base URL of the Ollama instance backing chat (when `AI_PROVIDER=ollama`) and, by default, embeddings. |
| `OLLAMA_MODELS_TO_PULL` | `hf.co/efficiencyx/Jun-LoRA-v4-E2B-GGUF:Q4_K_M,nomic-embed-text` | `ollama` service entrypoint | Comma-separated models pulled on first boot; idempotent across restarts. |
| `OPENROUTER_API_KEY` | *(empty)* | `providers.php` (`chat_request_headers()`) | Bearer key for OpenRouter. **Required when `AI_PROVIDER=openrouter`.** |
| `OPENROUTER_MODEL` | `openrouter/auto` | `providers.php` (`default_chat_model()`) | Default chat model id sent to OpenRouter. |
| `LLAMACPP_URL` | `http://llamacpp:8080` (Docker) / `http://127.0.0.1:8081` (PHP fallback) | `providers.php` (`chat_api_base()`) | Base URL of the llama.cpp `llama-server`. Point it at your own server to skip the managed `llamacpp` container. |
| `LLAMACPP_MODEL_HF` | `efficiencyx/Jun-LoRA-v4-E2B-GGUF:Q4_K_M` | `llamacpp` service (`LLAMA_ARG_HF_REPO`), `providers.php` (cosmetic default model id) | HF `repo:quant` the managed `llama-server` downloads and loads (`llama-server -hf` syntax, no `hf.co/` prefix). |
| `LLAMACPP_TOOLS` | `on` | `providers.php` (`provider_tools_enabled()`) | Set `off` when the loaded chat template can't do tool calling, to stop offering tools to llama.cpp. |

## 3. Embeddings / RAG

| Variable | Default | Consumed by | What it does |
|---|---|---|---|
| `EMBEDDINGS` | `on` when `AI_PROVIDER=ollama`, else `off` | `providers.php` (`embeddings_enabled()`) | Turns cross-chat recall embeddings on/off. They always run on Ollama's `nomic-embed-text` regardless of chat provider; a non-Ollama chat provider can opt back in with `EMBEDDINGS=on` plus a reachable Ollama. When off, vector-memory features degrade silently. |
| `EMBEDDINGS_URL` | falls back to `OLLAMA_URL` | `providers.php` (`embeddings_base_url()`) | Points embedding calls at a different Ollama than the one serving chat. |

## 4. Voice sidecar

| Variable | Default | Consumed by | What it does |
|---|---|---|---|
| `VOICE` | `on` | `start.ps1` only | **Bare-metal Windows only.** `off` skips launching the TTS/STT sidecar process. Under Docker the `tts` service always runs (no compose `voice` profile exists); `php`/frontend degrade to text-only when it's unreachable or unhealthy. |
| `TTS_URL` | `http://tts:8001` (Docker) / `http://localhost:8001` (PHP fallback) | `webapp/api/tts.php`, `stt.php` | Base URL of the audio sidecar. The pre-rename name `KOKORO_URL` is still honored as a fallback for existing `.env` files. |
| `TTS_DEVICE` | `auto` | `docker/tts.Dockerfile` ENV → `tts/server.py` | `cpu` \| `cuda` \| `auto`. Torch device for TTS synthesis. `auto` resolves to `cpu` unless the image was built with a GPU torch wheel (the nvidia/amd overlays do this). |
| `STT_MODEL` | `base.en` | `tts/server.py` | faster-whisper model size, e.g. `tiny.en`, `base.en`, `small.en`, or a multilingual variant without `.en` for non-English. Must agree with `STT_LANG`. |
| `STT_LANG` | `en` | `tts/server.py` (`STT_LANG` env) | Whisper language code. In `docker-compose.yml` this is wired as `STT_LANG: "${STT_LANG-en}"` (bash-style *unset*-only default, note the missing `:`) — so an **explicitly empty** `STT_LANG=` in `.env` is passed through as `""` rather than defaulting to `en`, and `server.py` treats an empty string as `None`, i.e. whisper auto-detect. Leaving the var unset entirely gets you `en`. |
| `STT_DEVICE` | `cpu` | `tts/server.py` | `cpu` \| `cuda`. Separate from `TTS_DEVICE` by design — whisper runs on CTranslate2, which needs different CUDA/cuDNN support than the torch wheel ships. |
| `CORS_ORIGIN` | `http://nginx` (Docker) | `tts/server.py` (FastAPI `CORSMiddleware`) | Allowed browser origin for the sidecar's own HTTP API. Should match wherever nginx serves the frontend from; `start.ps1` sets it to the bare-metal site URL. |

`TTS_HOST`, `TTS_PORT`, and `STT_COMPUTE` also exist as `ENV` defaults baked
into `docker/tts.Dockerfile` (`0.0.0.0`, `8001`, `int8`), but they are not
exposed as `.env` knobs in `docker-compose.yml` — they're internal to the
sidecar image (bare-metal `start.ps1` does override `TTS_HOST`/`TTS_PORT`
directly as process env when launching the venv).

## 5. Ollama tuning

| Variable | Default | Consumed by | What it does |
|---|---|---|---|
| `OLLAMA_FLASH_ATTENTION` | `1` | `ollama` service | Enables flash attention; required for `OLLAMA_KV_CACHE_TYPE` quantization to take effect (otherwise Ollama warns and falls back to `f16`). |
| `OLLAMA_KV_CACHE_TYPE` | `q8_0` | `ollama` service | KV cache quantization. `q8_0` roughly halves KV memory at 16k context with negligible quality loss; `f16` opts out, `q4_0` goes smaller with a noticeable quality cost on long contexts. |
| `OLLAMA_NUM_PARALLEL` | `1` | `ollama` service | Concurrent request slots. Left at the default, RAM stays bounded; raising it multiplies KV cache usage per slot. |
| `OLLAMA_MAX_LOADED_MODELS` | `2` | `ollama` service | Cap on simultaneously loaded models (room for the chat model + `nomic-embed-text`). |
| `OLLAMA_KEEP_ALIVE` | `5m` | `ollama` service | How long an idle model stays loaded before unloading. |

## 6. State & persistence

| Variable | Default | Consumed by | What it does |
|---|---|---|---|
| `OMEGA_STATE_DIR` | `/var/lib/omega` | `webapp/api/_lib.php` (`state_dir()`) | Directory for the SQLite DB and rate-limit flat files. Under Docker this is fixed at the default (mounted as the `omega_state` named volume) — the var is not forwarded into the `php` container's environment, so this is effectively **bare-metal only** (`start.ps1` points it at `runtime\state`). |
| `MEMORY_DIR` | `<state dir>/memory` (i.e. `/var/lib/omega/memory` under Docker) | `webapp/api/_lib.php` (`memory_file_path()`) | Directory holding per-user durable-memory JSONL files. Same Docker/bare-metal split as `OMEGA_STATE_DIR` above. **Migration note:** builds before 2026-07 defaulted to `/var/lib/jun/memory`, a path that was never mounted as a volume under Docker — memories written there were silently lost on every container recreation. The current default lives inside the persisted `omega_state` volume, so it survives rebuilds/restarts. |

## 7. Bare-metal Windows only

| Variable | Default | Consumed by | What it does |
|---|---|---|---|
| `JUN_PORT` | `8080` | `start.ps1` | Port PHP's built-in server serves the web UI on. |
| `LLAMACPP_PORT` | `8081` | `start.ps1`, `install.ps1` | Port the bare-metal managed `llama-server` listens on. `8080` is avoided because it collides with `JUN_PORT`. |

## 8. GPU overlays

| Variable | Default | Consumed by | What it does |
|---|---|---|---|
| `VIDEO_GID` | the literal group name `video` (compose fallback) | `docker-compose.amd.yml` | GID the `tts`/`ollama`/`llamacpp` containers join so they can access `/dev/dri` render nodes. `start.sh` fills in the host's numeric gid on AMD detection. |
| `RENDER_GID` | the literal group name `render` (compose fallback) | `docker-compose.amd.yml` | Same, for the `render` group; `start.sh` reads it off `/dev/dri/renderD128`. |
| `HSA_OVERRIDE_GFX_VERSION` | unset | `docker-compose.amd.yml` (passed through to ROCm) | Consumer-card ROCm override, e.g. `11.0.0` for RDNA3, `10.3.0` for RDNA2. |

---

## Defaults differ by deployment mode

Compose injects Docker-internal hostnames as defaults: `http://ollama:11434`,
`http://llamacpp:8080`, `http://tts:8001`. The PHP-side fallbacks baked into
`webapp/api/providers.php`, `tts.php`, and `stt.php` (used when a var is unset
and nothing overrides it) instead target `localhost`
(`http://localhost:11434`, `http://127.0.0.1:8081` for llama.cpp,
`http://localhost:8001` for the audio sidecar) — the bare-metal case. In
practice `start.ps1` never relies on those PHP fallbacks: it sets its own
`127.0.0.1`-based env vars explicitly before launching PHP.
