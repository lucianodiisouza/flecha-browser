#!/bin/bash
# Builds the release (non-component, optimized) Flecha.app and packages it.
#
#   chromium/scripts/build-release.sh [--dmg] [--no-package] [autoninja arguments...]
#
# The release flow, each step safe to run again (a full build takes 3-6 hours; when it stops
# for any reason, run the same command and it carries on where it was):
#   1. builds the shell (chromium/shell/dist; needs `npm ci` at the repo root once);
#   2. puts branding and patches on the checkout with apply.sh, unless this same patch set is
#      already there (out/Release/flecha-applied.sha256): re-applying rewrites every patched
#      file and so recompiles them. FLECHA_REAPPLY=1 applies anyway;
#   3. stages the shell in the checkout at //flecha/shell, where the flecha_shell_dir GN arg
#      (patch 0050) copies it into the framework's Resources/flecha-shell, which is where the
#      app loads it from without --flecha-shell-dir. It sits inside the checkout because the
#      build (siso) only tracks files under the source root; it is not part of Chromium's git;
#      Sparkle.framework (fetch-sparkle.sh) is staged the same way, at //flecha/Sparkle.framework,
#      for the app's Contents/Frameworks (patch 0053);
#   4. writes out/Release/args.gn from chromium/build/release.gn plus Flecha's version
#      (package.json) and build number (see below), only when it changes, so a re-run doesn't
#      regenerate. FLECHA_OFFICIAL=1 adds is_official_build = true: ThinLTO, slower still,
#      and a full rebuild when switched;
#   5. autoninja -C out/Release chrome, under caffeinate so the Mac doesn't sleep;
#   6. package-release.sh: copies the app to out/Release/flecha-release/Flecha, adds the
#      native host (with its Node) and signs it all, ad hoc unless FLECHA_SIGN_IDENTITY names
#      an identity; --dmg also makes Flecha-<version>.dmg there. See that script.
# Then copy Flecha.app to /Applications and run
#   chromium/scripts/install-native-host.sh --app /Applications/Flecha.app
#
# FLECHA_ARCH=x64 builds for Intel Macs instead, into out/Release-x64 (see env.sh); its
# package step needs an Intel Node in FLECHA_NODE.
#
# Dev builds (build.sh, out/Dev) share the checkout: don't run both at once. The release app
# uses the default profile folder, ~/Library/Application Support/Flecha Browser.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=env.sh
. "$here/scripts/env.sh"
root="$(cd "$here/.." && pwd)"
out="$release_out"

package=1
package_args=()
ninja_args=()
for arg in "$@"; do
  case "$arg" in
    --no-package) package=0 ;;
    --dmg) package_args+=(--dmg) ;;
    *) ninja_args+=("$arg") ;;
  esac
done

step() { printf '\n== %s\n' "$*"; }

step "shell"
if [ ! -d "$root/node_modules/esbuild" ]; then
  echo "error: no node_modules in $root; run npm ci there first" >&2
  exit 1
fi
(cd "$root" && node chromium/shell/build.mjs)
if [ ! -f "$here/shell/dist/manifest.json" ]; then
  echo "error: the shell build left no $here/shell/dist/manifest.json" >&2
  exit 1
fi
rules="$here/shell/dist/rules/easylist.json"
if [ ! -f "$rules" ] || [ "$(wc -c <"$rules")" -lt 10000 ]; then
  echo "warning: the ad blocker's rules look empty (no network for build-adblock.mjs?)" >&2
fi

step "patches"
mkdir -p "$out"
stamp="$out/flecha-applied.sha256"
want="$(cat "$here"/patches/*.patch "$here/branding/BRANDING" "$here"/branding/mac/* \
  "$here"/branding/logo/*.png | shasum -a 256 | cut -d' ' -f1)"
last="$(ls "$here"/patches/*.patch | tail -n 1)"
if [ "${FLECHA_REAPPLY:-0}" != 1 ] && [ -f "$stamp" ] && [ "$(cat "$stamp")" = "$want" ] &&
  (cd "$src" && git apply --reverse --check "$last" 2>/dev/null); then
  echo "already applied (FLECHA_REAPPLY=1 to apply again)"
else
  rm -f "$stamp"
  "$here/scripts/apply.sh"
  echo "$want" >"$stamp"
fi

step "stage the shell at //flecha/shell"
staged="$src/flecha/shell"
if diff -rq "$here/shell/dist" "$staged" >/dev/null 2>&1; then
  echo "unchanged"
else
  # A fresh folder, so its time is newer than the copy in the app and the build copies it.
  rm -rf "$staged"
  mkdir -p "$src/flecha"
  cp -R "$here/shell/dist" "$staged"
  echo "staged $staged"
fi

step "stage Sparkle at //flecha/Sparkle.framework"
# The official Sparkle 2 release, pinned and checked (fetch-sparkle.sh); the
# flecha_sparkle_framework GN arg (patch 0053) copies it into Contents/Frameworks.
sparkle_dir="$("$here/scripts/fetch-sparkle.sh")"
staged_sparkle="$src/flecha/Sparkle.framework"
if diff -rq "$sparkle_dir/Sparkle.framework" "$staged_sparkle" >/dev/null 2>&1; then
  echo "unchanged"
else
  rm -rf "$staged_sparkle"
  mkdir -p "$src/flecha"
  # cp -R keeps the framework's symlinks (Versions/Current and the top-level links), and,
  # like the shell's, the fresh copy is newer than the one in the app, so the build copies it.
  cp -R "$sparkle_dir/Sparkle.framework" "$staged_sparkle"
  echo "staged $staged_sparkle"
fi

step "$(basename "$out")/args.gn"
# release.gn is the arm64 build; FLECHA_ARCH=x64 (env.sh) swaps the CPU and the feed.
args="$(sed -e "s/^target_cpu = .*/target_cpu = \"$FLECHA_ARCH\"/" \
  -e "s|^flecha_sparkle_feed_url = \"https://flecha.dev/appcast.xml\"|flecha_sparkle_feed_url = \"https://flecha.dev/$release_feed\"|" \
  "$here/build/release.gn")"
# Flecha's own version (patch 0052): package.json's "version" is the one source of it, the
# app's CFBundleShortVersionString. Its CFBundleVersion, which Sparkle compares to decide
# what is newer, is Chromium's BUILD.PATCH plus a build counter: the number of commits in
# Flecha's history (git rev-list --count HEAD), so it only ever grows, both across Flecha
# releases on one Chromium and across Chromium updates (whose BUILD grows), and it is
# already past the 8119.0 the first releases had. FLECHA_BUILD_NUMBER overrides the counter.
flecha_version="$(node -p 'require(process.argv[1]).version' "$root/package.json")"
flecha_build_number="${FLECHA_BUILD_NUMBER:-$(git -C "$root" rev-list --count HEAD)}"
args="$args
flecha_version = \"$flecha_version\"
flecha_build_number = \"$flecha_build_number\""
if [ "${FLECHA_OFFICIAL:-0}" = 1 ]; then
  args="$args
is_official_build = true"
fi
if [ -f "$out/args.gn" ] && [ "$(cat "$out/args.gn")" = "$args" ]; then
  echo "unchanged"
else
  printf '%s\n' "$args" >"$out/args.gn"
  echo "wrote $out/args.gn"
fi

cd "$src"
if [ ! -f "$out/build.ninja" ]; then
  step "gn gen $out"
  gn gen "$out"
fi

step "autoninja -C $out chrome"
caffeinate -i autoninja -C "$out" chrome ${ninja_args[@]+"${ninja_args[@]}"}

if [ "$package" = 1 ]; then
  step "package"
  "$here/scripts/package-release.sh" ${package_args[@]+"${package_args[@]}"}
fi
