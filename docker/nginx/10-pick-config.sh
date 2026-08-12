#!/bin/sh
# Runs from /docker-entrypoint.d/ before nginx reads any template.
# deletes whichever template does NOT match TLS_MODE, so only one omega.conf
# comes out the other side.
set -e

TLS_MODE="${TLS_MODE:-off}"

if [ "$TLS_MODE" = "on" ]; then
    echo "[10-pick-config] TLS_MODE=on - using TLS template, removing plain template"
    rm -f /etc/nginx/templates/omega.conf.template
else
    echo "[10-pick-config] TLS_MODE=off - serving HTTP + self-signed HTTPS, removing certbot TLS template"
    rm -f /etc/nginx/templates/omega-tls.conf.template
    if [ ! -f /etc/nginx/selfsigned/fullchain.pem ]; then
        echo "[10-pick-config] Generating self-signed certificate for ${DOMAIN:-localhost}"
        mkdir -p /etc/nginx/selfsigned
        openssl req -x509 -nodes -newkey rsa:2048 -days 3650 \
            -subj "/CN=${DOMAIN:-localhost}" \
            -addext "subjectAltName=DNS:${DOMAIN:-localhost},DNS:localhost,IP:127.0.0.1" \
            -keyout /etc/nginx/selfsigned/privkey.pem \
            -out /etc/nginx/selfsigned/fullchain.pem
    fi
fi
