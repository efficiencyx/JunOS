#!/bin/sh
# build.ps1 for linux. start the game once with MelonLoader first, that
# writes MelonLoader/Il2CppAssemblies (even when it then crashes without LinuxFix)
set -eu
[ $# -ge 1 ] || { echo "usage: $0 <game folder> [Release|Debug]" >&2; exit 1; }
game="$1" conf="${2:-Release}" here="$(cd "$(dirname "$0")" && pwd)"
[ -d "$game/MelonLoader/Il2CppAssemblies" ] || { echo "no MelonLoader/Il2CppAssemblies under $game. install MelonLoader and start the game once" >&2; exit 1; }
dotnet build "$here/JunBridge.csproj" -c "$conf" -p:GamePath="$game"
"$here/LinuxFix/build.sh" "$game/MelonLoader" "$conf"
sha256sum "$here/bin/$conf/net6.0/JunBridge.dll" "$here/LinuxFix/bin/$conf/net6.0/JunBridge.LinuxFix.dll"
