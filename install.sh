#!/usr/bin/env bash
#
# Bootstrap installer. Clones Jun OS (if not already present), prepares .env,
# and launches it via start.sh — which autodetects your GPU.
#
#   curl -fsSL https://raw.githubusercontent.com/efficiencyx/JunOS/main/install.sh | bash
#
# Overrides: JUN_REPO (git url), JUN_DIR (target dir), JUN_REF (branch/tag).
# Prefer to read before you run? That's the right instinct — open the file
# first, then clone the repo and run ./start.sh yourself.

set -euo pipefail

REPO="${JUN_REPO:-https://github.com/efficiencyx/JunOS.git}"
DIR="${JUN_DIR:-JunOS}"
REF="${JUN_REF:-main}"

need() {
    command -v "$1" >/dev/null 2>&1 || {
        echo "error: '$1' is required but not installed." >&2
        exit 1
    }
}

need git
need docker

if [ -d "$DIR/.git" ]; then
    echo "==> $DIR already cloned, pulling latest"
    git -C "$DIR" pull --ff-only
else
    echo "==> Cloning $REPO ($REF) into $DIR"
    git clone --depth 1 --branch "$REF" "$REPO" "$DIR"
fi

cd "$DIR"
[ -f .env ] || cp .env.example .env

echo "==> Starting"
exec ./start.sh
