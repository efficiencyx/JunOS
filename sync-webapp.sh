#!/bin/sh
# Push the local webapp/ into the running containers without rebuilding images.
#
# The webapp lives in two images: nginx serves the static files (html/js/css/
# assets) and php-fpm executes api/*.php - both out of /var/www/omega. So a sync
# has to update both containers. The php image runs opcache with
# validate_timestamps=0, meaning it won't notice changed .php files on its own,
# so after copying we restart php-fpm to flush the bytecode cache.
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

# index.html carries boot.css inlined; regenerate so the two cannot drift.
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
  # tools/ is a read-only bind mount, so chown always reports failures there;
  # set -e would abort before the restart below and leave stale opcache running.
  docker exec "$PHP" chown -R www-data:www-data "$DEST" 2>/dev/null || true
  echo "→ restarting php-fpm (flushes opcache)"
  docker restart "$PHP" >/dev/null
else
  echo "✗ $PHP not running - skipped php sync." >&2
fi

echo "✓ done. Hard-refresh the browser (Ctrl-Shift-R) to drop cached js/css."
