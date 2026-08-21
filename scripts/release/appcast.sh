#!/bin/bash
# scripts/release/appcast.sh <archives-dir> <tag>
# Generates/updates appcast.xml for the zip in <archives-dir>. Pulls the
# previous feed + up to two previous enclosures (for deltas) from the
# latest GitHub Release, signs with SPARKLE_ED_KEY (stdin to generate_appcast),
# restores prior items' download URLs (generate_appcast rewrites every
# enclosure to the current tag's prefix, which would 404 older releases),
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

MATCH_COUNT="$(ls "$ARCHIVES"/mattstack-*.zip 2>/dev/null | wc -l | tr -d ' ')" || true
[ "$MATCH_COUNT" = "1" ] || { echo "✗ expected exactly one mattstack-*.zip in $ARCHIVES, found $MATCH_COUNT" >&2; exit 1; }
NEW_ZIP="$(ls "$ARCHIVES"/mattstack-*.zip)"

# Literal (non-regex) substring replace: URLs carry regex metacharacters
# that would corrupt a sed/awk-gsub pattern match.
literal_replace_in_file() {
    local file="$1" old="$2" new="$3"
    awk -v old="$old" -v new="$new" '
        { line = $0; out = ""
          while ((i = index(line, old)) > 0) {
              out = out substr(line, 1, i - 1) new
              line = substr(line, i + length(old))
          }
          print out line
        }' "$file" > "$file.tmp"
    mv "$file.tmp" "$file"
}

# 0 = fetched; 22 = HTTP error (curl -f), treated as "not found"; anything
# else aborts the whole run rather than silently treating e.g. a DNS blip
# as a clean 404.
fetch_or_abort() {
    local url="$1" dest="$2" ctx="$3" rc=0
    curl -fsSL -o "$dest" "$url" || rc=$?
    [ "$rc" -eq 0 ] && return 0
    rm -f "$dest"
    [ "$rc" -eq 22 ] && return 22
    echo "✗ failed to fetch $ctx (curl exit $rc — not a 404, aborting rather than degrading silently)" >&2
    exit 1
}

OLD_FILES=()
OLD_URLS=()
cleanup_old_files() {
    for f in "${OLD_FILES[@]+"${OLD_FILES[@]}"}"; do rm -f "$f"; done
}
trap cleanup_old_files EXIT

HAVE_PREV=0
if fetch_or_abort "https://github.com/$REPO/releases/latest/download/appcast.xml" "$ARCHIVES/appcast.xml" "previous appcast.xml"; then
    HAVE_PREV=1
    echo "→ previous appcast fetched"
else
    echo "→ no previous appcast (first release)"
fi

if [ "$HAVE_PREV" -eq 1 ]; then
    # Enclosure URLs, newest first; the two newest become delta sources.
    for url in $(grep -o 'url="[^"]*\.zip"' "$ARCHIVES/appcast.xml" | sed 's/url="//; s/"$//' | head -2); do
        f="$ARCHIVES/$(basename "$url")"
        [ "$f" = "$NEW_ZIP" ] && continue
        if fetch_or_abort "$url" "$f" "old enclosure $(basename "$url")"; then
            OLD_FILES+=("$f")
            OLD_URLS+=("$url")
            echo "  fetched $(basename "$f") for deltas"
        fi
    done
fi

GEN_OUTPUT="$(printf '%s' "$SPARKLE_ED_KEY" | env -u SPARKLE_ED_KEY "$GEN" --ed-key-file - \
    --download-url-prefix "$PREFIX" \
    --maximum-versions 3 \
    --link "https://github.com/$REPO/releases" \
    "$ARCHIVES" 2>&1)" || { printf '%s\n' "$GEN_OUTPUT" >&2; echo "✗ generate_appcast failed" >&2; exit 1; }
printf '%s\n' "$GEN_OUTPUT"

if printf '%s' "$GEN_OUTPUT" | grep -q "does not match"; then
    echo "✗ generate_appcast reported a key mismatch (\"does not match\") — SUPublicEDKey does not correspond to SPARKLE_ED_KEY" >&2
    exit 1
fi

# --download-url-prefix rewrites every enclosure to the new tag; items that
# actually shipped under an older tag need their real URL back.
i=0
while [ "$i" -lt "${#OLD_FILES[@]}" ]; do
    f="${OLD_FILES[$i]}"
    origurl="${OLD_URLS[$i]}"
    newurl="$PREFIX$(basename "$f")"
    literal_replace_in_file "$ARCHIVES/appcast.xml" "$newurl" "$origurl"
    i=$((i + 1))
done

rm -rf "$ARCHIVES/old_updates"

ENCLOSURE_COUNT="$(grep -c '<enclosure ' "$ARCHIVES/appcast.xml")" || true
SIG_COUNT="$(grep -c 'sparkle:edSignature=' "$ARCHIVES/appcast.xml")" || true
if [ "$ENCLOSURE_COUNT" = "0" ] || [ "$ENCLOSURE_COUNT" != "$SIG_COUNT" ]; then
    echo "✗ appcast.xml has $ENCLOSURE_COUNT enclosure(s) but $SIG_COUNT edSignature attribute(s) — not every update got signed" >&2
    exit 1
fi

NEW_ZIP_LINE="$(grep '<enclosure' "$ARCHIVES/appcast.xml" | grep -F "$(basename "$NEW_ZIP")" || true)"
[ -n "$NEW_ZIP_LINE" ] || { echo "✗ appcast.xml has no enclosure for $(basename "$NEW_ZIP")" >&2; exit 1; }
case "$NEW_ZIP_LINE" in
    *sparkle:edSignature=*) ;;
    *) echo "✗ new enclosure for $(basename "$NEW_ZIP") is missing sparkle:edSignature" >&2; exit 1 ;;
esac

echo "✓ appcast.xml updated; deltas: $(ls "$ARCHIVES"/*.delta 2>/dev/null | wc -l | tr -d ' ')"
