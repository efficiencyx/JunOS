#!/usr/bin/env bash
# puts jun's local CA in (or takes it out of) every trust store a
# browser on this box reads. `./start.sh trust` and uninstall.sh
# call it.
#
#   tools/trust-ca.sh install|remove <ca.pem>
#
# linux has no one store. the system one (update-ca-certificates
# and friends) covers curl, python, and the distro firefox on
# fedora and arch. chrome and the ubuntu/snap/flatpak firefox
# ignore it and read their own NSS databases (NSS, mozilla's cert
# library), so those get certutil too. WSL: the browser lives on
# the windows side, so it goes in windows' user store instead.
#
# run as root through sudo (the not-in-the-docker-group install)
# the NSS dbs are still the ones in SUDO_USER's home, not root's.
set -euo pipefail

action=${1:-}
ca=${2:-}
case $action in install|remove) ;; *) echo "usage: $0 install|remove <ca.pem>" >&2; exit 2 ;; esac
[ -s "$ca" ] || { echo "no CA at $ca" >&2; exit 1; }
ca=$(cd "$(dirname "$ca")" && pwd)/$(basename "$ca")

# cksum and not a fingerprint. it's coreutils everywhere, the host
# may not have openssl, and all we need is a name that's the same
# for install and remove of one file and differs between CAs.
ca_id=$(cksum <"$ca" | cut -d' ' -f1)
nick="Jun OS local CA $ca_id"

if [ "$(id -u)" -eq 0 ]; then
    SUDO=""
    user=${SUDO_USER:-root}
else
    SUDO=$(command -v sudo || true)
    user=$(id -un)
fi
home=$(getent passwd "$user" 2>/dev/null | cut -d: -f6 || true)
home=${home:-$HOME}
as_user() { if [ "$(id -u)" -eq 0 ] && [ "$user" != root ]; then sudo -u "$user" "$@"; else "$@"; fi; }

failed=0

system_store() {
    local dir refresh
    if [ -d /etc/pki/ca-trust/source/anchors ]; then dir=/etc/pki/ca-trust/source/anchors refresh="update-ca-trust extract"
    elif [ -d /usr/local/share/ca-certificates ]; then dir=/usr/local/share/ca-certificates refresh=update-ca-certificates
    elif [ -d /etc/ca-certificates/trust-source/anchors ]; then dir=/etc/ca-certificates/trust-source/anchors refresh=update-ca-trust
    elif [ -d /etc/pki/trust/anchors ]; then dir=/etc/pki/trust/anchors refresh=update-ca-certificates
    else
        echo "no system CA store this script knows, skipping it"
        return 0
    fi
    if [ "$(id -u)" -ne 0 ] && [ -z "$SUDO" ]; then
        echo "the system store needs root and there's no sudo, skipping it" >&2
        failed=1
        return 0
    fi
    # debian's update-ca-certificates only picks up *.crt
    local file="$dir/jun-os-ca-$ca_id.crt"
    if [ "$action" = install ]; then
        $SUDO install -m 644 "$ca" "$file"
    else
        [ -e "$file" ] || return 0
        $SUDO rm -f "$file"
    fi
    # shellcheck disable=SC2086
    if $SUDO $refresh >/dev/null; then
        echo "system store: $file"
    else
        echo "$refresh failed" >&2
        failed=1
    fi
}

nss_dbs() {
    local d
    for d in "$home/.pki/nssdb" "$home/snap/chromium/current/.pki/nssdb" \
        "$home"/.mozilla/firefox/*/ "$home"/.config/mozilla/firefox/*/ \
        "$home"/snap/firefox/common/.mozilla/firefox/*/ \
        "$home"/.var/app/org.mozilla.firefox/.mozilla/firefox/*/ \
        "$home"/.var/app/org.chromium.Chromium/.pki/nssdb "$home"/.var/app/com.google.Chrome/.pki/nssdb; do
        [ -f "$d/cert9.db" ] && printf '%s\n' "${d%/}"
    done
    return 0
}

nss_stores() {
    # chrome makes ~/.pki/nssdb on its first run. installed and never
    # opened means no db yet, and it would miss the CA forever.
    if [ "$action" = install ] && [ ! -f "$home/.pki/nssdb/cert9.db" ] && command -v certutil >/dev/null &&
        { command -v google-chrome || command -v google-chrome-stable || command -v chromium || command -v chromium-browser; } >/dev/null 2>&1; then
        as_user mkdir -p "$home/.pki/nssdb"
        as_user certutil -N -d "sql:$home/.pki/nssdb" --empty-password
    fi
    local dbs
    dbs=$(nss_dbs)
    [ -n "$dbs" ] || return 0
    if ! command -v certutil >/dev/null; then
        echo "found browser profiles but no certutil. install it (libnss3-tools on debian/ubuntu, nss-tools on fedora/opensuse, nss on arch) and run this again" >&2
        failed=1
        return 0
    fi
    local db
    while IFS= read -r db; do
        if [ "$action" = install ]; then
            as_user certutil -A -d "sql:$db" -t C,, -n "$nick" -i "$ca" && echo "browser db: $db" || failed=1
        else
            as_user certutil -D -d "sql:$db" -n "$nick" 2>/dev/null && echo "browser db: $db" || true
        fi
    done <<<"$dbs"
}

mac_store() {
    if [ "$action" = install ]; then
        $SUDO security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain "$ca" || failed=1
    else
        $SUDO security remove-trusted-cert -d "$ca" 2>/dev/null || true
        local sha1
        sha1=$(openssl x509 -noout -fingerprint -sha1 -in "$ca" | sed 's/.*=//; s/://g')
        $SUDO security delete-certificate -Z "$sha1" /Library/Keychains/System.keychain 2>/dev/null || true
    fi
}

# the user Root store, same as start.ps1. windows asks first, with
# its own dialog, on the windows desktop.
wsl_store() {
    local op=Add
    [ "$action" = remove ] && op=Remove
    powershell.exe -NoProfile -Command "\$c = [Security.Cryptography.X509Certificates.X509Certificate2]::new('$(wslpath -w "$ca")');
        \$s = [Security.Cryptography.X509Certificates.X509Store]::new('Root', 'CurrentUser');
        \$s.Open('ReadWrite'); \$s.$op(\$c); \$s.Close()" || failed=1
}

if [ "$(uname -s)" = Darwin ]; then
    mac_store
    nss_stores
elif grep -qi microsoft /proc/version 2>/dev/null && command -v powershell.exe >/dev/null; then
    wsl_store
else
    system_store
    nss_stores
fi

if [ "$failed" = 1 ]; then
    echo "some stores didn't take it, see above" >&2
    exit 1
fi
