#!/bin/bash
# Puts Flecha's branding and patches on the Chromium checkout, then builds the
# dev (component) app at out/Dev/Flecha.app. Extra arguments go to autoninja.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=env.sh
. "$here/scripts/env.sh"

"$here/scripts/apply.sh"
cd "$src"
autoninja -C out/Dev chrome "$@"
