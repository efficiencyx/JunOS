#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

detect_gpu() {
  case "${GPU:-auto}" in
    nvidia|amd|cpu) echo "$GPU"; return ;;
  esac
  if { command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi -L >/dev/null 2>&1; } \
     || [ -e /proc/driver/nvidia/version ]; then
    echo nvidia
  elif [ -e /dev/kfd ] && compgen -G "/dev/dri/renderD*" >/dev/null; then
    echo amd
  else
    echo cpu
  fi
}


# The model-server containers are profile-gated: `ollama` runs the Ollama
# service, `llamacpp` the llama.cpp one. Merge (never replace) what's already
# in the shell (e.g. COMPOSE_PROFILES=prod ./start.sh) and in .env, then inject
# what AI_PROVIDER implies - so a pre-provider-era .env still boots ollama.
env_get() { sed -n "s/^$1=//p" .env 2>/dev/null | tail -n1 || true; }
add_profile() {
  case ",${profiles}," in *,"$1",*) ;; *) profiles="${profiles:+$profiles,}$1" ;; esac
}

profiles="${COMPOSE_PROFILES:-}"
file_profiles="$(env_get COMPOSE_PROFILES)"
for p in ${file_profiles//,/ }; do add_profile "$p"; done

provider="$(env_get AI_PROVIDER)"; provider="${provider:-ollama}"
llamacpp_url="$(env_get LLAMACPP_URL)"
case "$provider" in
  llamacpp)
    # Managed llama-server container unless the user pointed at their own.
    case "${llamacpp_url:-http://llamacpp:8080}" in
      http://llamacpp:8080) add_profile llamacpp ;;
    esac
    ;;
  openrouter) : ;;
  *) add_profile ollama ;;
esac

export COMPOSE_PROFILES="$profiles"
echo "AI provider: $provider${profiles:+ (compose profiles: $profiles)}"

gpu="$(detect_gpu)"
files=(-f docker-compose.yml)

case "$gpu" in
  nvidia)
    files+=(-f docker-compose.nvidia.yml)
    if ! command -v nvidia-smi >/dev/null 2>&1; then
      echo "warning: NVIDIA selected but nvidia-smi not found - you also need" >&2
      echo "         nvidia-container-toolkit installed, or run GPU=cpu ./start.sh" >&2
    fi
    ;;
  amd)
    files+=(-f docker-compose.amd.yml)
    # The container must join the host groups that own the GPU device nodes.
    vgid="$(getent group video | cut -d: -f3 || true)"
    rgid="$(stat -c '%g' /dev/dri/renderD* 2>/dev/null | head -n1 || true)"
    [ -n "$rgid" ] || rgid="$(getent group render | cut -d: -f3 || true)"
    export VIDEO_GID="${vgid:-44}"
    export RENDER_GID="${rgid:-105}"
    ;;
esac

echo "GPU detected: $gpu"
if [ "$gpu" = amd ]; then
  echo "  video gid=$VIDEO_GID, render gid=$RENDER_GID${HSA_OVERRIDE_GFX_VERSION:+, HSA_OVERRIDE_GFX_VERSION=$HSA_OVERRIDE_GFX_VERSION}"
fi

# A bare first word is a lifecycle subcommand; anything else (a flag like
# --build, or service names) is forwarded to `up -d` exactly as before.
case "${1:-up}" in
  stop|down)  shift; set -x; exec docker compose "${files[@]}" down "$@" ;;
  restart)    shift; docker compose "${files[@]}" down
              set -x; exec docker compose "${files[@]}" up -d --build "$@" ;;
  status|ps)  shift; set -x; exec docker compose "${files[@]}" ps "$@" ;;
  logs)       shift; set -x; exec docker compose "${files[@]}" logs -f "$@" ;;
  *)          set -x; exec docker compose "${files[@]}" up -d --build "$@" ;;
esac
