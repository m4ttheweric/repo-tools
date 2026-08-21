#!/bin/bash
# scripts/release/make-dmg.sh <app> <out.dmg> [signing-identity]
# First-install disk image: APFS, LZFSE, volume "mattstack", drag-to-Applications.
set -euo pipefail

if [ "$#" -lt 2 ] || [ "$#" -gt 3 ]; then
    echo "usage: make-dmg.sh <app> <out.dmg> [signing-identity]" >&2
    exit 2
fi
APP="$1"; OUT="$2"; IDENTITY="${3:-}"

[ -d "$APP" ] || { echo "✗ no app bundle at $APP" >&2; exit 1; }

STAGE="$(mktemp -d "${TMPDIR:-/tmp}/mattstack-release-stage.XXXXXX")"
MOUNTPOINT="$(mktemp -d "${TMPDIR:-/tmp}/mattstack-release-mount.XXXXXX")"
cleanup() {
    # Runs on every exit path, including a failed attach/verify, so a busted
    # build never leaves a volume mounted behind it.
    hdiutil detach "$MOUNTPOINT" -quiet -force >/dev/null 2>&1 || true
    rm -rf "$STAGE" "$MOUNTPOINT"
}
trap cleanup EXIT

ditto "$APP" "$STAGE/$(basename "$APP")"
ln -s /Applications "$STAGE/Applications"

rm -f "$OUT"
mkdir -p "$(dirname "$OUT")"
hdiutil create -volname "mattstack" -srcfolder "$STAGE" -ov -fs APFS -format ULFO -quiet "$OUT"

hdiutil attach "$OUT" -quiet -nobrowse -mountpoint "$MOUNTPOINT"
[ -L "$MOUNTPOINT/Applications" ] || { echo "✗ built DMG missing Applications symlink" >&2; exit 1; }
[ -d "$MOUNTPOINT/$(basename "$APP")" ] || { echo "✗ built DMG missing $(basename "$APP")" >&2; exit 1; }
hdiutil detach "$MOUNTPOINT" -quiet

if [ -n "$IDENTITY" ]; then
    codesign --force --sign "$IDENTITY" --timestamp "$OUT"
    echo "✓ signed $OUT"
fi

echo "✓ $(du -h "$OUT" | cut -f1) $OUT"
