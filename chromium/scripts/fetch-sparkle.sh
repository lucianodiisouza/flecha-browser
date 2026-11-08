#!/bin/bash
# Fetches Sparkle, Flecha's auto-updater, from its official GitHub release, checks it against
# the pinned SHA-256 and unpacks it. Prints the folder it is in. Safe to run again: a folder
# already unpacked and checked is reused.
#
#   chromium/scripts/fetch-sparkle.sh
#
# The folder ($FLECHA_SPARKLE_DIR, default $FLECHA_DISK/vendor/Sparkle-<version>) holds the
# release as Sparkle ships it: Sparkle.framework (which build-release.sh stages into the
# checkout and the flecha_sparkle_framework GN arg copies into the app, patch 0053) and bin/
# (generate_keys, sign_update, generate_appcast, used by make-appcast.sh).
#
# To move to a newer Sparkle 2: take the .tar.xz of its release at
# https://github.com/sparkle-project/Sparkle/releases (not a beta), and update the version
# and the SHA-256 GitHub lists for that asset, below.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=env.sh
. "$here/scripts/env.sh"

sparkle_version="2.10.0"
sparkle_url="https://github.com/sparkle-project/Sparkle/releases/download/$sparkle_version/Sparkle-$sparkle_version.tar.xz"
sparkle_sha256="c2bf58aa8387266ac179357b1415d6f2635f044da8be41042af32425dae6da0c"

dir="${FLECHA_SPARKLE_DIR:-$FLECHA_DISK/vendor/Sparkle-$sparkle_version}"
stamp="$dir/.flecha-sha256"
if [ -f "$stamp" ] && [ "$(cat "$stamp")" = "$sparkle_sha256" ] &&
  [ -d "$dir/Sparkle.framework" ] && [ -x "$dir/bin/sign_update" ]; then
  echo "$dir"
  exit 0
fi

archive="$(mktemp -d)/Sparkle-$sparkle_version.tar.xz"
echo "fetching $sparkle_url" >&2
curl --fail --location --silent --show-error --proto '=https' -o "$archive" "$sparkle_url"
got="$(shasum -a 256 "$archive" | cut -d' ' -f1)"
if [ "$got" != "$sparkle_sha256" ]; then
  echo "error: $archive has SHA-256 $got, expected $sparkle_sha256" >&2
  exit 1
fi

# A fresh, empty folder: nothing from an older or partial unpack is mixed in.
rm -rf "$dir"
mkdir -p "$dir"
tar -xJf "$archive" -C "$dir"
rm -f "$archive"
if [ ! -d "$dir/Sparkle.framework" ] || [ ! -x "$dir/bin/sign_update" ]; then
  echo "error: $dir has no Sparkle.framework or bin/sign_update; did the archive change shape?" >&2
  exit 1
fi
# The framework is Sparkle's own signed build; make sure it still is.
codesign --verify --deep --strict "$dir/Sparkle.framework" >&2
echo "$sparkle_sha256" >"$stamp"
echo "$dir"
