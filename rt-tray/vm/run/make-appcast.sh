#!/bin/bash
# Build the vN+1 Sparkle enclosure + appcast from a built app, for the update phase.
# Usage: make-appcast.sh <mattstack.app> <new-version> <ed-private-key-file> <out-dir> [--sign <identity>]
# The app's SUPublicEDKey must match the private key (L4 build: SPARKLE_PUBLIC_ED_KEY override).
# CFBundleVersion = major*1000000 + minor*1000 + patch — the same scheme as the release build, so
# Sparkle's numeric comparison stays monotonic against real releases.
set -euo pipefail
source "$(cd "$(dirname "$0")/.." && pwd)/lib/common.sh"
APP="${1:-}"; NEWV="${2:-}"; KEY="${3:-}"; OUT="${4:-}"; shift 4 2>/dev/null || true
SIGN="-"
while [ $# -gt 0 ]; do case "$1" in --sign) SIGN="$2"; shift 2;; *) vm_die "unknown arg $1";; esac; done
[ -d "$APP" ] && [ -n "$NEWV" ] && [ -f "$KEY" ] && [ -n "$OUT" ] \
  || vm_die "usage: make-appcast.sh <mattstack.app> <new-version> <ed-key-file> <out-dir> [--sign <identity>]"
echo "$NEWV" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' || vm_die "new-version must be X.Y.Z (got $NEWV)"
NEWB=$(echo "$NEWV" | awk -F. '{ printf "%d", $1*1000000 + $2*1000 + $3 }')

GEN="${SPARKLE_BIN:+$SPARKLE_BIN/}generate_appcast"
command -v "$GEN" >/dev/null 2>&1 || vm_die "generate_appcast not found — download Sparkle-<ver>.tar.xz from https://github.com/sparkle-project/Sparkle/releases, extract, and set SPARKLE_BIN=<extracted>/bin"

mkdir -p "$OUT"; STAGE=$(mktemp -d); trap 'rm -rf "$STAGE"' EXIT
ditto "$APP" "$STAGE/mattstack.app"
PL="$STAGE/mattstack.app/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $NEWV" "$PL"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $NEWB" "$PL"
# Inside-out re-sign: every nested Mach-O first, then the bundle (never --deep).
find "$STAGE/mattstack.app/Contents" -type f -perm -u+x -not -path '*/Info.plist' | while read -r f; do
  file -b "$f" | grep -q Mach-O && codesign --force --options runtime --timestamp=none --sign "$SIGN" "$f" 2>/dev/null || true
done
codesign --force --options runtime --timestamp=none --sign "$SIGN" "$STAGE/mattstack.app"
rm -f "$OUT"/mattstack-*.zip "$OUT"/appcast.xml
REL="$VM_ROOT/../../scripts/release"
if [ -x "$REL/make-zip.sh" ]; then
  "$REL/make-zip.sh" "$STAGE/mattstack.app" "$OUT/mattstack-$NEWV.zip"
else
  (cd "$STAGE" && ditto -c -k --sequesterRsrc --keepParent mattstack.app "$OUT/mattstack-$NEWV.zip")
fi
"$GEN" --ed-key-file "$KEY" --download-url-prefix "http://127.0.0.1:$VM_APPCAST_PORT/" -o "$OUT/appcast.xml" "$OUT"
vm_log "appcast → $OUT/appcast.xml (enclosure mattstack-$NEWV.zip, build $NEWB)"
