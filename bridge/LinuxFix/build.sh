#!/bin/sh
set -eu
here="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
[ "$(uname -s)" = Linux ] && [ "$(uname -m)" = x86_64 ] || { echo 'build on Linux x86_64' >&2; exit 1; }
for tool in git cmake c++ dotnet curl unzip python3; do
    command -v "$tool" >/dev/null || { echo "missing build tool: $tool" >&2; exit 1; }
done
ml="${1:-}" conf="${2:-Release}" out="${3:-$here/bin/$conf/net6.0}"
mkdir -p "$out"
out="$(CDPATH= cd -- "$out" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT HUP INT TERM
if [ -z "$ml" ]; then
    curl -fsSL --retry 3 -o "$work/ml.zip" https://github.com/LavaGang/MelonLoader/releases/download/v0.7.3/MelonLoader.Linux.x64.zip
    echo "519f25639cde796a749ea0670daedfa251a45d0217608ac6e12c1bc6aa9e114f  $work/ml.zip" | sha256sum -c -
    unzip -q "$work/ml.zip" 'MelonLoader/net6/*' -d "$work/ml"
    ml="$work/ml/MelonLoader"
fi
ml="$(CDPATH= cd -- "$ml" && pwd)"
dobby_ref=642dd93513d890acb7ceb0312b2c1a0a27668cce
git init -q "$work/dobby"
git -C "$work/dobby" remote add origin https://github.com/Ketlark/Dobby.git
git -C "$work/dobby" fetch -q --depth 1 origin "$dobby_ref"
git -C "$work/dobby" checkout -q --detach FETCH_HEAD
[ "$(git -C "$work/dobby" rev-parse HEAD)" = "$dobby_ref" ]
git -C "$work/dobby" apply --unidiff-zero --check "$here/native/dobby-linux-memory.patch"
git -C "$work/dobby" apply --unidiff-zero "$here/native/dobby-linux-memory.patch"
# gcc only got __has_feature in 14, dobby's headers use it bare
printf '#ifndef __has_feature\n#define __has_feature(x) 0\n#endif\n' > "$work/has-feature.h"
cmake -S "$work/dobby" -B "$work/build" -DCMAKE_BUILD_TYPE=Release \
    -DCMAKE_POLICY_VERSION_MINIMUM=3.5 -DCMAKE_ASM_FLAGS='-x assembler-with-cpp' \
    -DCMAKE_C_FLAGS="-include $work/has-feature.h" -DCMAKE_CXX_FLAGS="-include $work/has-feature.h" \
    -DDOBBY_DEBUG=OFF -DPlugin.SymbolResolver=OFF
cmake --build "$work/build" --target dobby dobby_static --parallel 2
c++ -std=c++17 -O2 -include "$work/has-feature.h" -DDOBBY_LOGGING_DISABLE \
    -I"$work/dobby" -I"$work/dobby/include" -I"$work/dobby/source" \
    -I"$work/dobby/source/dobby" -I"$work/dobby/external" -I"$work/dobby/external/logging" \
    "$here/native/allocator.test.cc" "$work/build/libdobby.a" -ldl -lpthread -o "$work/allocator-test"
"$work/allocator-test"
mkdir -p "$here/bin/native"
cp "$work/build/libdobby.so" "$here/bin/native/dobby.so"
python3 - "$work/dobby" "$here/bin/native/NOTICES.txt" <<'PYTHON'
from pathlib import Path
import sys
source, out = map(Path, sys.argv[1:])
header = (source / 'external/TINYSTL/vector.h').read_text().split('*/', 1)[0]
tiny = '\n'.join(line[3:] if line.startswith(' * ') else '' for line in header.splitlines()[1:]).strip()
out.write_text('JunBridge.LinuxFix embeds Dobby (Apache-2.0) from\n'
    'https://github.com/Ketlark/Dobby/commit/642dd93513d890acb7ceb0312b2c1a0a27668cce\n'
    'derived from https://github.com/jmpews/Dobby.\n'
    'JunOS changes its Linux memory backend and hook error handling;\n'
    'see bridge/LinuxFix/native/dobby-linux-memory.patch.\n\n'
    + (source / 'LICENSE').read_text() + '\n\nTinySTL (BSD-2-Clause)\n\n' + tiny + '\n')
PYTHON
DOTNET_CLI_TELEMETRY_OPTOUT=1
export DOTNET_CLI_TELEMETRY_OPTOUT
dotnet build "$here/JunBridge.LinuxFix.csproj" -c "$conf" \
    -p:MelonLoaderPath="$ml" -p:NativeHookLibraryPath="$here/bin/native/dobby.so" \
    -p:NativeHookNoticesPath="$here/bin/native/NOTICES.txt"
plugin="$here/bin/$conf/net6.0/JunBridge.LinuxFix.dll"
dotnet build "$here/tests/Hooks.csproj" -c Release -o "$work/tests" \
    -p:BaseIntermediateOutputPath="$work/test-obj/" -p:MelonLoaderPath="$ml" -p:LinuxFixPath="$plugin"
dotnet "$work/tests/Hooks.dll"
dotnet "$work/tests/Hooks.dll" repair
if [ "$out" != "$(dirname "$plugin")" ]; then cp "$plugin" "$out/JunBridge.LinuxFix.dll"; fi
sha256sum "$out/JunBridge.LinuxFix.dll"
