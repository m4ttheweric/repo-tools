#!/bin/bash
# scripts/release/notarize.sh <target.app|target.dmg>
# Submits to Apple's notary service, waits, staples, validates. Env:
# APPLE_ID APPLE_ID_PASSWORD APPLE_TEAM_ID. On rejection prints the notary log.
set -euo pipefail

if [ "$#" -ne 1 ]; then
    echo "usage: notarize.sh <target.app|target.dmg>" >&2
    exit 2
fi
TARGET="$1"

: "${APPLE_ID:?APPLE_ID is required}"
: "${APPLE_ID_PASSWORD:?APPLE_ID_PASSWORD is required}"
: "${APPLE_TEAM_ID:?APPLE_TEAM_ID is required}"
[ -e "$TARGET" ] || { echo "✗ no such target $TARGET" >&2; exit 1; }

SUBMIT="$TARGET"
TMP=""
case "$TARGET" in
    *.app)
        TMP="$(mktemp -d "${TMPDIR:-/tmp}/mattstack-release-notarize.XXXXXX")"
        SUBMIT="$TMP/$(basename "$TARGET" .app).zip"
        ditto -c -k --keepParent "$TARGET" "$SUBMIT"
        ;;
    *.dmg) ;;
    *) echo "✗ notarize.sh handles .app and .dmg only" >&2; exit 2 ;;
esac
trap '[ -n "$TMP" ] && rm -rf "$TMP"' EXIT

echo "→ submitting $(basename "$SUBMIT") for notarization…"
# notarytool exits nonzero on Invalid — capture the output before branching
# so the log fetch below still runs, instead of set -e killing the script.
RESULT="$(xcrun notarytool submit "$SUBMIT" --apple-id "$APPLE_ID" --password "$APPLE_ID_PASSWORD" --team-id "$APPLE_TEAM_ID" --wait --timeout 45m --output-format json)" || true

ID="$(printf '%s' "$RESULT" | /usr/bin/plutil -extract id raw -o - - 2>/dev/null || printf '%s' "$RESULT" | sed -n 's/.*"id" *: *"\([^"]*\)".*/\1/p' | head -1)"
STATUS="$(printf '%s' "$RESULT" | sed -n 's/.*"status" *: *"\([^"]*\)".*/\1/p' | head -1)"

if [ -z "$STATUS" ]; then
    echo "✗ notarization failed: no status in notarytool output" >&2
    printf '%s\n' "$RESULT" >&2
    exit 1
fi
echo "  submission $ID → $STATUS"

if [ "$STATUS" = "Invalid" ]; then
    echo "✗ notarization rejected (Invalid) — fetching notary log" >&2
    if [ -n "$ID" ]; then
        xcrun notarytool log "$ID" --apple-id "$APPLE_ID" --password "$APPLE_ID_PASSWORD" --team-id "$APPLE_TEAM_ID" || true
    fi
    exit 1
elif [ "$STATUS" != "Accepted" ]; then
    echo "✗ notarization did not complete: status=$STATUS" >&2
    if [ -n "$ID" ]; then
        xcrun notarytool log "$ID" --apple-id "$APPLE_ID" --password "$APPLE_ID_PASSWORD" --team-id "$APPLE_TEAM_ID" || true
    fi
    exit 1
fi

xcrun stapler staple "$TARGET"
xcrun stapler validate "$TARGET"
echo "✓ notarized + stapled $TARGET"
