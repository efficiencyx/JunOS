#!/usr/bin/env bash
# Find the draft depth that is actually fastest on THIS machine, then write it
# into .env.
#
# Speculation only pays when checking K+1 tokens costs about what checking 1
# costs. Whether that holds depends on the card, so the only honest answer is
# to measure. Measured on a 3060 with the 12B: depth 1 gave +25%, depth 2 +16%,
# depth 3 broke even, depth 4 came out Slower than no drafter at all. A bigger
# card can afford a deeper draft. Yours might not.
#
# Needs the stack up and the models pulled. Safe to re-run any time. After a GPU
# change you don't have to remember to, start.sh sees the card this was measured
# on is gone and runs it for you.
#
#   ./mtp-autotune.sh
#
# No jq, no python. Installers run on machines that have neither.
set -eu

cd "$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ] && [ "${TERM:-}" != "dumb" ]; then
    R=$'\033[0m'; B=$'\033[1m'
    ACCENT=$'\033[38;2;124;158;255m'    #7c9eff
    OK=$'\033[38;2;123;216;143m'        #7bd88f
    WARN=$'\033[38;2;255;200;112m'      #ffc870
    DIM=$'\033[38;2;142;146;149m'       #8e9295
else
    R=; B=; ACCENT=; OK=; WARN=; DIM=
fi

say()  { printf "    ${DIM}%s${R}\n" "$1"; }
good() { printf "    ${OK}v${R} %s\n" "$1"; }
warn_(){ printf "    ${WARN}!${R} %s\n" "$1"; }
die()  { printf "    ${WARN}!${R} %s\n" "$1"; exit 1; }

env_get() {
    [ -f .env ] || return 0
    sed -n "s/^$1=//p" .env | tail -n1
}

set_env() {
    tmp=".env.tmp.$$"
    if grep -qE "^$1=" .env 2>/dev/null; then
        grep -vE "^$1=" .env > "$tmp"
        printf '%s=%s\n' "$1" "$2" >> "$tmp"
        mv "$tmp" .env
    else
        printf '%s=%s\n' "$1" "$2" >> .env
    fi
    chmod 600 .env 2>/dev/null || true
}

# The card this tune was measured on, as one string: the vendor,
# then every GPU's name and how much VRAM it has. Sorted biggest
# card first, so moving cards between slots is not a change, only
# a real swap is.
#
# Keep this byte for byte in step with the copy in start.sh. that
# one compares what it prints against MTP_TUNED_GPU, so the day
# the two print a different string for the same card, start.sh
# reads every boot as a GPU change and re-runs the whole sweep,
# forever.
gpu_signature() {
  if command -v nvidia-smi >/dev/null 2>&1; then
    nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits 2>/dev/null \
      | sed -e 's/\r//' -e 's/[[:space:]]*,[[:space:]]*/:/' \
      | sort -t: -k2 -nr \
      | awk 'NF { s = s (s ? "," : "") $0 } END { if (s) print "nvidia:" s }'
  elif command -v rocm-smi >/dev/null 2>&1; then
    rocm-smi --showmeminfo vram --csv 2>/dev/null \
      | awk -F, 'NR>1 { gsub(/[^0-9]/,"",$2); if ($2 != "") print int($2/1048576) }' \
      | sort -nr \
      | awk 'NF { s = s (s ? "," : "") $0 } END { if (s) print "amd:" s }'
  fi
}

# Only a run that measured something gets to stamp, and only when
# we could actually name the card. No stamp is better than one
# that means "we could not tell", start.sh has nothing to compare
# then and leaves you alone.
stamp_gpu() {
    sig="$(gpu_signature)"
    [ -n "$sig" ] || return 0
    set_env MTP_TUNED_GPU "$sig"
}

# The drafter that goes with a chat model is the same repo with -MTP
# in the name, so Jun-LoRA-12B-GGUF drafts off Jun-LoRA-12B-MTP-GGUF.
# The quant tag rides along untouched. A repo that doesn't end in
# -GGUF just gets -MTP on the end.
mtp_repo_for() {
    _ref="$1"
    case "${_ref##*/}" in
        *:*) _tag=":${_ref##*:}"; _repo="${_ref%:*}" ;;
        *)   _tag=""; _repo="$_ref" ;;
    esac
    case "$_repo" in
        *-GGUF) printf '%s-MTP-GGUF%s\n' "${_repo%-GGUF}" "$_tag" ;;
        *)      printf '%s-MTP%s\n' "$_repo" "$_tag" ;;
    esac
}

# One number out of a flat JSON body. Enough for eval_count and friends, and it
# saves a dependency this script would otherwise need on every distro.
json_num() {
    sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\([0-9][0-9.]*\).*/\1/p" | head -n1
}

command -v docker >/dev/null 2>&1 || die "docker not found"

# Two in-character turns, no code. A coding prompt makes any drafter look
# great, Gemma's assistants were tuned on code, and then the number you tuned
# against is one Jun's traffic NEVER sees. Prose is what she actually writes.
P1='You have been quiet all evening. Talk to me, properly.'
P2='Tell me what you remember about the day we met.'

# 2 prompts x 80 tokens is 160 per row, five rows, so the whole ollama sweep
# lands near half a minute on a normal card. Short rows are noisier, that is
# what MARGIN below is for, a depth that only ties inside the noise doesn't
# get to win anyway.
TOKENS=80

# Her real system prompt goes in front of every one of those, because it goes in
# front of every real message too. Measured bare, depth 2 came out on top by 1%,
# measured with the prompt in place depth 1 won by 6% - same box, same drafter,
# same afternoon. Tuning without it picks the winner for a regime the app never
# runs in.
SYSTEM_JSON=""
if [ -f webapp/system_prompt.txt ]; then
    SYSTEM_JSON="$(sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/\t/\\t/g' -e 's/\r//g' \
        webapp/system_prompt.txt | awk '{ printf "%s\\n", $0 }')"
fi

messages_json() {
    if [ -n "$SYSTEM_JSON" ]; then
        printf '{"role":"system","content":"%s"},{"role":"user","content":"%s"}' "$SYSTEM_JSON" "$1"
    else
        printf '{"role":"user","content":"%s"}' "$1"
    fi
}

# Anything under this much is noise on a warm box, and a deeper draft that only
# ties costs VRAM and gets worse the moment layers spill to the CPU. So a deeper
# one has to actually earn the spot, not tie for it.
MARGIN=1.02

better() {  # a beats b by enough to be worth it
    awk -v a="$1" -v b="$2" -v m="$MARGIN" 'BEGIN { exit !(a > b * m) }'
}

ollama_exec() { docker exec -i omega-ollama sh -c "$1"; }

# We just wrote OLLAMA_MTP into .env, but php got its copy from compose the day
# the container was built and nothing re-reads the file. Until php is recreated
# it still believes MTP is off, so it keeps offering the raw drafter in the
# picker - pick that one and ollama tries to load a drafter as a chat model,
# which fails and reaches you as an empty reply.
#
# Only php. the GPU overlays don't touch that service, so recreating it alone
# needs no -f flags and can't drop anyone else's device config.
sync_php_env() {
    docker ps --format '{{.Names}}' | grep -qx omega-php || return 0
    _want="$(env_get OLLAMA_MTP)"
    _have="$(docker exec omega-php sh -c 'printf %s "${OLLAMA_MTP-}"' 2>/dev/null || true)"
    [ "$_want" = "$_have" ] && return 0
    say "restarting php so it sees the new OLLAMA_MTP"
    docker compose up -d --force-recreate php >/dev/null 2>&1 \
        || warn_ "could not restart php - run ./start.sh to pick the new setting up"
}

# tok/s for one ollama model, pooled over both prompts. Ollama reports
# eval_count and eval_duration per request, so this counts generation only and
# leaves prompt processing out of it.
bench_ollama() {
    _model="$1"; _tok=0; _ns=0
    for _p in "$P1" "$P2"; do
        _body=$(printf '{"model":"%s","stream":false,"messages":[%s],"options":{"temperature":0,"num_predict":%s}}' \
            "$_model" "$(messages_json "$_p")" "$TOKENS")
        _out=$(printf '%s' "$_body" | ollama_exec 'cat > /tmp/mtp_req.json && curl -s --max-time 300 http://localhost:11434/api/chat -d @/tmp/mtp_req.json' 2>/dev/null || true)
        _c=$(printf '%s' "$_out" | json_num eval_count)
        _d=$(printf '%s' "$_out" | json_num eval_duration)
        [ -n "${_c:-}" ] && [ -n "${_d:-}" ] || continue
        _tok=$((_tok + _c)); _ns=$((_ns + _d))
    done
    [ "$_ns" -gt 0 ] || { echo 0; return; }
    awk -v t="$_tok" -v n="$_ns" 'BEGIN { printf "%.2f", t / (n / 1000000000) }'
}

tune_ollama() {
    chat="$(env_get OLLAMA_MODELS_TO_PULL)"
    drafter="$(env_get OLLAMA_MTP)"
    mtp_model="$(env_get OLLAMA_MTP_MODEL)"; mtp_model="${mtp_model:-jun-mtp}"

    [ -n "$chat" ] || die "OLLAMA_MODELS_TO_PULL is empty."
    docker ps --format '{{.Names}}' | grep -qx omega-ollama || die "omega-ollama is not running - start the stack first."

    if [ -z "$drafter" ]; then
        drafter="$(mtp_repo_for "$chat")"
        say "no OLLAMA_MTP set, trying $drafter"
        ollama_exec "ollama pull '$drafter'" >/dev/null 2>&1 \
            || die "$drafter is not there - set OLLAMA_MTP by hand if the drafter lives somewhere else."
        set_env OLLAMA_MTP "$drafter"
    fi

    # DRAFT wants a path to a gguf, a model name is rejected. For a gguf-only
    # pull the blob ollama landed it in IS the gguf, and the modelfile is where
    # it admits which blob that was.
    blob="$(ollama_exec "ollama show --modelfile '$drafter' 2>/dev/null | awk '/^FROM /{print \$2; exit}'" | tr -d '\r')"
    case "$blob" in
        /*) ;;
        *) die "could not find the drafter blob for $drafter - is it pulled?" ;;
    esac

    printf '\n     %smeasuring%s %s(a few seconds per row)%s\n' "$B" "$R" "$DIM" "$R"
    base="$(bench_ollama "$chat")"
    printf '       %sno drafter%s   %s tok/s\n' "$DIM" "$R" "$base"
    # A baseline of zero means every request failed, not that she is infinitely
    # slow. Carrying on from here would read the silence as "drafting never
    # helps" and switch the feature off on the strength of nothing.
    better "$base" 0 || die "could not measure a baseline - is $chat pulled and the stack healthy?"

    best_n=0; best="$base"
    for n in 1 2 3 4; do
        printf 'FROM %s\nDRAFT %s\nPARAMETER draft_num_predict %s\n' "$chat" "$blob" "$n" \
            | ollama_exec 'cat > /tmp/Modelfile.tune && ollama create jun-mtp-tune -f /tmp/Modelfile.tune' >/dev/null 2>&1 \
            || { warn_ "depth $n failed to build, skipping"; continue; }
        got="$(bench_ollama jun-mtp-tune)"
        printf '       %sdraft %s%s     %s tok/s\n' "$DIM" "$n" "$R" "$got"
        better "$got" "$best" && { best="$got"; best_n="$n"; }
    done
    ollama_exec 'ollama rm jun-mtp-tune' >/dev/null 2>&1 || true

    if [ "$best_n" = 0 ]; then
        warn_ "no draft depth beat plain decoding here - leaving MTP off."
        set_env OLLAMA_MTP ""
        stamp_gpu
        sync_php_env
        say "the drafter stays pulled, put OLLAMA_MTP back to try again."
        return
    fi

    printf 'FROM %s\nDRAFT %s\nPARAMETER draft_num_predict %s\n' "$chat" "$blob" "$best_n" \
        | ollama_exec "cat > /tmp/Modelfile.mtp && ollama create '$mtp_model' -f /tmp/Modelfile.mtp" >/dev/null 2>&1 \
        || die "could not rebuild $mtp_model at depth $best_n"

    set_env OLLAMA_MTP_N_MAX "$best_n"
    gain="$(awk -v a="$best" -v b="$base" 'BEGIN { if (b > 0) printf "%.0f", (a / b - 1) * 100; else print 0 }')"
    good "draft $best_n wins: $best tok/s, ${gain}% over plain decoding"
    stamp_gpu
    sync_php_env
}

wait_llamacpp() {
    i=0
    while [ "$i" -lt 90 ]; do
        docker exec omega-llamacpp curl -fsS http://127.0.0.1:8080/health >/dev/null 2>&1 && return 0
        i=$((i + 1))
        sleep 2
    done
    return 1
}

bench_llamacpp() {
    _tok=0; _ms=0
    for _p in "$P1" "$P2"; do
        _body=$(printf '{"stream":false,"messages":[%s],"temperature":0,"max_tokens":%s}' \
            "$(messages_json "$_p")" "$TOKENS")
        _out=$(printf '%s' "$_body" | docker exec -i omega-llamacpp sh -c 'cat > /tmp/mtp_req.json && curl -s --max-time 300 http://127.0.0.1:8080/v1/chat/completions -H "Content-Type: application/json" -d @/tmp/mtp_req.json' 2>/dev/null || true)
        _c=$(printf '%s' "$_out" | json_num completion_tokens)
        _t=$(printf '%s' "$_out" | json_num predicted_ms)
        [ -n "${_c:-}" ] && [ -n "${_t:-}" ] || continue
        _tok=$((_tok + _c))
        _ms=$(awk -v a="$_ms" -v b="$_t" 'BEGIN { printf "%.0f", a + b }')
    done
    [ "${_ms:-0}" -gt 0 ] || { echo 0; return; }
    awk -v t="$_tok" -v m="$_ms" 'BEGIN { printf "%.2f", t / (m / 1000) }'
}

# start.sh re-runs this script when the GPU stamp is stale, and the
# stamp stays stale until the sweep ends. so every restart in here
# has to say "already tuning", otherwise the first one starts a
# second sweep inside this one.
restart_llamacpp() {
    MTP_AUTOTUNE_RUNNING=1 ./start.sh >/dev/null 2>&1 || true
    wait_llamacpp || { warn_ "llama-server did not come back healthy"; return 1; }
}

# llama-server takes the draft depth as a startup flag, so unlike ollama there
# is no way to swap it on a live server. Every row down here is a full restart,
# which is why this half is the slow one.
tune_llamacpp() {
    drafter="$(env_get LLAMACPP_MTP)"
    if [ -z "$drafter" ]; then
        chat="$(env_get LLAMACPP_MODEL_HF)"
        [ -n "$chat" ] || die "LLAMACPP_MTP is empty and LLAMACPP_MODEL_HF names nothing to derive it from."
        drafter="$(mtp_repo_for "$chat")"
        say "no LLAMACPP_MTP set, trying $drafter"
        set_env LLAMACPP_MTP "$drafter"
    fi
    keep_n="$(env_get LLAMACPP_MTP_N_MAX)"

    printf '\n     %smeasuring%s %s(each row restarts llama-server, this takes a while)%s\n' "$B" "$R" "$DIM" "$R"

    set_env LLAMACPP_MTP ""
    restart_llamacpp || { set_env LLAMACPP_MTP "$drafter"; die "could not get a baseline"; }
    base="$(bench_llamacpp)"
    printf '       %sno drafter%s   %s tok/s\n' "$DIM" "$R" "$base"
    set_env LLAMACPP_MTP "$drafter"
    # A baseline of zero means every request failed, not that she is infinitely
    # slow. Carrying on from here would read the silence as "drafting never
    # helps" and switch the feature off on the strength of nothing.
    better "$base" 0 || die "could not measure a baseline - is llama-server healthy?"

    best_n=0; best="$base"
    for n in 1 2 3 4; do
        set_env LLAMACPP_MTP_N_MAX "$n"
        if restart_llamacpp; then
            got="$(bench_llamacpp)"
            printf '       %sdraft %s%s     %s tok/s\n' "$DIM" "$n" "$R" "$got"
            better "$got" "$best" && { best="$got"; best_n="$n"; }
        else
            warn_ "depth $n did not start, skipping"
        fi
    done

    if [ "$best_n" = 0 ]; then
        warn_ "no draft depth beat plain decoding here - leaving MTP off."
        set_env LLAMACPP_MTP ""
        set_env LLAMACPP_MTP_N_MAX "${keep_n:-1}"
        stamp_gpu
        restart_llamacpp || true
        return
    fi

    set_env LLAMACPP_MTP_N_MAX "$best_n"
    restart_llamacpp || true
    gain="$(awk -v a="$best" -v b="$base" 'BEGIN { if (b > 0) printf "%.0f", (a / b - 1) * 100; else print 0 }')"
    good "draft $best_n wins: $best tok/s, ${gain}% over plain decoding"
    stamp_gpu
}

provider="$(env_get AI_PROVIDER)"
printf '\n  %s>%s %smulti-token prediction autotune%s\n' "$ACCENT" "$R" "$B" "$R"

case "$provider" in
    ollama)   tune_ollama ;;
    llamacpp) tune_llamacpp ;;
    *) die "AI_PROVIDER is '$provider' - MTP only applies to ollama and llamacpp." ;;
esac

# The sweep runs on an idle card. Once a browser is drawing Live2D it takes
# about 1.5GB of the same VRAM, and if that pushes layers onto the CPU every
# number above shifts down. Deeper drafts got Worse under that pressure when it
# was measured, not better, so the winner still holds.
say "measured with nothing else on the GPU. Live2D in a browser wants ~1.5GB more."
printf '\n'
