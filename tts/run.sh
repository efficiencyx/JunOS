#!/usr/bin/env bash
# Start the audio (TTS/STT) sidecar. First run creates a venv and installs deps.
# Requires espeak-ng on the host (sudo pacman -S espeak-ng on Arch).

set -euo pipefail
cd "$(dirname "$0")"

VENV=".venv"
if [ ! -d "$VENV" ]; then
  echo "[tts] creating venv..."
  python3 -m venv "$VENV"
  "$VENV/bin/pip" install --upgrade pip
  "$VENV/bin/pip" install -r requirements.txt
fi

exec "$VENV/bin/python" server.py
