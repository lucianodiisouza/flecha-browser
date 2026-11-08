#!/bin/bash
# Puts Flecha on top of a Chromium checkout: branding files, then our patches.
# Safe to run again: it first resets every file it touches.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=env.sh
. "$here/scripts/env.sh"
theme="$src/chrome/app/theme/chromium"
cd "$src"

# Undo a previous run, last patch first.
# shellcheck disable=SC2045 # the patch names have no spaces; ls -r gives the reverse order
for p in $(ls -r "$here"/patches/*.patch); do
  if git apply --reverse --check "$p" 2>/dev/null; then git apply --reverse "$p"; fi
done
git checkout -- chrome/app/theme/chromium

cp "$here/branding/BRANDING" "$theme/BRANDING"
cp "$here/branding/mac/app.icns" "$here/branding/mac/Assets.car" "$theme/mac/"
for png in "$here"/branding/logo/*.png; do cp "$png" "$theme/"; done

for p in "$here"/patches/*.patch; do
  echo "patch: $(basename "$p")"
  git apply "$p"
done

echo "Flecha applied to $src"
