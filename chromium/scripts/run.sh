#!/bin/bash
# Launches the dev build (out/Dev/Flecha.app) with its own profile. The Flecha shell is a
# component extension (it can't be removed or turned off); --flecha-shell-dir points it at
# chromium/shell/dist, so shell changes need no C++ build: rebuild the shell
# (node chromium/shell/build.mjs) and relaunch. Extra arguments go to Chromium, e.g.
# --flecha-show-top-chrome.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=env.sh
. "$here/scripts/env.sh"
profile="${FLECHA_PROFILE:-$FLECHA_DISK/profiles/dev}"
shell_dist="$here/shell/dist"

if [ ! -d "$shell_dist" ]; then
  echo "note: $shell_dist does not exist yet; build the shell first" >&2
fi
mkdir -p "$profile"
# Chromium keeps running the cached background script of a component extension across
# launches while its version stays the same, even after its files change; drop the cache so
# the new shell runs. (Extension data, chrome.storage, lives elsewhere and stays.)
rm -rf "$profile/Default/Service Worker"

exec "$src/out/Dev/Flecha.app/Contents/MacOS/Flecha" \
  --user-data-dir="$profile" \
  --flecha-shell-dir="$shell_dist" \
  "$@"
