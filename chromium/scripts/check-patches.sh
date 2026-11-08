#!/bin/bash
# Checks that every patch still applies, in order, to the Chromium in chromium/CHROMIUM_VERSION,
# without a checkout: only the files the patches change are fetched from googlesource, into a
# scratch repo. CI runs this; it needs curl and git, not the build volume.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
version="$(tr -d '[:space:]' <"$here/CHROMIUM_VERSION")"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
cd "$work"
git init -q

# Files a patch creates (--- /dev/null) aren't in Chromium, even when later patches change
# them; every other file a patch changes must be.
created="$(awk '/^--- \/dev\/null/ { getline; sub(/^\+\+\+ b\//, ""); print }' "$here"/patches/*.patch | sort -u)"
files="$(sed -n 's|^--- a/||p' "$here"/patches/*.patch | sort -u | comm -23 - <(echo "$created"))"
echo "fetching $(wc -l <<<"$files" | tr -d ' ') files from Chromium $version"
for f in $files; do
  mkdir -p "$(dirname "$f")"
  # Gitiles hands out a file's raw bytes base64-encoded with ?format=TEXT.
  curl -fsS --retry 3 "https://chromium.googlesource.com/chromium/src/+/refs/tags/$version/$f?format=TEXT" | base64 --decode >"$f"
done

for p in "$here"/patches/*.patch; do
  echo "patch: $(basename "$p")"
  git apply "$p"
done
echo "all patches apply to Chromium $version"
