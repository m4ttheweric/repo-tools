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
# generate_keys -x emits a trailing newline the offline fixture doesn't reproduce.
SPARKLE_ED_KEY="$(printf '%s' "$SPARKLE_ED_KEY" | tr -d '\r\n')"

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

# Branches on the HTTP STATUS, not curl's exit code.
#
# The exit code is not a reliable proxy: fetching a missing asset from
# `releases/latest/download/...` redirects, and curl reported
# "The requested URL returned error: 404" while exiting 56 (recv failure)
# rather than the 22 that `-f` documents. That aborted the first release with
# a message flatly contradicting the line above it — a genuine 404 reported as
# "not a 404".
#
# Intent is unchanged: a real 4xx means "no previous appcast, first release",
# while a network-level failure still aborts rather than silently degrading a
# DNS blip into a fresh appcast that drops every existing delta.
fetch_or_abort() {
    local url="$1" dest="$2" ctx="$3" rc=0 status
    status="$(curl -sSL -o "$dest" -w '%{http_code}' "$url")" || rc=$?

    if [ "$rc" -eq 0 ] && [ "$status" -ge 200 ] && [ "$status" -lt 300 ]; then
        return 0
    fi

    rm -f "$dest"
    if [ "$status" -ge 400 ] && [ "$status" -lt 500 ]; then
        return 22
    fi
    echo "✗ failed to fetch $ctx (curl exit $rc, HTTP ${status:-none} — not a 4xx, aborting rather than degrading silently)" >&2
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

# Sparkle refuses a directory holding two archives of the same bundle version
# ("Duplicate updates are not supported"), and out/ has both by design: the zip
# is what Sparkle updates from — this script already asserts exactly one and
# verifies its enclosure below — while the dmg is the human download. So the
# dmg steps aside for the generation and comes straight back.
#
# Restored via trap, not just on the happy path: Checksums, the release-asset
# assertion and Create Release all read the dmg out of this directory, so
# leaving it parked on a failure would turn one red step into three.
DMG_PARK=""
restore_dmg() {
    [ -n "$DMG_PARK" ] || return 0
    for parked in "$DMG_PARK"/*.dmg; do
        [ -e "$parked" ] && mv "$parked" "$ARCHIVES/"
    done
    rmdir "$DMG_PARK" 2>/dev/null || true
    DMG_PARK=""
}
trap 'restore_dmg; cleanup_old_files' EXIT

if ls "$ARCHIVES"/*.dmg >/dev/null 2>&1; then
    DMG_PARK="$(mktemp -d "${TMPDIR:-/tmp}/mattstack-appcast-dmg.XXXXXX")"
    mv "$ARCHIVES"/*.dmg "$DMG_PARK/"
    echo "  → dmg set aside for appcast generation (Sparkle updates from the zip)"
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

restore_dmg

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
