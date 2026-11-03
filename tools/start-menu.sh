#!/usr/bin/env bash
set -uo pipefail
cd "$(dirname "$0")/.."

if [ -z "${NO_COLOR:-}" ] && [ "${TERM:-}" != "dumb" ]; then
  R=$'\033[0m'; B=$'\033[1m'
  ACCENT=$'\033[38;2;124;158;255m'
  PURPLE=$'\033[38;2;155;114;203m'
  OK=$'\033[38;2;123;216;143m'
  DANGER=$'\033[38;2;255;138;138m'
  WARN=$'\033[38;2;255;200;112m'
  DIM=$'\033[38;2;142;146;149m'
  MUTED=$'\033[38;2;196;199;197m'
else
  R=; B=; ACCENT=; PURPLE=; OK=; DANGER=; WARN=; DIM=; MUTED=
fi

env_get() { sed -n "s/^$1=//p" .env 2>/dev/null | tail -n1 || true; }
env_set() {
  local tmp
  tmp="$(mktemp .env.XXXXXX)"
  grep -vE "^$1=" .env > "$tmp" 2>/dev/null || true
  printf '%s=%s\n' "$1" "$2" >> "$tmp"
  chmod 600 "$tmp"
  mv "$tmp" .env
}
is_on() { case "$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')" in on|1|true|yes) return 0 ;; esac; return 1; }
onoff() { if is_on "$1"; then printf 'on'; else printf 'off'; fi; }
voice_now() { local v; v="$(env_get VOICE)"; printf '%s' "${v:-on}"; }

# a handler, NOT trap '' INT. an ignored SIGINT carries into the
# child and Ctrl+C stops killing `logs -f`
trap 'printf "\n"' INT

start_sh() { JUN_NO_MENU=1 ./start.sh "$@"; }

running() {
  local names
  names="$(timeout 5 docker ps --format '{{.Names}}' 2>/dev/null)" || return 1
  printf '%s\n' "$names" | grep -qx omega-nginx
}

site_url() {
  case "$(printf '%s' "$(env_get TLS_MODE)" | tr '[:upper:]' '[:lower:]')" in
    off|'') printf 'https://localhost' ;;
    *) printf 'https://%s' "$(env_get DOMAIN)" ;;
  esac
}

pause() {
  printf '\n   %spress Enter for the menu%s ' "$DIM" "$R"
  read -r _ || exit 0
}

ask() {
  printf '   %s$%s %s %s→%s ' "$OK" "$R" "$1" "$ACCENT" "$R"
  read -r REPLY || exit 0
}

item() { printf '     %s%2s%s  %-15s %s%s%s\n' "$ACCENT" "$1" "$R" "$2" "$DIM" "$3" "$R"; }
section() { printf '\n   %s%s%s\n' "$B" "$1" "$R"; }

# same test start.sh's detect_gpu() makes, minus asking docker
has_gpu() {
  case "${GPU:-auto}" in nvidia|amd) return 0 ;; cpu) return 1 ;; esac
  { command -v nvidia-smi >/dev/null 2>&1 && nvidia-smi -L >/dev/null 2>&1; } || [ -e /proc/driver/nvidia/version ] \
    || { [ -e /dev/kfd ] && compgen -G "/dev/dri/renderD*" >/dev/null; }
}

splitting() {
  if ! has_gpu; then printf 'CPU, no GPU on this machine'
  elif [ "$(env_get SEP_DEVICE)" = cpu ]; then printf 'CPU'
  else printf 'GPU'
  fi
}

header() {
  local state provider
  printf '\033[H\033[2J'
  printf '\n   %s%sΩ%s  %s%sJUN OS%s  %s%s%s\n\n' "$B" "$PURPLE" "$R" "$B" "$ACCENT" "$R" "$DIM" "$PWD" "$R"
  if running; then
    state="${OK}she's up${R} ${DIM}at${R} ${B}$(site_url)${R}"
  else
    state="${WARN}she's down${R}"
  fi
  provider="$(env_get AI_PROVIDER)"
  printf '   %s\n' "$state"
  printf '   %s%s, voice %s, karaoke %s, bridge %s%s\n' "$DIM" "${provider:-ollama}" \
    "$(onoff "$(voice_now)")" "$(onoff "$(env_get KARAOKE)")" "$(onoff "$(env_get GAME_BRIDGE)")" "$R"
}

restart_prompt() {
  running || return 0
  ask "restart her so it applies? ${DIM}[Y/n]${R}"
  case "$REPLY" in n|N|no|NO) return 0 ;; esac
  start_sh restart
}

configure() {
  local changed=0
  while :; do
    header
    section "configure"
    item 1 "Voice" "$(onoff "$(voice_now)") - text to speech and the mic"
    item 2 "Karaoke" "$(onoff "$(env_get KARAOKE)") - sing along, a few GB of images"
    is_on "$(env_get KARAOKE)" && item 3 "Song splitting" "$(splitting) - splits songs into voice and music"
    item 4 "Game bridge" "$(onoff "$(env_get GAME_BRIDGE)") - her and your game save"
    item 5 "Update check" "$(onoff "$(env_get UPDATE_CHECK)") - asks GitHub for new releases on start"
    item 6 "Full setup" "provider, model, everything. runs install.sh again"
    item 0 "Back" ""
    printf '\n'
    ask "choice"
    case "$REPLY" in
      1) if is_on "$(voice_now)"; then
           env_set VOICE off
         else
           env_set VOICE on
           [ -n "$(env_get TTS_DEVICE)" ] || env_set TTS_DEVICE cpu
         fi
         changed=1 ;;
      2) if is_on "$(env_get KARAOKE)"; then env_set KARAOKE off; else env_set KARAOKE on; fi
         changed=1 ;;
      3) if is_on "$(env_get KARAOKE)" && has_gpu; then
           if [ "$(env_get SEP_DEVICE)" = cpu ]; then env_set SEP_DEVICE cuda; else env_set SEP_DEVICE cpu; fi
           changed=1
         fi ;;
      4) if is_on "$(env_get GAME_BRIDGE)"; then
           env_set GAME_BRIDGE off
           printf '\n   %sbridge off. the mod stays in the game folder and just stops reaching her%s\n' "$DIM" "$R"
           pause
         else
           printf '\n'
           JUN_ONLY=bridge ./install.sh; pause
         fi
         changed=1 ;;
      5) if is_on "$(env_get UPDATE_CHECK)"; then env_set UPDATE_CHECK off; else env_set UPDATE_CHECK on; fi ;;
      6) JUN_REUSE=0 ./install.sh; pause; return ;;
      0|q|'') [ "$changed" = 1 ] && restart_prompt; return ;;
    esac
  done
}

[ -f .env ] || { printf '   %sno .env here, run ./install.sh first%s\n' "$DANGER" "$R" >&2; exit 1; }

while :; do
  header
  section "her"
  item 1 "Start" "bring her up"
  item 2 "Stop" "take her down"
  item 3 "Restart" "down and up again, picks up .env changes"
  item 4 "Status" "which containers are up"
  item 5 "Logs" "follow them, Ctrl+C comes back here"
  section "setup"
  item 6 "Configure" "voice, karaoke, bridge, provider and model"
  item 7 "Update" "newest version on her channel, settings stay"
  item 8 "Tune MTP" "measure the best multi-token draft depth"
  item 9 "Uninstall" "asks before it deletes anything"
  section "connections"
  item 10 "Phone link" "QR for the Android app, same wifi"
  item 11 "Notebook link" "paste new lines from colab.ipynb Step 3"
  item 12 "Game bridge" "point the game mod at her again"
  item 13 "Certificate" "trust her local CA, no more browser warning"
  printf '\n'
  item 0 "Exit" ""
  printf '\n'
  ask "choice ${DIM}[enter = start]${R}"
  printf '\n'
  case "$REPLY" in
    ''|1) start_sh; pause ;;
    2) start_sh stop; pause ;;
    3) start_sh restart; pause ;;
    4) start_sh status; pause ;;
    5) start_sh logs; pause ;;
    6) configure ;;
    7) JUN_REUSE=1 ./install.sh; pause ;;
    8) ./mtp-autotune.sh; pause ;;
    9) ./uninstall.sh; exit $? ;;
    10) start_sh phone; pause ;;
    11) start_sh link; pause ;;
    12) start_sh bridge; pause ;;
    13) start_sh trust; pause ;;
    0|q|Q|exit) exit 0 ;;
    *) printf '   %sno option %s%s\n' "$DANGER" "$REPLY" "$R"; pause ;;
  esac
done
