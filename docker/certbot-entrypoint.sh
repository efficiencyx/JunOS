#!/bin/sh
set -e

if [ -z "$DOMAIN" ] || [ "$DOMAIN" = "localhost" ]; then
    echo "[certbot] DOMAIN must be set to a real public domain for TLS issuance"
    sleep infinity
fi

if [ ! -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]; then
    certbot certonly \
        --webroot -w /var/www/certbot \
        -d "$DOMAIN" \
        -m "${EMAIL:-admin@$DOMAIN}" \
        --agree-tos \
        --non-interactive \
        --keep-until-expiring \
        || echo "[certbot] Initial issuance failed; nginx will start without a certificate"
fi

# Renewal loop: certbot checks every 12h, only renews when near expiry
while :; do
    sleep 12h
    certbot renew \
        --webroot -w /var/www/certbot \
        --quiet
done
