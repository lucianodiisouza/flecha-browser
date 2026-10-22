#!/bin/sh
# Rebuilds the raster icons from the SVGs in this folder.
# Needs Google Chrome (headless, for SVG rendering) and the macOS tools sips and iconutil.
set -eu
cd "$(dirname "$0")"

CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# render <svg> <size> <out.png>
render() {
  printf '<html><body style="margin:0;background:transparent"><img src="%s" style="display:block;width:%spx;height:%spx"></body></html>' \
    "file://$PWD/$1" "$2" "$2" > "$TMP/page.html"
  "$CHROME" --headless --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
    --default-background-color=00000000 --window-size="$2,$2" \
    --screenshot="$3" "file://$TMP/page.html" >/dev/null 2>&1
}

render flecha.svg 1024 flecha-1024.png
render flecha-small.svg 1024 "$TMP/small-1024.png"

ICONSET="$TMP/flecha.iconset"
mkdir "$ICONSET"
for size in 16 32 128 256 512; do
  for scale in 1 2; do
    px=$((size * scale))
    name="icon_${size}x${size}"
    [ "$scale" = 2 ] && name="${name}@2x"
    src=flecha-1024.png
    [ "$px" -le 32 ] && src="$TMP/small-1024.png"
    sips -z "$px" "$px" "$src" --out "$ICONSET/$name.png" >/dev/null
  done
done
iconutil -c icns "$ICONSET" -o flecha.icns

render favicon.svg 512 "$TMP/favicon-512.png"
sips -z 32 32 "$TMP/favicon-512.png" --out favicon-32.png >/dev/null
sips -z 180 180 "$TMP/favicon-512.png" --out apple-touch-icon.png >/dev/null
