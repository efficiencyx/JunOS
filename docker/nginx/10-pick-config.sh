#!/bin/sh
# Runs from /docker-entrypoint.d/ before nginx reads any template.
# deletes whichever template does NOT match TLS_MODE, so only one
# omega.conf comes out the other side.
set -e

TLS_MODE="${TLS_MODE:-off}"

# the cert TLS_MODE=off serves for real, and the placeholder
# TLS_MODE=on starts on while there is no letsencrypt cert yet
# (see 30-cert-watch.sh). signed by a CA that's local to this
# install, so `./start.sh trust` can put the CA in the browser's
# trust store once and every leaf after that just works.
#
# every name the phone might type goes in the SAN, the LAN
# addresses start.sh puts in OMEGA_EXTRA_HOSTS too. otherwise
# https://192.168.1.42 gets a name mismatch on top of the
# untrusted warning. that list moves with DHCP, so the SAN we
# minted is kept next to the cert and a different one means a
# new leaf. same CA though, so a trusted box doesn't notice.
#
# 825 days and serverAuth are apple's rules. iOS rejects a TLS
# cert without either. CA:FALSE on the leaf because firefox calls
# a CA cert used as the server's own a different error.
dir=/etc/nginx/selfsigned

# the CA has nameConstraints, the list of names it's allowed to
# sign for. ca.key sits in a docker volume, and a CA in your trust
# store without them can vouch for your bank just as well as for
# her. with them it covers localhost, the private ranges, the
# usual LAN suffixes and whatever was in the SAN when it was made.
# a later host outside all that fails `openssl verify`, which gets
# a new CA (and the trust has to be redone, start.sh says so).
ca_constraints() {
    nc="permitted;DNS:localhost,permitted;DNS:local,permitted;DNS:lan,permitted;DNS:internal,permitted;DNS:home.arpa"
    for net in 127.0.0.0/255.0.0.0 10.0.0.0/255.0.0.0 172.16.0.0/255.240.0.0 192.168.0.0/255.255.0.0 \
        169.254.0.0/255.255.0.0 100.64.0.0/255.192.0.0 ::1/ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff \
        fc00::/fe00:: fe80::/ffc0::; do
        nc="$nc,permitted;IP:$net"
    done
    for name in $(printf '%s' "$1" | tr ',' ' '); do
        case $name in
            IP:*:*) nc="$nc,permitted;$name/ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff" ;;
            IP:*) nc="$nc,permitted;$name/255.255.255.255" ;;
            *) nc="$nc,permitted;$name" ;;
        esac
    done
    printf '%s' "$nc"
}

make_ca() {
    echo "[10-pick-config] Generating local CA"
    (umask 077 && openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$dir/ca.key" 2>/dev/null)
    openssl req -x509 -new -key "$dir/ca.key" -days 3650 \
        -subj "/O=Jun OS/CN=Jun OS local CA $(openssl rand -hex 4)" \
        -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
        -addext "keyUsage=critical,keyCertSign,cRLSign" \
        -addext "nameConstraints=critical,$(ca_constraints "$1")" \
        -out "$dir/ca.pem" 2>/dev/null
}

make_leaf() {
    (umask 077 && openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 -out "$dir/privkey.pem" 2>/dev/null)
    openssl req -x509 -new -key "$dir/privkey.pem" -CA "$dir/ca.pem" -CAkey "$dir/ca.key" -days 825 \
        -subj "/CN=${DOMAIN:-localhost}" \
        -addext "subjectAltName=$1" \
        -addext "basicConstraints=critical,CA:FALSE" \
        -addext "keyUsage=critical,digitalSignature,keyEncipherment" \
        -addext "extendedKeyUsage=serverAuth" \
        -out "$dir/fullchain.pem" 2>/dev/null
}

ca_vouches() {
    openssl verify -CAfile "$dir/ca.pem" -purpose sslserver "$dir/fullchain.pem" >/dev/null 2>&1
}

make_cert() {
    san="DNS:${DOMAIN:-localhost},DNS:localhost,IP:127.0.0.1"
    for h in $(printf '%s' "${OMEGA_EXTRA_HOSTS:-}" | tr ',' ' '); do
        case $h in
            *[!0-9.]*) case $h in *:*) san="$san,IP:$h" ;; *) san="$san,DNS:$h" ;; esac ;;
            *) san="$san,IP:$h" ;;
        esac
    done
    mkdir -p "$dir"
    if [ ! -s "$dir/ca.key" ] || ! openssl x509 -checkend 2592000 -noout -in "$dir/ca.pem" >/dev/null 2>&1; then
        make_ca "$san"
    fi
    if [ -s "$dir/fullchain.pem" ] && [ "$(cat "$dir/san" 2>/dev/null)" = "$san" ] &&
        openssl x509 -checkend 2592000 -noout -in "$dir/fullchain.pem" >/dev/null 2>&1 && ca_vouches; then
        return 0
    fi
    echo "[10-pick-config] Generating certificate for $san"
    make_leaf "$san"
    if ! ca_vouches; then
        echo "[10-pick-config] $san is outside the local CA's names, making a new CA"
        make_ca "$san"
        make_leaf "$san"
    fi
    printf '%s' "$san" >"$dir/san"
}

make_cert

if [ "$TLS_MODE" = "on" ]; then
    echo "[10-pick-config] TLS_MODE=on - using TLS template, removing plain template"
    rm -f /etc/nginx/templates/omega.conf.template
    . /usr/local/lib/omega-tls-link.sh
    tls_link
else
    echo "[10-pick-config] TLS_MODE=off - local-CA HTTPS, :80 only redirects, removing certbot TLS template"
    rm -f /etc/nginx/templates/omega-tls.conf.template
fi
