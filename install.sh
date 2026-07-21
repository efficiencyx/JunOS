#!/usr/bin/env bash
set -euo pipefail

REPO="${JUN_REPO:-https://github.com/efficiencyx/Jun.git}"
DIR="${JUN_DIR:-Jun}"
REF="${JUN_REF:-main}"
OS="$(uname -s)"
NEED_SG=0
DOCKER_JUST_INSTALLED=0

if [ "$(id -u)" -eq 0 ]; then
    SUDO=""
elif command -v sudo >/dev/null 2>&1; then
    SUDO="sudo"
else
    SUDO=""
fi

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ] && [ "${TERM:-}" != "dumb" ]; then
    R=$'\033[0m'; B=$'\033[1m'; D=$'\033[2m'
    ACCENT=$'\033[38;2;124;158;255m'    #7c9eff
    PURPLE=$'\033[38;2;155;114;203m'    #9b72cb
    OK=$'\033[38;2;123;216;143m'        #7bd88f
    DANGER=$'\033[38;2;255;138;138m'    #ff8a8a
    WARN=$'\033[38;2;255;200;112m'      #ffc870
    DIM=$'\033[38;2;142;146;149m'       #8e9295
    MUTED=$'\033[38;2;196;199;197m'     #c4c7c5
else
    R=; B=; D=; ACCENT=; PURPLE=; OK=; DANGER=; WARN=; DIM=; MUTED=
fi

UI_W=52   # interior width of the window frame

_rule() { local n=$UI_W out=; while [ "$n" -gt 0 ]; do out="$out$1"; n=$((n-1)); done; printf '%s' "$out"; }

banner() {
    local os_name="Linux"; [ "$OS" = "Darwin" ] && os_name="macOS"
    printf '\n'
    printf '  %s┌%s┐%s\n' "$DIM" "$(_rule ─)" "$R"
    printf '  %s│%s %s●%s %s●%s %s●%s   %sjun@omega%s:%s ~/install%s%*s%s│%s\n' \
        "$DIM" "$R" "$DANGER" "$R" "$WARN" "$R" "$OK" "$R" \
        "$ACCENT" "$R" "$MUTED" "$R" $((UI_W-29)) "" "$DIM" "$R"
    printf '  %s└%s┘%s\n\n' "$DIM" "$(_rule ─)" "$R"
    printf '   %s%sΩ%s  %s%sJUN OS%s\n\n' "$B" "$PURPLE" "$R" "$B" "$ACCENT" "$R"
    printf '   %sWelcome to Jun OS%s %s·%s %somega build%s\n' "$MUTED" "$R" "$DIM" "$R" "$DIM" "$R"
    printf '   %sshell detected:%s %s%s%s %s-%s installer\n\n' "$DIM" "$R" "$B$ACCENT" "$os_name" "$R" "$DIM" "$R"
}

step()  { printf '   %s$%s %s%s%s\n' "$OK" "$R" "$B" "$1" "$R"; }
ok()    { printf '     %s✓%s %s%s%s\n' "$OK" "$R" "$MUTED" "$1" "$R"; }
note()  { printf '     %s%s%s\n' "$DIM" "$1" "$R"; }
warn_() { printf '   %s!%s %s%s%s\n' "$WARN" "$R" "$WARN" "$1" "$R" >&2; }
fail_()  { printf '   %s✗%s %s%s%s\n' "$DANGER" "$R" "$DANGER" "$1" "$R" >&2; }

_spin() {
    local pid="$1" msg="$2" frames='|/-\' i=0
    while kill -0 "$pid" 2>/dev/null; do
        printf '\r     %s%s%s %s%s%s' "$ACCENT" "${frames:i++%4:1}" "$R" "$DIM" "$msg" "$R"
        sleep 0.1
    done
    printf '\r\033[K'
}

# Run a command with its output hidden (the user asked for a clean interface):
# captured to a temp log, shown only if it fails. A spinner gives feedback on a
# TTY; piped/redirected it just runs quietly. Aborts the installer on failure.
run() {
    local msg="$1"; shift
    local log rc=0; log="$(mktemp)"
    if [ -t 1 ]; then
        "$@" >"$log" 2>&1 &
        local pid=$!
        _spin "$pid" "$msg"
        wait "$pid" || rc=$?
    else
        "$@" >"$log" 2>&1 || rc=$?
    fi
    if [ "$rc" -eq 0 ]; then
        ok "$msg"
        rm -f "$log"
    else
        fail_ "$msg"
        sed 's/^/       /' "$log" >&2
        rm -f "$log"
        exit "$rc"
    fi
}

# Like run(), but streams output live - for long steps (image builds, model
# pulls) where a silent spinner reads as a hang.
run_live() {
    local msg="$1"; shift
    printf '     %s→%s %s%s%s\n' "$ACCENT" "$R" "$DIM" "$msg" "$R"
    local rc=0
    "$@" 2>&1 | sed -u 's/^/       /' || rc=$?
    if [ "$rc" -eq 0 ]; then
        ok "$msg"
    else
        fail_ "$msg"
        exit "$rc"
    fi
}

MODEL_12B="hf.co/efficiencyx/Jun-LoRA-v4-12B-GGUF:Q4_K_M"
MODEL_E4B="hf.co/efficiencyx/Jun-LoRA-v4-E4B-GGUF:Q4_K_M"
MODEL_E2B="hf.co/efficiencyx/Jun-LoRA-v4-E2B-GGUF:Q4_K_M"

resolve_model() {  # alias|full-ref -> full-ref
    case "$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')" in
        12b|jun|best|"") echo "$MODEL_12B" ;;
        e4b|balanced|fast) echo "$MODEL_E4B" ;;
        e2b|fastest|cpu) echo "$MODEL_E2B" ;;
        *)               echo "$1" ;;
    esac
}

detect_vram_mb() {
    if command -v nvidia-smi >/dev/null 2>&1; then
        nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits 2>/dev/null \
            | head -n1 | tr -dc '0-9'
    elif command -v rocm-smi >/dev/null 2>&1; then
        rocm-smi --showmeminfo vram 2>/dev/null \
            | grep -i 'total' | grep -oE '[0-9]+' | head -n1 \
            | awk '{ if ($1 > 0) print int($1 / 1048576) }'
    fi
}

recommend_model() {
    local mb="$1"
    [ -z "$mb" ] && { echo "$MODEL_E2B"; return; }
    if   [ "$mb" -ge 23500 ]; then echo "hf.co/efficiencyx/Jun-LoRA-v4-12B-GGUF:Q8_0"
    elif [ "$mb" -ge 15500 ]; then echo "hf.co/efficiencyx/Jun-LoRA-v4-12B-GGUF:Q6_K"
    elif [ "$mb" -ge 11500 ]; then echo "$MODEL_12B"
    elif [ "$mb" -ge 9500 ]; then echo "hf.co/efficiencyx/Jun-LoRA-v4-E4B-GGUF:Q8_0"
    elif [ "$mb" -ge 7500 ]; then echo "$MODEL_E4B"
    elif [ "$mb" -ge 5500 ]; then echo "hf.co/efficiencyx/Jun-LoRA-v4-E2B-GGUF:Q6_K"
    else                               echo "$MODEL_E2B"
    fi
}

set_env() {
    local key="$1" val="$2" tmp
    if grep -qE "^${key}=" .env 2>/dev/null; then
        tmp="$(mktemp)"
        grep -vE "^${key}=" .env > "$tmp"
        printf '%s=%s\n' "$key" "$val" >> "$tmp"
        mv "$tmp" .env
    else
        printf '%s=%s\n' "$key" "$val" >> .env
    fi
}

ask_model_ref() {
    local vram rec alias ans
    vram="$(detect_vram_mb)"
    rec="$(recommend_model "$vram")"

    if [ -n "${JUN_MODEL:-}" ] || [ "${JUN_YES:-}" = "1" ] || [ ! -r /dev/tty ]; then
        alias="${JUN_MODEL:-$rec}"
    else
        {
            printf '\n     %sselect a model%s\n' "$B" "$R"
            printf '       %s1%s  Jun 12B  %s-%s highest quality\n' "$ACCENT" "$R" "$DIM" "$R"
            printf '       %s2%s  Jun E4B  %s-%s balanced\n' "$ACCENT" "$R" "$DIM" "$R"
            printf '       %s3%s  Jun E2B  %s-%s lightest / CPU-friendly\n' "$ACCENT" "$R" "$DIM" "$R"
            [ -n "$vram" ] && printf '       %sdetected %sMB VRAM%s\n' "$DIM" "$vram" "$R"
            printf '     %s$%s choice %s[enter = recommended %s]%s %s→%s ' \
                "$OK" "$R" "$DIM" "$rec" "$R" "$ACCENT" "$R"
        } > /dev/tty
        read -r ans < /dev/tty || ans=""
        case "$ans" in
            1) alias=12b ;; 2) alias=e4b ;; 3) alias=e2b ;;
            "") alias="$rec" ;;
            *) printf '     %s✗%s unrecognized choice, using recommended model\n' "$DANGER" "$R" > /dev/tty; alias="$rec" ;;
        esac
    fi

    MODEL_REF="$(resolve_model "$alias")"
}

# "run voice (TTS) on the GPU? [y/N]". Defaults to CPU: both shipped engines are
# real-time there anyway, while the GPU copy holds ~2GB of VRAM the LLM would
# otherwise use for layer offload. Sets $TTS_DEVICE_CHOICE (cpu|cuda).
# Non-interactive knob: JUN_TTS_DEVICE=cpu|cuda (default cpu).
ask_tts_device() {
    local v
    if [ -n "${JUN_TTS_DEVICE:-}" ]; then
        case "$(printf '%s' "$JUN_TTS_DEVICE" | tr '[:upper:]' '[:lower:]')" in
            cuda|gpu|1|true|yes|y) TTS_DEVICE_CHOICE=cuda ;; *) TTS_DEVICE_CHOICE=cpu ;;
        esac
    elif [ "${JUN_YES:-}" = "1" ] || [ ! -r /dev/tty ]; then
        TTS_DEVICE_CHOICE=cpu
    else
        printf '     %s$%s run voice on the GPU? %s(~2GB VRAM, barely faster than CPU)%s %s[y/N]%s %s→%s ' \
            "$OK" "$R" "$DIM" "$R" "$DIM" "$R" "$ACCENT" "$R" > /dev/tty
        read -r v < /dev/tty || v=""
        case "$v" in y|Y|yes|YES) TTS_DEVICE_CHOICE=cuda ;; *) TTS_DEVICE_CHOICE=cpu ;; esac
    fi
}

# Opt-out consent: anonymized chats & usage stats train better versions of Jun.
# Sets $TELEMETRY (on|off). Non-interactive knob: JUN_TELEMETRY=on|off (default on).
ask_telemetry() {
    local v
    if [ -n "${JUN_TELEMETRY:-}" ]; then
        case "$(printf '%s' "$JUN_TELEMETRY" | tr '[:upper:]' '[:lower:]')" in
            off|0|false|no|n) TELEMETRY=off ;; *) TELEMETRY=on ;;
        esac
    elif [ "${JUN_YES:-}" = "1" ] || [ ! -r /dev/tty ]; then
        TELEMETRY=on
    else
        printf '     %s$%s share anonymized chats & usage stats to help train better versions of Jun? %s[Y/n]%s %s→%s ' \
            "$OK" "$R" "$DIM" "$R" "$ACCENT" "$R" > /dev/tty
        read -r v < /dev/tty || v=""
        case "$v" in n|N|no|NO) TELEMETRY=off ;; *) TELEMETRY=on ;; esac
    fi
}

configure() {
    local provider voice ans profiles

    step "configure"

    if [ -n "${JUN_PROVIDER:-}" ]; then
        provider="$(printf '%s' "$JUN_PROVIDER" | tr '[:upper:]' '[:lower:]')"
    elif [ "${JUN_YES:-}" = "1" ] || [ ! -r /dev/tty ]; then
        provider=ollama
    else
        {
            printf '\n     %sselect an AI provider%s\n' "$B" "$R"
            printf '       %s1%s  Ollama      %s-%s local, fully managed %s(default)%s\n' "$ACCENT" "$R" "$DIM" "$R" "$DIM" "$R"
            printf '       %s2%s  OpenRouter  %s-%s cloud API - needs an API key; chats leave this machine\n' "$ACCENT" "$R" "$DIM" "$R"
            printf '       %s3%s  llama.cpp   %s-%s local llama-server\n' "$ACCENT" "$R" "$DIM" "$R"
            printf '     %s$%s choice %s[enter = Ollama]%s %s→%s ' \
                "$OK" "$R" "$DIM" "$R" "$ACCENT" "$R"
        } > /dev/tty
        read -r ans < /dev/tty || ans=""
        case "$ans" in
            2) provider=openrouter ;; 3) provider=llamacpp ;;
            ""|1) provider=ollama ;;
            *) printf '     %s✗%s unrecognized choice, using Ollama\n' "$DANGER" "$R" > /dev/tty; provider=ollama ;;
        esac
    fi
    case "$provider" in
        ollama|openrouter|llamacpp) ;;
        *) printf '     %s✗%s unknown provider "%s", using Ollama\n' "$DANGER" "$R" "$provider" > /dev/tty 2>/dev/null || true
           provider=ollama ;;
    esac

    case "$provider" in
    ollama)
        ask_model_ref
        set_env OLLAMA_MODELS_TO_PULL "$MODEL_REF"
        profiles=ollama
        ok "model $MODEL_REF"
        ;;

    openrouter)
        local key orm
        key="${OPENROUTER_API_KEY:-}"
        if [ -z "$key" ] && [ "${JUN_YES:-}" != "1" ] && [ -r /dev/tty ]; then
            # Silent read: the key must never be echoed (or land in scrollback).
            printf '     %s$%s OpenRouter API key %s(hidden; from openrouter.ai/keys)%s %s→%s ' \
                "$OK" "$R" "$DIM" "$R" "$ACCENT" "$R" > /dev/tty
            read -rs key < /dev/tty || key=""
            printf '\n' > /dev/tty
        fi
        [ -z "$key" ] && warn_ "no API key set - add OPENROUTER_API_KEY to .env before chatting"

        orm="${OPENROUTER_MODEL:-}"
        if [ -z "$orm" ] && [ "${JUN_YES:-}" != "1" ] && [ -r /dev/tty ]; then
            printf '     %s$%s model id %s[enter = openrouter/auto]%s %s→%s ' \
                "$OK" "$R" "$DIM" "$R" "$ACCENT" "$R" > /dev/tty
            read -r orm < /dev/tty || orm=""
        fi
        orm="${orm:-openrouter/auto}"

        set_env OPENROUTER_API_KEY "$key"
        set_env OPENROUTER_MODEL "$orm"
        profiles=""
        ok "model $orm"
        ;;

    llamacpp)
        local url
        url="${LLAMACPP_URL:-}"
        if [ -z "$url" ] && [ "${JUN_YES:-}" != "1" ] && [ -r /dev/tty ]; then
            printf '     %s$%s llama-server URL %s[enter = managed setup]%s %s→%s ' \
                "$OK" "$R" "$DIM" "$R" "$ACCENT" "$R" > /dev/tty
            read -r url < /dev/tty || url=""
        fi
        if [ -n "$url" ]; then
            case "$url" in
                http://*|https://*) ;;
                *) printf '     %s✗%s not an http(s) URL, using managed setup\n' "$DANGER" "$R" > /dev/tty 2>/dev/null || true
                   url="" ;;
            esac
        fi
        if [ -n "$url" ]; then
            set_env LLAMACPP_URL "$url"
            profiles=""
            ok "llama-server $url"
        else
            ask_model_ref
            # llama-server -hf syntax has no hf.co/ prefix.
            set_env LLAMACPP_MODEL_HF "${MODEL_REF#hf.co/}"
            set_env LLAMACPP_URL "http://llamacpp:8080"
            profiles=llamacpp
            ok "model ${MODEL_REF#hf.co/}"
        fi
        ;;
    esac

    set_env AI_PROVIDER "$provider"
    set_env COMPOSE_PROFILES "$profiles"
    ok "provider $provider"

    if [ -n "${VOICE:-}" ]; then
        case "$(printf '%s' "$VOICE" | tr '[:upper:]' '[:lower:]')" in
            off|0|false|no) voice=off ;; *) voice=on ;;
        esac
    elif [ "${JUN_YES:-}" = "1" ] || [ ! -r /dev/tty ]; then
        voice=on
    else
        printf '     %s$%s enable voice %s(TTS)%s %s[Y/n]%s %s→%s ' \
            "$OK" "$R" "$DIM" "$R" "$DIM" "$R" "$ACCENT" "$R" > /dev/tty
        read -r v < /dev/tty || v=""
        case "$v" in n|N|no|NO) voice=off ;; *) voice=on ;; esac
    fi
    set_env VOICE "$voice"
    ok "voice $voice"

    if [ "$voice" = on ]; then
        ask_tts_device
        set_env TTS_DEVICE "$TTS_DEVICE_CHOICE"
        ok "tts device $TTS_DEVICE_CHOICE"
    fi

    ask_telemetry
    set_env TELEMETRY "$TELEMETRY"
    if [ "$TELEMETRY" = on ] && ! grep -qE '^TELEMETRY_INSTALL_ID=[0-9a-f]+' .env 2>/dev/null; then
        set_env TELEMETRY_INSTALL_ID "$(od -An -tx1 -N8 /dev/urandom | tr -d ' \n')"
    fi
    ok "telemetry $TELEMETRY"
}

pkg_manager() {
    if [ "$OS" = "Darwin" ]; then
        command -v brew >/dev/null 2>&1 && echo brew || echo none
        return
    fi
    # rpm-ostree hosts (including Bazzite) are immutable: layer packages into
    # the next deployment instead of trying to use a mutable package manager.
    for pm in rpm-ostree apt-get dnf yum pacman zypper; do
        if command -v "$pm" >/dev/null 2>&1; then echo "$pm"; return; fi
    done
    echo none
}

manual_url() {
    case "$1" in
        git) echo "https://git-scm.com/downloads" ;;
        python) echo "https://www.python.org/downloads/" ;;
        compose) echo "https://docs.docker.com/compose/install/" ;;
        docker)
            if [ "$OS" = "Darwin" ]; then echo "https://www.docker.com/products/docker-desktop/"
            else echo "https://docs.docker.com/engine/install/"; fi ;;
    esac
}

install_git() {
    case "$PM" in
        apt-get) $SUDO apt-get update && $SUDO apt-get install -y git ;;
        dnf)     $SUDO dnf install -y git ;;
        yum)     $SUDO yum install -y git ;;
        pacman)  $SUDO pacman -Sy --noconfirm git ;;
        zypper)  $SUDO zypper install -y git ;;
        brew)    brew install git ;;
    esac
}

install_docker() {
    case "$PM" in
        brew)
            if [ "$OS" = "Darwin" ]; then
                brew install --cask docker
            else
                brew install docker docker-compose docker-engine rootlesskit slirp4netns
            fi
            ;;
        *)    curl -fsSL https://get.docker.com | $SUDO sh ;; # official cross-distro script
    esac
}

install_compose() {
    case "$PM" in
        apt-get) $SUDO apt-get update && $SUDO apt-get install -y docker-compose-plugin ;;
        dnf|yum) $SUDO "$PM" install -y docker-compose-plugin ;;
        pacman)  $SUDO pacman -Sy --noconfirm docker-compose ;;
        zypper)  $SUDO zypper install -y docker-compose ;;
        brew)
            if [ "$OS" = "Darwin" ]; then
                brew install --cask docker
            else
                brew install docker-compose
            fi
            ;;
    esac
}

install_python() {
    case "$PM" in
        apt-get) $SUDO apt-get update && $SUDO apt-get install -y python3 python3-venv ;;
        dnf)     $SUDO dnf install -y python3 ;;
        yum)     $SUDO yum install -y python3 ;;
        pacman)  $SUDO pacman -Sy --noconfirm python ;;
        zypper)  $SUDO zypper install -y python3 ;;
        brew)    brew install python ;;
    esac
}

# rpm-ostree applies package changes to a new deployment, so install every
# missing dependency in one transaction and let the caller stop for a reboot.
install_ostree_deps() {
    local c packages=()
    for c in "$@"; do
        case "$c" in
            git)    packages+=(git) ;;
            docker) packages+=(moby-engine) ;;
            compose) packages+=(docker-compose) ;;
            python) packages+=(python3) ;;
        esac
    done
    $SUDO rpm-ostree install "${packages[@]}"
}

python_command() {
    local candidate
    for candidate in python3 python; do
        if command -v "$candidate" >/dev/null 2>&1 \
            && "$candidate" -c 'import ensurepip, sys, venv; assert sys.version_info >= (3, 9)' >/dev/null 2>&1; then
            command -v "$candidate"
            return 0
        fi
    done
    return 1
}

ensure_recovery_python() {
    python_command >/dev/null && return 0

    PM="$(pkg_manager)"
    if [ "$PM" = none ]; then
        warn_ "Python 3.9+ is needed for asset recovery - install it from $(manual_url python), then re-run."
        return 1
    fi
    if [ "$PM" != brew ] && [ "$SUDO" = "" ] && [ "$(id -u)" -ne 0 ]; then
        warn_ "installing Python needs root, and sudo isn't available."
        return 1
    fi

    local proceed=0 answer=""
    if [ "${JUN_YES:-}" = "1" ]; then
        proceed=1
    elif [ -r /dev/tty ]; then
        printf '     %s$%s install Python 3 for asset recovery with %s%s%s? %s[y/N]%s %sâ†’%s ' \
            "$OK" "$R" "$B" "$PM" "$R" "$DIM" "$R" "$ACCENT" "$R" > /dev/tty
        read -r answer < /dev/tty || answer=""
        case "$answer" in y|Y|yes|YES) proceed=1 ;; esac
    fi
    if [ "$proceed" != 1 ]; then
        warn_ "Python installation declined - asset recovery was skipped."
        return 1
    fi

    if [ "$PM" != brew ] && [ -n "$SUDO" ]; then
        note "sudo authentication"
        $SUDO -v
    fi
    if [ "$PM" = "rpm-ostree" ]; then
        note "immutable system detected - layering Python for the next boot"
        run "layer Python" install_ostree_deps python
        warn_ "Python was layered - reboot, then re-run this installer with JUN_EXTRACT=1."
        return 1
    fi

    run "install Python" install_python
    if ! python_command >/dev/null; then
        warn_ "Python 3.9+ is still unavailable - re-run after installation finishes."
        return 1
    fi
}

install_asset_recovery() {
    local python venv recovery_python args=(tools/recover_assets.py)
    ensure_recovery_python || return 1
    python="$(python_command)"
    venv="runtime/asset-recovery-venv"
    recovery_python="$venv/bin/python"

    if [ ! -x "$recovery_python" ]; then
        note "setting up the local asset-recovery environment"
        "$python" -m venv "$venv" || {
            warn_ "could not create the asset-recovery virtual environment."
            return 1
        }
    fi
    run "install UnityPy + Pillow" "$recovery_python" -m pip install --disable-pip-version-check --quiet UnityPy Pillow
    [ -n "${JUN_GAME_DIR:-}" ] && args+=(--game "$JUN_GAME_DIR")
    if "$recovery_python" "${args[@]}"; then
        ok "assets extracted to webapp/assets (local use only)"
        return 0
    fi

    # A supplied path is deliberate, and non-interactive installs must never
    # wait for input. Only offer the friendly fallback after auto-discovery.
    if [ -n "${JUN_GAME_DIR:-}" ] || [ "${JUN_YES:-}" = "1" ] || [ ! -r /dev/tty ]; then
        warn_ "extraction failed - set JUN_GAME_DIR to the game folder, then re-run with JUN_EXTRACT=1."
        return 1
    fi

    warn_ "couldn't find the game in its usual locations."
    local selection game_dir data_dir
    while :; do
        printf '     %s$%s paste the game folder or drag the game executable here %s[Enter = skip]%s %s→%s ' \
            "$OK" "$R" "$DIM" "$R" "$ACCENT" "$R" > /dev/tty
        read -r selection < /dev/tty || selection=""
        selection="${selection%$'\r'}"
        # Drag-and-drop paths may be wrapped in shell quotes.
        selection="${selection#\"}"
        selection="${selection%\"}"
        selection="${selection#\'}"
        selection="${selection%\'}"
        if [ -z "$selection" ]; then
            note "asset extraction skipped."
            return 1
        fi

        if [ -d "$selection" ]; then
            game_dir="$selection"
        elif [ -f "$selection" ]; then
            game_dir="$(dirname "$selection")"
        else
            warn_ "path not found: $selection"
            continue
        fi
        data_dir="$game_dir/My Dystopian Robot Girlfriend_Data"
        if [ ! -d "$data_dir" ]; then
            warn_ "that location does not contain My Dystopian Robot Girlfriend_Data"
            continue
        fi

        if "$recovery_python" tools/recover_assets.py --game "$game_dir"; then
            ok "assets extracted to webapp/assets (local use only)"
            return 0
        fi
        warn_ "extraction failed from that location. Try another path or press Enter to skip."
    done

    return 1
}

# Homebrew's Linux Docker engine is rootless. Its Compose plugin lives outside
# Docker's default plugin directory, so expose it after Homebrew installs it.
configure_brew_docker() {
    local plugin
    dockerd-rootless-setuptool.sh install
    plugin="$(brew --prefix docker-compose)/lib/docker/cli-plugins/docker-compose"
    mkdir -p "$HOME/.docker/cli-plugins"
    ln -sf "$plugin" "$HOME/.docker/cli-plugins/docker-compose"
}

prepare_docker() {
    if [ "$OS" = "Darwin" ]; then
        ok "launching Docker Desktop"
        open -a Docker 2>/dev/null || true
        return
    fi
    if [ "$PM" = "brew" ]; then
        ok "using rootless Docker"
        return
    fi
    ok "starting the Docker daemon"
    if command -v systemctl >/dev/null 2>&1; then
        $SUDO systemctl enable --now docker 2>/dev/null || true
    elif command -v service >/dev/null 2>&1; then
        $SUDO service docker start 2>/dev/null || true
    fi
    local me; me="$(id -un)"
    if [ "$(id -u)" -ne 0 ] && ! id -nG "$me" 2>/dev/null | tr ' ' '\n' | grep -qx docker; then
        $SUDO usermod -aG docker "$me" 2>/dev/null || true
        command -v sg >/dev/null 2>&1 && NEED_SG=1
    fi
}

docker_run() {
    if [ "$NEED_SG" = 1 ]; then sg docker -c "$*"; else "$@"; fi
}

# Rootless Docker (Bazzite/Fedora Atomic, brew) can't bind :80 - RootlessKit
# refuses privileged ports unless the host lowers ip_unprivileged_port_start.
# The rootless netns inherits the value at creation, hence the daemon restart.
allow_privileged_ports() {
    docker_run docker info -f '{{.SecurityOptions}}' 2>/dev/null | grep -q rootless || return 0
    local start
    start="$(sysctl -n net.ipv4.ip_unprivileged_port_start 2>/dev/null || echo 1024)"
    [ "$start" -le 80 ] && return 0
    note "rootless Docker needs unprivileged ports to start at 80 (for the web UI)"
    if printf 'net.ipv4.ip_unprivileged_port_start=80\n' \
            | $SUDO tee /etc/sysctl.d/99-jun-unprivileged-ports.conf >/dev/null 2>&1 \
        && $SUDO sysctl -q net.ipv4.ip_unprivileged_port_start=80; then
        systemctl --user restart docker 2>/dev/null || true
        ok "allowed rootless Docker to bind port 80"
    else
        warn_ "couldn't lower net.ipv4.ip_unprivileged_port_start - port 80 will fail."
        note "fix manually: sudo sysctl net.ipv4.ip_unprivileged_port_start=80"
    fi
}

wait_for_docker() {
    printf '     %s…%s waiting for Docker to be ready' "$DIM" "$R"
    local i=0
    while [ "$i" -lt 45 ]; do
        if docker_run docker info >/dev/null 2>&1; then printf ' %sready%s\n' "$OK" "$R"; return 0; fi
        printf '%s.%s' "$DIM" "$R"; sleep 2; i=$((i + 1))
    done
    printf ' %stimeout%s\n' "$WARN" "$R"
    return 1
}

confirm_deps() {
    local missing=()
    command -v git >/dev/null 2>&1 || missing+=(git)
    command -v docker >/dev/null 2>&1 || missing+=(docker)
    docker compose version >/dev/null 2>&1 || missing+=(compose)
    step "check dependencies"
    [ ${#missing[@]} -eq 0 ] && { ok "git, Docker + Compose present"; return; }

    warn_ "missing: ${missing[*]}"

    PM="$(pkg_manager)"
    if [ "$PM" = none ]; then
        fail_ "no supported package manager - install manually and re-run:"
        for c in "${missing[@]}"; do printf '       %s%-7s%s %s%s%s\n' "$ACCENT" "$c" "$R" "$DIM" "$(manual_url "$c")" "$R" >&2; done
        exit 1
    fi

    # curl | bash leaves stdin pointing at the pipe, so prompt on /dev/tty.
    local proceed=0
    if [ "${JUN_YES:-}" = "1" ]; then
        proceed=1
    elif [ -r /dev/tty ]; then
        if [ "$PM" = "rpm-ostree" ]; then
            printf '     %s$%s layer %s with %s%s%s? %s[Y/n]%s %s→%s ' \
                "$OK" "$R" "${missing[*]}" "$B" "$PM" "$R" "$DIM" "$R" "$ACCENT" "$R" > /dev/tty
        else
            printf '     %s$%s install %s with %s%s%s? %s[y/N]%s %s→%s ' \
                "$OK" "$R" "${missing[*]}" "$B" "$PM" "$R" "$DIM" "$R" "$ACCENT" "$R" > /dev/tty
        fi
        read -r answer < /dev/tty || answer=""
        case "$answer" in
            y | Y | yes | YES | "")
                [ "$PM" = "rpm-ostree" ] && proceed=1
                [ "$PM" != "rpm-ostree" ] && { case "$answer" in y | Y | yes | YES) proceed=1 ;; esac; }
                ;;
            *)
                if [ "$PM" = "rpm-ostree" ] && command -v brew >/dev/null 2>&1; then
                    PM=brew
                    proceed=1
                    note "rpm-ostree declined - using Homebrew instead"
                fi
                ;;
        esac
    else
        fail_ "re-run in an interactive terminal (or set JUN_YES=1) to install them."
        exit 1
    fi
    [ "$proceed" = 1 ] || { note "okay, leaving it to you - install the tools above and re-run."; exit 1; }

    if [ "$PM" != brew ] && [ "$SUDO" = "" ] && [ "$(id -u)" -ne 0 ]; then
        fail_ "installing packages needs root, and sudo isn't available."
        exit 1
    fi

    # Authenticate sudo up front: installs run output-hidden, and a password
    # prompt buried behind the spinner would just hang.
    [ -n "$SUDO" ] && [ "$PM" != brew ] && { note "sudo authentication"; $SUDO -v; }

    # Bazzite and other rpm-ostree systems cannot use newly layered packages
    # until after booting into the deployment created by rpm-ostree.
    if [ "$PM" = "rpm-ostree" ]; then
        note "immutable system detected - layering ${missing[*]} for the next boot"
        run "layer ${missing[*]}" install_ostree_deps "${missing[@]}"
        ok "packages layered - reboot, then re-run this installer"
        exit 0
    fi

    for c in "${missing[@]}"; do
        case "$c" in
            git)    run "install git" install_git ;;
            docker) run "install docker" install_docker; DOCKER_JUST_INSTALLED=1 ;;
            compose) run "install Docker Compose" install_compose ;;
        esac
    done

    if ! docker compose version >/dev/null 2>&1; then
        fail_ "Docker Compose is still unavailable - install it from $(manual_url compose), then re-run."
        exit 1
    fi

    if [ "$DOCKER_JUST_INSTALLED" = 1 ]; then
        if [ "$PM" = "brew" ] && [ "$OS" != "Darwin" ]; then
            run "configure rootless Docker" configure_brew_docker
            export DOCKER_HOST="${DOCKER_HOST:-unix://${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/docker.sock}"
        fi
        prepare_docker
    fi
}

# First choice a non-technical user sees: Express runs the whole install with
# detected defaults and asks nothing further (identical to JUN_YES=1); Custom
# walks the provider/model/voice prompts. JUN_EXPRESS=1 selects Express up front.
choose_install_mode() {
    [ "${JUN_YES:-}" = "1" ] && return
    case "$(printf '%s' "${JUN_EXPRESS:-}" | tr '[:upper:]' '[:lower:]')" in
        1|on|yes|true) JUN_YES=1; export JUN_YES; return ;;
    esac
    # A readable /dev/tty node can still fail to open with no controlling
    # terminal, so probe an actual open rather than trusting the mode bits.
    { true >/dev/tty; } 2>/dev/null || return 0
    local ans
    {
        printf '\n     %show should I install?%s\n' "$B" "$R"
        printf '       %s1%s  Express  %s-%s everything with recommended settings %s(default)%s\n' "$ACCENT" "$R" "$DIM" "$R" "$DIM" "$R"
        printf '       %s2%s  Custom   %s-%s pick the provider, model, voice, and more\n' "$ACCENT" "$R" "$DIM" "$R"
        printf '     %s$%s choice %s[enter = Express]%s %s→%s ' "$OK" "$R" "$DIM" "$R" "$ACCENT" "$R"
    } > /dev/tty
    read -r ans < /dev/tty || ans=""
    case "$ans" in
        2|custom|Custom|CUSTOM) note "custom install - I'll ask about each option below" ;;
        *) JUN_YES=1; export JUN_YES; ok "express install - using recommended settings" ;;
    esac
}

banner
choose_install_mode
confirm_deps

if [ -d "$DIR/.git" ]; then
    step "update repository"
    run "$DIR up to date" git -C "$DIR" pull --ff-only
else
    step "clone repository"
    run "$REPO ($REF)" git clone --depth 1 --branch "$REF" "$REPO" "$DIR"
fi

cd "$DIR"
[ -f .env ] || cp .env.example .env

configure

step "asset policy"
warn_ "Jun's Live2D model & textures belong to the creator of"
warn_ "My Dystopian Robot Girlfriend. tools/recover_assets.py rebuilds"
warn_ "them from YOUR game copy, for personal use only - do NOT"
warn_ "republish them (public fork, release, mirror). See NOTICE in LICENSE."

# Opt-in extraction of the Live2D assets from the user's own game install.
# Never runs unless explicitly requested: answer y here, or JUN_EXTRACT=1
# when non-interactive. Without it the webapp uses placeholder assets.
extract=0
case "$(printf '%s' "${JUN_EXTRACT:-}" | tr '[:upper:]' '[:lower:]')" in
    1|on|yes|true) extract=1 ;;
    0|off|no|false) extract=0 ;;
    *)
        if [ -r /dev/tty ] && [ "${JUN_YES:-}" != "1" ]; then
            printf '     %s$%s extract them now from your game install? %s[y/N]%s %s→%s ' \
                "$OK" "$R" "$DIM" "$R" "$ACCENT" "$R" > /dev/tty
            read -r e < /dev/tty || e=""
            case "$e" in y|Y|yes|YES) extract=1 ;; esac
        fi
        ;;
esac
if [ "$extract" = 1 ]; then
    install_asset_recovery || true
else
    note "skipped - re-run this installer with JUN_EXTRACT=1 anytime to extract."
fi

[ "$DOCKER_JUST_INSTALLED" = 1 ] && wait_for_docker || true

if docker_run docker info >/dev/null 2>&1; then
    step "boot stack"
    allow_privileged_ports
    run_live "build & start containers" docker_run ./start.sh
    if docker_run docker ps --format '{{.Names}}' | grep -qx omega-ollama; then
        note "model pull (first run can take a while):"
        # `logs -f` never exits on its own; awk bails once the entrypoint
        # reports the pull/pre-warm outcome and SIGPIPE reaps the follow.
        docker_run docker logs -f omega-ollama 2>&1 \
            | awk '{ print "       " $0; fflush() } /pre-warm (done|failed)|pull failed/ { exit }' || true
        ok "models ready"
    fi
    printf '\n   %s$%s %s%sready%s %s-%s open %shttp://localhost%s\n' \
        "$OK" "$R" "$B" "$OK" "$R" "$DIM" "$R" "$B$ACCENT" "$R"
    printf '   %sstop:%s ./start.sh stop   %s·%s   %sstatus:%s ./start.sh status\n\n' \
        "$DIM" "$R" "$DIM" "$R" "$DIM" "$R"
else
    printf '\n'
    warn_ "Docker isn't reachable yet - finish its setup and run ./start.sh from $DIR."
    if [ "$OS" != "Darwin" ]; then
        note "you may also need to log out and back in for the 'docker' group to apply."
    fi
    exit 0
fi
