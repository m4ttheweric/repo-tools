#!/bin/bash
# rt-tray/check-bundle.sh — asserts the mattstack.app bundle contract for BOTH
# flavors. Builds them via build.sh (no notarization; that is CI-only), then
# checks identity, layout, signing, Helpers (deps.lock), Sparkle, and the dev
# shim's exit codes. Exit 0 only when every assertion passes.
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
# Opt-in, and deliberately not inferred from "is a ticket stapled?": a build
# that silently lost its notarization would then simply stop being checked,
# which is the vacuous-pass shape this whole file exists to avoid. CI passes
# the flag after notarize, so a missing ticket there is a failure, not a skip.
NOTARIZED=false
for arg in "$@"; do [ "$arg" = "--notarized" ] && NOTARIZED=true; done
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

# Aborts rather than recording a failure and continuing: several assertions
# below `find` the whole of $PROD, so a --app path that is not a bundle (a
# typo resolving to $HOME, or to /) walks the entire filesystem instead of
# reporting the mistake.
if [ ! -f "$PROD/Contents/Info.plist" ]; then
    fail "prod bundle not found at $PROD (no Contents/Info.plist — not an app bundle)"
    echo ""; echo "  $PASS passed, $FAIL failed"; exit 1
fi
[ -z "$DEV" ] || [ -d "$DEV" ] || fail "dev bundle not found at $DEV"

# ─── build.sh never notarizes, never --deep signs ───────────────────────────
if grep -qi notarize build.sh; then fail "build.sh contains a notarize step (CI-only: scripts/release/notarize.sh)"; else pass "build.sh has no local notarize step"; fi
if grep -E 'codesign.*--deep' build.sh | grep -vq '^ *#'; then fail "build.sh signs with --deep (forbidden: corrupts nested Sparkle XPC signatures)"; else pass "build.sh never signs with --deep"; fi

# ─── Notarization + Gatekeeper (opt-in: --notarized) ────────────────────────
# Asserts what a USER's machine actually enforces, rather than properties of
# the artifact. A bundle can be correctly signed, pass every check below, and
# still be refused on first launch because it was never notarized -- and the
# clean-room never caught that class, because extracting a zip into a scratch
# HOME is not what a browser download produces.
check_gatekeeper() { # app label
    local app="$1" label="$2"
    if ! $NOTARIZED; then
        echo "  · $label: notarization not asserted (pass --notarized after notarize.sh)"
        return
    fi
    xcrun stapler validate "$app" >/dev/null 2>&1 \
        && pass "$label has a stapled notarization ticket" \
        || fail "$label has no stapled ticket -- Gatekeeper will refuse it on a machine that has not seen it before"
    # -t exec + --context: assess it the way Launch Services does, not as an
    # install package. Offline is the point: a stapled ticket must verify with
    # no network, which is the case a first launch on a locked-down or airplane
    # machine actually hits.
    local out
    out="$(spctl --assess --type exec --context context:primary-signature -vv "$app" 2>&1)"
    printf '%s' "$out" | grep -q "accepted" \
        && pass "$label is accepted by Gatekeeper" \
        || fail "$label is rejected by Gatekeeper: $(printf '%s' "$out" | tr '\n' ' ')"
}
check_gatekeeper "$PROD" "$(basename "$PROD")"

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
# `flags=` sits mid-line inside the CodeDirectory record (not line-anchored
# like `Authority=`), so it needs -o extraction rather than a `^` anchor.
sign_flags() { codesign -dvv "$1" 2>&1 | grep -oE '(^Authority=.*|flags=[^ ]+)' | head -2 | tr '\n' ' '; }
# Piping codesign straight into `grep -q` is a pipefail trap: grep exits on
# its first match while codesign is still writing later lines, so codesign
# dies of SIGPIPE and pipefail reports the whole pipeline as failed even
# though the pattern WAS found. Capture full output first, then match on the
# captured string (a here-string, not a pipe, so there is no producer left
# for a second grep to SIGPIPE) so nothing is still writing when the match
# happens.
has_runtime() { local out; out="$(codesign -dvv "$1" 2>&1)"; grep -q 'flags=.*runtime' <<< "$out"; }
is_devid() { local out; out="$(codesign -dvv "$1" 2>&1)"; [[ "$out" == *"Authority=Developer ID Application"* ]]; }
ent_has() { local out; out="$(codesign -d --entitlements - --xml "$1" 2>/dev/null)"; grep -q "$2" <<< "$out"; }
SKIPPED_RUNTIME=0
assert_hardened_runtime() { # path label
    if is_devid "$1"; then
        has_runtime "$1" && pass "$2 has hardened runtime" || fail "$2 lacks hardened runtime ($(sign_flags "$1"))"
    else
        SKIPPED_RUNTIME=$((SKIPPED_RUNTIME + 1))
    fi
}
check_signed() { # path label want-ent(none|jit)
    local p="$1" label="$2" want="$3"
    [ -f "$p" ] || { fail "$label missing at $p"; return; }
    codesign --verify --strict "$p" 2>/dev/null && pass "$label signature verifies" || fail "$label signature does not verify"
    assert_hardened_runtime "$p" "$label"
    if ent_has "$p" 'allow-jit'; then [ "$want" = jit ] && pass "$label has allow-jit" || fail "$label unexpectedly has allow-jit"; else [ "$want" = none ] && pass "$label has no jit entitlement" || fail "$label missing allow-jit"; fi
    # allow-unsigned-executable-memory rides WITH allow-jit and never alone:
    # bun's JIT emits into plain malloc'd pages (not MAP_JIT), so a
    # long-running bun-compiled service is CODESIGNING-killed mid-run
    # without it (the daemon crash-looped 15 times in the VM clean room;
    # version-check smokes never warm the JIT, so only a soak catches it).
    if ent_has "$p" 'allow-unsigned-executable-memory'; then
        [ "$want" = jit ] && pass "$label has allow-unsigned-executable-memory (with jit)" || fail "$label unexpectedly has allow-unsigned-executable-memory"
    else
        [ "$want" = jit ] && fail "$label missing allow-unsigned-executable-memory (bun JIT dies mid-run without it)" || pass "$label has no allow-unsigned-executable-memory"
    fi
}
APPS=("$PROD")
[ -n "$DEV" ] && APPS+=("$DEV")
for app in "${APPS[@]}"; do
    if [ ! -d "$app" ]; then fail "bundle not found for signing checks: $app"; continue; fi
    if [ ! -f "$app/Contents/Info.plist" ]; then fail "Info.plist missing, cannot determine executable name for signing checks ($app)"; continue; fi
    exe="$(plist "$app/Contents/Info.plist" CFBundleExecutable)"
    if [ -z "$exe" ]; then fail "CFBundleExecutable unreadable from $app/Contents/Info.plist, skipping signing checks"; continue; fi
    # build.sh itself only ever runs --strict (never --deep, which would
    # corrupt the nested Sparkle XPC signatures), so this is the only place
    # the full inside-out signature chain is proven. Any stderr output
    # counts as a failure even at rc 0 — codesign can print a warning and
    # still exit clean.
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
    assert_hardened_runtime "$fw" "$exe MattstackCore.framework"
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
# Under `set -uo pipefail` (no -e), a failed assignment's exit status is
# discarded — an emitter crash (bun off PATH, malformed lock) would leave
# LOCK_TSV empty, check_helpers' `while … <<< "$LOCK_TSV"` would iterate zero
# rows, and every per-helper assertion would vanish while the script still
# reports 0 failed. Fail loudly instead of iterating nothing.
LOCK_TSV="$(bun "$SCRIPT_DIR/../scripts/lib/deps-lock.ts" --kind helper)" \
    || { fail "deps-lock emitter failed — Helpers assertions cannot run"; LOCK_TSV=""; }
[ -n "$LOCK_TSV" ] || fail "deps-lock emitter produced no helper rows"
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
            [ -e "$p" ] && fail "$exe ships $name although deps.lock says pending" || pass "$exe: $name absent (pending per deps.lock)"
            continue
        fi
        [ -e "$p" ] || { fail "$exe missing Helpers/$name at $bundlePath"; continue; }
        pass "$exe ships Helpers/$name"
        while IFS= read -r -d '' f; do
            file -b "$f" | grep -q "Mach-O" || continue
            check_signed "$f" "$exe Helpers/$name/$(basename "$f")" "$ent"
            assert_eq "$exe $name identifier" "Identifier=com.mattstack.helper.$(basename "$f")" "$(codesign -dv "$f" 2>&1 | grep '^Identifier=' || true)"
        done < <(find "$p" -type f -print0)
        # Every regular file under Helpers — not just the Mach-O ones — is
        # nested code to codesign's seal, and an unsigned one makes the outer
        # `sign` fail. Asserting only Mach-O files (as the loop above does) is
        # blind to a pure-script helper like fast-browser, and is blind again
        # if packaging drops the xattr the non-binary signatures live in.
        unsigned=0; first_unsigned=""
        while IFS= read -r -d '' f; do
            codesign --verify --strict "$f" 2>/dev/null && continue
            # Relative to the bundle, not to $p: a single-file helper's $p IS
            # the file, so stripping "$p/" leaves the absolute path in the
            # message.
            unsigned=$((unsigned + 1)); [ -n "$first_unsigned" ] || first_unsigned="${f#"$app"/}"
        done < <(find "$p" -type f -print0)
        [ "$unsigned" -eq 0 ] \
            && pass "$exe Helpers/$name: every file carries a signature" \
            || fail "$exe Helpers/$name: $unsigned unsigned file(s), first: $first_unsigned — the outer bundle seal will refuse this"
        # Every bundled helper answers --version from inside the bundle
        # (signed, entitled). Driven off deps.lock rather than a hand-kept
        # list: gh and glab were both bundled for a release with no run
        # assertion at all, because adding a row and remembering to add a line
        # here are two separate acts. Helpers that are directories rather than
        # single executables are asserted individually below.
        case "$name" in
            node|fast-browser|portless) ;;
            *)
                if [ -f "$p" ] && [ -x "$p" ]; then
                    "$p" --version >/dev/null 2>&1 \
                        && pass "$exe Helpers/$name runs (entitlements: $ent)" \
                        || fail "$exe Helpers/$name does not run from inside the bundle under its entitlements"
                else
                    fail "$exe Helpers/$name at $bundlePath is not an executable file"
                fi
                ;;
        esac
    done <<< "$LOCK_TSV"
    # Skills trees: each dir under Helpers/skills/<app>/ must be a skill
    # (carry a SKILL.md) and stay dot-free (dot dirs read as nested bundles).
    local skdir dotdir
    if [ -d "$app/Contents/Helpers/skills" ]; then
        while IFS= read -r -d '' skdir; do
            [ -f "$skdir/SKILL.md" ] && pass "$exe skills: $(basename "$(dirname "$skdir")")/$(basename "$skdir") has SKILL.md" \
                || fail "$exe skills: $skdir has no SKILL.md"
        done < <(find "$app/Contents/Helpers/skills" -mindepth 2 -maxdepth 2 -type d -print0)
        while IFS= read -r -d '' dotdir; do
            fail "$exe skills: dot directory $dotdir would break the bundle seal"
        done < <(find "$app/Contents/Helpers/skills" -type d -name '*.*' -print0)
    fi
    # Reverse direction: every top-level Helpers entry must trace to a
    # deps.lock row or be a first-party build.sh product (rt-ui, skills,
    # mattstack-proxy-install).
    # The row loop above only proves declared things exist; a helper the
    # lock doesn't pin would otherwise ship unverified and unversioned.
    local allowed=" rt-ui skills mattstack-proxy-install " seg entry stowaways=0
    while IFS= read -r row; do
        [ -n "$row" ] || continue
        split_tsv "$row"
        seg="${FIELDS[6]#Contents/Helpers/}"; seg="${seg%%/*}"
        allowed="$allowed$seg "
    done <<< "$LOCK_TSV"
    while IFS= read -r -d '' entry; do
        seg="$(basename "$entry")"
        case "$allowed" in
            *" $seg "*) ;;
            *) fail "$exe Helpers/$seg is not declared by deps.lock"; stowaways=$((stowaways + 1)) ;;
        esac
    done < <(find "$app/Contents/Helpers" -mindepth 1 -maxdepth 1 -print0)
    [ "$stowaways" -eq 0 ] && pass "$exe Helpers holds only deps.lock-declared and first-party entries"
    [ -x "$app/Contents/Helpers/node/bin/node" ] && "$app/Contents/Helpers/node/bin/node" -e 'process.exit(0)' >/dev/null 2>&1 && pass "$exe Helpers/node runs" || fail "$exe Helpers/node does not run under its entitlements"
    # Actually RUN it, like every other helper above. Asserting the entry file
    # merely exists is what let a bundled fast-browser that crashes at module
    # load pass every gate: build.sh prunes .claude-plugin/ (a dotted dir the
    # bundle seal rejects) and lib/hosts/claude.mjs readFileSync's
    # ../../.claude-plugin/plugin.json unconditionally at import time.
    if [ -f "$app/Contents/Helpers/fast-browser/bin/fast-browser.mjs" ]; then
        "$app/Contents/Helpers/node/bin/node" "$app/Contents/Helpers/fast-browser/bin/fast-browser.mjs" --version >/dev/null 2>&1 \
            && pass "$exe Helpers/fast-browser runs" \
            || fail "$exe Helpers/fast-browser does not run from inside the bundle"
    else
        fail "$exe Helpers/fast-browser package missing"
    fi
    # First-party helper (built from ui/, not a deps.lock row). The dev bundle
    # runs from source and resolves ui/dist/rt-ui directly, so it ships none.
    if [ "$exe" = mattstack ]; then
        local rtui="$app/Contents/Helpers/rt-ui"
        if [ -f "$rtui" ]; then
            pass "$exe ships Helpers/rt-ui"
            assert_eq "$exe rt-ui codesign identifier" "Identifier=com.mattstack.helper.rt-ui" "$(codesign -dv "$rtui" 2>&1 | grep '^Identifier=' || true)"
            "$rtui" --version 2>/dev/null | grep -q '^rt-ui .* protocol 1$' && pass "$exe rt-ui answers --version with protocol 1" || fail "$exe rt-ui --version did not report protocol 1"
        else
            fail "$exe missing Helpers/rt-ui"
        fi
        local pxy="$app/Contents/Helpers/mattstack-proxy-install"
        if [ -f "$pxy" ]; then
            pass "$exe ships Helpers/mattstack-proxy-install"
            assert_eq "$exe proxy-helper codesign identifier" "Identifier=com.mattstack.helper.mattstack-proxy-install" "$(codesign -dv "$pxy" 2>&1 | grep '^Identifier=' || true)"
            "$pxy" --version 2>/dev/null | grep -q '^mattstack-proxy-install .* protocol 1$' && pass "$exe proxy-helper answers --version" || fail "$exe proxy-helper --version failed"
            [ -d "$app/Contents/Helpers/portless-dist" ] && pass "$exe ships portless-dist" || fail "$exe missing Helpers/portless-dist"
        else
            fail "$exe missing Helpers/mattstack-proxy-install"
        fi
    fi
}
check_helpers "$PROD"
[ -n "$DEV" ] && check_helpers "$DEV"
# Agent PATH is the static system set (asserted per plist in check_identity); services never
# capture a shell PATH and never bake in an install location — rt/deck prepend their own Helpers dir.

# ═══ Sparkle ═══
check_sparkle() { # app
    local app="$1" exe fw otool_L otool_l_rpath; exe="$(plist "$app/Contents/Info.plist" CFBundleExecutable)"; fw="$app/Contents/Frameworks/Sparkle.framework"
    [ -d "$fw" ] || { fail "$exe missing Contents/Frameworks/Sparkle.framework"; return; }
    pass "$exe ships Sparkle.framework"
    # Capture-then-here-string, same as has_runtime/ent_has: piping otool
    # straight into `grep -q` is the SIGPIPE-under-pipefail trap — grep can
    # exit on its first match while otool is still writing, and pipefail
    # reports the whole pipeline as failed even though the pattern matched.
    otool_L="$(otool -L "$app/Contents/MacOS/$exe" 2>&1)"
    grep -q '@rpath/Sparkle.framework' <<< "$otool_L" && pass "$exe tray links Sparkle via @rpath" || fail "$exe tray does not link Sparkle"
    otool_l_rpath="$(otool -l "$app/Contents/MacOS/$exe" 2>&1 | grep -A2 LC_RPATH)"
    grep -q '@executable_path/../Frameworks' <<< "$otool_l_rpath" && pass "$exe tray has the Frameworks rpath" || fail "$exe tray lacks the @executable_path/../Frameworks rpath"
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
    local key; key="$(plist "$info" SUPublicEDKey)"
    if [ -n "${SPARKLE_PUBLIC_ED_KEY:-}" ]; then
        assert_eq "$exe SUPublicEDKey (env override)" "$SPARKLE_PUBLIC_ED_KEY" "$key"
    elif [ -f "$SCRIPT_DIR/SUPublicEDKey" ]; then
        assert_eq "$exe SUPublicEDKey (committed file)" "$(tr -d '[:space:]' < "$SCRIPT_DIR/SUPublicEDKey")" "$key"
    elif $INSTALLED_ONLY && [ "$(plist "$info" MSDevBuild)" != "true" ]; then
        # --app mode asserts a shipped bundle, not a local dev build: a prod
        # bundle whose key is missing or still the template placeholder can
        # never verify a real Sparkle update, so this is a shipping defect
        # and must fail the gate, not warn past it.
        if [ -z "$key" ] || [ "$key" = "REPLACE_WITH_RELEASE_PUBLIC_ED_KEY" ]; then
            fail "$exe SUPublicEDKey is missing or the template placeholder — shipped bundle cannot verify updates"
        else
            pass "$exe SUPublicEDKey is set (not the template placeholder)"
        fi
    else
        echo "  ⚠ $exe: no Sparkle public key available to assert (rt-tray/SUPublicEDKey or SPARKLE_PUBLIC_ED_KEY)"
    fi
}
check_sparkle "$PROD"
[ -n "$DEV" ] && check_sparkle "$DEV"

# ─── Dev shim exit-code contract ────────────────────────────────────────────
# Config source is state.db (RT-48/MAT-383 §9: kv table, ns='dev-mode',
# k='config') — see the note on the kv table in lib/state/db.ts. Fixtures are
# built with sqlite3 directly, never through rt, so this stays a pure Swift-
# side contract test.
if [ -n "$DEV" ]; then
    SHIM="$DEV/Contents/MacOS/rt"
    SHIM_TMP=$(mktemp -d /tmp/mattstack-check-shim.XXXXXX)
    CLEANUP+=("$SHIM_TMP")

    # Neither dependency is probed elsewhere in this script — a missing one
    # must fail loudly, not silently drop test cases (a missing python3
    # previously made the busy-contention case pass vacuously: no blocker
    # process, no contention, green anyway).
    SHIM_DEPS_OK=true
    command -v sqlite3 >/dev/null 2>&1 || { fail "shim tests: sqlite3 not on PATH — cannot build fixtures"; SHIM_DEPS_OK=false; }
    command -v python3 >/dev/null 2>&1 || { fail "shim tests: python3 not on PATH — cannot run the busy-contention case"; SHIM_DEPS_OK=false; }

if $SHIM_DEPS_OK; then
    # The shim redirects fd 2 to ~/.mattstack/rt/logs/daemon-stderr.log before
    # evaluating any precondition, so its stand-down message lands in that file
    # rather than the caller's captured stderr. Assertions read both.
    shim_output() { cat "$1/.mattstack/rt/logs/daemon-stderr.log" 2>/dev/null; }
    shim_case() {
        local desc="$1" expected_code="$2" home="$3" out rc
        out=$(env -i HOME="$home" "$SHIM" --daemon 2>&1); rc=$?
        out="$out$(shim_output "$home")"
        if [ "$rc" -ne "$expected_code" ]; then fail "$desc: expected exit $expected_code, got $rc (${out:-<empty>})"; return; fi
        if [ "$expected_code" -eq 0 ] && [ "$(printf '%s' "$out" | grep -c 'standing down' || true)" -ne 1 ]; then fail "$desc: exit 0 but not exactly one stand-down line"; return; fi
        pass "$desc → exit $rc"
    }
    # $2 is always a shell VARIABLE already holding the JSON, never a literal
    # `{...,...}` at the call site — bash brace-expansion runs on literal
    # source text before parameter expansion, so an inline `{"a":"x","b":"y"}`
    # argument gets misparsed as a brace-expansion list and silently split at
    # the comma.
    shim_write_kv() { # dbPath json
        local db="$1" json="$2"
        sqlite3 "$db" "CREATE TABLE IF NOT EXISTS kv (ns TEXT NOT NULL, k TEXT NOT NULL, v TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (ns,k));"
        sqlite3 "$db" "INSERT INTO kv (ns,k,v,updated_at) VALUES ('dev-mode','config','$json',0);"
    }

    H1="$SHIM_TMP/no-db"; mkdir -p "$H1/.mattstack/rt"; shim_case "shim: missing state.db entirely" 0 "$H1"

    H1B="$SHIM_TMP/no-table"; mkdir -p "$H1B/.mattstack/rt"
    sqlite3 "$H1B/.mattstack/rt/state.db" "CREATE TABLE other (x TEXT);"
    shim_case "shim: state.db exists but has no kv table" 0 "$H1B"

    H1C="$SHIM_TMP/no-row"; mkdir -p "$H1C/.mattstack/rt"
    sqlite3 "$H1C/.mattstack/rt/state.db" "CREATE TABLE IF NOT EXISTS kv (ns TEXT NOT NULL, k TEXT NOT NULL, v TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (ns,k));"
    shim_case "shim: kv table exists but no dev-mode row" 0 "$H1C"

    H1D="$SHIM_TMP/corrupt-db"; mkdir -p "$H1D/.mattstack/rt"
    echo "not a database" > "$H1D/.mattstack/rt/state.db"
    shim_case "shim: state.db is not a valid sqlite file" 0 "$H1D"

    H2="$SHIM_TMP/no-sourcepath"; mkdir -p "$H2/.mattstack/rt"
    shim_write_kv "$H2/.mattstack/rt/state.db" '{"bunPath":"/nope/bun"}'
    shim_case "shim: config without sourcePath" 0 "$H2"

    H3="$SHIM_TMP/no-bun"; mkdir -p "$H3/.mattstack/rt"
    JSON3=$(printf '{"sourcePath":"%s/src","bunPath":"%s/absent-bun"}' "$SHIM_TMP" "$SHIM_TMP")
    shim_write_kv "$H3/.mattstack/rt/state.db" "$JSON3"
    shim_case "shim: bun missing" 0 "$H3"

    H4="$SHIM_TMP/no-source"; mkdir -p "$H4/.mattstack/rt"
    JSON4=$(printf '{"sourcePath":"%s/gone","bunPath":"/bin/echo"}' "$SHIM_TMP")
    shim_write_kv "$H4/.mattstack/rt/state.db" "$JSON4"
    shim_case "shim: sourcePath gone" 0 "$H4"

    OUT5=$(env -i "$SHIM" --daemon 2>&1); RC5=$?
    [ "$RC5" -eq 0 ] && printf '%s' "$OUT5" | grep -q 'standing down: HOME not set' && pass "shim: HOME unset → exit 0" || fail "shim: HOME unset → got $RC5"

    H6="$SHIM_TMP/exec-fail"; mkdir -p "$H6/.mattstack/rt" "$SHIM_TMP/realsrc/lib"
    echo 'x' > "$SHIM_TMP/realsrc/lib/daemon.ts"; printf '#no\n' > "$SHIM_TMP/fake-bun"; chmod 644 "$SHIM_TMP/fake-bun"
    JSON6=$(printf '{"sourcePath":"%s/realsrc","bunPath":"%s/fake-bun"}' "$SHIM_TMP" "$SHIM_TMP")
    shim_write_kv "$H6/.mattstack/rt/state.db" "$JSON6"
    env -i HOME="$H6" "$SHIM" --daemon >/dev/null 2>&1; RC6=$?
    [ "$RC6" -ne 0 ] && grep -q 'error: execv' "$H6/.mattstack/rt/logs/daemon-stderr.log" 2>/dev/null && pass "shim: genuine execv failure → exit $RC6" || fail "shim: execv failure should exit nonzero with an error line (got $RC6)"

    # F1 fix: a machine that already has state.db (other data, no dev-mode
    # row — the realistic upgrade scenario, not a fresh machine) but still
    # has the legacy dev-mode.json must keep working with NO manual step.
    # The shim never migrates (read-only fallback), so dev-mode.json is
    # deliberately left in place by this fixture, unlike every other case
    # here — that mirrors production: only `rt settings dev-mode` migrates it.
    H8="$SHIM_TMP/legacy-fallback-success"; mkdir -p "$H8/.mattstack/rt" "$SHIM_TMP/legacysrc/lib"
    sqlite3 "$H8/.mattstack/rt/state.db" "CREATE TABLE IF NOT EXISTS kv (ns TEXT NOT NULL, k TEXT NOT NULL, v TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (ns,k));"
    echo 'x' > "$SHIM_TMP/legacysrc/lib/daemon.ts"
    cat > "$SHIM_TMP/legacy-fake-bun" <<'EOF'
#!/bin/sh
echo "legacy-fake-bun invoked with: $*"
exit 0
EOF
    chmod 755 "$SHIM_TMP/legacy-fake-bun"
    JSON8=$(printf '{"sourcePath":"%s/legacysrc","bunPath":"%s/legacy-fake-bun"}' "$SHIM_TMP" "$SHIM_TMP")
    echo "$JSON8" > "$H8/.mattstack/rt/dev-mode.json"
    OUT8=$(env -i HOME="$H8" "$SHIM" --daemon 2>&1); RC8=$?
    OUT8="$OUT8$(shim_output "$H8")"
    if [ "$RC8" -eq 0 ] && printf '%s' "$OUT8" | grep -q "legacy-fake-bun invoked with: run $SHIM_TMP/legacysrc/lib/daemon.ts --daemon"; then
        pass "shim: no dev-mode row but legacy dev-mode.json present → falls back and succeeds (no manual step)"
    else
        fail "shim: legacy fallback should have execv'd into legacy-fake-bun (rc=$RC8, out=$OUT8)"
    fi

    # F3: a relative sourcePath has no sensible default (unlike bunPath) and
    # invalidates the row entirely — the shim never treats a relative path as
    # PATH-relative, so it could never have resolved anyway.
    H9="$SHIM_TMP/relative-sourcepath"; mkdir -p "$H9/.mattstack/rt"
    shim_write_kv "$H9/.mattstack/rt/state.db" '{"sourcePath":"relative/src","bunPath":"/bin/echo"}'
    OUT9=$(env -i HOME="$H9" "$SHIM" --daemon 2>&1); RC9=$?
    OUT9="$OUT9$(shim_output "$H9")"
    [ "$RC9" -eq 0 ] && printf '%s' "$OUT9" | grep -q 'has no absolute sourcePath' && pass "shim: relative sourcePath → exit 0, invalidates the row" || fail "shim: relative sourcePath should stand down naming the reason (rc=$RC9, out=$OUT9)"

    # F3: a relative bunPath IS defaulted (falls back to ~/.bun/bin/bun,
    # which does not exist under this isolated HOME) rather than invalidating
    # the whole row — proves the fallback default actually engages.
    H10="$SHIM_TMP/relative-bunpath"; mkdir -p "$H10/.mattstack/rt" "$SHIM_TMP/relbunsrc/lib"
    echo 'x' > "$SHIM_TMP/relbunsrc/lib/daemon.ts"
    JSON10=$(printf '{"sourcePath":"%s/relbunsrc","bunPath":"relative-bun"}' "$SHIM_TMP")
    shim_write_kv "$H10/.mattstack/rt/state.db" "$JSON10"
    OUT10=$(env -i HOME="$H10" "$SHIM" --daemon 2>&1); RC10=$?
    OUT10="$OUT10$(shim_output "$H10")"
    [ "$RC10" -eq 0 ] && printf '%s' "$OUT10" | grep -qF "bun not found at $H10/.bun/bin/bun" && pass "shim: relative bunPath ignored, default engages" || fail "shim: relative bunPath should fall back to the default bunPath (rc=$RC10, out=$OUT10)"

    # F3: state.db is now a shared multi-namespace store (unlike the old
    # single-purpose dev-mode.json) — a group/other-writable copy must never
    # be trusted, even though its content would otherwise be a valid,
    # successful config.
    H11="$SHIM_TMP/untrusted-db"; mkdir -p "$H11/.mattstack/rt" "$SHIM_TMP/untrustedsrc/lib"
    echo 'x' > "$SHIM_TMP/untrustedsrc/lib/daemon.ts"
    JSON11=$(printf '{"sourcePath":"%s/untrustedsrc","bunPath":"/bin/echo"}' "$SHIM_TMP")
    shim_write_kv "$H11/.mattstack/rt/state.db" "$JSON11"
    chmod 664 "$H11/.mattstack/rt/state.db"
    OUT11=$(env -i HOME="$H11" "$SHIM" --daemon 2>&1); RC11=$?
    OUT11="$OUT11$(shim_output "$H11")"
    [ "$RC11" -eq 0 ] && printf '%s' "$OUT11" | grep -q 'not owned by this user or is group/other-writable' && pass "shim: group-writable state.db is refused, not trusted" || fail "shim: group-writable state.db should be refused by name (rc=$RC11, out=$OUT11)"

    # The legacy fallback reaches execv the same way the state.db row does, so
    # it carries the same trust gate — a source that skipped it would hand the
    # choice of what the daemon runs to anyone who can write the file. No
    # state.db here, so the fallback is the only path under test.
    H11B="$SHIM_TMP/untrusted-legacy"; mkdir -p "$H11B/.mattstack/rt" "$SHIM_TMP/untrustedlegacysrc/lib"
    echo 'x' > "$SHIM_TMP/untrustedlegacysrc/lib/daemon.ts"
    printf '{"sourcePath":"%s/untrustedlegacysrc","bunPath":"/bin/echo"}' "$SHIM_TMP" > "$H11B/.mattstack/rt/dev-mode.json"
    chmod 664 "$H11B/.mattstack/rt/dev-mode.json"
    OUT11B=$(env -i HOME="$H11B" "$SHIM" --daemon 2>&1); RC11B=$?
    OUT11B="$OUT11B$(shim_output "$H11B")"
    [ "$RC11B" -eq 0 ] && printf '%s' "$OUT11B" | grep -q 'not owned by this user or is group/other-writable' && pass "shim: group-writable legacy dev-mode.json is refused, not trusted" || fail "shim: group-writable legacy dev-mode.json should be refused by name (rc=$RC11B, out=$OUT11B)"

    # F4 fix: this case previously used WAL mode, where a reader is NOT
    # blocked by a concurrent BEGIN EXCLUSIVE at all (measured 16ms vs 2530ms
    # for the same experiment against a rollback-journal db — WAL's whole
    # point is that readers and writers don't block each other), so
    # busy_timeout was never exercised despite the case's name. Using the
    # default rollback journal here makes the lock genuinely block this
    # read. The old assertion (`rc == 0`) also could not tell "read the row"
    # from "read nothing", since both produce exit 0 — asserting the SPECIFIC
    # stand-down text (which only appears if the row was actually read after
    # the wait) and a nonzero minimum elapsed time closes both gaps: remove
    # busy_timeout from the shim and this case fails on both counts (the read
    # fails immediately with SQLITE_BUSY, elapsed ~0s, and the generic
    # "no dev-mode row"/open-failure text appears instead).
    # Whole-second timing (BSD `date` on macOS has no portable %N/millisecond
    # format) — coarse, but a genuine wait for a 2s-held lock reliably reads
    # as >=1s elapsed, which is all this needs to prove: not instant.
    H7="$SHIM_TMP/busy"; mkdir -p "$H7/.mattstack/rt"
    JSON7=$(printf '{"sourcePath":"%s/nope-daemon-dir","bunPath":"/bin/echo"}' "$SHIM_TMP")
    shim_write_kv "$H7/.mattstack/rt/state.db" "$JSON7"
    python3 - "$H7/.mattstack/rt/state.db" <<'PYEOF' &
import sqlite3, sys, time
db = sqlite3.connect(sys.argv[1], isolation_level=None)
db.execute("PRAGMA busy_timeout=0;")
db.execute("BEGIN EXCLUSIVE;")
time.sleep(2)
db.execute("COMMIT;")
PYEOF
    BUSY_BLOCKER_PID=$!
    sleep 0.3
    BUSY_START=$(date +%s)
    OUT7=$(env -i HOME="$H7" "$SHIM" --daemon 2>&1); RC7=$?
    OUT7="$OUT7$(shim_output "$H7")"
    BUSY_ELAPSED=$(( $(date +%s) - BUSY_START ))
    wait "$BUSY_BLOCKER_PID" 2>/dev/null
    if [ "$RC7" -eq 0 ] && [ "$BUSY_ELAPSED" -ge 1 ] && [ "$BUSY_ELAPSED" -le 6 ] \
        && printf '%s' "$OUT7" | grep -q "daemon source not found at $SHIM_TMP/nope-daemon-dir/lib/daemon.ts"; then
        pass "shim: busy_timeout actually waited out the lock and then read the row (${BUSY_ELAPSED}s) → exit $RC7"
    else
        fail "shim: busy contention did not prove busy_timeout mattered (rc=$RC7, elapsed=${BUSY_ELAPSED}s, out=$OUT7)"
    fi
fi
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

[ "$SKIPPED_RUNTIME" -gt 0 ] && echo "  · skip: $SKIPPED_RUNTIME hardened-runtime checks (not Developer ID signed)"

echo ""
echo "  $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
