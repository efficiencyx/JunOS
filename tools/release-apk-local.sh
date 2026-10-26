#!/usr/bin/env bash
# Rebuilds a draft release's APK against the LiteRT-LM build in NOTICE
# section 6 (the first with Session.clone(), so the phone's prefix cache
# is on) and swaps it into the draft, SHA256SUMS included.
#
#   tools/release-apk-local.sh v1.1.0            build + check only
#   tools/release-apk-local.sh v1.1.0 --upload   then swap it into the draft
#
# Signing comes from the environment, the same names CI uses:
#   JUN_ANDROID_KEYSTORE_BASE64 (or JUN_ANDROID_KEYSTORE, a path)
#   JUN_ANDROID_STORE_PASSWORD  JUN_ANDROID_KEY_ALIAS  JUN_ANDROID_KEY_PASSWORD
#
# LiteRT-LM c30ab949d5605022d2ccf714794e99d5f5effe4c, built with NDK
# 28.0.13004108 and bazelisk (.bazelversion 7.6.1):
#   bazelisk build --config=android_arm64 \
#     //kotlin/java/com/google/ai/edge/litertlm/jni:litertlm_jni \
#     //kotlin/java/com/google/ai/edge/litertlm:litertlm-android
# LITERT_LOCAL holds classes.jar (litertlm-android-kt.jar) and
# jni/arm64-v8a/: liblitertlm_jni.so (llvm-strip --strip-unneeded) plus
# every .so in that commit's prebuilt/android_arm64/ (git lfs pull first).
set -euo pipefail

tag="${1:?usage: tools/release-apk-local.sh vX.Y.Z [--upload]}"
upload="${2:-}"
repo="${JUN_RELEASE_REPO:-efficiencyx/JunOS}"
public="${JUN_PUBLIC:-$HOME/Documenti/Jun-public}"
litert="${LITERT_LOCAL:-$HOME/.cache/jun-litert-build/local}"
apk="JunOS-$tag.apk"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/.local/share/jun-android-sdk}"

die() { echo "release-apk-local: $*" >&2; exit 1; }

[ -f "$litert/classes.jar" ] && [ -f "$litert/jni/arm64-v8a/liblitertlm_jni.so" ] || die "no LiteRT-LM build in $litert"
git -C "$public" rev-parse -q --verify "refs/tags/$tag" >/dev/null || die "$tag is not a tag in $public"
[ "$(gh release view "$tag" -R "$repo" --json isDraft --jq .isDraft)" = true ] || die "$tag is not a draft release, refusing to touch it"
gh release view "$tag" -R "$repo" --json assets --jq '.assets[].name' | grep -qx "$apk" || die "the draft has no $apk yet, wait for release-installer.yml"

work="$(mktemp -d)"
cleanup() {
  git -C "$public" worktree remove --force "$work/src" 2>/dev/null || true
  rm -rf "$work"
}
trap cleanup EXIT

if [ -n "${JUN_ANDROID_KEYSTORE_BASE64:-}" ]; then
  printf '%s' "$JUN_ANDROID_KEYSTORE_BASE64" | base64 -d > "$work/release.jks"
  export JUN_ANDROID_KEYSTORE="$work/release.jks"
fi
[ -f "${JUN_ANDROID_KEYSTORE:-}" ] || die "no keystore: set JUN_ANDROID_KEYSTORE_BASE64 or JUN_ANDROID_KEYSTORE"
for v in JUN_ANDROID_STORE_PASSWORD JUN_ANDROID_KEY_ALIAS JUN_ANDROID_KEY_PASSWORD; do
  [ -n "${!v:-}" ] || die "$v is not set"
done

git -C "$public" worktree add --detach -q "$work/src" "$tag"
# same values release-installer.yml derives, or the update won't install
export JUN_ANDROID_VERSION_CODE="$(git -C "$public" rev-list --count "$tag")"
export JUN_ANDROID_VERSION_NAME="${tag#v}"
(cd "$work/src/android" && sh ./gradlew :app:verifyReleaseContents -PlitertlmLocal="$litert" --no-daemon -q)
built="$work/src/android/app/build/outputs/apk/release/app-release.apk"
[ -f "$built" ] || die "gradle built no signed apk"
unzip -l "$built" | grep -q 'lib/arm64-v8a/libwebgpu_dawn.so' || die "the apk doesn't carry the local LiteRT-LM build"

apksigner="$(printf '%s\n' "$ANDROID_HOME"/build-tools/* | sort -V | tail -1)/apksigner"
gh release download "$tag" -R "$repo" -p "$apk" -p SHA256SUMS -D "$work/draft"
cert() { "$apksigner" verify --print-certs "$1" | grep 'certificate SHA-256 digest'; }
[ "$(cert "$built")" = "$(cert "$work/draft/$apk")" ] || die "signing certificate differs from the draft's apk, an install would refuse the update"
echo "built $apk: versionCode $JUN_ANDROID_VERSION_CODE, $(du -h "$built" | cut -f1), same certificate as the draft"

if [ "$upload" != "--upload" ]; then
  cp "$built" "./$apk"
  echo "left it at ./$apk, run again with --upload to swap it into the draft"
  exit 0
fi

cp "$built" "$work/$apk"
sum="$(cd "$work" && sha256sum "$apk")"
grep -q "  $apk\$" "$work/draft/SHA256SUMS" || die "SHA256SUMS has no line for $apk"
awk -v apk="$apk" -v line="$sum" '$2 == apk { print line; next } { print }' "$work/draft/SHA256SUMS" > "$work/SHA256SUMS"
gh release upload "$tag" -R "$repo" "$work/$apk" "$work/SHA256SUMS" --clobber

# check what the installers will actually download
mkdir "$work/check"
gh release download "$tag" -R "$repo" -D "$work/check"
(cd "$work/check" && sha256sum -c SHA256SUMS)
echo "swapped. re-pushing $tag refills the draft with CI's apk, run this again after that"
