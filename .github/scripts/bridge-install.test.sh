#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
fixture="$(mktemp -d)"
running_pid=''
trap 'if [ -n "$running_pid" ]; then kill "$running_pid" 2>/dev/null || true; fi; rm -rf "$fixture"' EXIT
python3 - "$root/install.sh" "$fixture/functions.sh" <<'PY'
import pathlib, re, sys
source = pathlib.Path(sys.argv[1]).read_text()
functions = [re.search(r'^' + name + r'\(\) \{\n.*?^\}', source, re.M | re.S).group()
             for name in ('fetch_release_asset', 'install_bridge_mod')]
pathlib.Path(sys.argv[2]).write_text('\n'.join(functions))
PY
source "$fixture/functions.sh"
REPO=fixture
ok() { :; }
note() { :; }
warn_() { :; }
github_slug() { echo efficiencyx/JunOS; }
release_tag() { echo v0.0.0-fixture; }
git() { return 1; }
curl() {
    local destination='' url=''
    while [ "$#" -gt 0 ]; do
        case "$1" in
            -o) destination="$2"; shift 2 ;;
            -*) shift ;;
            *) url="$1"; shift ;;
        esac
    done
    [ -f "$fixture/release/${url##*/}" ] || return 1
    cp "$fixture/release/${url##*/}" "$destination"
}
mkdir -p "$fixture/release" "$fixture/game"
printf 'JunBridge' > "$fixture/release/JunBridge-v0.0.0-fixture.dll"
printf 'LinuxFix' > "$fixture/release/JunBridge.LinuxFix-v0.0.0-fixture.dll"
python3 - "$fixture/release" <<'PY'
from pathlib import Path
import sys, zipfile
root=Path(sys.argv[1])
for name, entry in [('MelonLoader.Linux.x64.zip', 'MelonLoader.Bootstrap.so'), ('MelonLoader.x64.zip', 'version.dll')]:
    with zipfile.ZipFile(root/name, 'w') as archive:
        archive.writestr(entry, 'stock-loader')
PY
(cd "$fixture/release" && sha256sum JunBridge-* JunBridge.* > SHA256SUMS)
cp "$fixture/release/SHA256SUMS" "$fixture/sums.good"
fetch_release_asset JunBridge "$fixture/download.dll"
cmp "$fixture/download.dll" "$fixture/release/JunBridge-v0.0.0-fixture.dll"
printf 'wrong' > "$fixture/release/JunBridge-v0.0.0-fixture.dll"
if fetch_release_asset JunBridge "$fixture/download.dll"; then exit 1; fi
[ "$(cat "$fixture/download.dll")" = JunBridge ]
printf 'JunBridge' > "$fixture/release/JunBridge-v0.0.0-fixture.dll"
printf '' > "$fixture/release/SHA256SUMS"
if fetch_release_asset JunBridge "$fixture/download.dll"; then exit 1; fi
cp "$fixture/sums.good" "$fixture/release/SHA256SUMS"
touch "$fixture/game/My Dystopian Robot Girlfriend.x86_64"
printf 'old-loader' > "$fixture/game/MelonLoader.Bootstrap.so"
printf 'keep-config' > "$fixture/game/JunBridge.cfg"
install_bridge_mod "$fixture/game"
[ "$(cat "$fixture/game/MelonLoader.Bootstrap.so")" = old-loader ]
[ "$(cat "$fixture/game/Plugins/JunBridge.LinuxFix.dll")" = LinuxFix ]
[ "$(cat "$fixture/game/JunBridge.cfg")" = keep-config ]
[ -x "$fixture/game/junos-game.sh" ]
printf 'existing' > "$fixture/game/Mods/JunBridge.dll"
mv "$fixture/release/JunBridge.LinuxFix-v0.0.0-fixture.dll" "$fixture/missing.dll"
if install_bridge_mod "$fixture/game"; then exit 1; fi
[ "$(cat "$fixture/game/MelonLoader.Bootstrap.so")" = old-loader ]
[ "$(cat "$fixture/game/Mods/JunBridge.dll")" = existing ]
mv "$fixture/missing.dll" "$fixture/release/JunBridge.LinuxFix-v0.0.0-fixture.dll"
rm "$fixture/game/MelonLoader.Bootstrap.so"
install_bridge_mod "$fixture/game"
[ "$(cat "$fixture/game/MelonLoader.Bootstrap.so")" = stock-loader ]
mkdir "$fixture/proton"
touch "$fixture/proton/My Dystopian Robot Girlfriend.exe"
printf 'existing-proton' > "$fixture/proton/version.dll"
install_bridge_mod "$fixture/proton"
[ "$(cat "$fixture/proton/version.dll")" = existing-proton ]
[ -f "$fixture/proton/Mods/JunBridge.dll" ]
[ ! -f "$fixture/proton/junos-game.sh" ]
rm "$fixture/proton/version.dll"
install_bridge_mod "$fixture/proton"
[ "$(cat "$fixture/proton/version.dll")" = stock-loader ]
cp /bin/sleep "$fixture/game/My Dystopian Robot Girlfriend.x86_64"
chmod +x "$fixture/game/My Dystopian Robot Girlfriend.x86_64"
"$fixture/game/My Dystopian Robot Girlfriend.x86_64" 60 &
running_pid=$!
for attempt in {1..100}; do
    [ "$(readlink "/proc/$running_pid/exe" 2>/dev/null)" = "$fixture/game/My Dystopian Robot Girlfriend.x86_64" ] && break
    kill -0 "$running_pid"
    sleep 0.01
done
[ "$(readlink "/proc/$running_pid/exe")" = "$fixture/game/My Dystopian Robot Girlfriend.x86_64" ]
if install_bridge_mod "$fixture/game"; then exit 1; fi
[ "$(cat "$fixture/game/MelonLoader.Bootstrap.so")" = stock-loader ]
kill "$running_pid"
wait "$running_pid" 2>/dev/null || true
running_pid=''
echo 'bridge install tests: ok'
