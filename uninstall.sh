#!/usr/bin/env bash
#
# Uninstaller for the Docker install (Linux, macOS, WSL). Everything
# Jun created lives either in this folder or in Docker under the
# `omega` compose project, so removal is:
#   1. stop and remove the containers (docker compose down)
#   2. optionally delete the Docker volumes (accounts, chats,
#      settings, downloaded model weights) and images. The state
#      volume is saved to ~/jun-backup-<date>.tar.gz first.
#   3. undo the system changes install.sh recorded in
#      .install-changes: removing you from the docker group if the
#      installer added you, and restoring
#      net.ipv4.ip_unprivileged_port_start if it lowered it for
#      rootless Docker
#   4. delete this folder
#
# Docker itself, git and Python are left alone, since they're
# general-purpose tools you may use elsewhere. Remove them with your
# package manager if you want. Installs from before .install-changes
# existed have nothing recorded; undo those by hand:
#   sudo gpasswd -d "$USER" docker
#   sudo rm /etc/sysctl.d/99-jun-unprivileged-ports.conf
#   sudo sysctl net.ipv4.ip_unprivileged_port_start=1024
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

if [ "$(id -u)" -eq 0 ]; then
    SUDO=""
elif command -v sudo >/dev/null 2>&1; then
    SUDO="sudo"
else
    SUDO=""
fi

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

recorded() {
    sed -n "s/^$1=//p" .install-changes 2>/dev/null | head -n 1
}

group_user="$(recorded docker_group)"
if [ -n "$group_user" ] && confirm "Remove $group_user from the docker group (the installer added it)?"; then
    if $SUDO gpasswd -d "$group_user" docker >/dev/null; then
        echo "Removed $group_user from the docker group. It takes effect at the next login."
    else
        echo "Could not remove $group_user from the docker group. Run: sudo gpasswd -d $group_user docker" >&2
    fi
fi

port_start="$(recorded unprivileged_port_start)"
if [ -n "$port_start" ] && confirm "Restore net.ipv4.ip_unprivileged_port_start to $port_start (the installer lowered it to 80)?"; then
    if $SUDO rm -f /etc/sysctl.d/99-jun-unprivileged-ports.conf \
        && $SUDO sysctl -q net.ipv4.ip_unprivileged_port_start="$port_start"; then
        echo "Restored net.ipv4.ip_unprivileged_port_start to $port_start."
    else
        echo "Could not restore it. Run: sudo rm /etc/sysctl.d/99-jun-unprivileged-ports.conf && sudo sysctl net.ipv4.ip_unprivileged_port_start=$port_start" >&2
    fi
fi

# From outside the folder, since this script lives inside it.
cd "${HOME:-/}"
rm -rf "$root"
echo "Removed $root. Jun is uninstalled."
echo 'Left in place: Docker, git and any Python installed for asset recovery - remove with your package manager if unwanted.'
