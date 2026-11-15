#!/usr/bin/env bash
# start.sh's model update check against a fake hf cache and a canned
# HF tree, no docker, no network
set -euo pipefail
cd "$(dirname "$0")/../.."
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT

docker() { [ "$1 $2" = "exec -i" ] && shift 3 && "$@"; }
curl() {
  printf '%s' '[{"type":"file","oid":"1","size":9,"path":"README.md"},{"type":"file","oid":"2","size":5,"lfs":{"oid":"mm","size":5,"pointerSize":1},"path":"X.BF16-mmproj.gguf"},{"type":"file","oid":"3","size":7,"lfs":{"oid":"bbb","size":7381383840,"pointerSize":1},"path":"X.Q4_K_M.gguf"}]'
}
eval "$(sed -n '/^hf_gguf_lfs() {/,/^gb() {/p' start.sh)"

[ "$(hf_gguf_lfs o/r q4_k_m)" = "bbb 7381383840" ] || { echo "hf_gguf_lfs: $(hf_gguf_lfs o/r q4_k_m)"; exit 1; }
[ -z "$(hf_gguf_lfs o/r Q8_0)" ] || { echo "hf_gguf_lfs matched a quant that isn't there"; exit 1; }

d="$tmp/models--o--r"
mkdir -p "$d/blobs" "$d/snapshots/old" "$d/snapshots/new"
head -c 3000 /dev/zero > "$d/blobs/aaa"; head -c 10 /dev/zero > "$d/blobs/bbb"; head -c 5 /dev/zero > "$d/blobs/mm"
ln -s ../../blobs/aaa "$d/snapshots/old/X.Q4_K_M.gguf"; ln -s ../../blobs/mm "$d/snapshots/old/X.BF16-mmproj.gguf"
ln -s ../../blobs/bbb "$d/snapshots/new/X.Q4_K_M.gguf"; ln -s ../../blobs/mm "$d/snapshots/new/X.BF16-mmproj.gguf"

[ "$(llamacpp_old_snapshots "$d" bbb)" = 3000 ] || { echo "old bytes: $(llamacpp_old_snapshots "$d" bbb)"; exit 1; }
[ -z "$(llamacpp_old_snapshots "$d" nope)" ] || { echo "sized a cache that doesn't hold the new file"; exit 1; }
llamacpp_old_snapshots "$d" bbb rm
[ ! -e "$d/blobs/aaa" ] && [ ! -e "$d/snapshots/old" ] || { echo "old version still there"; exit 1; }
[ -e "$d/blobs/bbb" ] && [ -e "$d/blobs/mm" ] && [ -L "$d/snapshots/new/X.BF16-mmproj.gguf" ] || { echo "removed something the new version uses"; exit 1; }
[ -z "$(llamacpp_old_snapshots "$d" bbb)" ] || { echo "still sizes something after rm"; exit 1; }
echo "model-update: ok"
