#!/bin/bash
# Wrap a built mattstack.app in a DMG shaped like the release artifact.
# Usage: make-dmg.sh <mattstack.app> <out.dmg>
set -euo pipefail
source "$(cd "$(dirname "$0")/.." && pwd)/lib/common.sh"
APP="${1:-}"; OUT="${2:-}"
[ -d "$APP" ] && [ -n "$OUT" ] || vm_die "usage: make-dmg.sh <mattstack.app> <out.dmg>"
[ "$(basename "$APP")" = "mattstack.app" ] || vm_die "bundle must be named mattstack.app (got $(basename "$APP"))"
REL="$VM_ROOT/../../scripts/release"
if [ -x "$REL/make-dmg.sh" ]; then
  # L4's recipe is the artifact under test once it exists.
  "$REL/make-dmg.sh" "$APP" "$OUT"
else
  STAGE=$(mktemp -d); trap 'rm -rf "$STAGE"' EXIT
  ditto "$APP" "$STAGE/mattstack.app"
  ln -s /Applications "$STAGE/Applications"
  rm -f "$OUT"
  hdiutil create -quiet -volname mattstack -srcfolder "$STAGE" -ov -format UDZO "$OUT"
fi
vm_log "dmg → $OUT ($(du -h "$OUT" | cut -f1))"
