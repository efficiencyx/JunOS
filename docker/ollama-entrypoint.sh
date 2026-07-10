#!/usr/bin/env bash
# Boot ollama serve, wait until the HTTP API answers, then `ollama pull`
# whatever is listed in OLLAMA_MODELS_TO_PULL (comma-separated). Models
# already present locally are skipped - `ollama pull` is idempotent and
# cheap when the manifest is already cached.

set -e

# Bind to all interfaces so the `php` service can reach us over the docker net.
export OLLAMA_HOST="${OLLAMA_HOST:-0.0.0.0:11434}"

ollama serve &
SERVE_PID=$!

# Wait for /api/tags (= server up + model store readable) before pulling.
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
    # Track first non-embedding model as the chat model to pre-warm.
    if [ -z "$CHAT_MODEL" ] && [ "$m" != "nomic-embed-text" ]; then
      CHAT_MODEL="$m"
    fi
  done
fi

# Pre-warm: load the chat model into VRAM now so the first user message
# doesn't pay the ~2 min cold-load cost.
if [ -n "$CHAT_MODEL" ]; then
  echo "[ollama-entrypoint] pre-warming $CHAT_MODEL..."
  curl -s -X POST "http://127.0.0.1:11434/api/generate" \
    -H 'Content-Type: application/json' \
    -d "{\"model\":\"$CHAT_MODEL\",\"prompt\":\"\",\"stream\":false}" >/dev/null \
    && echo "[ollama-entrypoint] pre-warm done" \
    || echo "[ollama-entrypoint] pre-warm failed (non-fatal)"
fi

# Hand the foreground to ollama so signals (SIGTERM from `docker stop`) reach it.
wait "$SERVE_PID"
