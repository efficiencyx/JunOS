#!/usr/bin/env bash
#
# Uninstaller for the Docker install (Linux, macOS, WSL). Everything
# Jun created lives either in this folder or in Docker under the
# `omega` compose project, so removal is:
#   1. stop and remove the containers (docker compose down)
#   2. optionally delete the Docker volumes (accounts, chats,
#      settings, downloaded model weights) and images. The state
#      volume is saved to ~/jun-backup-<date>.tar.gz first.
#   3. delete this folder
#
# Docker itself, git and Python are left alone - they're
# general-purpose tools you may use elsewhere. So is your docker
# group membership. Remove them with your package manager if you
# want.
#
#   ./uninstall.sh          # interactive
#   ./uninstall.sh -y       # no prompts
#     Stops the stack, deletes the Docker data and this folder.
#
# Add `sudo` in front if you said no to the docker group at install.

set -euo pipefail
cd "$(dirname "$0")"
root="$(pwd)"

yes=0
case "${1:-}" in -y|--yes) yes=1 ;; esac

confirm() {
    [ "$yes" -eq 1 ] && return 0
    local a
    read -r -p "$1 [y/N] " a
    [[ "$a" =~ ^([yY]|yes)$ ]]
}

echo "This removes Jun from: $root"
echo "Chat history, settings and downloaded models are in Docker volumes and go only if you say so below."
confirm 'Continue?' || { echo 'Aborted, nothing touched.'; exit 0; }

if command -v docker >/dev/null 2>&1 && [ -f docker-compose.yml ]; then
    if ! docker info >/dev/null 2>&1; then
        echo 'docker is not reachable. Start it, or run this with sudo.' >&2
        exit 1
    fi
    # --remove-orphans also takes containers from compose profiles
    # that are off in .env right now (voice, karaoke, llamacpp).
    docker compose -f docker-compose.yml down --remove-orphans
    down=()
    if confirm 'Also delete the Docker volumes (every account, every chat, the model weights)?'; then
        # Accounts, chats and memory notes are small, so they get a
        # tarball before the volume goes. Model weights do not, they
        # are re-downloaded on a reinstall. Taken with the stack
        # already down so sqlite is not mid-write.
        backup="${HOME:-/tmp}/jun-backup-$(date +%Y%m%d-%H%M%S).tar.gz"
        docker run --rm -v omega_omega_state:/state:ro alpine tar czf - -C /state . > "$backup"
        echo "Saved accounts, chats and memory to $backup"
        down+=(-v)
    fi
    if confirm 'Also remove the Docker images (re-downloaded on a reinstall)?'; then
        down+=(--rmi all)
    fi
    [ "${#down[@]}" -eq 0 ] || docker compose -f docker-compose.yml down "${down[@]}"
fi

# From outside the folder, since this script lives inside it.
cd "${HOME:-/}"
rm -rf "$root"
echo "Removed $root. Jun is uninstalled."
echo 'Left in place: Docker, git and any Python installed for asset recovery - remove with your package manager if unwanted.'
