#!/bin/bash
# scripts/release/appcast.sh <archives-dir> <tag>
# Generates/updates appcast.xml for the zip in <archives-dir>. Pulls the
# previous feed + up to two previous enclosures (for deltas) from the
# latest GitHub Release, signs with SPARKLE_ED_KEY (stdin to generate_appcast),
# and leaves only NEW files in <archives-dir>: the new zip, *.delta, appcast.xml.
set -euo pipefail

if [ "$#" -ne 2 ]; then
    echo "usage: appcast.sh <archives-dir> <tag>" >&2
    exit 2
fi
ARCHIVES="$1"; TAG="$2"

if [ -z "${SPARKLE_ED_KEY:-}" ]; then
    echo "✗ SPARKLE_ED_KEY is required (private EdDSA key)" >&2
    exit 1
fi

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
GEN="$ROOT/rt-tray/deps/tools/sparkle/bin/generate_appcast"
[ -x "$GEN" ] || { echo "✗ $GEN missing — run scripts/fetch-deps.sh" >&2; exit 1; }

REPO="${GITHUB_REPOSITORY:-m4ttstack/rt}"
PREFIX="https://github.com/$REPO/releases/download/$TAG/"

NEW_ZIP="$(ls "$ARCHIVES"/mattstack-*.zip 2>/dev/null | head -1 || true)"
[ -n "$NEW_ZIP" ] && [ -f "$NEW_ZIP" ] || { echo "✗ no mattstack-*.zip in $ARCHIVES" >&2; exit 1; }

OLD_FILES=()
if curl -fsSL -o "$ARCHIVES/appcast.xml" "https://github.com/$REPO/releases/latest/download/appcast.xml"; then
    echo "→ previous appcast fetched"
    # Enclosure URLs, newest first; the two newest become delta sources.
    for url in $(grep -o 'url="[^"]*\.zip"' "$ARCHIVES/appcast.xml" | sed 's/url="//; s/"$//' | head -2); do
        f="$ARCHIVES/$(basename "$url")"
        if [ "$f" != "$NEW_ZIP" ] && curl -fsSL -o "$f" "$url"; then
            OLD_FILES+=("$f")
            echo "  fetched $(basename "$f") for deltas"
        fi
    done
else
    rm -f "$ARCHIVES/appcast.xml"
    echo "→ no previous appcast (first release)"
fi

printf '%s' "$SPARKLE_ED_KEY" | "$GEN" --ed-key-file - \
    --download-url-prefix "$PREFIX" \
    --maximum-versions 3 \
    --link "https://github.com/$REPO/releases" \
    "$ARCHIVES"

for f in "${OLD_FILES[@]+"${OLD_FILES[@]}"}"; do rm -f "$f"; done
rm -rf "$ARCHIVES/old_updates"

grep -q "$(basename "$NEW_ZIP")" "$ARCHIVES/appcast.xml" || { echo "✗ appcast.xml does not reference $(basename "$NEW_ZIP")" >&2; exit 1; }
echo "✓ appcast.xml updated; deltas: $(ls "$ARCHIVES"/*.delta 2>/dev/null | wc -l | tr -d ' ')"
