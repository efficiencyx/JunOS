#!/bin/sh
set -e

if [ -z "$DOMAIN" ] || [ "$DOMAIN" = "localhost" ]; then
    echo "[certbot] DOMAIN must be set to a real public domain for TLS issuance"
    sleep infinity
fi

# nginx is up on a self-signed placeholder by the time we get here
# (compose waits for it to be healthy), serving the challenge dir on
# :80. its 30-cert-watch.sh swaps the real cert in once this lands.
#
# a failed first issuance is usually DNS not pointing here yet, or
# :80 not reachable from outside. keep retrying, don't go to sleep
# for 12h. backoff 1, 4, 16, then 60 min, because Let's Encrypt
# allows 5 failed validations per hostname per hour and this stays
# at 4.
wait=60
while [ ! -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]; do
    if certbot certonly \
        --webroot -w /var/www/certbot \
        -d "$DOMAIN" \
        -m "${EMAIL:-admin@$DOMAIN}" \
        --agree-tos \
        --non-interactive \
        --keep-until-expiring; then
        break
    fi
    echo "[certbot] issuance for $DOMAIN failed, retrying in ${wait}s. check that $DOMAIN resolves to this machine and port 80 is reachable from the internet."
    sleep "$wait"
    wait=$((wait * 4))
    [ "$wait" -gt 3600 ] && wait=3600
done

# certbot looks every 12h and only renews when the cert is close
# to expiry. nginx picks the new one up on its own, see above.
while :; do
    sleep 12h
    certbot renew \
        --webroot -w /var/www/certbot \
        --quiet \
        || echo "[certbot] renewal failed, trying again in 12h"
done
