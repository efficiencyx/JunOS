#!/bin/sh
# TLS_MODE=on only. nginx reads its certificate once, at start or
# reload, and nothing tells it when certbot writes a new one: not
# the first issuance (it's still on the placeholder then) and not
# a renewal every ~60 days. without this it serves the old cert
# until somebody restarts it, and at day 90 that cert is expired.
# so poll, and reload when the file actually changed.
#
# every 60s while on the placeholder, hourly after that. renewals
# land 30 days before expiry, an hour late is nothing.
# CERT_WATCH_INTERVAL overrides both (CI sets it to 1).

[ "${TLS_MODE:-off}" = "on" ] || exit 0

. /usr/local/lib/omega-tls-link.sh

fingerprint() {
    src=$(tls_source)
    echo "$src $(sha256sum "$src/fullchain.pem" 2>/dev/null)"
}

(
    seen=$(fingerprint)
    while :; do
        case $seen in
            /etc/nginx/selfsigned*) sleep "${CERT_WATCH_INTERVAL:-60}" ;;
            *) sleep "${CERT_WATCH_INTERVAL:-3600}" ;;
        esac
        now=$(fingerprint)
        [ "$now" = "$seen" ] && continue
        tls_link
        # a failed reload leaves the old config running, so keep
        # $seen and try again next round
        if nginx -t -q && nginx -s reload; then
            echo "[tls] reloaded nginx"
            seen=$now
        fi
    done
) &
