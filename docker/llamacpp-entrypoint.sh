#!/bin/sh
# llama-server in router mode: one server, every model in a preset
# file, each loaded on demand as its own child process. this
# writes that file out of .env on every start, so a blank value
# is just a line we don't write. (the old per-flag LLAMA_ARG_*
# setup needed a whole compose overlay for that, an empty
# LLAMA_ARG_SPEC_TYPE isn't "off", it's a value llama.cpp parses
# and dies on)
set -eu

ini=/tmp/models.ini
: > "$ini"

# her context tops out at 16k, same as the ollama side. done by
# lying about the trained length instead of pinning ctx-size,
# because --fit only shrinks what we LEAVE unset. pin it and a
# small card keeps 16k and shoves layers onto the CPU instead.
# leave it unset under a 16k ceiling and fit shrinks the context
# first, down to fit-ctx, which is what ollama does. the override
# only lands on gemma4 GGUFs, on anything else it does nothing and
# you want OMEGA_NUM_CTX. fit-target is 1024, NOT php's 2048
# VRAM_RESERVE_MB: at 2048 the 12B on a 12 GB card went partly CPU.
chat_section() {  # name, where-the-weights-are line, mtp yes/no
    printf '[%s]\n%s\n' "$1" "$2"
    if [ -n "${OMEGA_NUM_CTX:-}" ]; then
        printf 'ctx-size = %s\n' "$OMEGA_NUM_CTX"
    else
        printf 'override-kv = gemma4.context_length=int:16384\nfit-ctx = 6144\n'
    fi
    printf 'fit-target = 1024\n'
    # the drafter matches ONE gemma 4 size, so only the default
    # model gets it
    if [ "$3" = yes ] && [ -n "${LLAMACPP_MTP:-}" ]; then
        printf 'spec-type = draft-mtp\nspec-draft-hf = %s\nspec-draft-n-max = %s\n' \
            "$LLAMACPP_MTP" "${LLAMACPP_MTP_N_MAX:-4}"
    fi
    printf '\n'
}

{
    if [ -n "${LLAMACPP_MODEL_FILE:-}" ]; then
        chat_section "${LLAMACPP_MODEL_ALIAS:-jun-local}" "model = /models/$LLAMACPP_MODEL_FILE" yes
    else
        mtp=yes
        for ref in $(printf '%s' "${LLAMACPP_MODEL_HF:-efficiencyx/Jun-LoRA-E2B-GGUF:Q4_K_M}" | tr ',' ' '); do
            chat_section "$ref" "hf-repo = $ref" "$mtp"
            mtp=no
        done
    fi

    # the title model, same one the ollama side pins to the CPU.
    # ctx 2048 because it only ever reads one message.
    title="${TITLE_MODEL-hf.co/efficiencyx/Titlewen-GGUF:F16}"
    title="${title#hf.co/}"
    case "$title" in
        */*) printf '[%s]\nhf-repo = %s\nn-gpu-layers = 0\nctx-size = 2048\nmmproj-auto = false\n\n' "$title" "$title" ;;
        "") ;;
        *) echo "TITLE_MODEL=$title isn't a Hugging Face repo, llama.cpp can't fetch it - chats get no titles" >&2 ;;
    esac
} >> "$ini"

# 2 = her and the title model. php unloads the old chat model
# before switching to another one, past that the router drops
# whatever was used last
exec /app/llama-server --models-preset "$ini" --models-max 2 --host 0.0.0.0 --port 8080
