#!/usr/bin/env bash
# Start ollama serve, wait for the HTTP API to answer, then `ollama pull`
# whatever OLLAMA_MODELS_TO_PULL lists, seperated by commas. anything already
# here is skipped, `ollama pull` does nothing twice and is cheap once the
# manifest is cached.

set -e

# Listen on everything so the `php` service can reach us over the docker net.
export OLLAMA_HOST="${OLLAMA_HOST:-0.0.0.0:11434}"

ollama serve &
SERVE_PID=$!

# Wait for /api/tags, that means the server is up and can read the model store.
echo "[ollama-entrypoint] waiting for ollama to come up..."
for i in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:11434/api/tags" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

CHAT_MODEL=""
if [ -n "${OLLAMA_MODELS_TO_PULL:-}" ]; then
  IFS=',' read -ra MODELS <<< "$OLLAMA_MODELS_TO_PULL"
  for raw in "${MODELS[@]}"; do
    m="$(echo "$raw" | xargs)"
    [ -z "$m" ] && continue
    echo "[ollama-entrypoint] pulling $m"
    ollama pull "$m" || echo "[ollama-entrypoint] pull failed: $m (will continue)"
    if [ -z "$CHAT_MODEL" ]; then CHAT_MODEL="$m"; fi
  done
fi

if [ -n "${TITLE_MODEL:-}" ]; then
  echo "[ollama-entrypoint] pulling $TITLE_MODEL"
  ollama pull "$TITLE_MODEL" || echo "[ollama-entrypoint] pull failed: $TITLE_MODEL (will continue)"
  # CPU only and pinned with keep_alive -1. titling must NEVER take VRAM off
  # the chat model.
  echo "[ollama-entrypoint] pinning $TITLE_MODEL to CPU..."
  curl -s -X POST "http://127.0.0.1:11434/api/generate" \
    -H 'Content-Type: application/json' \
    -d "{\"model\":\"$TITLE_MODEL\",\"prompt\":\"\",\"stream\":false,\"keep_alive\":-1,\"options\":{\"num_gpu\":0}}" >/dev/null \
    && echo "[ollama-entrypoint] title model pinned" \
    || echo "[ollama-entrypoint] title model pin failed (non-fatal)"
fi

# Warm it up. get the chat model into VRAM NOW so the first message you send
# doesn't sit through the ~2 min cold load.
if [ -n "$CHAT_MODEL" ]; then
  echo "[ollama-entrypoint] pre-warming $CHAT_MODEL..."
  curl -s -X POST "http://127.0.0.1:11434/api/generate" \
    -H 'Content-Type: application/json' \
    -d "{\"model\":\"$CHAT_MODEL\",\"prompt\":\"\",\"stream\":false}" >/dev/null \
    && echo "[ollama-entrypoint] pre-warm done" \
    || echo "[ollama-entrypoint] pre-warm failed (non-fatal)"
fi

# Give the foreground to ollama so a SIGTERM from `docker stop` gets to it.
wait "$SERVE_PID"
