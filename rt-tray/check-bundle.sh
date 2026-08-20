#!/bin/bash
# rt-tray/check-bundle.sh — MAT-383 Task 3 + Task 4 scripted assertions.
#
# There is no bash unit-test framework in this repo, so this script is the
# substitute the task brief asks for: it builds BOTH flavors locally via
# build.sh (release build, no notarization — build.sh has never had a
# notarize step; that's CI-only, see .github/workflows/release.yml) and
# asserts, via PlistBuddy/codesign/find/stat, that the bundle-identity
# templating (spec MAT-383 §1/§3) landed correctly in each.
#
# Task 4 adds the Swift-runtime section at the bottom: the shim's exit-code
# contract is exercised for real (the DEV BUNDLE's own Contents/MacOS/rt-daemon
# is RUN against throwaway HOMEs), and the parts that only a launched app can
# prove — live SMAppService registration, real socket contention — are pinned
# down as far as an offline check can: the shipped strings must be in the built
# binary and the source must be shaped the way the spec requires. Those two
# behaviours still need the plan's manual smoke gate.
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

# ─── App icon (spec §7): per-flavor source, same bundle-internal name ───────
# make-icon.swift generates AppIcon.icns (prod) and AppIcon-dev.icns (dev,
# tinted) in one run; build.sh must copy the flavor-correct source into each
# bundle as Contents/Resources/AppIcon.icns (Info.plist's CFBundleIconFile
# names "AppIcon" for both flavors, so the bundle-internal name never varies —
# only which source file was copied in does).
PROD_ICON="$PROD/Contents/Resources/AppIcon.icns"
DEV_ICON="$DEV/Contents/Resources/AppIcon.icns"
if [ -f "$PROD_ICON" ]; then
    pass "prod bundle ships Contents/Resources/AppIcon.icns"
else
    fail "prod bundle missing Contents/Resources/AppIcon.icns"
fi
if [ -f "$DEV_ICON" ]; then
    pass "dev bundle ships Contents/Resources/AppIcon.icns"
else
    fail "dev bundle missing Contents/Resources/AppIcon.icns"
fi
if [ -f "$PROD_ICON" ] && [ -f "$DEV_ICON" ]; then
    if cmp -s "$PROD_ICON" "$DEV_ICON"; then
        fail "prod and dev AppIcon.icns are byte-identical — dev tint did not make it into the bundle"
    else
        pass "prod and dev AppIcon.icns differ — dev flavor got its tinted variant"
    fi
fi
# Both source .icns must exist at the repo root too (git-tracked, regenerated
# at change time — build.sh only regenerates when BOTH are absent).
if [ -f "$SCRIPT_DIR/AppIcon.icns" ] && [ -f "$SCRIPT_DIR/AppIcon-dev.icns" ]; then
    pass "source AppIcon.icns and AppIcon-dev.icns both present at rt-tray/"
else
    fail "source AppIcon.icns / AppIcon-dev.icns missing at rt-tray/ (make-icon.swift should generate both)"
fi

# ════════════════════════════════════════════════════════════════════════════
# Task 4 — Swift runtime (spec §1 MSDaemonLabel, §3 socket guard /
#          /flavor/retire / login item / exit codes / dev cosmetics)
# ════════════════════════════════════════════════════════════════════════════

echo ""
echo "== Task 4: Swift runtime =="

grep_src() { grep -R --include='*.swift' -q "$1" Sources Sources-daemon-shim; }

assert_src_has() {
    local desc="$1" pattern="$2"
    if grep_src "$pattern"; then pass "$desc"; else fail "$desc (no source match for: $pattern)"; fi
}
assert_src_lacks() {
    local desc="$1" pattern="$2"
    if grep_src "$pattern"; then
        fail "$desc (still present: $(grep -Rn --include='*.swift' "$pattern" Sources Sources-daemon-shim | head -3 | tr '\n' ' '))"
    else
        pass "$desc"
    fi
}

# ─── MSDaemonLabel is read, never compiled in (spec §1) ─────────────────────
# The old code hardcoded BOTH the plist name and the kickstart label; a dev
# bundle that kept either would register/kickstart the PROD job.
assert_src_has "BundleFlavor reads Info.plist MSDaemonLabel" \
    'forInfoDictionaryKey: "MSDaemonLabel"'
assert_src_has "BundleFlavor falls back to com.rt.daemon when the key is absent" \
    'defaultDaemonLabel = "com.rt.daemon"'
assert_src_has "DaemonLifecycle derives plistName from the label" \
    'SMAppService.agent(plistName: "\\(label).plist")'
assert_src_has "DaemonLifecycle defaults its label to BundleFlavor.daemonLabel" \
    'label: String = BundleFlavor.daemonLabel'
assert_src_lacks "no hardcoded com.rt.daemon.plist literal survives" \
    '"com.rt.daemon.plist"'
assert_src_lacks "no hardcoded launchctl label literal survives" \
    'let label = "com.rt.daemon"'
# Only the documented fallback may carry the literal; every other Swift line
# mentioning it must be a comment.
BARE_LABEL_HITS=$(grep -Rn --include='*.swift' 'com\.rt\.daemon' Sources Sources-daemon-shim \
    | grep -v 'defaultDaemonLabel' | grep -vE '^[^:]+:[0-9]+: *(///|//|\*)' || true)
if [ -z "$BARE_LABEL_HITS" ]; then
    pass "com.rt.daemon appears in Swift only as BundleFlavor's fallback (rest are comments)"
else
    fail "stray com.rt.daemon literal in Swift: $BARE_LABEL_HITS"
fi

# ─── TrayServer registration surface (spec §3) ──────────────────────────────
assert_src_lacks "/login-item/reset endpoint deleted" '/login-item/reset'
assert_src_has "/flavor/retire endpoint added" 'path == "/flavor/retire"'
# It must retire BOTH registrations — daemon agent AND login item.
if awk '/path == "\/flavor\/retire"/,/GET" && path == "\/daemon\/status"/' Sources/TrayServer.swift \
    | grep -q 'lifecycle.stopDaemon()' &&
   awk '/path == "\/flavor\/retire"/,/GET" && path == "\/daemon\/status"/' Sources/TrayServer.swift \
    | grep -q 'SMAppService.mainApp.unregister()'; then
    pass "/flavor/retire unregisters the daemon agent AND the login item"
else
    fail "/flavor/retire does not unregister both the daemon agent and the login item"
fi

# ─── Socket guard runs BEFORE any SMAppService registration (spec §3) ───────
# Offline-provable half: the guard is a CONNECT probe, it is called from
# main.swift, and that call precedes the AppDelegate (the only place either
# registration happens). The live-contention half is manual-smoke only.
assert_src_has "socket guard is a connect+answer probe, not a file check" \
    'Darwin.connect(fd, sa, socklen_t'
assert_src_has "socket guard logs 'another tray owns the socket' and exits" \
    'another tray owns the socket'
GUARD_LINE=$(grep -n 'TrayServer.exitIfAnotherTrayOwnsSocket()' Sources/main.swift | head -1 | cut -d: -f1)
DELEGATE_LINE=$(grep -n 'AppDelegate()' Sources/main.swift | head -1 | cut -d: -f1)
if [ -n "$GUARD_LINE" ] && [ -n "$DELEGATE_LINE" ] && [ "$GUARD_LINE" -lt "$DELEGATE_LINE" ]; then
    pass "main.swift runs the socket guard (line $GUARD_LINE) before AppDelegate (line $DELEGATE_LINE)"
else
    fail "socket guard does not precede AppDelegate in main.swift (guard=$GUARD_LINE delegate=$DELEGATE_LINE)"
fi
MAIN_SM=$(grep -n 'SMAppService' Sources/main.swift | grep -vE '^[0-9]+: *(//|///|\*)' || true)
if [ -z "$MAIN_SM" ]; then
    pass "main.swift performs no SMAppService registration (nothing registers ahead of the guard)"
else
    fail "main.swift touches SMAppService outside comments: $MAIN_SM"
fi

# ─── Login item: idempotent auto-register, user opt-out wins (spec §3) ──────
assert_src_has "AppDelegate auto-registers the login item at startup" \
    'autoRegisterLoginItem()'
assert_src_has "auto-register is skipped when the user opted out" \
    'guard !LoginItemPreference.isOptedOut'
assert_src_has "auto-register only acts on .notRegistered" \
    'guard status == .notRegistered'
assert_src_has "panel toggle records the opt-out when disabling" \
    'LoginItemPreference.isOptedOut = true'
assert_src_has "panel toggle clears the opt-out when enabling" \
    'LoginItemPreference.isOptedOut = false'

# ─── Dev cosmetics + silent updater (spec §3) ──────────────────────────────
assert_src_has "menu-bar title carries a dev mark when MSDevBuild is true" \
    'if BundleFlavor.isDevBuild {'
assert_src_has "BundleFlavor reads Info.plist MSDevBuild" \
    'forInfoDictionaryKey: "MSDevBuild"'
if awk '/func checkForUpdates/,/let urlString/' Sources/UpdateChecker.swift | grep -q 'BundleFlavor.isDevBuild'; then
    pass "checkForUpdates returns early on a dev build (silent even when user-initiated)"
else
    fail "checkForUpdates does not short-circuit on BundleFlavor.isDevBuild"
fi

# ─── The shipped binary really carries this code ───────────────────────────
# NOTE: "MSDaemonLabel"/"MSDevBuild"/"/flavor/retire" are ≤15 bytes and get
# packed into Swift's small-string representation — they are NOT in `strings`
# output by design, which is why the key reads above are source assertions.
# The longer literals below do land in the binary and prove the built artifact
# (not just the tree) contains the new paths.
TRAY_BIN="$SCRIPT_DIR/.build/release/rt-tray"
# Dumped to a file, not piped: `strings … | grep -q` dies of SIGPIPE under
# `set -o pipefail` whenever grep finds its match before strings finishes,
# which makes the assertion flaky in exactly the passing case.
TRAY_STRINGS=$(mktemp /tmp/mat383-strings.XXXXXX)
strings "$TRAY_BIN" > "$TRAY_STRINGS" 2>/dev/null
assert_bin_has() {
    local desc="$1" needle="$2"
    if grep -qF "$needle" "$TRAY_STRINGS"; then
        pass "built tray binary contains: $needle"
    else
        fail "built tray binary is missing: $needle ($desc)"
    fi
}
assert_bin_has "socket guard" "another tray owns the socket"
assert_bin_has "socket guard, stale-socket branch" "stale tray socket found, taking it over"
assert_bin_has "login-item auto-register" "login item auto-registered"
assert_bin_has "login-item opt-out" "login item auto-register skipped (user opted out)"
assert_bin_has "opt-out UserDefaults key" "MSLoginItemOptOut"
assert_bin_has "silent dev updater" "update check skipped (dev build)"

# ─── Shim exit-code contract, exercised for real (spec §3) ─────────────────
# The DEV BUNDLE's own Contents/MacOS/rt-daemon is the artifact under test —
# not .build output — so this proves what actually ships. Each case runs under
# `env -i` with a throwaway HOME, so nothing touches the real ~/.mattstack.
# No case is allowed to reach execv into a working bun: a stand-down case must
# stop at its precondition, and the failure case execs a NON-executable file.
SHIM="$DEV/Contents/MacOS/rt-daemon"
SHIM_TMP=$(mktemp -d /tmp/mat383-shim.XXXXXX)
trap 'rm -rf "$SHIM_TMP" "$TRAY_STRINGS"' EXIT

shim_case() {
    local desc="$1" expected_code="$2" home="$3"
    local out rc
    out=$(env -i HOME="$home" "$SHIM" --daemon 2>&1)
    rc=$?
    if [ "$rc" -ne "$expected_code" ]; then
        fail "$desc: expected exit $expected_code, got $rc (stderr: ${out:-<empty>})"
        return
    fi
    if [ "$expected_code" -eq 0 ]; then
        local lines
        lines=$(printf '%s' "$out" | grep -c 'standing down' || true)
        if [ "$lines" -ne 1 ]; then
            fail "$desc: exited 0 but logged $lines stand-down lines (want exactly 1): ${out:-<empty>}"
            return
        fi
    fi
    pass "$desc → exit $rc"
}

if [ ! -x "$SHIM" ]; then
    fail "dev bundle rt-daemon (shim) not executable at $SHIM — cannot test exit codes"
else
    # 1. No dev-mode config at all — the common case after a fresh dev install.
    H1="$SHIM_TMP/no-config"; mkdir -p "$H1/.mattstack/rt"
    shim_case "shim: missing dev-mode.json" 0 "$H1"

    # 2. Config present but without sourcePath.
    H2="$SHIM_TMP/no-sourcepath"; mkdir -p "$H2/.mattstack/rt"
    echo '{"bunPath":"/nope/bun"}' > "$H2/.mattstack/rt/dev-mode.json"
    shim_case "shim: config without sourcePath" 0 "$H2"

    # 3. bun missing.
    H3="$SHIM_TMP/no-bun"; mkdir -p "$H3/.mattstack/rt"
    echo "{\"sourcePath\":\"$SHIM_TMP/src\",\"bunPath\":\"$SHIM_TMP/absent-bun\"}" \
        > "$H3/.mattstack/rt/dev-mode.json"
    shim_case "shim: bun missing" 0 "$H3"

    # 4. sourcePath gone (bun exists — /bin/echo stands in, never reached).
    H4="$SHIM_TMP/no-source"; mkdir -p "$H4/.mattstack/rt"
    echo "{\"sourcePath\":\"$SHIM_TMP/gone\",\"bunPath\":\"/bin/echo\"}" \
        > "$H4/.mattstack/rt/dev-mode.json"
    shim_case "shim: sourcePath gone" 0 "$H4"

    # 5. HOME unset — no environment at all.
    OUT5=$(env -i "$SHIM" --daemon 2>&1); RC5=$?
    if [ "$RC5" -eq 0 ] && printf '%s' "$OUT5" | grep -q 'standing down: HOME not set'; then
        pass "shim: HOME unset → exit 0"
    else
        fail "shim: HOME unset → expected exit 0 + one stand-down line, got $RC5 (${OUT5:-<empty>})"
    fi

    # 6. GENUINE failure: every precondition passes, execv still fails (bun
    #    exists but is not executable). Must be NONZERO so launchd's
    #    KeepAlive={SuccessfulExit=false} restarts it.
    H6="$SHIM_TMP/exec-fail"; mkdir -p "$H6/.mattstack/rt" "$SHIM_TMP/realsrc/lib"
    echo 'not a real daemon' > "$SHIM_TMP/realsrc/lib/daemon.ts"
    printf '#not executable\n' > "$SHIM_TMP/fake-bun"; chmod 644 "$SHIM_TMP/fake-bun"
    echo "{\"sourcePath\":\"$SHIM_TMP/realsrc\",\"bunPath\":\"$SHIM_TMP/fake-bun\"}" \
        > "$H6/.mattstack/rt/dev-mode.json"
    env -i HOME="$H6" "$SHIM" --daemon >/dev/null 2>&1; RC6=$?
    # stderr is freopen'd into the temp HOME's logs by this point.
    ERRLOG="$H6/.mattstack/rt/logs/daemon-stderr.log"
    if [ "$RC6" -ne 0 ] && grep -q 'error: execv' "$ERRLOG" 2>/dev/null; then
        pass "shim: genuine execv failure → exit $RC6 (nonzero) and logged as an error"
    else
        fail "shim: genuine execv failure should exit nonzero with an error line (got $RC6; log: $(cat "$ERRLOG" 2>/dev/null))"
    fi
fi

echo ""
echo "  Not assertable offline (manual smoke gate, spec Verification):"
echo "    · live SMAppService registration of either flavor's daemon agent / login item"
echo "    · real socket contention between two running trays"
echo "    · the dev menu-bar mark and updater silence as seen in a launched app"

echo ""
echo "  $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
