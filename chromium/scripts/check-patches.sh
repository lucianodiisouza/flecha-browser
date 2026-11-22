#!/bin/bash
# Checks that every patch still applies, in order, to the Chromium in chromium/CHROMIUM_VERSION,
# without a checkout: only the files the patches change are fetched, into a scratch repo. CI
# runs this; it needs git, not the build volume.
#
# The files come from Chromium's GitHub mirror, which has the same bytes at each release tag.
# A shallow, blobless fetch of the tag plus a sparse checkout downloads them in one batch.
# googlesource's Gitiles answered GitHub's runners with 504s, and raw.githubusercontent.com
# rate-limited them with 429s that curl kept retrying.
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
git remote add origin https://github.com/chromium/chromium.git
git fetch -q --depth=1 --filter=blob:none origin tag "$version"
# Anchor each path at the root and escape glob characters so every pattern matches one file.
sed 's/[][*?\\]/\\&/g; s|^|/|' <<<"$files" | git sparse-checkout set --no-cone --stdin
git -c advice.detachedHead=false checkout -q "$version"

for p in "$here"/patches/*.patch; do
  echo "patch: $(basename "$p")"
  git apply "$p"
done
echo "all patches apply to Chromium $version"
