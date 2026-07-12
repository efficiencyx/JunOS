#!/usr/bin/env bash
#
# Bootstrap installer. Clones Jun OS (if not already present), prepares .env,
# and launches it via start.sh - which autodetects your GPU.
#
#   curl -fsSL https://raw.githubusercontent.com/efficiencyx/Jun/main/install.sh | bash
#
# On a fresh machine it checks for git + Docker, offers to install them with
# your package manager, then starts the daemon and continues automatically.
#
# Interactive in a terminal: it asks which model to pull (auto-detecting a
# sensible default from your VRAM) and whether to enable voice. Piped or with
# JUN_YES=1 it stays one-command, defaulting to the 12B model + voice on.
# Override either non-interactively: JUN_MODEL=12b|e4b|e2b|<full-ref> VOICE=on|off.
#
# Overrides: JUN_REPO, JUN_DIR, JUN_REF. Set JUN_YES=1 to skip prompts.
# Prefer to read before you run? That's the right instinct - open the file
# first, then clone the repo and run ./start.sh yourself.

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

# ── UI ───────────────────────────────────────────────────────────────────────
# Mirrors the webapp's terminal-styled auth/boot screen (styles.css palette):
# Ω/JUN OS header in a window frame, green `$` field markers, `→` actions,
# `✓ OK` step badges, `✗` errors. Truecolor when stdout is a TTY; plain text
# when piped/redirected or NO_COLOR is set.
if [ -t 1 ] && [ -z "${NO_COLOR:-}" ] && [ "${TERM:-}" != "dumb" ]; then
    R=$'\033[0m'; B=$'\033[1m'; D=$'\033[2m'
    ACCENT=$'\033[38;2;124;158;255m'    # --accent  #7c9eff
    PURPLE=$'\033[38;2;155;114;203m'    # --grad mid #9b72cb
    OK=$'\033[38;2;123;216;143m'        # --ok      #7bd88f
    DANGER=$'\033[38;2;255;138;138m'    # --danger  #ff8a8a
    WARN=$'\033[38;2;255;200;112m'      # --warn    #ffc870
    DIM=$'\033[38;2;142;146;149m'       # --dim     #8e9295
    MUTED=$'\033[38;2;196;199;197m'     # --muted   #c4c7c5
else
    R=; B=; D=; ACCENT=; PURPLE=; OK=; DANGER=; WARN=; DIM=; MUTED=
fi

UI_W=52   # interior width of the window frame

# A horizontal rule of box chars, padded to UI_W.
_rule() { local n=$UI_W out=; while [ "$n" -gt 0 ]; do out="$out$1"; n=$((n-1)); done; printf '%s' "$out"; }

banner() {
    local os_name="Linux"; [ "$OS" = "Darwin" ] && os_name="macOS"
    printf '\n'
    printf '  %s┌%s┐%s\n' "$DIM" "$(_rule ─)" "$R"
    # The title row's visible glyphs (dots + "jun@omega: ~/install") span 29
    # columns; pad the rest so the right border lines up with the rules.
    printf '  %s│%s %s●%s %s●%s %s●%s   %sjun@omega%s:%s ~/install%s%*s%s│%s\n' \
        "$DIM" "$R" "$DANGER" "$R" "$WARN" "$R" "$OK" "$R" \
        "$ACCENT" "$R" "$MUTED" "$R" $((UI_W-29)) "" "$DIM" "$R"
    printf '  %s└%s┘%s\n\n' "$DIM" "$(_rule ─)" "$R"
    printf '   %s%sΩ%s  %s%sJUN OS%s\n\n' "$B" "$PURPLE" "$R" "$B" "$ACCENT" "$R"
    printf '   %sWelcome to Jun OS%s %s·%s %somega build%s\n' "$MUTED" "$R" "$DIM" "$R" "$DIM" "$R"
    printf '   %sshell detected:%s %s%s%s %s-%s installer\n\n' "$DIM" "$R" "$B$ACCENT" "$os_name" "$R" "$DIM" "$R"
}

# Section header - the green `$` shell prompt from the auth screen.
step()  { printf '   %s$%s %s%s%s\n' "$OK" "$R" "$B" "$1" "$R"; }
ok()    { printf '     %s✓%s %s%s%s\n' "$OK" "$R" "$MUTED" "$1" "$R"; }
note()  { printf '     %s%s%s\n' "$DIM" "$1" "$R"; }
warn_() { printf '   %s!%s %s%s%s\n' "$WARN" "$R" "$WARN" "$1" "$R" >&2; }
fail_()  { printf '   %s✗%s %s%s%s\n' "$DANGER" "$R" "$DANGER" "$1" "$R" >&2; }

# Animate a working line next to $pid until it exits, then clear the line.
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

# ── Model catalog ────────────────────────────────────────────────────────────
# Short aliases the menu and JUN_MODEL accept; anything else is taken verbatim
# as an explicit Ollama ref.
MODEL_12B="hf.co/efficiencyx/Jun-Lora-v2-GGUF:Q4_K_M"
MODEL_E4B="hf.co/efficiencyx/Jun-LoRA-V3-E4B-GGUF:Q4_K_M"
MODEL_E2B="hf.co/efficiencyx/Jun-LoRA-v3-E2B-GGUF:Q4_K_M"

resolve_model() {  # alias|full-ref -> full-ref
    case "$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')" in
        12b|jun|best|"") echo "$MODEL_12B" ;;
        e4b|balanced|fast) echo "$MODEL_E4B" ;;
        e2b|fastest|cpu) echo "$MODEL_E2B" ;;
        *)               echo "$1" ;;
    esac
}

# Best-effort total VRAM in MB (empty when no GPU / no tool to ask).
detect_vram_mb() {
    if command -v nvidia-smi >/dev/null 2>&1; then
        nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits 2>/dev/null \
            | head -n1 | tr -dc '0-9'
    elif command -v rocm-smi >/dev/null 2>&1; then
        # rocm-smi reports VRAM total in bytes; collapse to MB.
        rocm-smi --showmeminfo vram 2>/dev/null \
            | grep -i 'total' | grep -oE '[0-9]+' | head -n1 \
            | awk '{ if ($1 > 0) print int($1 / 1048576) }'
    fi
}

# Map detected VRAM to the conservative quant at each recommended tier.
# Unknown/none -> CPU-friendly E2B Q4_K_M.
recommend_model() {
    local mb="$1"
    [ -z "$mb" ] && { echo "$MODEL_E2B"; return; }
    if   [ "$mb" -ge 15500 ]; then echo "hf.co/efficiencyx/Jun-Lora-v2-GGUF:Q6_K"
    elif [ "$mb" -ge 11500 ]; then echo "hf.co/efficiencyx/Jun-LoRA-V3-E4B-GGUF:Q8_0"
    elif [ "$mb" -ge 9500 ]; then echo "hf.co/efficiencyx/Jun-LoRA-V3-E4B-GGUF:Q6_K"
    elif [ "$mb" -ge 7500 ]; then echo "$MODEL_E4B"
    elif [ "$mb" -ge 5500 ]; then echo "hf.co/efficiencyx/Jun-LoRA-v3-E2B-GGUF:Q6_K"
    else                               echo "$MODEL_E2B"
    fi
}

# Set or replace KEY=VALUE in ./.env (run from inside the repo).
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

# Ask which model + whether voice, then persist both into .env. Non-interactive
# (piped, JUN_YES=1, or per-field env override) keeps the one-command flow.
configure() {
    local vram rec alias voice
    vram="$(detect_vram_mb)"
    rec="$(recommend_model "$vram")"

    step "configure"

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

    local ref; ref="$(resolve_model "$alias")"
    set_env OLLAMA_MODELS_TO_PULL "${ref},nomic-embed-text"
    set_env VOICE "$voice"
    ok "model $ref"
    ok "voice $voice"
}

pkg_manager() {
    if [ "$OS" = "Darwin" ]; then
        command -v brew >/dev/null 2>&1 && echo brew || echo none
        return
    fi
    for pm in apt-get dnf yum pacman zypper; do
        if command -v "$pm" >/dev/null 2>&1; then echo "$pm"; return; fi
    done
    echo none
}

manual_url() {
    case "$1" in
        git) echo "https://git-scm.com/downloads" ;;
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
    if [ "$OS" = "Darwin" ]; then
        brew install --cask docker
    else
        curl -fsSL https://get.docker.com | $SUDO sh   # official cross-distro script
    fi
}

# Bring the daemon up and grant the current user docker access without a logout.
prepare_docker() {
    if [ "$OS" = "Darwin" ]; then
        ok "launching Docker Desktop"
        open -a Docker 2>/dev/null || true
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

# Run a command, joining the docker group if we just added the user to it.
docker_run() {
    if [ "$NEED_SG" = 1 ]; then sg docker -c "$*"; else "$@"; fi
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
    step "check dependencies"
    [ ${#missing[@]} -eq 0 ] && { ok "git, docker present"; return; }

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
        printf '     %s$%s install %s with %s%s%s? %s[y/N]%s %s→%s ' \
            "$OK" "$R" "${missing[*]}" "$B" "$PM" "$R" "$DIM" "$R" "$ACCENT" "$R" > /dev/tty
        read -r answer < /dev/tty || answer=""
        case "$answer" in y | Y | yes | YES) proceed=1 ;; esac
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
    [ -n "$SUDO" ] && { note "sudo authentication"; $SUDO -v; }

    for c in "${missing[@]}"; do
        case "$c" in
            git)    run "install git" install_git ;;
            docker) run "install docker" install_docker; DOCKER_JUST_INSTALLED=1 ;;
        esac
    done

    [ "$DOCKER_JUST_INSTALLED" = 1 ] && prepare_docker
}

banner
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

[ "$DOCKER_JUST_INSTALLED" = 1 ] && wait_for_docker || true

if docker_run docker info >/dev/null 2>&1; then
    step "boot stack"
    run "build & start containers (first run pulls models, can take a while)" docker_run ./start.sh
    printf '\n   %s$%s %s%sready%s %s-%s open %shttp://localhost%s\n\n' \
        "$OK" "$R" "$B" "$OK" "$R" "$DIM" "$R" "$B$ACCENT" "$R"
else
    printf '\n'
    warn_ "Docker isn't reachable yet - finish its setup and run ./start.sh from $DIR."
    if [ "$OS" != "Darwin" ]; then
        note "you may also need to log out and back in for the 'docker' group to apply."
    fi
    exit 0
fi
