#!/usr/bin/env bash
# Start ollama serve, wait for the HTTP API to answer, then
# `ollama pull` whatever OLLAMA_MODELS_TO_PULL lists, seperated
# by commas. anything already here is skipped, `ollama pull` does
# nothing twice and is cheap once the manifest is cached.

set -e

# Listen on everything so the `php` service can reach us over the
# docker net.
export OLLAMA_HOST="${OLLAMA_HOST:-0.0.0.0:11434}"

# Name of the MTP model we derive below. php has to guess the
# same name, so the default lives in both places, keep them
# together.
OLLAMA_MTP_MODEL="${OLLAMA_MTP_MODEL:-jun-mtp}"

ollama serve &
SERVE_PID=$!

# Wait for /api/tags, that means the server is up and can read
# the model store.
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

# Multi-token prediction. OLLAMA_MTP names the drafter, a small
# assistant model that guesses the next few tokens so Jun only
# has to check them, and the ones she agrees with came almost
# free. Ollama wants a DRAFT layer baked into the model, so we
# derive one from the chat model here rather than pass a flag.
#
# DRAFT takes a PATH to a gguf, a model name is rejected, so we
# pull the drafter like anything else and then dig its blob out
# of the store with `ollama show`. the blob IS the gguf, that is
# what a gguf-only pull leaves behind.
if [ -n "${OLLAMA_MTP:-}" ] && [ -n "$CHAT_MODEL" ]; then
  echo "[ollama-entrypoint] pulling drafter $OLLAMA_MTP"
  if ollama pull "$OLLAMA_MTP"; then
    DRAFT_GGUF="$(ollama show --modelfile "$OLLAMA_MTP" | awk '/^FROM /{print $2; exit}')"
    if [ -n "$DRAFT_GGUF" ] && [ -f "$DRAFT_GGUF" ]; then
      # A word here instead of a number ("auto" is the one people
      # try) would build a model that refuses to load. so anything
      # non-numeric falls back to drafting one token.
      # ./mtp-autotune.sh is what turns auto into a real depth, and
      # it writes a number into .env when it does.
      DRAFT_N="${OLLAMA_MTP_N_MAX:-4}"
      case "$DRAFT_N" in
        ''|*[!0-9]*) DRAFT_N=1 ;;
      esac
      # draft_num_predict has to be baked in too. it defaults to 4, but
      # ollama zeroes it for any model that didn't ask for it by name,
      # and 0 turns speculation back off without a word about it.
      # ollama picks gemma4-small or -large off the NAME first
      # (e2b/e4b small, 12b/26b/31b large), the parameter count
      # only after that, cutoff 12B. "jun-mtp" has no size in it
      # and the 12B is 11.9B on paper, so the derived model got
      # small while the hf.co one it's built from gets large.
      # small ends a think:false prompt on a bare <|turn>model, she
      # opens a thought channel anyway, now and then never closes
      # it, and the parser files her whole reply as thinking. which
      # think:false throws away = empty reply. large closes an
      # empty one for her. every other byte is the same
      RENDERER=""
      case "$(printf '%s' "$CHAT_MODEL" | tr '[:upper:]' '[:lower:]')" in
        *e2b*|*e4b*) ;;
        *12b*|*26b*|*31b*) RENDERER="RENDERER gemma4-large" ;;
      esac
      printf 'FROM %s\nDRAFT %s\nPARAMETER draft_num_predict %s\n%s\n' \
        "$CHAT_MODEL" "$DRAFT_GGUF" "$DRAFT_N" "$RENDERER" > /tmp/Modelfile.mtp
      if ollama create "$OLLAMA_MTP_MODEL" -f /tmp/Modelfile.mtp; then
        echo "[ollama-entrypoint] MTP model $OLLAMA_MTP_MODEL built on $CHAT_MODEL"
      else
        echo "[ollama-entrypoint] MTP create failed, staying on $CHAT_MODEL"
      fi
    else
      echo "[ollama-entrypoint] could not find the drafter blob, staying on $CHAT_MODEL"
    fi
  else
    echo "[ollama-entrypoint] drafter pull failed, staying on $CHAT_MODEL"
  fi
fi

if [ -n "${TITLE_MODEL:-}" ]; then
  echo "[ollama-entrypoint] pulling $TITLE_MODEL"
  ollama pull "$TITLE_MODEL" || echo "[ollama-entrypoint] pull failed: $TITLE_MODEL (will continue)"
  # CPU only and pinned with keep_alive -1. titling must NEVER take
  # VRAM off the chat model.
  echo "[ollama-entrypoint] pinning $TITLE_MODEL to CPU..."
  curl -fsS -X POST "http://127.0.0.1:11434/api/generate" \
    -H 'Content-Type: application/json' \
    -d "{\"model\":\"$TITLE_MODEL\",\"prompt\":\"\",\"stream\":false,\"keep_alive\":-1,\"options\":{\"num_gpu\":0}}" >/dev/null \
    && echo "[ollama-entrypoint] title model pinned" \
    || echo "[ollama-entrypoint] title model pin failed (non-fatal)"
fi

# no pre-warm here. only php knows the num_ctx chat sends, so
# api/prewarm.php does it (php-entrypoint.sh starts it). install.sh
# waits for this line.
echo "[ollama-entrypoint] models ready"

# Give the foreground to ollama so a SIGTERM from `docker stop`
# gets to it.
wait "$SERVE_PID"
