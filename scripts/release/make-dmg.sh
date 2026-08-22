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

STAGE=""
MOUNTPOINT=""
cleanup() {
    # A trap that fails, or that falls through to its own last command's
    # status, silently overwrites the script's real exit code — capture it
    # first and re-exit with it explicitly once cleanup is done.
    local rc=$?
    if [ -n "$MOUNTPOINT" ]; then
        hdiutil detach "$MOUNTPOINT" -force >/dev/null 2>&1 || true
        rm -rf "$MOUNTPOINT" || true
    fi
    if [ -n "$STAGE" ]; then
        rm -rf "$STAGE" || true
    fi
    exit "$rc"
}
trap cleanup EXIT

STAGE="$(mktemp -d -t mattstack-release-stage)"
MOUNTPOINT="$(mktemp -d -t mattstack-release-mount)"

ditto "$APP" "$STAGE/$(basename "$APP")"
ln -s /Applications "$STAGE/Applications"

rm -f "$OUT"
mkdir -p "$(dirname "$OUT")"
hdiutil create -volname "mattstack" -srcfolder "$STAGE" -ov -fs APFS -format ULFO -quiet "$OUT"

hdiutil attach "$OUT" -quiet -nobrowse -mountpoint "$MOUNTPOINT"
[ -L "$MOUNTPOINT/Applications" ] || { echo "✗ built DMG missing Applications symlink" >&2; exit 1; }
[ -d "$MOUNTPOINT/$(basename "$APP")" ] || { echo "✗ built DMG missing $(basename "$APP")" >&2; exit 1; }
hdiutil detach "$MOUNTPOINT" -quiet -force

if [ -n "$IDENTITY" ]; then
    codesign --force --sign "$IDENTITY" --timestamp "$OUT"
    echo "✓ signed $OUT"
fi

echo "✓ $(du -h "$OUT" | cut -f1) $OUT"
