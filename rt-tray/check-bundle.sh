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
# Piping codesign straight into `grep -q` is a pipefail trap: grep exits on
# its first match while codesign is still writing later lines, so codesign
# dies of SIGPIPE and pipefail reports the whole pipeline as failed even
# though the pattern WAS found. Capture full output first, then match on the
# captured string so nothing is still writing when the match happens.
has_runtime() { local out; out="$(codesign -dvv "$1" 2>&1)"; [[ "$out" =~ flags=.*runtime ]]; }
is_devid() { local out; out="$(codesign -dvv "$1" 2>&1)"; [[ "$out" == *"Authority=Developer ID Application"* ]]; }
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
    # THE deep-verify gate (R-T4-5): build.sh itself only ever runs --strict
    # (never --deep, which would corrupt the nested Sparkle XPC signatures),
    # so this is the only place the full inside-out signature chain is
    # proven. Any stderr output counts as a failure even at rc 0 — codesign
    # can print a warning and still exit clean.
    DEEP_VERIFY_OUT="$(codesign --verify --deep --strict "$app" 2>&1)"; DEEP_VERIFY_RC=$?
    if [ "$DEEP_VERIFY_RC" -eq 0 ] && [ -z "$DEEP_VERIFY_OUT" ]; then
        pass "$exe bundle deep-verifies clean (--deep --strict, no output)"
    else
        fail "$exe bundle deep-verify failed (rc=$DEEP_VERIFY_RC): ${DEEP_VERIFY_OUT:-<no output>}"
    fi
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

# ─── MattstackCore.framework (xcodebuild path only — swift build never embeds it) ───
check_core_framework() { # app
    local app="$1" exe fw; exe="$(plist "$app/Contents/Info.plist" CFBundleExecutable)"; fw="$app/Contents/Frameworks/MattstackCore.framework"
    [ -d "$fw" ] || { echo "  · $exe: MattstackCore.framework absent (swift-build path, not xcodebuild)"; return; }
    codesign --verify --strict "$fw" 2>/dev/null && pass "$exe MattstackCore.framework signature verifies" || fail "$exe MattstackCore.framework signature does not verify"
    if is_devid "$fw"; then has_runtime "$fw" && pass "$exe MattstackCore.framework has hardened runtime" || fail "$exe MattstackCore.framework lacks hardened runtime ($(sign_flags "$fw"))"; fi
}
check_core_framework "$PROD"
[ -n "$DEV" ] && check_core_framework "$DEV"

# ─── Icons ──────────────────────────────────────────────────────────────────
[ -f "$PROD/Contents/Resources/AppIcon.icns" ] && pass "prod ships AppIcon.icns" || fail "prod missing AppIcon.icns"
if [ -n "$DEV" ]; then
    [ -f "$DEV/Contents/Resources/AppIcon.icns" ] && pass "dev ships AppIcon.icns" || fail "dev missing AppIcon.icns"
    cmp -s "$PROD/Contents/Resources/AppIcon.icns" "$DEV/Contents/Resources/AppIcon.icns" && fail "prod/dev icons identical (dev tint missing)" || pass "prod/dev icons differ"
fi

# ═══ Helpers (deps.lock) ═══
# bash `read` collapses runs of an IFS-whitespace delimiter (tab included)
# even when IFS is set to only tab, which would drop deps.lock's empty
# pending-row fields and shift later columns left. Split by hand instead.
# Kept in sync by hand with the identical copies in scripts/fetch-deps.sh and
# rt-tray/build.sh.
split_tsv() {
    local rest="$1" field
    FIELDS=()
    while [[ "$rest" == *$'\t'* ]]; do
        field="${rest%%$'\t'*}"
        FIELDS+=("$field")
        rest="${rest#*$'\t'}"
    done
    FIELDS+=("$rest")
}
LOCK_TSV="$(bun "$SCRIPT_DIR/../scripts/lib/deps-lock.ts" --kind helper)"
check_helpers() { # app
    local app="$1" exe; exe="$(plist "$app/Contents/Info.plist" CFBundleExecutable)"
    if [ ! -d "$SCRIPT_DIR/deps/arm64" ] && ! $INSTALLED_ONLY; then echo "  ⚠ $exe: rt-tray/deps/arm64 absent — Helpers assertions skipped (scripts/fetch-deps.sh arm64)"; return; fi
    cmp -s "$SCRIPT_DIR/deps.lock" "$app/Contents/Resources/deps.lock" && pass "$exe Resources/deps.lock matches rt-tray/deps.lock" || fail "$exe Resources/deps.lock missing or stale"
    if find "$app" -name '*.sha256' -print -quit 2>/dev/null | grep -q .; then
        fail "$exe bundle contains .sha256 stamp files (deps/arm64 fetch stamps must never be copied in)"
    else
        pass "$exe bundle carries no .sha256 stamp files"
    fi
    local row name bundlePath ent status p
    while IFS= read -r row; do
        [ -n "$row" ] || continue
        split_tsv "$row"
        name="${FIELDS[0]}"; bundlePath="${FIELDS[6]}"; ent="${FIELDS[7]}"; status="${FIELDS[8]}"
        p="$app/$bundlePath"
        if [ "$status" = pending ]; then
            [ -e "$p" ] && fail "$exe ships $name although deps.lock says pending" || pass "$exe: $name absent (pending until L5)"
            continue
        fi
        [ -e "$p" ] || { fail "$exe missing Helpers/$name at $bundlePath"; continue; }
        pass "$exe ships Helpers/$name"
        while IFS= read -r -d '' f; do
            file -b "$f" | grep -q "Mach-O" || continue
            check_signed "$f" "$exe Helpers/$name/$(basename "$f")" "$ent"
            assert_eq "$exe $name identifier" "Identifier=com.mattstack.helper.$(basename "$f")" "$(codesign -dv "$f" 2>&1 | grep '^Identifier=' || true)"
        done < <(find "$p" -type f -print0)
    done <<< "$LOCK_TSV"
    # Every bundled helper answers --version from inside the bundle (signed, entitled).
    [ -x "$app/Contents/Helpers/fzf" ] && "$app/Contents/Helpers/fzf" --version >/dev/null 2>&1 && pass "$exe Helpers/fzf runs" || fail "$exe Helpers/fzf does not run"
    [ -x "$app/Contents/Helpers/jq" ] && "$app/Contents/Helpers/jq" --version >/dev/null 2>&1 && pass "$exe Helpers/jq runs" || fail "$exe Helpers/jq does not run"
    [ -x "$app/Contents/Helpers/bun" ] && "$app/Contents/Helpers/bun" --version >/dev/null 2>&1 && pass "$exe Helpers/bun runs (jit entitlement sufficient)" || fail "$exe Helpers/bun does not run under its entitlements"
    [ -x "$app/Contents/Helpers/node/bin/node" ] && "$app/Contents/Helpers/node/bin/node" -e 'process.exit(0)' >/dev/null 2>&1 && pass "$exe Helpers/node runs" || fail "$exe Helpers/node does not run under its entitlements"
    [ -f "$app/Contents/Helpers/fast-browser/bin/fast-browser.mjs" ] && pass "$exe Helpers/fast-browser package present" || fail "$exe Helpers/fast-browser package missing"
}
check_helpers "$PROD"
[ -n "$DEV" ] && check_helpers "$DEV"
# Agent PATH is the static system set (asserted per plist in check_identity); services never
# capture a shell PATH and never bake in an install location — rt/deck prepend their own Helpers dir.

# ═══ Sparkle ═══
check_sparkle() { # app
    local app="$1" exe fw; exe="$(plist "$app/Contents/Info.plist" CFBundleExecutable)"; fw="$app/Contents/Frameworks/Sparkle.framework"
    [ -d "$fw" ] || { fail "$exe missing Contents/Frameworks/Sparkle.framework"; return; }
    pass "$exe ships Sparkle.framework"
    otool -L "$app/Contents/MacOS/$exe" | grep -q '@rpath/Sparkle.framework' && pass "$exe tray links Sparkle via @rpath" || fail "$exe tray does not link Sparkle"
    otool -l "$app/Contents/MacOS/$exe" | grep -A2 LC_RPATH | grep -q '@executable_path/../Frameworks' && pass "$exe tray has the Frameworks rpath" || fail "$exe tray lacks the @executable_path/../Frameworks rpath"
    codesign --verify --deep --strict "$fw" 2>/dev/null && pass "$exe Sparkle.framework verifies (inside-out signed)" || fail "$exe Sparkle.framework signature broken"
    for xpc in Installer Downloader; do
        codesign --verify --strict "$fw/Versions/B/XPCServices/$xpc.xpc" 2>/dev/null && pass "$exe $xpc.xpc verifies" || fail "$exe $xpc.xpc signature broken"
    done
    assert_eq "$exe Sparkle signing authority matches app" "$(codesign -dvv "$app" 2>&1 | grep '^Authority=' | head -1)" "$(codesign -dvv "$fw" 2>&1 | grep '^Authority=' | head -1)"
    # Plist keys.
    local info="$app/Contents/Info.plist"
    if [ "$(plist "$info" MSDevBuild)" = "true" ]; then
        assert_eq "$exe SUEnableAutomaticChecks (dev)" "false" "$(plist "$info" SUEnableAutomaticChecks)"
    else
        assert_eq "$exe SUFeedURL" "https://github.com/m4ttstack/rt/releases/latest/download/appcast.xml" "$(plist "$info" SUFeedURL)"
        assert_eq "$exe SUEnableAutomaticChecks" "true" "$(plist "$info" SUEnableAutomaticChecks)"
        assert_eq "$exe SUScheduledCheckInterval" "21600" "$(plist "$info" SUScheduledCheckInterval)"
        assert_eq "$exe SUAutomaticallyUpdate" "true" "$(plist "$info" SUAutomaticallyUpdate)"
        assert_eq "$exe SUVerifyUpdateBeforeExtraction" "true" "$(plist "$info" SUVerifyUpdateBeforeExtraction)"
    fi
    for k in SUEnableInstallerLauncherService SUEnableDownloaderService SUEnableInstallerConnectionService SUEnableInstallerStatusService; do
        plist "$info" "$k" >/dev/null && fail "$exe sets $k (sandbox-only, must be absent)"
    done
    if [ -n "${SPARKLE_PUBLIC_ED_KEY:-}" ]; then
        assert_eq "$exe SUPublicEDKey (env override)" "$SPARKLE_PUBLIC_ED_KEY" "$(plist "$info" SUPublicEDKey)"
    elif [ -f "$SCRIPT_DIR/SUPublicEDKey" ]; then
        assert_eq "$exe SUPublicEDKey (committed file)" "$(tr -d '[:space:]' < "$SCRIPT_DIR/SUPublicEDKey")" "$(plist "$info" SUPublicEDKey)"
    else
        echo "  ⚠ $exe: no Sparkle public key available to assert (rt-tray/SUPublicEDKey or SPARKLE_PUBLIC_ED_KEY)"
    fi
}
check_sparkle "$PROD"
[ -n "$DEV" ] && check_sparkle "$DEV"

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
