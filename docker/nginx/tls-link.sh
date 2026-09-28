# shellcheck shell=sh
# sourced by 10-pick-config.sh and 30-cert-watch.sh, never run.
# the TLS template reads its certificate from /etc/nginx/tls/.
# these point that at the letsencrypt cert for $DOMAIN once certbot
# has one, and at the self-signed placeholder until then. without
# the placeholder nginx can't start on a fresh volume, and without
# nginx on :80 certbot can't answer the challenge that would get
# the real cert. each one waiting on the other, forever.

tls_source() {
    live="/etc/letsencrypt/live/${DOMAIN:-localhost}"
    if [ -s "$live/fullchain.pem" ] && [ -s "$live/privkey.pem" ]; then
        echo "$live"
    else
        echo /etc/nginx/selfsigned
    fi
}

tls_link() {
    src=$(tls_source)
    mkdir -p /etc/nginx/tls
    ln -sfn "$src/fullchain.pem" /etc/nginx/tls/fullchain.pem
    ln -sfn "$src/privkey.pem" /etc/nginx/tls/privkey.pem
    echo "[tls] certificate from $src"
}
