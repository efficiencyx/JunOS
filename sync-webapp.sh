#!/bin/sh
# Push the local webapp/ into the running containers without
# building images.
#
# the webapp lives in two images. nginx serves the static files,
# html and js and css and assets, php-fpm runs api/*.php, and
# both of them read /var/www/omega. so a sync has to update both
# containers. the php image runs opcache, which keeps a compiled
# copy of every file in memory, with validate_timestamps=0, so it
# will Never notice a changed .php on its own. that is why we
# restart php-fpm after copying.
#
#   ./sync-webapp.sh          # static + php, restart php-fpm
#   ./sync-webapp.sh -s       # js/css/html/assets only, no restart
#   ./sync-webapp.sh --clean  # also drop files that are gone here
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$ROOT"

NGINX=omega-nginx
PHP=omega-php
DEST=/var/www/omega

static_only=0
clean=0
for a in "$@"; do
  case "$a" in
    -s|--static) static_only=1 ;;
    --clean) clean=1 ;;
    -h|--help) echo "usage: $0 [-s|--static] [--clean]   (-s = skip php copy + restart, --clean = delete files that no longer exist locally)"; exit 0 ;;
    *) echo "unknown option: $a (try -h)" >&2; exit 2 ;;
  esac
done

# --type container is not optional. the containers and their
# images share a name, and some docker builds resolve the image
# first, so without it this asks an image whether it is running
# and decides the stack is down.
running() { [ "$(docker inspect --type container -f '{{.State.Running}}' "$1" 2>/dev/null)" = true ]; }

if ! running "$NGINX"; then
  echo "✗ $NGINX is not running - start the stack first (./start.sh)." >&2
  exit 1
fi

# index.html has boot.css inlined, so rebuild it or the two drift
# apart.
echo "→ inlining critical css"
if command -v php >/dev/null; then
  php tools/build-critical-css.php
else
  docker run --rm -v "$PWD:/w" -w /w php:cli php tools/build-critical-css.php
fi

# docker cp keeps the host's uid and mode bits, and the containers
# drop every capability, so nothing in there can chown or chmod
# afterwards (root included). the checkout has to be world
# readable on its own, which a normal umask gives you.
# api/review.php is the local dataset review page. the image build
# leaves it out (.dockerignore) and so does the sync, unless you
# ask: SYNC_REVIEW=1 ./sync-webapp.sh
copy_tree() {
  if [ "${SYNC_REVIEW:-}" = 1 ]; then
    tar -C webapp -cf - . | docker cp - "$1:$DEST"
  else
    tar -C webapp --exclude=./api/review.php -cf - . | docker cp - "$1:$DEST"
  fi
}

# docker cp only ever ADDS. a file that got moved or deleted here
# stays in the container, still served, until the image gets
# rebuilt. --clean lists js/, css/, api/ and the top level pages
# in the container and deletes whatever doesn't exist locally
# anymore. tools/ is a bind mount of the host checkout
# (docker-compose.yml) and assets/ is the recovered art, neither
# is in that list and neither gets touched, EVER.
# rm goes twice, as root and as you. root has no DAC_OVERRIDE in
# the php container, so it can't delete inside the dirs docker cp
# made with your uid, and you can't delete inside the ones the
# image build made as root. between the two everything goes.
prune_tree() {
  stale=$(docker exec "$1" sh -c "cd $DEST && { find js css api -type f 2>/dev/null; find . -maxdepth 1 -type f \( -name '*.css' -o -name '*.js' -o -name '*.html' \) | sed 's#^\./##'; }" \
    | while IFS= read -r f; do
        case "$f" in api/review.*) continue ;; esac
        [ -e "webapp/$f" ] || printf '%s\n' "$f"
      done)
  [ -n "$stale" ] || return 0
  printf '%s\n' "$stale" | sed "s#^#    - $1:$DEST/#"
  for who in 0 "$(id -u):$(id -g)"; do
    printf '%s\n' "$stale" | docker exec -i -u "$who" "$1" sh -c "cd $DEST && xargs rm -f --" 2>/dev/null || true
  done
  left=$(printf '%s\n' "$stale" | docker exec -i "$1" sh -c "cd $DEST && while IFS= read -r f; do [ -e \"\$f\" ] && echo \"\$f\"; done" || true)
  if [ -n "$left" ]; then
    echo "✗ couldn't delete these from $1, rebuild the image instead (./start.sh --build):" >&2
    printf '%s\n' "$left" | sed 's/^/    /' >&2
  fi
}

echo "→ static assets → $NGINX:$DEST"
copy_tree "$NGINX"
if [ "$clean" -eq 1 ]; then
  echo "→ pruning stale files from $NGINX"
  prune_tree "$NGINX"
fi

if [ "$static_only" -eq 1 ]; then
  echo "✓ static synced. Hard-refresh the browser (Ctrl-Shift-R) to drop cached js/css."
  exit 0
fi

if running "$PHP"; then
  echo "→ php           → $PHP:$DEST"
  copy_tree "$PHP"
  if [ "$clean" -eq 1 ]; then
    echo "→ pruning stale files from $PHP"
    prune_tree "$PHP"
  fi
  echo "→ restarting php-fpm (flushes opcache)"
  docker restart "$PHP" >/dev/null
else
  echo "✗ $PHP not running - skipped php sync." >&2
fi

echo "✓ done. Hard-refresh the browser (Ctrl-Shift-R) to drop cached js/css."
