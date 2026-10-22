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

# Sort by VRAM so the biggest card ends up as device 0. it has to
# be UUIDs and NOT indices, nvidia-smi counts cards in slot order
# while CUDA sorts them fastest first, so index 1 means a
# different card to each of them.
nvidia_visible() {
  nvidia-smi --query-gpu=memory.total,uuid --format=csv,noheader,nounits 2>/dev/null \
    | sort -t, -k1 -nr | cut -d, -f2 | tr -d ' \r' | paste -sd, - || true
}

nvidia_count() {
  nvidia-smi --query-gpu=uuid --format=csv,noheader 2>/dev/null | grep -c . || true
}

# VRAM on the biggest card, in MiB. php has no GPU device of its
# own so this is the ONLY way it finds out, see default_num_ctx()
# in api/lib/providers/context.php.
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

# the card the MTP tune was measured on, as one string. MTP is
# multi-token prediction, a small drafter model guesses the next
# few tokens (how many = the draft depth) and the chat model
# checks them all in one pass. string is the vendor, then every
# GPU's name and how much VRAM it has. sorted biggest card first,
# so moving cards between slots is not a change, only a real
# swap is.
#
# the AMD half takes VRAM and nothing else. rocm-smi moves its
# product-name columns around between versions, and a name read
# out of the wrong column would make every boot look like a new
# card. missing a swap between two cards of the same size is the
# cheaper mistake. prints nothing when neither tool is here, an
# empty string is how the callers know we could not tell.
gpu_signature() {
  if command -v nvidia-smi >/dev/null 2>&1; then
    nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits 2>/dev/null \
      | sed -e 's/\r//' -e 's/[[:space:]]*,[[:space:]]*/:/' \
      | sort -t: -k2 -nr \
      | awk 'NF { s = s (s ? "," : "") $0 } END { if (s) print "nvidia:" s }'
  elif command -v rocm-smi >/dev/null 2>&1; then
    rocm-smi --showmeminfo vram --csv 2>/dev/null \
      | awk -F, 'NR>1 { gsub(/[^0-9]/,"",$2); if ($2 != "") print int($2/1048576) }' \
      | sort -nr \
      | awk 'NF { s = s (s ? "," : "") $0 } END { if (s) print "amd:" s }'
  fi
}


# the model servers sit behind compose profiles, `ollama` runs
# the Ollama one and `llamacpp` the llama.cpp one. we MERGE with
# whatever the shell already set, like
# COMPOSE_PROFILES=prod ./start.sh, and whatever .env set. never
# replace it. then add what AI_PROVIDER implies on top. that way
# an old .env from before providers existed still boots ollama.
env_get() { sed -n "s/^$1=//p" .env 2>/dev/null | tail -n1 || true; }
add_profile() {
  case ",${profiles}," in *,"$1",*) ;; *) profiles="${profiles:+$profiles,}$1" ;; esac
}

# her brain on another machine, mostly colab.ipynb in inference
# only mode. the quick tunnel URL and the gate key are new every
# notebook run, so a link that stopped answering is how we find
# out it changed. ask for Step 3's lines instead of making people
# hand edit .env. only these names get in, the rest of a paste is
# dropped.
CLOUD_KEYS="AI_PROVIDER OLLAMA_URL OLLAMA_API_KEY OLLAMA_MODELS_TO_PULL TITLE_MODEL OMEGA_NUM_CTX VLLM_URL VLLM_API_KEY VLLM_MODEL"

env_set() {
  local tmp
  tmp="$(mktemp .env.XXXXXX)"
  grep -vE "^$1=" .env > "$tmp" 2>/dev/null || true
  printf '%s=%s\n' "$1" "$2" >> "$tmp"
  chmod 600 "$tmp"
  mv "$tmp" .env
}

# "url|key|probe-path" of a model server off this machine, nothing
# when it's ours. loopback and the compose names are ours.
cloud_link() {
  local url
  case "$(env_get AI_PROVIDER)" in
    vllm) printf '%s|%s|/v1/models' "$(env_get VLLM_URL)" "$(env_get VLLM_API_KEY)" ;;
    openrouter|llamacpp) ;;
    *)
      url="$(env_get OLLAMA_URL)"
      case "$url" in ''|*://ollama[:/]*|*://localhost[:/]*|*://127.0.0.1[:/]*|*://host.docker.internal[:/]*) ;;
        *) printf '%s|%s|/api/tags' "$url" "$(env_get OLLAMA_API_KEY)" ;;
      esac
      ;;
  esac
}

cloud_paste() {
  local line key n=0
  echo "paste the lines Step 3 of the notebook printed, then enter on an empty line."
  echo "(just enter keeps what .env has)"
  while IFS= read -r line < /dev/tty; do
    line="$(printf '%s' "$line" | tr -d '\r' | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
    [ -n "$line" ] || break
    key="${line%%=*}"
    [ "$key" != "$line" ] || continue
    case " $CLOUD_KEYS " in
      *" $key "*) env_set "$key" "${line#*=}"; n=$((n + 1)) ;;
      *) echo "skipped $key, the notebook never prints that one" ;;
    esac
  done
  [ "$n" -eq 0 ] || echo "saved $n line(s) to .env"
}

# 8 s, a tunnel that's alive answers in under one. a dead quick
# tunnel is a DNS failure or a cloudflare 530, a stale key is the
# gate's 401. same thing to us, the lines are old.
check_cloud_link() {
  local url="" key="" probe="" auth=()
  IFS='|' read -r url key probe <<<"$(cloud_link)" || true
  [ -n "$probe" ] || return 0
  command -v curl >/dev/null 2>&1 || return 0
  [ -z "$key" ] || auth=(-H "Authorization: Bearer $key")
  if [ -n "$url" ] && curl -fsS -o /dev/null -m 8 ${auth[@]+"${auth[@]}"} "${url%/}$probe" 2>/dev/null; then
    return 0
  fi
  if [ -z "$url" ]; then
    echo "no link to her model server in .env yet (VLLM_URL is empty)" >&2
  else
    echo "her model server at $url isn't answering. a new notebook run means a new URL and key" >&2
  fi
  if [ -t 1 ] && { true >/dev/tty; } 2>/dev/null; then
    cloud_paste
  else
    echo "./start.sh link takes the new lines" >&2
  fi
}

is_on() {
  case "$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')" in on|1|true|yes) return 0 ;; esac
  return 1
}

# --ignore-security can sit anywhere on the line. it comes out
# here so it never reaches compose as a service name
ignore_security="${JUN_IGNORE_SECURITY:-$(env_get JUN_IGNORE_SECURITY)}"
args=()
for a in "$@"; do
  case "$a" in --ignore-security) ignore_security=1 ;; *) args+=("$a") ;; esac
done
set -- ${args[@]+"${args[@]}"}

# install.sh's version_lt() plus one rule. a -security tag sorts
# right above the same tag without it, so v1.0.4-beeeta-security
# beats v1.0.4-beeeta and v1.0.4-security beats v1.0.4.
version_lt() {
  local a="${1#v}" b="${2#v}" as=0 bs=0 ac bc ap="" bp="" i x y
  case "$a" in *-security) a="${a%-security}"; as=1 ;; esac
  case "$b" in *-security) b="${b%-security}"; bs=1 ;; esac
  ac="${a%%-*}"; bc="${b%%-*}"
  [ "$ac" != "$a" ] && ap="${a#*-}"
  [ "$bc" != "$b" ] && bp="${b#*-}"
  for i in 1 2 3 4; do
    x="$(printf '%s' "$ac" | cut -d. -f"$i")"; y="$(printf '%s' "$bc" | cut -d. -f"$i")"
    case "$x" in ''|*[!0-9]*) x=0 ;; esac
    case "$y" in ''|*[!0-9]*) y=0 ;; esac
    [ "$x" -lt "$y" ] && return 0
    [ "$x" -gt "$y" ] && return 1
  done
  if [ "$ap" != "$bp" ]; then
    [ -z "$ap" ] && return 1
    [ -z "$bp" ] && return 0
    [[ "$ap" < "$bp" ]]
    return
  fi
  [ "$as" -lt "$bs" ]
}

# tag<TAB>prerelease, one release a line. no jq on a fresh box.
# tag_name comes before prerelease in every release object and
# a release body can't fake either key, its quotes come escaped
release_rows() {
  grep -oE '"(tag_name|prerelease)": *("[^"]*"|true|false)' "$1" \
    | awk -F': *' '/"tag_name"/ { gsub(/"/, "", $2); t = $2; next } t != "" { print t "\t" $2; t = "" }'
}

# UPDATE_CHECK=on (the installer asks) and we're on a release
# tag: ask GitHub once what's newer on our channel. a newer
# -security release means the one we run has a hole bad enough
# to stop her over (unauthenticated RCE class, see SECURITY.md),
# so no boot unless --ignore-security / JUN_IGNORE_SECURITY=1.
# anything else newer is one line after boot. it never updates
# anything. main or a branch of your own is skipped, the fix for
# a -security release lands on main first.
update_note=""
update_check() {
  local current slug channel body code tag pre newest="" security=""
  is_on "${UPDATE_CHECK:-$(env_get UPDATE_CHECK)}" || return 0
  command -v curl >/dev/null 2>&1 || return 0
  current="$(git describe --tags --exact-match HEAD 2>/dev/null || true)"
  [ -n "$current" ] || return 0
  slug="$(git remote get-url origin 2>/dev/null \
    | sed -nE 's#^(https://github\.com/|git@github\.com:)([^/]+/[^/]+)$#\2#p' | sed 's#/$##; s#\.git$##')"
  [ -n "$slug" ] || return 0
  channel="$(env_get JUN_CHANNEL)"

  body="$(mktemp)"
  code="$(curl --proto '=https' --tlsv1.2 -sS -m 8 -o "$body" -w '%{http_code}' \
    -H 'Accept: application/vnd.github+json' -H 'User-Agent: JunOS-update-check' \
    "https://api.github.com/repos/$slug/releases?per_page=20" 2>/dev/null || true)"
  if [ "$code" = 200 ]; then
    while IFS=$'\t' read -r tag pre; do
      [ "$channel" = latest ] || [ "$channel" = experimental ] || [ "$pre" = false ] || continue
      version_lt "$current" "$tag" || continue
      { [ -z "$newest" ] || version_lt "$newest" "$tag"; } && newest="$tag"
      case "$tag" in *-security) security="$tag" ;; esac
    done < <(release_rows "$body")
  else
    # 60 anonymous API calls an hour per IP. the website's
    # /releases/latest redirect has no cap but only knows the
    # newest full release
    tag="$(curl --proto '=https' --tlsv1.2 -sS -m 8 -o /dev/null -w '%{redirect_url}' \
      "https://github.com/$slug/releases/latest" 2>/dev/null || true)"
    case "$tag" in
      */releases/tag/?*) tag="${tag##*/releases/tag/}" ;;
      *) rm -f "$body"; echo "update check: couldn't reach GitHub, skipped"; return 0 ;;
    esac
    if version_lt "$current" "$tag"; then
      newest="$tag"
      case "$tag" in *-security) security="$tag" ;; esac
    fi
  fi
  rm -f "$body"

  if [ -n "$security" ]; then
    {
      echo ""
      echo "SECURITY: $security is out and fixes a vulnerability in the version you run ($current)."
      echo "  details: https://github.com/$slug/releases/tag/$security"
      echo "  update:  ./install.sh from this folder. it only moves the code, chats and settings stay."
    } >&2
    if is_on "$ignore_security"; then
      echo "  starting anyway, --ignore-security / JUN_IGNORE_SECURITY is set. update soon." >&2
      update_note="reminder: you're on $current with a security fix out ($security). ./install.sh updates her."
      return 0
    fi
    {
      echo "  NOT starting her on it. if she's still up from before, ./start.sh stop takes her down."
      echo "  ./start.sh --ignore-security (or JUN_IGNORE_SECURITY=1) starts her anyway, at your own risk."
    } >&2
    exit 3
  fi
  [ -z "$newest" ] || update_note="update: $newest is out, you're on $current. ./install.sh from this folder updates her, chats and settings stay."
}

case "${1:-up}" in
  link)
    { true >/dev/tty; } 2>/dev/null || { echo "./start.sh link needs a terminal" >&2; exit 1; }
    cloud_paste
    echo "./start.sh to restart her with them"
    exit 0
    ;;
  stop|down|status|ps|logs|trust) ;;
  *) check_cloud_link; update_check ;;
esac

profiles="${COMPOSE_PROFILES:-}"
file_profiles="$(env_get COMPOSE_PROFILES)"
# except the model server ones. those come from AI_PROVIDER and
# the URLs below. install.sh writes COMPOSE_PROFILES=ollama, so
# pointing OLLAMA_URL at the colab tunnel later would still boot
# a local ollama nobody talks to, and it'd pull the 12B into it.
# 8 GB. for nothing.
for p in ${file_profiles//,/ }; do
  case "$p" in ollama|llamacpp) ;; *) add_profile "$p" ;; esac
done

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
  # vllm is never ours to run, it's the colab/kaggle TPU (or a
  # server of your own) behind VLLM_URL
  openrouter|vllm) : ;;
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

# Compose publishes on BIND_ADDR, loopback unless somebody
# changed it. Say which it is, out loud, every start. "it's only
# on my machine" is the kind of thing people believe long after
# it stopped being true.
bind_addr="${BIND_ADDR:-$(env_get BIND_ADDR)}"
bind_addr="${bind_addr:-127.0.0.1}"
export BIND_ADDR="$bind_addr"
case "$bind_addr" in
  127.0.0.1|localhost|::1) echo "listening on: $bind_addr (this machine only)" ;;
  *) echo "listening on: $bind_addr - anything that can reach this box can open Jun"
     echo "off loopback even the first account needs OMEGA_REGISTRATION_KEY from .env" ;;
esac

# install.sh and install.ps1 both write this on first run, but
# cp .env.example .env && ./start.sh never went through either,
# and that box has open signup until someone notices. same rule
# as the installers, only when the line is MISSING. an empty
# OMEGA_REGISTRATION_KEY= is the operator saying "off".
if [ -f .env ] && ! grep -qE '^OMEGA_REGISTRATION_KEY=' .env; then
  reg_key="$(openssl rand -hex 16 2>/dev/null || head -c16 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  printf 'OMEGA_REGISTRATION_KEY=%s\n' "$reg_key" >> .env
  echo "registration key: $reg_key (written to .env, the first account skips it while listening on loopback only, everyone after needs it)"
fi
# same shape for the header php shows the tts/karaoke sidecars.
# an empty SIDECAR_SECRET= is honoured too, the sidecar then runs
# on its Host allowlist alone and warns about it at startup.
if [ -f .env ] && ! grep -qE '^SIDECAR_SECRET=' .env; then
  printf 'SIDECAR_SECRET=%s\n' "$(openssl rand -hex 32 2>/dev/null || head -c32 /dev/urandom | od -An -tx1 | tr -d ' \n')" >> .env
fi

# nginx and php both refuse a Host they don't know (444 and 421),
# so opening the phone at https://192.168.1.42 needs that exact
# address in the allowlist. the containers can't work it out
# themselves, all they see is the docker bridge, so we read the
# host's own private v4 addresses here and hand them down. only
# when BIND_ADDR is off loopback: on the default install nothing
# outside this box can connect anyway, so widening the list buys
# nothing. 10.*, 172.16-31.* and 192.168.* only, and never the
# docker bridges, or we'd be naming addresses that aren't ours to
# answer for. DHCP moves these, so a new lease means a restart.
# OMEGA_EXTRA_HOSTS stays for anything we can't guess: an mDNS
# name, a tailscale address, whatever the proxy calls you.
lan_hosts() {
  command -v ip >/dev/null 2>&1 || return 0
  ip -4 -o addr show scope global up 2>/dev/null | awk '
    $2 ~ /^(docker|br-|veth|virbr)/ { next }
    { split($4, a, "/")
      if (a[1] ~ /^10\./ || a[1] ~ /^192\.168\./ || a[1] ~ /^172\.(1[6-9]|2[0-9]|3[01])\./) print a[1] }'
}
case "$bind_addr" in
  127.0.0.1|127.*|localhost|::1) ;;
  *)
    extra_hosts="${OMEGA_EXTRA_HOSTS:-$(env_get OMEGA_EXTRA_HOSTS)}"
    detected="$(lan_hosts | tr '\n' ' ')"
    # commas out FIRST. php takes either, nginx's server_name only
    # takes spaces and would happily register a host called
    # "jun.local,".
    extra_hosts="$(printf '%s %s' "$extra_hosts" "$detected" | tr ',' ' ' | tr -s ' ' | sed 's/^ //; s/ $//')"
    export OMEGA_EXTRA_HOSTS="$extra_hosts"
    [ -z "$detected" ] || echo "reachable as: $(printf '%s' "$detected" | sed 's/ $//; s/[^ ]*/https:\/\/&/g')"
    ;;
esac

tls_mode="${TLS_MODE:-$(env_get TLS_MODE)}"
tls_mode_normalized="$(printf '%s' "${tls_mode:-off}" | tr '[:upper:]' '[:lower:]')"
case "$tls_mode_normalized" in
  off|"") ;;
  *) case "$bind_addr" in
       127.0.0.1|localhost|::1)
         echo "note: TLS_MODE=$tls_mode but we only listen on $bind_addr, so Let's Encrypt can't reach the challenge. set BIND_ADDR=0.0.0.0 in .env." ;;
     esac ;;
esac
export TLS_MODE="${tls_mode:-off}"

tts_device="${TTS_DEVICE:-$(env_get TTS_DEVICE)}"
export TTS_DEVICE="${tts_device:-cpu}"

# The GPU overlays build the karaoke sidecar with a CUDA or ROCm
# torch. when separation is set to run on the CPU we pin the CPU
# index instead, so we don't pull down a multi-GB wheel for
# hardware nobody asked to use.
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
    # the container has to be in the host groups that own the GPU
    # device nodes, or it can't open them.
    vgid="$(getent group video | cut -d: -f3 || true)"
    rgid="$(stat -c '%g' /dev/dri/renderD* 2>/dev/null | head -n1 || true)"
    [ -n "$rgid" ] || rgid="$(getent group render | cut -d: -f3 || true)"
    export VIDEO_GID="${vgid:-44}"
    export RENDER_GID="${rgid:-105}"
    probed_vram_mb="$(amd_vram_mb)"
    ;;
esac

# A hand-set value always wins: probing reports the whole card,
# which is wrong when something else on the machine permanently
# owns part of it.
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

# ollama picks the layer split at load time and then it's pinned
# (see default_num_ctx() and the keep_alive=-1 pin in
# api/lib/providers/). so a model that loads while the karaoke
# sidecar's CUDA torch is still initialising stays mostly on the
# CPU. that's ~1000x slower on prefill, the pass that reads the
# prompt in. karaoke waits until the model server answers, then
# until she's loaded (wait_for_ollama_model).
wait_for_ollama() {
  local i status
  for i in $(seq 1 90); do
    status="$(docker inspect -f '{{.State.Health.Status}}' omega-ollama 2>/dev/null || true)"
    [ "$status" = healthy ] && return 0
    sleep 2
  done
  echo "warning: omega-ollama did not report healthy; starting karaoke anyway" >&2
}

# "is she even on the right card" is the first thing anyone asks
# after an install, and the only thing that actually knows is
# ollama's own startup log. a box with an iGPU next to a real one
# is where this bites: we hand down a device list sorted biggest
# VRAM first, ollama picks from it, and nothing has ever said out
# loud which one it took. so say it. waits up to 20s for the
# line, then gives up without a word. the model server pulling
# an 8 GB fine-tune on first boot is not an error.
report_gpu_placement() {
  local i line
  [ "$gpu" != cpu ] || return 0
  case ",${profiles}," in
    *,ollama,*) ;;
    *,llamacpp,*) report_llamacpp_devices; return 0 ;;
    *) return 0 ;;
  esac
  for i in $(seq 1 10); do
    line="$(docker logs omega-ollama 2>&1 | grep 'inference compute' || true)"
    [ -n "$line" ] && break
    sleep 2
  done
  [ -n "$line" ] || return 0
  echo "ollama is running on:"
  printf '%s\n' "$line" | awk '{
    lib = ""; nm = ""; tot = "";
    if (match($0, /library=[^ ]+/))  lib = substr($0, RSTART + 8,  RLENGTH - 8);
    # 0.32 moved the card name to description= and left name=CUDA0
    # unquoted. older builds only have name="...". take either.
    if (match($0, /description="[^"]*"/)) nm = substr($0, RSTART + 13, RLENGTH - 14);
    else if (match($0, /name="[^"]*"/))   nm = substr($0, RSTART + 6,  RLENGTH - 7);
    if (match($0, /total="[^"]*"/))  tot = substr($0, RSTART + 7,  RLENGTH - 8);
    # a CPU-only line is description=cpu, unquoted, so nm stays empty
    if (lib == "cpu") print "  CPU. no GPU at all, ollama gave up on the card";
    else if (nm != "") printf "  %s (%s%s)\n", nm, lib, (tot != "" ? ", " tot : "");
  }'
  if printf '%s\n' "$line" | grep -q 'library=cpu'; then
    echo "  nvidia-smi working != CUDA working. a stale /etc/cdi/nvidia.yaml hands the" >&2
    echo "  container the wrong nvidia-uvm major (it moves between boots) and cuInit dies" >&2
    echo "  with 999. regen it: sudo nvidia-ctk cdi generate --output=/etc/cdi/nvidia.yaml" >&2
    return 0
  fi
  echo "  wrong card? pin it with GPU_DEVICES= in .env, biggest-VRAM-first is only our guess."
}

# same question on llama.cpp. it doesn't log the card at its
# default verbosity any more, but --list-devices asks the exact
# backend the server runs on, inside its container with its
# CUDA_VISIBLE_DEVICES, and prints `CUDA0: <name> (<MiB>, ...)` or
# `(none)`.
report_llamacpp_devices() {
  local devs
  devs="$(docker exec omega-llamacpp /app/llama-server --list-devices 2>/dev/null \
    | sed -n '/Available devices/,$p' | tail -n +2 || true)"
  [ -n "$devs" ] || return 0
  echo "llama.cpp is running on:"
  if printf '%s\n' "$devs" | grep -q '(none)'; then
    echo "  CPU. no GPU at all, llama.cpp found no card"
    [ "$gpu" = nvidia ] && echo "  nvidia-smi working != CUDA working. regen the CDI spec: sudo nvidia-ctk cdi generate --output=/etc/cdi/nvidia.yaml" >&2
    return 0
  fi
  printf '%s\n' "$devs" | sed 's/^ */  /'
  echo "  wrong card? pin it with GPU_DEVICES= in .env, biggest-VRAM-first is only our guess."
}

# llama-server runs in router mode and loads a model on its first
# request, which would make the first chat a 2-12 GB download. so
# load her right after `up`, same moment ollama pulls hers.
llamacpp_chat_model() {
  local file alias hf
  file="$(env_get LLAMACPP_MODEL_FILE)"
  if [ -n "$file" ]; then
    alias="$(env_get LLAMACPP_MODEL_ALIAS)"
    echo "${alias:-jun-local}"
    return
  fi
  hf="$(env_get LLAMACPP_MODEL_HF)"
  hf="${hf:-efficiencyx/Jun-LoRA-E2B-GGUF:Q4_K_M}"
  echo "${hf%%,*}"
}

# loaded / loading / unloaded, empty when the router doesn't answer.
# no jq on a fresh box, the JSON is split one model per line
llamacpp_status() {
  docker exec omega-llamacpp curl -fsS http://127.0.0.1:8080/v1/models 2>/dev/null \
    | sed 's/{"id":/\n&/g' | grep -F "{\"id\":\"$1\"" | grep -o '"value":"[a-z]*"' | head -n1 | cut -d'"' -f4 || true
}

load_llamacpp() {
  local model i
  case ",${profiles}," in *,llamacpp,*) ;; *) return 0 ;; esac
  model="$(llamacpp_chat_model)"
  for i in $(seq 1 45); do
    docker exec omega-llamacpp curl -fsS http://127.0.0.1:8080/health >/dev/null 2>&1 && break
    sleep 2
  done
  [ "$(llamacpp_status "$model")" = loaded ] && return 0
  docker exec omega-llamacpp curl -fsS -X POST http://127.0.0.1:8080/models/load \
    -H 'Content-Type: application/json' -d "{\"model\":\"$model\"}" >/dev/null 2>&1 \
    || echo "warning: llama.cpp didn't take the load for $model, she loads on the first message instead" >&2
  echo "llama.cpp: loading $model (the first start downloads it, 2-12 GB. ./start.sh logs llamacpp to watch)"
}

# for the karaoke stagger. the model has to be ON the card before
# karaoke's torch starts grabbing VRAM, see wait_for_ollama
wait_for_llamacpp_model() {
  local model i
  model="$(llamacpp_chat_model)"
  for i in $(seq 1 450); do
    [ "$(llamacpp_status "$model")" = loaded ] && return 0
    sleep 2
  done
  echo "warning: $model still isn't loaded after 15 minutes; starting karaoke anyway" >&2
}

# The draft depth in .env is a measurement, and it only describes
# the card it was measured on. Swap the GPU and the number in
# there is about hardware that left the building, so hold the
# stamp the tuner wrote against what is in the box now and measure
# again when the two don't match.
mtp_recheck() {
  local want tuned sig drafter server ready i
  # On the llamacpp side the tuner restarts the stack through
  # ./start.sh, and that is us. without this we start a tune inside
  # a tune, forever.
  [ -z "${MTP_AUTOTUNE_RUNNING:-}" ] || return 0

  want="${MTP_AUTOTUNE:-$(env_get MTP_AUTOTUNE)}"
  case "$(printf '%s' "$want" | tr '[:upper:]' '[:lower:]')" in
    off|0|false|no) return 0 ;;
  esac

  # No stamp means no tune ever finished on this box, so there is
  # nothing to compare and nothing to nag about.
  tuned="$(env_get MTP_TUNED_GPU)"
  [ -n "$tuned" ] || return 0
  sig="$(gpu_signature)"
  [ -n "$sig" ] || return 0
  [ "$sig" != "$tuned" ] || return 0

  case "$provider" in
    llamacpp)  drafter="$(env_get LLAMACPP_MTP)"; server=llamacpp ;;
    ollama|'') drafter="$(env_get OLLAMA_MTP)"; server=ollama ;;
    *) return 0 ;;
  esac
  # MTP is off, so there is no depth to measure. the tuner would
  # only die on it and we would come back here every single boot.
  [ -n "$drafter" ] || return 0
  # Point us at your own model server and none of this is ours to
  # tune, there is no omega- container to wait on and the tuner
  # wants one anyway. Both waits below would just run out their
  # clocks, every boot, and tell you nothing.
  case ",${profiles}," in *,"$server",*) ;; *) return 0 ;; esac

  echo ""
  echo "the GPU changed since MTP was tuned:"
  echo "  tuned on: $tuned"
  echo "  here now: $sig"
  echo "the draft depth in .env was measured on a card that is not in this box any"
  echo "more, so we are measuring it again. a few minutes on ollama, considerably"
  echo "longer on llamacpp where every depth needs a llama-server restart."
  echo "set MTP_AUTOTUNE=off in .env to skip this."

  # ollama's healthcheck is /api/tags, and that answers the moment
  # the server is up, long before ollama-entrypoint.sh has finished
  # pulling the chat model and the drafter. The tuner needs the
  # drafter blob on disk or it dies with "could not find the
  # drafter blob", so wait untill ollama admits it has one.
  ready=
  case "$provider" in
    llamacpp)
      for i in $(seq 1 60); do
        if [ "$(docker inspect -f '{{.State.Health.Status}}' omega-llamacpp 2>/dev/null || true)" = healthy ]; then
          ready=1; break
        fi
        sleep 5
      done
      ;;
    *)
      wait_for_ollama
      for i in $(seq 1 60); do
        if docker exec omega-ollama ollama show --modelfile "$drafter" >/dev/null 2>&1; then
          ready=1; break
        fi
        sleep 5
      done
      ;;
  esac

  # Leave the stamp stale on purpose. it is the only thing that
  # makes the next boot try again, and a pull that is still running
  # now is probably done by then.
  if [ -z "$ready" ]; then
    echo "warning: the drafter is not here yet, so the re-tune is skipped." >&2
    echo "         run ./mtp-autotune.sh by hand once it has finished pulling." >&2
    return 0
  fi

  if ! MTP_AUTOTUNE_RUNNING=1 ./mtp-autotune.sh; then
    echo "warning: autotune did not finish, run ./mtp-autotune.sh by hand" >&2
  fi
}

staged_up() {
  case ",${profiles}," in
    *,karaoke,*) ;;
    *) return 1 ;;
  esac
  case ",${profiles}," in
    *,ollama,*|*,llamacpp,*) ;;
    *) return 1 ;;
  esac
  [ "$#" -eq 0 ]
}

# /api/tags answers long before she's on the card, so that alone
# lets karaoke's torch in mid-load. php-entrypoint.sh already
# started the same warm, a second one just waits for that load
wait_for_ollama_model() {
  wait_for_ollama
  docker exec omega-php php /var/www/omega/api/prewarm.php \
    || echo "warning: she didn't load ahead of time; starting karaoke anyway" >&2
}

wait_for_model_server() {
  case ",${profiles}," in
    *,llamacpp,*) load_llamacpp; wait_for_llamacpp_model ;;
    *) wait_for_ollama_model ;;
  esac
}

# No exec here. it replaces the shell, so nothing after the
# compose call gets to run, mtp_recheck included. set -e still
# takes a compose failure out on the spot, with compose's own
# exit code.
up_and_check() {
  set -x; docker compose "${files[@]}" up -d --build "$@"
  { set +x; } 2>/dev/null
  report_gpu_placement
  load_llamacpp
  mtp_recheck
  check_trusted_ca
  [ -z "$update_note" ] || echo "$update_note"
}

# runtime/jun-ca.pem is the copy of the CA we put in the trust
# stores. the real one lives in the nginx volume, so this copy is
# also what uninstall.sh takes back out after the volume is gone.
trusted_ca=runtime/jun-ca.pem

# healthy, not just running. 10-pick-config.sh mints the CA before
# nginx starts, and the healthcheck only passes once nginx is up.
current_ca() {
  for _ in $(seq 1 60); do
    [ "$(docker inspect -f '{{.State.Health.Status}}' "$(docker compose "${files[@]}" ps -q nginx)" 2>/dev/null)" = healthy ] && break
    sleep 1
  done
  docker compose "${files[@]}" exec -T nginx cat /etc/nginx/selfsigned/ca.pem 2>/dev/null
}

# a host outside the CA's names (or 10 years) makes a new CA, and
# every browser that trusted the old one is back to the warning.
check_trusted_ca() {
  [ -s "$trusted_ca" ] || return 0
  current_ca | cmp -s - "$trusted_ca" && return 0
  echo "the local CA changed since it was trusted. run ./start.sh trust to swap it in the trust stores" >&2
}

trust_ca() {
  local new
  new="$(mktemp runtime/jun-ca.XXXXXX)"
  if ! current_ca >"$new" || [ ! -s "$new" ]; then
    rm -f "$new"
    echo "no local CA from nginx. start her first (./start.sh), it makes one on boot" >&2
    return 1
  fi
  if [ -s "$trusted_ca" ] && ! cmp -s "$new" "$trusted_ca"; then
    tools/trust-ca.sh remove "$trusted_ca" || true
  fi
  # kept even when some stores said no. the ones that said yes still
  # have it, and uninstall.sh needs this copy to take it back out.
  local rc=0
  tools/trust-ca.sh install "$new" || rc=$?
  mv "$new" "$trusted_ca"
  chmod 644 "$trusted_ca"
  [ "$rc" -eq 0 ] && echo "trusted. restart the browser if it was open"
  return "$rc"
}

# a bare first word is a lifecycle subcommand. anything else (a
# flag like --build, or service names) goes straight through to
# `up -d`.
case "${1:-up}" in
  stop|down)  shift; set -x; exec docker compose "${files[@]}" down "$@" ;;
  restart)    shift; docker compose "${files[@]}" down
              up_and_check "$@" ;;
  status|ps)  shift; set -x; exec docker compose "${files[@]}" ps "$@" ;;
  logs)       shift; set -x; exec docker compose "${files[@]}" logs -f "$@" ;;
  trust)      mkdir -p runtime; trust_ca ;;
  *)          if staged_up "$@"; then
                set -x
                docker compose "${files[@]}" up -d --build --scale karaoke=0
                { set +x; } 2>/dev/null
                wait_for_model_server
                set -x
              fi
              up_and_check "$@" ;;
esac
