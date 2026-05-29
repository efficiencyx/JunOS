#!/usr/bin/env bash
#
# Bootstrap installer. Clones Jun OS (if not already present), prepares .env,
# and launches it via start.sh — which autodetects your GPU.
#
#   curl -fsSL https://raw.githubusercontent.com/efficiencyx/Jun/main/install.sh | bash
#
# On a fresh machine it checks for git + Docker, offers to install them with
# your package manager, then starts the daemon and continues automatically.
# Overrides: JUN_REPO, JUN_DIR, JUN_REF. Set JUN_YES=1 to skip the prompt.
# Prefer to read before you run? That's the right instinct — open the file
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
        echo "==> Launching Docker Desktop"
        open -a Docker 2>/dev/null || true
        return
    fi
    echo "==> Starting the Docker daemon"
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
    printf '==> Waiting for Docker to be ready'
    local i=0
    while [ "$i" -lt 45 ]; do
        if docker_run docker info >/dev/null 2>&1; then printf ' ready\n'; return 0; fi
        printf '.'; sleep 2; i=$((i + 1))
    done
    printf ' timeout\n'
    return 1
}

confirm_deps() {
    local missing=()
    command -v git >/dev/null 2>&1 || missing+=(git)
    command -v docker >/dev/null 2>&1 || missing+=(docker)
    [ ${#missing[@]} -eq 0 ] && return

    echo ""
    echo "These required tools aren't installed: ${missing[*]}" >&2

    PM="$(pkg_manager)"
    if [ "$PM" = none ]; then
        echo "No supported package manager found — install them manually and re-run:" >&2
        for c in "${missing[@]}"; do printf '  %-7s %s\n' "$c" "$(manual_url "$c")" >&2; done
        exit 1
    fi

    # curl | bash leaves stdin pointing at the pipe, so prompt on /dev/tty.
    local proceed=0
    if [ "${JUN_YES:-}" = "1" ]; then
        proceed=1
    elif [ -r /dev/tty ]; then
        printf 'Install %s now with %s? [y/N] ' "${missing[*]}" "$PM" > /dev/tty
        read -r answer < /dev/tty || answer=""
        case "$answer" in y | Y | yes | YES) proceed=1 ;; esac
    else
        echo "Re-run in an interactive terminal (or set JUN_YES=1) to install them." >&2
        exit 1
    fi
    [ "$proceed" = 1 ] || { echo "Okay, leaving it to you. Install the tools above and re-run."; exit 1; }

    if [ "$PM" != brew ] && [ "$SUDO" = "" ] && [ "$(id -u)" -ne 0 ]; then
        echo "error: installing packages needs root, and sudo isn't available." >&2
        exit 1
    fi

    for c in "${missing[@]}"; do
        echo "==> Installing $c"
        case "$c" in
            git)    install_git ;;
            docker) install_docker; DOCKER_JUST_INSTALLED=1 ;;
        esac
    done

    [ "$DOCKER_JUST_INSTALLED" = 1 ] && prepare_docker
}

confirm_deps

if [ -d "$DIR/.git" ]; then
    echo "==> $DIR already cloned, pulling latest"
    git -C "$DIR" pull --ff-only
else
    echo "==> Cloning $REPO ($REF) into $DIR"
    git clone --depth 1 --branch "$REF" "$REPO" "$DIR"
fi

cd "$DIR"
[ -f .env ] || cp .env.example .env

[ "$DOCKER_JUST_INSTALLED" = 1 ] && wait_for_docker || true

if docker_run docker info >/dev/null 2>&1; then
    echo "==> Starting"
    docker_run ./start.sh
else
    echo ""
    echo "Docker isn't reachable yet — finish its setup and run ./start.sh from $DIR."
    if [ "$OS" != "Darwin" ]; then
        echo "(You may also need to log out and back in for the 'docker' group to apply.)"
    fi
    exit 0
fi
