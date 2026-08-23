#!/bin/bash
# scripts/release/notarize.sh <target.app|target.dmg>
# Submits to Apple's notary service, waits, staples, validates the target.
# Auth, in the order tried:
#   1. App Store Connect API key — APPLE_API_KEY_P8 (the .p8 contents, raw or
#      base64) or APPLE_API_KEY_PATH, plus APPLE_API_KEY_ID and
#      APPLE_API_ISSUER_ID. Preferred for CI: no app-specific password to
#      expire or be revoked by an Apple ID password change.
#   2. NOTARY_PROFILE — a notarytool keychain-profile name, for local runs.
#   3. APPLE_ID + APPLE_ID_PASSWORD + APPLE_TEAM_ID, where the password must be
#      an app-specific one.
set -euo pipefail

if [ "$#" -ne 1 ]; then
    echo "usage: notarize.sh <target.app|target.dmg>" >&2
    echo "  auth: APPLE_API_KEY_P8+APPLE_API_KEY_ID+APPLE_API_ISSUER_ID, or NOTARY_PROFILE, or APPLE_ID+APPLE_ID_PASSWORD+APPLE_TEAM_ID" >&2
    exit 2
fi
TARGET="$1"

# ONE cleanup for both temp dirs, installed before either is created: a second
# `trap ... EXIT` replaces the first rather than adding to it, and the one that
# would have been dropped here holds a private key.
TMP=""; KEYTMP=""
trap '[ -n "$TMP" ] && rm -rf "$TMP"; [ -n "$KEYTMP" ] && rm -rf "$KEYTMP"' EXIT

# App Store Connect API key first: it is the only one of the three that does
# not depend on an app-specific password, which expires, is revoked whenever
# the Apple ID password changes, and fails as an opaque 401 when either
# happens. NOTARY_PROFILE is a local convenience — note that creating one via
# `notarytool store-credentials` stores these same credentials, so a profile
# built from a rejected password is rejected identically.
if [ -n "${APPLE_API_KEY_P8:-}" ] || [ -n "${APPLE_API_KEY_PATH:-}" ]; then
    : "${APPLE_API_KEY_ID:?APPLE_API_KEY_ID is required alongside the API key}"
    : "${APPLE_API_ISSUER_ID:?APPLE_API_ISSUER_ID is required alongside the API key}"
    KEY_PATH="${APPLE_API_KEY_PATH:-}"
    if [ -z "$KEY_PATH" ]; then
        # Written 0600 into the trap-cleaned temp dir: the .p8 is a private key
        # and must not outlive the run or be readable by other users.
        KEYTMP="$(mktemp -d "${TMPDIR:-/tmp}/mattstack-notary-key.XXXXXX")"
        KEY_PATH="$KEYTMP/AuthKey_${APPLE_API_KEY_ID}.p8"
        # Decided by content, never by "try base64 and fall back": a raw value
        # can itself be valid base64, and decoding it then yields silent
        # garbage that only surfaces as an unexplained auth failure.
        if printf '%s' "$APPLE_API_KEY_P8" | grep -q -- "-----BEGIN"; then
            ( umask 077; printf '%s\n' "$APPLE_API_KEY_P8" > "$KEY_PATH" )
        else
            ( umask 077; printf '%s' "$APPLE_API_KEY_P8" | base64 --decode > "$KEY_PATH" ) \
                || { echo "✗ APPLE_API_KEY_P8 is neither a PEM (-----BEGIN…) nor valid base64" >&2; exit 1; }
        fi
    fi
    [ -s "$KEY_PATH" ] || { echo "✗ API key at $KEY_PATH is empty" >&2; exit 1; }
    grep -q -- "-----BEGIN" "$KEY_PATH" || { echo "✗ API key at $KEY_PATH is not a PEM private key after decoding" >&2; exit 1; }
    AUTH_ARGS=(--key "$KEY_PATH" --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER_ID")
elif [ -n "${NOTARY_PROFILE:-}" ]; then
    AUTH_ARGS=(--keychain-profile "$NOTARY_PROFILE")
else
    : "${APPLE_ID:?APPLE_ID is required (or set NOTARY_PROFILE)}"
    : "${APPLE_ID_PASSWORD:?APPLE_ID_PASSWORD is required (or set NOTARY_PROFILE)}"
    : "${APPLE_TEAM_ID:?APPLE_TEAM_ID is required (or set NOTARY_PROFILE)}"
    AUTH_ARGS=(--apple-id "$APPLE_ID" --password "$APPLE_ID_PASSWORD" --team-id "$APPLE_TEAM_ID")
fi
[ -e "$TARGET" ] || { echo "✗ no such target $TARGET" >&2; exit 1; }

SUBMIT="$TARGET"
case "$TARGET" in
    *.app)
        TMP="$(mktemp -d "${TMPDIR:-/tmp}/mattstack-release-notarize.XXXXXX")"
        SUBMIT="$TMP/$(basename "$TARGET" .app).zip"
        ditto -c -k --keepParent "$TARGET" "$SUBMIT"
        ;;
    *.dmg) ;;
    *) echo "✗ notarize.sh handles .app and .dmg only" >&2; exit 2 ;;
esac

echo "→ submitting $(basename "$SUBMIT") for notarization…"
# notarytool exits nonzero on Invalid — capture the output before branching
# so the log fetch below still runs, instead of set -e killing the script.
# stderr to its own file rather than folded into stdout: --output-format json
# puts the JSON on stdout, and any warning notarytool writes to stderr would
# otherwise be spliced into the document the parser below reads.
ERR="$(mktemp "${TMPDIR:-/tmp}/mattstack-notary-err.XXXXXX")"
RESULT="$(xcrun notarytool submit "$SUBMIT" "${AUTH_ARGS[@]}" --wait --timeout 45m --output-format json 2>"$ERR")" || SUBMIT_RC=$?
SUBMIT_RC="${SUBMIT_RC:-0}"
DIAG="$(cat "$ERR"; printf '%s' "$RESULT")"
rm -f "$ERR"

# An auth failure never reaches the notary service, so there is no JSON and no
# submission at all — the output is a bare message like
# "HTTP status code: 401. Invalid credentials." Report that verbatim and stop:
# the parsing below would otherwise carry the error text forward as if it were
# a status, and hand it to `notarytool log` as a submission id.
if [ "$SUBMIT_RC" -ne 0 ] && ! printf '%s' "$RESULT" | grep -q '"status"'; then
    echo "✗ notarization could not be submitted (notarytool exited $SUBMIT_RC):" >&2
    printf '%s\n' "$DIAG" >&2
    case "$DIAG" in
        *401*|*"Invalid credentials"*)
            echo "  → 401 means the credentials were rejected before any upload. APPLE_ID_PASSWORD must be an" >&2
            echo "    APP-SPECIFIC password from appleid.apple.com (not the Apple ID password), and APPLE_TEAM_ID" >&2
            echo "    must match the team on the signing certificate." >&2 ;;
    esac
    exit 1
fi

# plutil writes its parse errors to STDOUT, so a failed extraction yields a
# non-empty string rather than the empty one an "is it set" check would catch.
# Both fields are therefore validated by shape, not merely by presence.
# `|| true`: plutil exits nonzero on a missing key, and under `set -e` with
# pipefail that would kill the script mid-assignment with no message at all.
extract() { printf '%s' "$RESULT" | /usr/bin/plutil -extract "$1" raw -o - - 2>/dev/null | head -1 || true; }
ID="$(extract id)"
STATUS="$(extract status)"
printf '%s' "$ID" | grep -Eqi '^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$' || ID=""
case "$STATUS" in
    Accepted|Invalid|Rejected|"In Progress") ;;
    *) STATUS="" ;;
esac

if [ -z "$STATUS" ]; then
    echo "✗ notarization failed: notarytool returned no usable status" >&2
    printf '%s\n' "$DIAG" >&2
    exit 1
fi
echo "  submission ${ID:-<none>} → $STATUS"

if [ "$STATUS" = "Invalid" ]; then
    echo "✗ notarization rejected (Invalid) — fetching notary log" >&2
    if [ -n "$ID" ]; then
        xcrun notarytool log "$ID" "${AUTH_ARGS[@]}" || true
    fi
    exit 1
elif [ "$STATUS" != "Accepted" ]; then
    echo "✗ notarization did not complete: status=$STATUS" >&2
    if [ -n "$ID" ]; then
        xcrun notarytool log "$ID" "${AUTH_ARGS[@]}" || true
    fi
    exit 1
fi

xcrun stapler staple "$TARGET"
xcrun stapler validate "$TARGET"
echo "✓ notarized + stapled $TARGET"
