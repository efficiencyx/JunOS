#!/usr/bin/env bash
#
# One-command launcher. Detects the GPU vendor, layers on the matching compose
# overlay, and brings the stack up. Works on NVIDIA, AMD (ROCm), or plain CPU.
#
#   ./start.sh                     # auto-detect
#   GPU=cpu ./start.sh             # force a specific backend: nvidia | amd | cpu
#   VOICE=off ./start.sh           # skip the Kokoro TTS sidecar (default: on, from .env)
#   HSA_OVERRIDE_GFX_VERSION=11.0.0 ./start.sh        # AMD consumer-card override
#   COMPOSE_PROFILES=prod TLS_MODE=on DOMAIN=example.com EMAIL=you@example.com ./start.sh
#
# Anything after `./start.sh` is forwarded to `docker compose ... up -d`.

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

# Voice (TTS) is a compose profile so it can be left out entirely. VOICE in the
# environment wins; otherwise read what install.sh wrote to .env; default on.
voice="${VOICE:-}"
if [ -z "$voice" ] && [ -f .env ]; then
  voice="$(grep -E '^VOICE=' .env | tail -n1 | cut -d= -f2- | tr -d '[:space:]')"
fi
voice="${voice:-on}"

gpu="$(detect_gpu)"
files=(-f docker-compose.yml)
profiles=()
[ "$voice" = on ] && profiles+=(--profile voice)

case "$gpu" in
  nvidia)
    files+=(-f docker-compose.nvidia.yml)
    if ! command -v nvidia-smi >/dev/null 2>&1; then
      echo "warning: NVIDIA selected but nvidia-smi not found — you also need" >&2
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
echo "Voice (TTS): $voice"

set -x
exec docker compose "${files[@]}" "${profiles[@]}" up -d --build "$@"
