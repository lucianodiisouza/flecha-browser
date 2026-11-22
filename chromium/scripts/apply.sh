#!/bin/bash
# Puts Flecha on top of a Chromium checkout: branding files, then our patches.
# Safe to run again: it first resets every file it touches.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
shopt -s nullglob
patches=("$here"/patches/*.patch)
shopt -u nullglob
if [[ -z ${patches[0]-} ]]; then
  echo "error: no patches in $here/patches" >&2
  exit 1
fi
for p in "${patches[@]}"; do
  if [[ ! -f $p ]]; then
    echo "error: not a regular patch file: $p" >&2
    exit 1
  fi
done

# shellcheck source=env.sh
. "$here/scripts/env.sh"
theme="$src/chrome/app/theme/chromium"
cd "$src"

# Undo a previous run, last patch first.
for ((i = ${#patches[@]} - 1; i >= 0; i--)); do
  p="${patches[i]}"
  if git apply --reverse --check "$p" 2>/dev/null; then git apply --reverse "$p"; fi
done
git checkout -- chrome/app/theme/chromium

cp "$here/branding/BRANDING" "$theme/BRANDING"
cp "$here/branding/mac/app.icns" "$here/branding/mac/Assets.car" "$theme/mac/"
for png in "$here"/branding/logo/*.png; do cp "$png" "$theme/"; done

for p in "${patches[@]}"; do
  echo "patch: $(basename "$p")"
  git apply "$p"
done

echo "Flecha applied to $src"
