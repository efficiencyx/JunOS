#!/bin/sh
# Push the local webapp/ into the running containers without building images.
#
# the webapp lives in two images. nginx serves the static files, html and js and
# css and assets, php-fpm runs api/*.php, and both of them read /var/www/omega.
# so a sync has to update both containers. the php image runs opcache, which
# keeps a compiled copy of every file in memory, with validate_timestamps=0, so
# it will Never notice a changed .php on its own. that is why we restart php-fpm
# after copying.
#
#   ./sync-webapp.sh            # sync everything (static + php), restart php-fpm
#   ./sync-webapp.sh -s         # static only (js/css/html/assets) - no php, no restart
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$ROOT"

NGINX=omega-nginx
PHP=omega-php
DEST=/var/www/omega

static_only=0
for a in "$@"; do
  case "$a" in
    -s|--static) static_only=1 ;;
    -h|--help) echo "usage: $0 [-s|--static]   (-s = skip php copy + restart)"; exit 0 ;;
    *) echo "unknown option: $a (try -h)" >&2; exit 2 ;;
  esac
done

running() { [ "$(docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null)" = true ]; }

if ! running "$NGINX"; then
  echo "✗ $NGINX is not running - start the stack first (./start.sh)." >&2
  exit 1
fi

# index.html has boot.css inlined, so rebuild it or the two drift apart.
echo "→ inlining critical css"
if command -v php >/dev/null; then
  php tools/build-critical-css.php
else
  docker run --rm -v "$PWD:/w" -w /w php:cli php tools/build-critical-css.php
fi

echo "→ static assets → $NGINX:$DEST"
docker cp webapp/. "$NGINX:$DEST"

if [ "$static_only" -eq 1 ]; then
  echo "✓ static synced. Hard-refresh the browser (Ctrl-Shift-R) to drop cached js/css."
  exit 0
fi

if running "$PHP"; then
  echo "→ php           → $PHP:$DEST"
  docker cp webapp/. "$PHP:$DEST"
  # tools/ is mounted read only so chown always complains about it, and set -e
  # would quit before the restart below and leave the old opcache running.
  docker exec "$PHP" chown -R www-data:www-data "$DEST" 2>/dev/null || true
  echo "→ restarting php-fpm (flushes opcache)"
  docker restart "$PHP" >/dev/null
else
  echo "✗ $PHP not running - skipped php sync." >&2
fi

echo "✓ done. Hard-refresh the browser (Ctrl-Shift-R) to drop cached js/css."
