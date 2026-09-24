#!/usr/bin/env bash
# starts the audio sidecar (TTS/STT). first run makes a venv and
# installs the deps into it.
# needs espeak-ng on the host (sudo pacman -S espeak-ng on Arch)

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
