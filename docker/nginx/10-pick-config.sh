#!/bin/sh
# Runs inside /docker-entrypoint.d/ before nginx loads templates.
# Removes the template that does NOT match TLS_MODE so that only one
# omega.conf is generated after envsubst expansion.
set -e

TLS_MODE="${TLS_MODE:-off}"

if [ "$TLS_MODE" = "on" ]; then
    echo "[10-pick-config] TLS_MODE=on — using TLS template, removing plain template"
    rm -f /etc/nginx/templates/omega.conf.template
else
    echo "[10-pick-config] TLS_MODE=off — using plain HTTP template, removing TLS template"
    rm -f /etc/nginx/templates/omega-tls.conf.template
fi
