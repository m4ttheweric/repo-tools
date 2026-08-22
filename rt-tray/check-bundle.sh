#!/bin/bash
# rt-tray/check-bundle.sh — asserts the mattstack.app bundle contract for BOTH
# flavors. Builds them via build.sh (no notarization; that is CI-only), then
# checks identity, layout, signing, and the dev shim's exit codes (Helpers and
# Sparkle assertions land in later tasks). Exit 0 only when every assertion
# passes.
#
# Usage:
#   RT_DAEMON_BIN=../dist/rt ./check-bundle.sh     # embed a compiled rt (a
#                                                  # dev-mode machine's `rt`
#                                                  # on PATH is a script)
#   ./check-bundle.sh --app /Applications/mattstack.app   # assert an INSTALLED
#                                                         # prod bundle, no build.
#                                                         # A relative --app path
#                                                         # resolves against the
#                                                         # caller's cwd, not
#                                                         # this script's dir.
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ORIG_PWD="$(pwd)"
cd "$SCRIPT_DIR"

PASS=0; FAIL=0
pass() { echo "  ✓ $1"; PASS=$((PASS + 1)); }
fail() { echo "  ✗ $1"; FAIL=$((FAIL + 1)); }
assert_eq() {
    local desc="$1" expected="$2" actual="$3"
    if [ "$expected" = "$actual" ]; then pass "$desc = $actual"; else fail "$desc: expected [$expected], got [$actual]"; fi
}
# PlistBuddy prints "File Doesn't Exist, Will Create: …" to STDOUT (not
# stderr) and exits nonzero on a missing plist — without the exit-status
# check that text would leak into every "got […]" comparison as a fake value.
plist() {
    local out rc
    out="$(/usr/libexec/PlistBuddy -c "Print :$2" "$1" 2>/dev/null)"
    rc=$?
    [ "$rc" -eq 0 ] && printf '%s' "$out"
}

CLEANUP=()
cleanup() { local p; for p in "${CLEANUP[@]:-}"; do [ -n "$p" ] && rm -rf "$p"; done; }
trap cleanup EXIT

PROD="$SCRIPT_DIR/mattstack.app"
DEV="$SCRIPT_DIR/mattstack-dev.app"
INSTALLED_ONLY=false
if [ "${1:-}" = "--app" ]; then
    INSTALLED_ONLY=true
    APP_ARG="${2:?--app requires a bundle path}"
    case "$APP_ARG" in
        /*) PROD="$APP_ARG" ;;
        *)  PROD="$ORIG_PWD/$APP_ARG" ;;
    esac
    DEV=""
else
    # A stale bundle from a previous run must never survive a failed rebuild —
    # otherwise a broken build can still show a full pass count below.
    rm -rf "$SCRIPT_DIR/mattstack.app" "$SCRIPT_DIR/mattstack-dev.app"
    echo "== Building prod flavor (release) =="; ./build.sh release || fail "build.sh release failed"; echo ""
    echo "== Building dev flavor (dev) ==";      ./build.sh dev     || fail "build.sh dev failed";     echo ""
fi
echo "== Assertions =="

[ -d "$PROD" ] || fail "prod bundle not found at $PROD"
[ -z "$DEV" ] || [ -d "$DEV" ] || fail "dev bundle not found at $DEV"

# ─── build.sh never notarizes, never --deep signs ───────────────────────────
if grep -qi notarize build.sh; then fail "build.sh contains a notarize step (CI-only: scripts/release/notarize.sh)"; else pass "build.sh has no local notarize step"; fi
if grep -E 'codesign.*--deep' build.sh | grep -vq '^ *#'; then fail "build.sh signs with --deep (forbidden: corrupts nested Sparkle XPC signatures)"; else pass "build.sh never signs with --deep"; fi

# ─── Identity ────────────────────────────────────────────────────────────────
check_identity() { # app bundle-id exe label devbuild
    local app="$1" bid="$2" exe="$3" label="$4" devbuild="$5" info="$1/Contents/Info.plist"
    if [ ! -d "$app" ]; then fail "$exe bundle not found at $app"; return; fi
    if [ ! -f "$info" ]; then fail "$exe Info.plist missing at $info"; return; fi
    assert_eq "$exe CFBundleIdentifier" "$bid" "$(plist "$info" CFBundleIdentifier)"
    assert_eq "$exe CFBundleExecutable" "$exe" "$(plist "$info" CFBundleExecutable)"
    assert_eq "$exe CFBundleDisplayName" "$exe" "$(plist "$info" CFBundleDisplayName)"
    assert_eq "$exe MSDaemonLabel" "$label" "$(plist "$info" MSDaemonLabel)"
    assert_eq "$exe MSDevBuild" "$devbuild" "$(plist "$info" MSDevBuild)"
    assert_eq "$exe LSMinimumSystemVersion" "14.0" "$(plist "$info" LSMinimumSystemVersion)"
    assert_eq "$exe LSUIElement" "true" "$(plist "$info" LSUIElement)"
    assert_eq "$exe URL scheme" "mattstack" "$(plist "$info" 'CFBundleURLTypes:0:CFBundleURLSchemes:0')"
    if plist "$info" LSFileQuarantineEnabled >/dev/null; then fail "$exe sets LSFileQuarantineEnabled (must be absent)"; else pass "$exe has no LSFileQuarantineEnabled"; fi
    local short build
    short="$(plist "$info" CFBundleShortVersionString)"; build="$(plist "$info" CFBundleVersion)"
    if [[ "$build" =~ ^[0-9]+$ ]]; then pass "$exe CFBundleVersion is numeric ($build)"; else fail "$exe CFBundleVersion not numeric: $build"; fi
    if [[ "$short" =~ ^([0-9]+)\.([0-9]+)\.([0-9]+)$ ]]; then
        assert_eq "$exe CFBundleVersion = major*1e6+minor*1e3+patch" "$(( BASH_REMATCH[1]*1000000 + BASH_REMATCH[2]*1000 + BASH_REMATCH[3] ))" "$build"
    else
        fail "$exe CFBundleShortVersionString is not semver: $short"
    fi
    # Embedded rt: present, executable, identifier "rt", no rt-daemon anywhere.
    local rt="$app/Contents/MacOS/rt"
    [ -x "$rt" ] && pass "$exe ships Contents/MacOS/rt" || fail "$exe missing Contents/MacOS/rt"
    assert_eq "$exe rt codesign identifier" "Identifier=rt" "$(codesign -dv "$rt" 2>&1 | grep '^Identifier=' || true)"
    [ -z "$(find "$app" -name 'rt-daemon*' 2>/dev/null)" ] && pass "$exe has no rt-daemon artifacts" || fail "$exe still contains rt-daemon artifacts"
    # Agent plist.
    local agent="$app/Contents/Library/LaunchAgents/$label.plist"
    if [ -f "$agent" ]; then
        pass "$exe agent plist named $label.plist"
        assert_eq "$exe agent Label" "$label" "$(plist "$agent" Label)"
        assert_eq "$exe agent BundleProgram" "Contents/MacOS/rt" "$(plist "$agent" BundleProgram)"
        assert_eq "$exe agent AssociatedBundleIdentifiers[0]" "$bid" "$(plist "$agent" 'AssociatedBundleIdentifiers:0')"
        if plist "$agent" StandardOutPath >/dev/null || plist "$agent" StandardErrorPath >/dev/null; then fail "$exe agent sets Std*Path (macOS 26 \$(HOME) breakage)"; else pass "$exe agent has no Std*Path"; fi
    else
        fail "$exe agent plist missing at $agent"
    fi
    # Deck agent plist (rendered by the same script; Contents/Helpers/deck may not
    # exist yet — the plist ships regardless and is asserted independently of it).
    local decklabel="${label/daemon/deck}" deck="$app/Contents/Library/LaunchAgents/${label/daemon/deck}.plist"
    if [ -f "$deck" ]; then
        pass "$exe deck plist named $decklabel.plist"
        assert_eq "$exe deck Label" "$decklabel" "$(plist "$deck" Label)"
        assert_eq "$exe deck BundleProgram" "Contents/Helpers/deck" "$(plist "$deck" BundleProgram)"
        assert_eq "$exe deck AssociatedBundleIdentifiers[0]" "$bid" "$(plist "$deck" 'AssociatedBundleIdentifiers:0')"
    else
        fail "$exe deck plist missing at $deck"
    fi
    # Both agents: KeepAlive must be the dict { SuccessfulExit = false }, and PATH
    # must be static — rt/deck prepend their own Helpers dir and ~/.local/bin at
    # process start, so the plist itself must carry no /Applications path.
    for a in "$agent" "$deck"; do
        [ -f "$a" ] || continue
        assert_eq "$exe $(basename "$a") KeepAlive:SuccessfulExit" "false" "$(plist "$a" 'KeepAlive:SuccessfulExit')"
        assert_eq "$exe $(basename "$a") EnvironmentVariables.PATH" "/usr/bin:/bin:/usr/sbin:/sbin" "$(plist "$a" 'EnvironmentVariables:PATH')"
        if plist "$a" EnvironmentVariables:PATH 2>/dev/null | grep -q '/Applications/'; then fail "$exe $(basename "$a") hardcodes /Applications in PATH"; fi
    done
}
check_identity "$PROD" "com.mattstack.app" "mattstack" "com.mattstack.daemon" "false"
[ -n "$DEV" ] && check_identity "$DEV" "com.mattstack.app.dev" "mattstack-dev" "com.mattstack.daemon.dev" "true"

if [ -n "$DEV" ]; then
    # Dev rt IS the shim: small Swift binary; prod rt is the compiled daemon (MB).
    DEV_RT_SIZE=$(stat -f%z "$DEV/Contents/MacOS/rt" 2>/dev/null || echo 0)
    [ "$DEV_RT_SIZE" -lt 1000000 ] && pass "dev rt is the shim ($DEV_RT_SIZE bytes)" || fail "dev rt is not the shim ($DEV_RT_SIZE bytes)"
    [ -z "$(find "$PROD" -iname '*rt-daemon-shim*')" ] && pass "prod bundle has no shim artifacts" || fail "prod bundle contains shim artifacts"
fi
PROD_RT_SIZE=$(stat -f%z "$PROD/Contents/MacOS/rt" 2>/dev/null || echo 0)
if [ "$PROD_RT_SIZE" -gt 1000000 ]; then pass "prod rt looks compiled ($PROD_RT_SIZE bytes)"; else echo "  ⚠ prod rt is $PROD_RT_SIZE bytes — pass RT_DAEMON_BIN=<compiled rt> for a meaningful check"; fi

# ─── Signing: every Mach-O signed, hardened runtime when Developer ID, jit-only entitlements ───
sign_flags() { codesign -dvv "$1" 2>&1 | grep -E '^(flags|Authority)=' | head -2 | tr '\n' ' '; }
has_runtime() { codesign -dvv "$1" 2>&1 | grep -q 'flags=.*runtime'; }
is_devid() { codesign -dvv "$1" 2>&1 | grep -q 'Authority=Developer ID Application'; }
ent_has() { codesign -d --entitlements - --xml "$1" 2>/dev/null | grep -q "$2"; }
check_signed() { # path label want-ent(none|jit)
    local p="$1" label="$2" want="$3"
    [ -f "$p" ] || { fail "$label missing at $p"; return; }
    codesign --verify --strict "$p" 2>/dev/null && pass "$label signature verifies" || fail "$label signature does not verify"
    if is_devid "$p"; then has_runtime "$p" && pass "$label has hardened runtime" || fail "$label lacks hardened runtime ($(sign_flags "$p"))"; fi
    if ent_has "$p" 'allow-jit'; then [ "$want" = jit ] && pass "$label has allow-jit" || fail "$label unexpectedly has allow-jit"; else [ "$want" = none ] && pass "$label has no jit entitlement" || fail "$label missing allow-jit"; fi
    ent_has "$p" 'allow-unsigned-executable-memory' && fail "$label carries allow-unsigned-executable-memory (JIT-only entitlements only)" || pass "$label has no allow-unsigned-executable-memory"
}
APPS=("$PROD")
[ -n "$DEV" ] && APPS+=("$DEV")
for app in "${APPS[@]}"; do
    if [ ! -d "$app" ]; then fail "bundle not found for signing checks: $app"; continue; fi
    if [ ! -f "$app/Contents/Info.plist" ]; then fail "Info.plist missing, cannot determine executable name for signing checks ($app)"; continue; fi
    exe="$(plist "$app/Contents/Info.plist" CFBundleExecutable)"
    if [ -z "$exe" ]; then fail "CFBundleExecutable unreadable from $app/Contents/Info.plist, skipping signing checks"; continue; fi
    codesign --verify --deep --strict "$app" 2>/dev/null && pass "$exe bundle verifies (--deep --strict)" || fail "$exe bundle fails codesign --verify --deep --strict"
    check_signed "$app/Contents/MacOS/rt" "$exe rt" jit
    check_signed "$app/Contents/MacOS/$exe" "$exe tray" none
    # Inner/outer identity must match (no nested ad-hoc inside a Developer ID
    # bundle); an empty authority on either side means codesign found nothing
    # to read, not a match, so it is reported as its own named failure.
    AUTH_OUTER="$(codesign -dvv "$app" 2>&1 | grep '^Authority=' | head -1)"
    AUTH_INNER="$(codesign -dvv "$app/Contents/MacOS/rt" 2>&1 | grep '^Authority=' | head -1)"
    if [ -z "$AUTH_OUTER" ] || [ -z "$AUTH_INNER" ]; then
        fail "$exe inner/outer signing authority: cannot compare (bundle=[${AUTH_OUTER:-<none>}] rt=[${AUTH_INNER:-<none>}])"
    else
        assert_eq "$exe inner/outer signing authority" "$AUTH_OUTER" "$AUTH_INNER"
    fi
done

# ─── Icons ──────────────────────────────────────────────────────────────────
[ -f "$PROD/Contents/Resources/AppIcon.icns" ] && pass "prod ships AppIcon.icns" || fail "prod missing AppIcon.icns"
if [ -n "$DEV" ]; then
    [ -f "$DEV/Contents/Resources/AppIcon.icns" ] && pass "dev ships AppIcon.icns" || fail "dev missing AppIcon.icns"
    cmp -s "$PROD/Contents/Resources/AppIcon.icns" "$DEV/Contents/Resources/AppIcon.icns" && fail "prod/dev icons identical (dev tint missing)" || pass "prod/dev icons differ"
fi

# ═══ Helpers (deps.lock) — not yet asserted ══════════════════════════════════
# ═══ Sparkle — not yet asserted ══════════════════════════════════════════════

# ─── Dev shim exit-code contract ────────────────────────────────────────────
if [ -n "$DEV" ]; then
    SHIM="$DEV/Contents/MacOS/rt"
    SHIM_TMP=$(mktemp -d /tmp/mattstack-check-shim.XXXXXX)
    CLEANUP+=("$SHIM_TMP")
    shim_case() {
        local desc="$1" expected_code="$2" home="$3" out rc
        out=$(env -i HOME="$home" "$SHIM" --daemon 2>&1); rc=$?
        if [ "$rc" -ne "$expected_code" ]; then fail "$desc: expected exit $expected_code, got $rc (${out:-<empty>})"; return; fi
        if [ "$expected_code" -eq 0 ] && [ "$(printf '%s' "$out" | grep -c 'standing down' || true)" -ne 1 ]; then fail "$desc: exit 0 but not exactly one stand-down line"; return; fi
        pass "$desc → exit $rc"
    }
    H1="$SHIM_TMP/no-config"; mkdir -p "$H1/.mattstack/rt"; shim_case "shim: missing dev-mode.json" 0 "$H1"
    H2="$SHIM_TMP/no-sourcepath"; mkdir -p "$H2/.mattstack/rt"; echo '{"bunPath":"/nope/bun"}' > "$H2/.mattstack/rt/dev-mode.json"; shim_case "shim: config without sourcePath" 0 "$H2"
    H3="$SHIM_TMP/no-bun"; mkdir -p "$H3/.mattstack/rt"; echo "{\"sourcePath\":\"$SHIM_TMP/src\",\"bunPath\":\"$SHIM_TMP/absent-bun\"}" > "$H3/.mattstack/rt/dev-mode.json"; shim_case "shim: bun missing" 0 "$H3"
    H4="$SHIM_TMP/no-source"; mkdir -p "$H4/.mattstack/rt"; echo "{\"sourcePath\":\"$SHIM_TMP/gone\",\"bunPath\":\"/bin/echo\"}" > "$H4/.mattstack/rt/dev-mode.json"; shim_case "shim: sourcePath gone" 0 "$H4"
    OUT5=$(env -i "$SHIM" --daemon 2>&1); RC5=$?
    [ "$RC5" -eq 0 ] && printf '%s' "$OUT5" | grep -q 'standing down: HOME not set' && pass "shim: HOME unset → exit 0" || fail "shim: HOME unset → got $RC5"
    H6="$SHIM_TMP/exec-fail"; mkdir -p "$H6/.mattstack/rt" "$SHIM_TMP/realsrc/lib"
    echo 'x' > "$SHIM_TMP/realsrc/lib/daemon.ts"; printf '#no\n' > "$SHIM_TMP/fake-bun"; chmod 644 "$SHIM_TMP/fake-bun"
    echo "{\"sourcePath\":\"$SHIM_TMP/realsrc\",\"bunPath\":\"$SHIM_TMP/fake-bun\"}" > "$H6/.mattstack/rt/dev-mode.json"
    env -i HOME="$H6" "$SHIM" --daemon >/dev/null 2>&1; RC6=$?
    [ "$RC6" -ne 0 ] && grep -q 'error: execv' "$H6/.mattstack/rt/logs/daemon-stderr.log" 2>/dev/null && pass "shim: genuine execv failure → exit $RC6" || fail "shim: execv failure should exit nonzero with an error line (got $RC6)"
fi

# ─── Swift source gates that survive the rename ─────────────────────────────
if ! $INSTALLED_ONLY; then
    # BSD grep -R returns 2 (could-not-run) when ANY named dir is missing, even
    # if another dir matched — so only pass the dirs that actually exist, and
    # keep 2 distinct from "no match" (1) for callers that gate on absence.
    grep_src() { # 0 match, 1 no match, 2 could-not-run
        local dirs=() d
        for d in Sources Sources-daemon-shim Sources-core; do [ -d "$d" ] && dirs+=("$d"); done
        [ "${#dirs[@]}" -gt 0 ] || return 2
        grep -R --include='*.swift' -q "$1" "${dirs[@]}" 2>/dev/null
    }
    grep_src 'forInfoDictionaryKey: "MSDaemonLabel"' && pass "BundleFlavor reads MSDaemonLabel" || fail "BundleFlavor does not read MSDaemonLabel"
    grep_src 'defaultDaemonLabel = "com.mattstack.daemon"' && pass "BundleFlavor falls back to com.mattstack.daemon" || fail "BundleFlavor fallback label wrong"
    # Named so the widened source-gate directories are self-verifying instead
    # of silently degrading to "no match found" when one of them is absent.
    [ -d Sources-core ] && pass "Sources-core exists" || fail "Sources-core missing — the widened rt-daemon-artifact gate has nothing to check until it does"
    grep_src 'Contents/MacOS/rt-daemon'; rc=$?
    case $rc in
        0) fail "Swift still references Contents/MacOS/rt-daemon" ;;
        1) pass "no Swift reference to Contents/MacOS/rt-daemon" ;;
        *) fail "rt-daemon source gate could not run" ;;
    esac
    grep_src 'path == "/flavor/retire"' && pass "/flavor/retire endpoint present" || fail "/flavor/retire endpoint missing"
    GUARD_LINE=$(grep -n 'TrayServer.exitIfAnotherTrayOwnsSocket()' Sources/main.swift | head -1 | cut -d: -f1)
    DELEGATE_LINE=$(grep -n 'AppDelegate()' Sources/main.swift | head -1 | cut -d: -f1)
    [ -n "$GUARD_LINE" ] && [ -n "$DELEGATE_LINE" ] && [ "$GUARD_LINE" -lt "$DELEGATE_LINE" ] && pass "socket guard precedes AppDelegate" || fail "socket guard does not precede AppDelegate"
    # Sparkle auto-update must stay silent on dev builds (gated via UpdaterController + UpdatePolicy).
    if grep -q 'UpdatePolicy.shouldStartUpdater(isDevBuild: isDevBuild' Sources/Updates/UpdaterController.swift 2>/dev/null; then
        pass "UpdaterController gates Sparkle on the dev flavor"
    else
        fail "UpdaterController does not gate Sparkle on BundleFlavor.isDevBuild"
    fi
    TRAY_STRINGS=$(mktemp /tmp/mattstack-check-strings.XXXXXX)
    CLEANUP+=("$TRAY_STRINGS")
    strings "$PROD/Contents/MacOS/$(plist "$PROD/Contents/Info.plist" CFBundleExecutable)" > "$TRAY_STRINGS" 2>/dev/null
    assert_bin_has() { # desc needle
        if grep -qF "$2" "$TRAY_STRINGS"; then pass "built tray binary contains: $2"; else fail "built tray binary is missing: $2 ($1)"; fi
    }
    assert_bin_has "silent dev updater" "update check skipped (dev build)"
    rm -f "$TRAY_STRINGS"
fi

echo ""
echo "  $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
