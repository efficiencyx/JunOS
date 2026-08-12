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

# Sort by VRAM so the biggest card ends up as device 0. it has to be UUIDs and
# NOT indices, nvidia-smi counts cards in slot order while CUDA sorts them
# fastest first, so index 1 means a different card to each of them.
nvidia_visible() {
  nvidia-smi --query-gpu=memory.total,uuid --format=csv,noheader,nounits 2>/dev/null \
    | sort -t, -k1 -nr | cut -d, -f2 | tr -d ' \r' | paste -sd, - || true
}

nvidia_count() {
  nvidia-smi --query-gpu=uuid --format=csv,noheader 2>/dev/null | grep -c . || true
}

# VRAM on the biggest card, in MiB. php has no GPU device of its own so this is
# the ONLY way it finds out, see default_num_ctx() in api/providers.php.
nvidia_vram_mb() {
  nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits 2>/dev/null \
    | sort -nr | head -n1 | tr -d ' \r' || true
}

amd_vram_mb() {
  rocm-smi --showmeminfo vram --csv 2>/dev/null \
    | awk -F, 'NR>1 { gsub(/[^0-9]/,"",$2); if ($2 != "") print int($2/1048576) }' \
    | sort -nr | head -n1 || true
}

amd_visible() {
  rocm-smi --showmeminfo vram --csv 2>/dev/null \
    | awk -F, 'NR>1 { gsub(/[^0-9]/,"",$1); gsub(/[^0-9]/,"",$2); if ($2 != "") print $2","$1 }' \
    | sort -t, -k1 -nr | cut -d, -f2 | paste -sd, - || true
}


# The model servers sit behind compose profiles, `ollama` runs the Ollama one
# and `llamacpp` the llama.cpp one. we MERGE with whatever is already set in the
# shell, like COMPOSE_PROFILES=prod ./start.sh, and in .env, we never replace it,
# then add what AI_PROVIDER implies. that way an old .env from before providers
# existed still boots ollama.
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
    # We run llama-server ourselves unless you pointed us at your own.
    case "${llamacpp_url:-http://llamacpp:8080}" in
      http://llamacpp:8080) add_profile llamacpp ;;
    esac
    llamacpp_model_file="$(env_get LLAMACPP_MODEL_FILE)"
    if [ -n "$llamacpp_model_file" ]; then
      export LLAMACPP_MODEL_FILE="$llamacpp_model_file"
      llamacpp_models_dir="$(env_get LLAMACPP_MODELS_DIR)"
      export LLAMACPP_MODELS_DIR="${llamacpp_models_dir:-./models}"
      if [ ! -f "$LLAMACPP_MODELS_DIR/$LLAMACPP_MODEL_FILE" ]; then
        echo "error: LLAMACPP_MODEL_FILE not found: $LLAMACPP_MODELS_DIR/$LLAMACPP_MODEL_FILE" >&2
        exit 1
      fi
      llamacpp_alias="$(env_get LLAMACPP_MODEL_ALIAS)"
      [ -z "$llamacpp_alias" ] || export LLAMACPP_MODEL_ALIAS="$llamacpp_alias"
    fi
    ;;
  openrouter) : ;;
  *)
    # We run ollama ourselves unless you pointed us at your own.
    case "$(env_get OLLAMA_URL)" in
      ''|http://ollama:11434) add_profile ollama ;;
    esac
    ;;
esac

voice="${VOICE:-$(env_get VOICE)}"
case "$(printf '%s' "${voice:-on}" | tr '[:upper:]' '[:lower:]')" in
  off|0|false|no) ;;
  *) add_profile voice ;;
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

# Compose publishes on BIND_ADDR, loopback unless somebody changed it. Say which
# it is, out loud, every start. "it's only on my machine" is the kind of thing
# people believe long after it stopped being true.
bind_addr="${BIND_ADDR:-$(env_get BIND_ADDR)}"
bind_addr="${bind_addr:-127.0.0.1}"
export BIND_ADDR="$bind_addr"
case "$bind_addr" in
  127.0.0.1|localhost|::1) echo "listening on: $bind_addr (this machine only)" ;;
  *) echo "listening on: $bind_addr - anything that can reach this box can open Jun" ;;
esac

tls_mode="${TLS_MODE:-$(env_get TLS_MODE)}"
case "$(printf '%s' "${tls_mode:-off}" | tr '[:upper:]' '[:lower:]')" in
  off|"") ;;
  *) case "$bind_addr" in
       127.0.0.1|localhost|::1)
         echo "note: TLS_MODE=$tls_mode but we only listen on $bind_addr, so Let's Encrypt can't reach the challenge. set BIND_ADDR=0.0.0.0 in .env." ;;
     esac ;;
esac

tts_device="${TTS_DEVICE:-$(env_get TTS_DEVICE)}"
export TTS_DEVICE="${tts_device:-cpu}"

# The GPU overlays build the karaoke sidecar with a CUDA or ROCm torch. when
# separation is set to run on the CPU we pin the CPU index instead, so we don't
# pull down a multi-GB wheel for hardware nobody asked to use.
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
[ -z "${LLAMACPP_MODEL_FILE:-}" ] || files+=(-f docker-compose.llamacpp-local.yml)

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
    probed_vram_mb="$(nvidia_vram_mb)"
    ;;
  amd)
    files+=(-f docker-compose.amd.yml)
    # The container must join the host groups that own the GPU device nodes.
    vgid="$(getent group video | cut -d: -f3 || true)"
    rgid="$(stat -c '%g' /dev/dri/renderD* 2>/dev/null | head -n1 || true)"
    [ -n "$rgid" ] || rgid="$(getent group render | cut -d: -f3 || true)"
    export VIDEO_GID="${vgid:-44}"
    export RENDER_GID="${rgid:-105}"
    probed_vram_mb="$(amd_vram_mb)"
    ;;
esac

# A hand-set value always wins: probing reports the whole card, which is wrong
# when something else on the machine permanently owns part of it.
vram_mb="${OMEGA_GPU_VRAM_MB:-$(env_get OMEGA_GPU_VRAM_MB)}"
vram_mb="${vram_mb:-${probed_vram_mb:-}}"
[ -z "$vram_mb" ] || export OMEGA_GPU_VRAM_MB="$vram_mb"

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
if [ -n "${OMEGA_GPU_VRAM_MB:-}" ]; then
  echo "  vram: ${OMEGA_GPU_VRAM_MB} MiB"
fi

# Ollama's layer split is decided at load time and then pinned (see
# default_num_ctx() and the keep_alive=-1 pin in api/providers.php), so a model
# that loads while the karaoke sidecar's CUDA torch is initialising stays mostly
# on the CPU - ~1000x on prefill. Hold karaoke back until the model server answers.
wait_for_ollama() {
  local i status
  for i in $(seq 1 90); do
    status="$(docker inspect -f '{{.State.Health.Status}}' omega-ollama 2>/dev/null || true)"
    [ "$status" = healthy ] && return 0
    sleep 2
  done
  echo "warning: omega-ollama did not report healthy; starting karaoke anyway" >&2
}

staged_up() {
  case ",${profiles}," in
    *,karaoke,*) ;;
    *) return 1 ;;
  esac
  case ",${profiles}," in
    *,ollama,*) ;;
    *) return 1 ;;
  esac
  [ "$#" -eq 0 ]
}

# A bare first word is a lifecycle subcommand; anything else (a flag like
# --build, or service names) is forwarded to `up -d` exactly as before.
case "${1:-up}" in
  stop|down)  shift; set -x; exec docker compose "${files[@]}" down "$@" ;;
  restart)    shift; docker compose "${files[@]}" down
              set -x; exec docker compose "${files[@]}" up -d --build "$@" ;;
  status|ps)  shift; set -x; exec docker compose "${files[@]}" ps "$@" ;;
  logs)       shift; set -x; exec docker compose "${files[@]}" logs -f "$@" ;;
  *)          if staged_up "$@"; then
                set -x
                docker compose "${files[@]}" up -d --build --scale karaoke=0
                { set +x; } 2>/dev/null
                wait_for_ollama
                set -x
              fi
              set -x; exec docker compose "${files[@]}" up -d --build "$@" ;;
esac
