# Sourced by the other scripts: where Chromium lives, with the APFS build volume mounted.
#
# On a Mac the checkout sits on an APFS volume (a disk image on the external disk) because
# the disk itself is HFS+, whose one-second file times make siso think every output is
# stale, so every build was a full two-hour rebuild. Linux file systems need no such volume.
case "$(uname -s)" in
  Darwin)
    flecha_os=mac
    FLECHA_DISK="${FLECHA_DISK:-/Volumes/EXT_FLASH_1TB/projs/flecha}"
    FLECHA_VOLUME="${FLECHA_VOLUME:-/Volumes/FlechaBuild}"
    if [ ! -d "$FLECHA_VOLUME/chromium" ]; then
      hdiutil attach -quiet "$FLECHA_DISK/FlechaBuild.sparsebundle"
    fi
    ;;
  Linux)
    flecha_os=linux
    FLECHA_DISK="${FLECHA_DISK:-$HOME/flecha}"
    FLECHA_VOLUME="${FLECHA_VOLUME:-$FLECHA_DISK}"
    ;;
  *) echo "error: Flecha builds on macOS or Linux, not $(uname -s)" >&2; exit 1 ;;
esac
src="${CHROMIUM_SRC:-$FLECHA_VOLUME/chromium/src}"
export PATH="${DEPOT_TOOLS:-$FLECHA_DISK/depot_tools}:$PATH"

# Release builds per CPU (build-release.sh, package-release.sh, make-appcast.sh):
# FLECHA_ARCH=arm64 (Apple silicon, the default) or x64 (Intel, cross-compiled here). Each
# has its own output folder, dmg name and Sparkle feed, so an Intel Mac is never offered
# the arm64 app and the other way round. arm64 keeps the names the first releases had.
FLECHA_ARCH="${FLECHA_ARCH:-arm64}"
case "$FLECHA_ARCH" in
  arm64) release_out="$src/out/Release"; release_suffix=""; release_feed="appcast.xml"; node_arch="arm64" ;;
  x64) release_out="$src/out/Release-x64"; release_suffix="-x64"; release_feed="appcast-x64.xml"; node_arch="x86_64" ;;
  *) echo "error: FLECHA_ARCH must be arm64 or x64, not $FLECHA_ARCH" >&2; exit 1 ;;
esac
