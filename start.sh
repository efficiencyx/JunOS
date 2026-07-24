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

# Order by VRAM so the biggest card lands at device 0. Must be UUIDs, not
# indices: nvidia-smi enumerates by PCI bus order while CUDA defaults to
# FASTEST_FIRST, so index 1 means different cards to the two of them.
nvidia_visible() {
  nvidia-smi --query-gpu=memory.total,uuid --format=csv,noheader,nounits 2>/dev/null \
    | sort -t, -k1 -nr | cut -d, -f2 | tr -d ' \r' | paste -sd, - || true
}

nvidia_count() {
  nvidia-smi --query-gpu=uuid --format=csv,noheader 2>/dev/null | grep -c . || true
}

amd_visible() {
  rocm-smi --showmeminfo vram --csv 2>/dev/null \
    | awk -F, 'NR>1 { gsub(/[^0-9]/,"",$1); gsub(/[^0-9]/,"",$2); if ($2 != "") print $2","$1 }' \
    | sort -t, -k1 -nr | cut -d, -f2 | paste -sd, - || true
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

karaoke="${KARAOKE:-$(env_get KARAOKE)}"
case "$(printf '%s' "$karaoke" | tr '[:upper:]' '[:lower:]')" in
  on|1|true|yes) add_profile karaoke ;;
esac

export COMPOSE_PROFILES="$profiles"
echo "AI provider: $provider${profiles:+ (compose profiles: $profiles)}"
case ",${profiles}," in
  *,karaoke,*) ;;
  *) echo "karaoke: off (set KARAOKE=on in .env to build its sidecar)" ;;
esac

tts_device="${TTS_DEVICE:-$(env_get TTS_DEVICE)}"
export TTS_DEVICE="${tts_device:-cpu}"

# The GPU overlays build the karaoke sidecar against a CUDA/ROCm torch. Pin the
# CPU index instead when separation is set to run on the CPU, so a multi-GB wheel
# isn't downloaded for a device nobody asked for.
sep_device="${SEP_DEVICE:-$(env_get SEP_DEVICE)}"
sep_device="${sep_device:-auto}"
karaoke_torch_index="${KARAOKE_TORCH_INDEX:-$(env_get KARAOKE_TORCH_INDEX)}"
if [ "$(printf '%s' "$sep_device" | tr '[:upper:]' '[:lower:]')" = cpu ] \
   && [ -z "$karaoke_torch_index" ]; then
  karaoke_torch_index=https://download.pytorch.org/whl/cpu
fi
export SEP_DEVICE="$sep_device"
[ -z "$karaoke_torch_index" ] || export KARAOKE_TORCH_INDEX="$karaoke_torch_index"

gpu="$(detect_gpu)"
files=(-f docker-compose.yml)

case "$gpu" in
  nvidia)
    files+=(-f docker-compose.nvidia.yml)
    if ! command -v nvidia-smi >/dev/null 2>&1; then
      echo "warning: NVIDIA selected but nvidia-smi not found - you also need" >&2
      echo "         nvidia-container-toolkit installed, or run GPU=cpu ./start.sh" >&2
    fi
    ngpus="$(nvidia_count)"
    if [ "${ngpus:-0}" -gt 0 ]; then
      export NVIDIA_GPU_COUNT="$ngpus"
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

devices="${GPU_DEVICES:-$(env_get GPU_DEVICES)}"
case "$devices" in
  ""|auto)
    case "$gpu" in
      nvidia) devices="$(nvidia_visible)" ;;
      amd)    devices="$(amd_visible)" ;;
      *)      devices="" ;;
    esac
    ;;
  all) devices="" ;;
esac

if [ -n "$devices" ]; then
  case "$gpu" in
    nvidia) export CUDA_VISIBLE_DEVICES="$devices" ;;
    amd)    export HIP_VISIBLE_DEVICES="$devices" ROCR_VISIBLE_DEVICES="$devices" GGML_VK_VISIBLE_DEVICES="$devices" ;;
  esac
fi

tp="${TENSOR_PARALLEL:-$(env_get TENSOR_PARALLEL)}"
case "$(printf '%s' "$tp" | tr '[:upper:]' '[:lower:]')" in
  on|1|true|yes) tp=on ;;
  *)             tp=off ;;
esac
if [ "$tp" = on ]; then
  export OLLAMA_SCHED_SPREAD="${OLLAMA_SCHED_SPREAD:-1}"
  if [ "$gpu" = nvidia ]; then
    export LLAMA_ARG_SPLIT_MODE="${LLAMA_ARG_SPLIT_MODE:-row}"
  fi
fi

echo "GPU detected: $gpu"
if [ "$gpu" = amd ]; then
  echo "  video gid=$VIDEO_GID, render gid=$RENDER_GID${HSA_OVERRIDE_GFX_VERSION:+, HSA_OVERRIDE_GFX_VERSION=$HSA_OVERRIDE_GFX_VERSION}"
fi
if [ -n "$devices" ]; then
  echo "  devices (largest VRAM first): $devices"
fi
if [ "$tp" = on ]; then
  echo "  tensor parallelism: on"
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
