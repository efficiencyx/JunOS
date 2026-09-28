#!/bin/sh
# Runs from /docker-entrypoint.d/ before nginx reads any template.
# deletes whichever template does NOT match TLS_MODE, so only one
# omega.conf comes out the other side.
set -e

TLS_MODE="${TLS_MODE:-off}"

# the cert TLS_MODE=off serves for real, and the placeholder
# TLS_MODE=on starts on while there is no letsencrypt cert yet
# (see 30-cert-watch.sh).
#
# every name the phone might type goes in the SAN, the LAN
# addresses start.sh puts in OMEGA_EXTRA_HOSTS too. otherwise
# https://192.168.1.42 gets a name mismatch on top of the
# self-signed warning. that list moves with DHCP, so the SAN we
# minted is kept next to the cert and a different one means a
# new cert (and clicking through the browser warning once more).
#
# 825 days and serverAuth are apple's rules. iOS rejects a TLS
# cert without either, self-signed or not. CA:FALSE because
# firefox calls a CA cert used as the server's own a different
# error than plain self-signed.
make_selfsigned() {
    dir=/etc/nginx/selfsigned
    san="DNS:${DOMAIN:-localhost},DNS:localhost,IP:127.0.0.1"
    for h in $(printf '%s' "${OMEGA_EXTRA_HOSTS:-}" | tr ',' ' '); do
        case $h in
            *[!0-9.]*) case $h in *:*) san="$san,IP:$h" ;; *) san="$san,DNS:$h" ;; esac ;;
            *) san="$san,IP:$h" ;;
        esac
    done
    if [ -s "$dir/fullchain.pem" ] && [ "$(cat "$dir/san" 2>/dev/null)" = "$san" ] &&
        openssl x509 -checkend 2592000 -noout -in "$dir/fullchain.pem" >/dev/null 2>&1; then
        return 0
    fi
    echo "[10-pick-config] Generating self-signed certificate for $san"
    mkdir -p "$dir"
    openssl req -x509 -nodes -newkey rsa:2048 -days 825 \
        -subj "/CN=${DOMAIN:-localhost}" \
        -addext "subjectAltName=$san" \
        -addext "basicConstraints=critical,CA:FALSE" \
        -addext "extendedKeyUsage=serverAuth" \
        -keyout "$dir/privkey.pem" \
        -out "$dir/fullchain.pem" 2>/dev/null
    printf '%s' "$san" >"$dir/san"
}

make_selfsigned

if [ "$TLS_MODE" = "on" ]; then
    echo "[10-pick-config] TLS_MODE=on - using TLS template, removing plain template"
    rm -f /etc/nginx/templates/omega.conf.template
    . /usr/local/lib/omega-tls-link.sh
    tls_link
else
    echo "[10-pick-config] TLS_MODE=off - self-signed HTTPS, :80 only redirects, removing certbot TLS template"
    rm -f /etc/nginx/templates/omega-tls.conf.template
fi
