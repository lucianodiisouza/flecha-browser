#!/bin/bash
# Makes the Sparkle update feed for a release: given the notarized dmg from
#   FLECHA_SIGN_IDENTITY=... FLECHA_NOTARY_PROFILE=... chromium/scripts/package-release.sh --dmg
# it fills a folder to publish on flecha.dev as it is: the dmg and appcast.xml, the feed the
# app reads (SUFeedURL https://flecha.dev/appcast.xml, patch 0053), with the dmg's EdDSA
# signature, made by Sparkle's generate_appcast with the private key in the login Keychain
# (the one generate_keys -p shows the public half of, the app's SUPublicEDKey).
#
#   chromium/scripts/make-appcast.sh <Flecha-<version>.dmg> [<folder>]
#
# The folder ($FLECHA_RELEASE_DIR/appcast by default, next to the dmg) keeps the dmgs of
# earlier releases, for generate_appcast to make delta updates from. The feed lists only
# the newest release: dl.flecha.dev holds only that one, and every release stays on GitHub. Release notes go next to a dmg, with its name and .html or
# .md (Flecha-0.2.0.md), embedded in the feed (flecha.dev serves no notes files). The dmgs are published at $FLECHA_DOWNLOAD_URL_PREFIX
# (https://dl.flecha.dev/ by default, the flecha-releases R2 bucket), and the feed at
# https://flecha.dev/appcast.xml, which the site rewrites to dl.flecha.dev. Nothing is
# uploaded here: publish-release.sh does that.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=env.sh
. "$here/scripts/env.sh"

if [ $# -lt 1 ] || [ $# -gt 2 ]; then
  echo "usage: $0 <Flecha-<version>.dmg> [<folder>]" >&2
  exit 1
fi
dmg="$1"
if [ ! -f "$dmg" ]; then
  echo "error: no $dmg" >&2
  exit 1
fi
release="${FLECHA_RELEASE_DIR:-$release_out/flecha-release}"
folder="${2:-$release/appcast}"
prefix="${FLECHA_DOWNLOAD_URL_PREFIX:-https://dl.flecha.dev/}"
sparkle="$("$here/scripts/fetch-sparkle.sh")"

# Sparkle installs what it downloads only if Gatekeeper would open it: a Developer ID
# signed, notarized and stapled dmg.
echo "== check $dmg"
codesign --verify --strict "$dmg"
xcrun stapler validate "$dmg"
spctl --assess --type open --context context:primary-signature "$dmg"

mkdir -p "$folder"
cp -f "$dmg" "$folder/"

echo "== generate_appcast $folder"
"$sparkle/bin/generate_appcast" \
  --download-url-prefix "$prefix" \
  --maximum-versions 1 \
  --embed-release-notes \
  -o "$folder/$release_feed" \
  --link "https://flecha.dev" \
  "$folder"

feed="$folder/$release_feed"
if [ ! -f "$feed" ] || ! grep -q 'sparkle:edSignature' "$feed"; then
  echo "error: $feed is missing or has no EdDSA signature" >&2
  exit 1
fi
echo "== $(basename "$dmg"): $("$sparkle/bin/sign_update" "$folder/$(basename "$dmg")")"
cat <<EOF

Made $feed. To publish it and the dmg to $prefix:
  chromium/scripts/publish-release.sh $dmg
EOF
