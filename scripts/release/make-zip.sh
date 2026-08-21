#!/bin/bash
# scripts/release/make-zip.sh <app> <out.zip> — the Sparkle update enclosure.
set -euo pipefail

if [ "$#" -ne 2 ]; then
    echo "usage: make-zip.sh <app> <out.zip>" >&2
    exit 2
fi
APP="$1"; OUT="$2"

[ -d "$APP" ] || { echo "✗ no app bundle at $APP" >&2; exit 1; }

rm -f "$OUT"
mkdir -p "$(dirname "$OUT")"
ditto -c -k --sequesterRsrc --keepParent "$APP" "$OUT"

echo "✓ $(du -h "$OUT" | cut -f1) $OUT"
