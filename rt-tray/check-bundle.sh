#!/bin/bash
# rt-tray/check-bundle.sh — MAT-383 Task 3 scripted assertions.
#
# There is no bash unit-test framework in this repo, so this script is the
# substitute the task brief asks for: it builds BOTH flavors locally via
# build.sh (release build, no notarization — build.sh has never had a
# notarize step; that's CI-only, see .github/workflows/release.yml) and
# asserts, via PlistBuddy/codesign/find/stat, that the bundle-identity
# templating (spec MAT-383 §1/§3) landed correctly in each.
#
# Usage:
#   ./check-bundle.sh                          # RT_DAEMON_BIN falls back to
#                                               # `command -v rt` (build.sh's
#                                               # own fallback)
#   RT_DAEMON_BIN=/path/to/compiled/rt ./check-bundle.sh
#
# NOTE: on a machine with dev-mode CLI toggled on, `rt` on PATH resolves to
# the ~/.local/bin/rt SOURCE WRAPPER SCRIPT, not the compiled binary — pass
# RT_DAEMON_BIN explicitly (e.g. ../dist/rt) to embed a real compiled daemon
# and get a meaningful prod-vs-shim size comparison below.

set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

PASS=0
FAIL=0

pass() { echo "  ✓ $1"; PASS=$((PASS + 1)); }
fail() { echo "  ✗ $1"; FAIL=$((FAIL + 1)); }

assert_eq() {
    local desc="$1" expected="$2" actual="$3"
    if [ "$expected" = "$actual" ]; then
        pass "$desc = $actual"
    else
        fail "$desc: expected [$expected], got [$actual]"
    fi
}

echo "== Building prod flavor (release) =="
./build.sh release
echo ""
echo "== Building dev flavor (dev) =="
./build.sh dev
echo ""
echo "== Assertions =="

PROD="$SCRIPT_DIR/mattstack.app"
DEV="$SCRIPT_DIR/mattstack-dev.app"

if [ ! -d "$PROD" ]; then
    fail "prod bundle not found at $PROD"
fi
if [ ! -d "$DEV" ]; then
    fail "dev bundle not found at $DEV"
fi

# ─── build.sh never gains a local notarize step (CI-only) ────────────────────
if grep -qi notarize build.sh; then
    fail "build.sh contains a notarize step (should stay CI-only, see release.yml)"
else
    pass "build.sh has no local notarize step"
fi

# ─── prod Info.plist ───────────────────────────────────────────────────────
assert_eq "prod CFBundleIdentifier" "com.mattstack.app" \
    "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$PROD/Contents/Info.plist" 2>/dev/null)"
assert_eq "prod CFBundleExecutable" "mattstack" \
    "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$PROD/Contents/Info.plist" 2>/dev/null)"
assert_eq "prod CFBundleDisplayName" "mattstack" \
    "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleDisplayName' "$PROD/Contents/Info.plist" 2>/dev/null)"
assert_eq "prod MSDaemonLabel" "com.rt.daemon" \
    "$(/usr/libexec/PlistBuddy -c 'Print :MSDaemonLabel' "$PROD/Contents/Info.plist" 2>/dev/null)"
assert_eq "prod MSDevBuild" "false" \
    "$(/usr/libexec/PlistBuddy -c 'Print :MSDevBuild' "$PROD/Contents/Info.plist" 2>/dev/null)"

# ─── dev Info.plist ────────────────────────────────────────────────────────
assert_eq "dev CFBundleIdentifier" "com.mattstack.app.dev" \
    "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$DEV/Contents/Info.plist" 2>/dev/null)"
assert_eq "dev CFBundleExecutable" "mattstack-dev" \
    "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$DEV/Contents/Info.plist" 2>/dev/null)"
assert_eq "dev CFBundleDisplayName" "mattstack-dev" \
    "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleDisplayName' "$DEV/Contents/Info.plist" 2>/dev/null)"
assert_eq "dev MSDaemonLabel" "com.rt.daemon.dev" \
    "$(/usr/libexec/PlistBuddy -c 'Print :MSDaemonLabel' "$DEV/Contents/Info.plist" 2>/dev/null)"
assert_eq "dev MSDevBuild" "true" \
    "$(/usr/libexec/PlistBuddy -c 'Print :MSDevBuild' "$DEV/Contents/Info.plist" 2>/dev/null)"

# ─── prod agent plist ──────────────────────────────────────────────────────
PROD_AGENT="$PROD/Contents/Library/LaunchAgents/com.rt.daemon.plist"
if [ -f "$PROD_AGENT" ]; then
    pass "prod agent plist named com.rt.daemon.plist"
    assert_eq "prod agent Label" "com.rt.daemon" \
        "$(/usr/libexec/PlistBuddy -c 'Print :Label' "$PROD_AGENT" 2>/dev/null)"
    assert_eq "prod agent AssociatedBundleIdentifiers[0]" "com.mattstack.app" \
        "$(/usr/libexec/PlistBuddy -c 'Print :AssociatedBundleIdentifiers:0' "$PROD_AGENT" 2>/dev/null)"
    assert_eq "prod agent KeepAlive" "true" \
        "$(/usr/libexec/PlistBuddy -c 'Print :KeepAlive' "$PROD_AGENT" 2>/dev/null)"
else
    fail "prod agent plist com.rt.daemon.plist missing at $PROD_AGENT"
fi

# ─── dev agent plist ───────────────────────────────────────────────────────
DEV_AGENT="$DEV/Contents/Library/LaunchAgents/com.rt.daemon.dev.plist"
if [ -f "$DEV_AGENT" ]; then
    pass "dev agent plist named com.rt.daemon.dev.plist"
    assert_eq "dev agent Label" "com.rt.daemon.dev" \
        "$(/usr/libexec/PlistBuddy -c 'Print :Label' "$DEV_AGENT" 2>/dev/null)"
    assert_eq "dev agent AssociatedBundleIdentifiers[0]" "com.mattstack.app.dev" \
        "$(/usr/libexec/PlistBuddy -c 'Print :AssociatedBundleIdentifiers:0' "$DEV_AGENT" 2>/dev/null)"
    # KeepAlive must be a DICT shaped { SuccessfulExit = false }, not a bool.
    KA_PRINT=$(/usr/libexec/PlistBuddy -c 'Print :KeepAlive' "$DEV_AGENT" 2>&1)
    if echo "$KA_PRINT" | grep -q "SuccessfulExit"; then
        pass "dev agent KeepAlive is a dict containing SuccessfulExit"
        assert_eq "dev agent KeepAlive:SuccessfulExit" "false" \
            "$(/usr/libexec/PlistBuddy -c 'Print :KeepAlive:SuccessfulExit' "$DEV_AGENT" 2>/dev/null)"
    else
        fail "dev agent KeepAlive is not a dict (got: $KA_PRINT)"
    fi
else
    fail "dev agent plist com.rt.daemon.dev.plist missing at $DEV_AGENT"
fi

# ─── prod bundle ships NO rt-daemon-shim artifacts ────────────────────────
SHIM_HITS=$(find "$PROD" -iname "*rt-daemon-shim*" 2>/dev/null)
if [ -z "$SHIM_HITS" ]; then
    pass "prod bundle contains no rt-daemon-shim artifacts"
else
    fail "prod bundle contains rt-daemon-shim artifacts: $SHIM_HITS"
fi

# ─── dev bundle's rt-daemon IS the shim binary ────────────────────────────
DEV_ID=$(codesign -dv "$DEV/Contents/MacOS/rt-daemon" 2>&1 | grep '^Identifier=' || true)
assert_eq "dev rt-daemon codesign identifier (the -i rt-daemon override)" "Identifier=rt-daemon" "$DEV_ID"

# Content check: the shim is a small Swift binary (tens of KB); a real
# compiled `rt` daemon (bun --compile) is tens of MB. Compare the dev bundle's
# embedded rt-daemon size against the just-built rt-daemon-shim product —
# codesign only appends a signature blob, it doesn't rewrite the binary body.
SHIM_BUILD_SIZE=$(stat -f%z "$SCRIPT_DIR/.build/release/rt-daemon-shim" 2>/dev/null || echo 0)
DEV_DAEMON_SIZE=$(stat -f%z "$DEV/Contents/MacOS/rt-daemon" 2>/dev/null || echo 0)
PROD_DAEMON_SIZE=$(stat -f%z "$PROD/Contents/MacOS/rt-daemon" 2>/dev/null || echo 0)
if [ "$DEV_DAEMON_SIZE" -ge "$SHIM_BUILD_SIZE" ]; then
    SIZE_DELTA=$((DEV_DAEMON_SIZE - SHIM_BUILD_SIZE))
else
    SIZE_DELTA=$((SHIM_BUILD_SIZE - DEV_DAEMON_SIZE))
fi
if [ "$SHIM_BUILD_SIZE" -gt 0 ] && [ "$SIZE_DELTA" -lt 65536 ]; then
    pass "dev rt-daemon ($DEV_DAEMON_SIZE bytes) matches the freshly-built rt-daemon-shim ($SHIM_BUILD_SIZE bytes) within signing overhead"
else
    fail "dev rt-daemon ($DEV_DAEMON_SIZE bytes) does not match rt-daemon-shim build output ($SHIM_BUILD_SIZE bytes)"
fi
if [ "$PROD_DAEMON_SIZE" -gt 1000000 ]; then
    pass "prod rt-daemon ($PROD_DAEMON_SIZE bytes) looks like a real compiled daemon, not the shim"
else
    echo "  ⚠ prod rt-daemon is only $PROD_DAEMON_SIZE bytes — RT_DAEMON_BIN likely pointed at a source"
    echo "    wrapper (this machine's dev-mode-toggled \`rt\` on PATH), not a compiled binary. Re-run with"
    echo "    RT_DAEMON_BIN=<path to a compiled rt, e.g. ../dist/rt> for a meaningful size check here."
fi

# ─── signature sanity ──────────────────────────────────────────────────────
if codesign --verify "$PROD" 2>/dev/null; then
    pass "prod bundle signature verifies"
else
    fail "prod bundle signature verification failed"
fi
if codesign --verify "$DEV" 2>/dev/null; then
    pass "dev bundle signature verifies"
else
    fail "dev bundle signature verification failed"
fi

# Dev signs bundle-wide with the SAME identity for the inner daemon (shim)
# and the outer app — never a nested ad-hoc binary inside a Developer-ID
# hardened-runtime bundle.
DEV_INNER_AUTH=$(codesign -dvv "$DEV/Contents/MacOS/rt-daemon" 2>&1 | grep '^Authority=' | head -1)
DEV_OUTER_AUTH=$(codesign -dvv "$DEV" 2>&1 | grep '^Authority=' | head -1)
assert_eq "dev inner/outer signing identity match (bundle-wide, no nested ad-hoc)" "$DEV_OUTER_AUTH" "$DEV_INNER_AUTH"

echo ""
echo "  $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
