#!/bin/bash
# Build the vN+1 Sparkle enclosure + appcast from a built app, for the update phase.
# Usage: make-appcast.sh <mattstack.app> <new-version> <ed-private-key-file> <out-dir> [--sign <identity>]
# The app's SUPublicEDKey must match the private key (L4 build: SPARKLE_PUBLIC_ED_KEY override).
# CFBundleVersion = major*1000000 + minor*1000 + patch — the same scheme as the release build, so
# Sparkle's numeric comparison stays monotonic against real releases.
set -euo pipefail
source "$(cd "$(dirname "$0")/.." && pwd)/lib/common.sh"
APP="${1:-}"; NEWV="${2:-}"; KEY="${3:-}"; OUT="${4:-}"; shift 4 2>/dev/null || true
SIGN="-"
while [ $# -gt 0 ]; do case "$1" in --sign) SIGN="$2"; shift 2;; *) vm_die "unknown arg $1";; esac; done
[ -d "$APP" ] && [ -n "$NEWV" ] && [ -f "$KEY" ] && [ -n "$OUT" ] \
  || vm_die "usage: make-appcast.sh <mattstack.app> <new-version> <ed-key-file> <out-dir> [--sign <identity>]"
echo "$NEWV" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' || vm_die "new-version must be X.Y.Z (got $NEWV)"
NEWB=$(echo "$NEWV" | awk -F. '{ printf "%d", $1*1000000 + $2*1000 + $3 }')

GEN="${SPARKLE_BIN:+$SPARKLE_BIN/}generate_appcast"
command -v "$GEN" >/dev/null 2>&1 || vm_die "generate_appcast not found — download Sparkle-<ver>.tar.xz from https://github.com/sparkle-project/Sparkle/releases, extract, and set SPARKLE_BIN=<extracted>/bin"

mkdir -p "$OUT"; STAGE=$(mktemp -d); trap 'rm -rf "$STAGE"' EXIT
ditto "$APP" "$STAGE/mattstack.app"
PL="$STAGE/mattstack.app/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $NEWV" "$PL"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $NEWB" "$PL"
# An ad-hoc signature carries no Team ID, and hardened runtime turns on Library Validation,
# which then refuses to load the app's own (equally ad-hoc) frameworks. The update installs
# and the new app dies at launch on "different Team IDs" -- a crash the appcast, the enclosure
# signature and `codesign --verify --deep --strict` all still call healthy. A real release is
# signed by one team and never hits this, so the bypass rides only on the ad-hoc default, and
# only on the outer bundle: Library Validation is enforced against the process's main
# executable, not against each nested Mach-O.
#
# `codesign --force` also DROPS the existing entitlements unless they are preserved, and
# build.sh signs Contents/MacOS/rt and every Bun helper with the JIT entitlements those
# binaries need under hardened runtime. Strip them and the update still installs, still
# launches, and then its rt daemon is SIGKILLed with CODESIGNING / "Invalid Page" the first
# time it faults in a JIT page -- so the leg sees the version change and no daemon.
NESTED_SIGN=(--force --preserve-metadata=entitlements --options runtime --timestamp=none --sign "$SIGN")
APP_SIGN=(--force --preserve-metadata=entitlements --options runtime --timestamp=none --sign "$SIGN")
if [ "$SIGN" = "-" ]; then
  # --entitlements and --preserve-metadata=entitlements are mutually exclusive; the explicit
  # file below is built FROM the app's own entitlements, so nothing is lost by dropping it.
  APP_SIGN=(--force --options runtime --timestamp=none --sign "$SIGN")
  ENT="$STAGE/entitlements.plist"
  codesign -d --entitlements :- "$APP" >"$ENT" 2>/dev/null || true
  [ -s "$ENT" ] || printf '%s\n' '<?xml version="1.0" encoding="UTF-8"?>' \
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">' \
    '<plist version="1.0"><dict/></plist>' >"$ENT"
  /usr/libexec/PlistBuddy -c "Add :com.apple.security.cs.disable-library-validation bool true" "$ENT" >/dev/null 2>&1 \
    || /usr/libexec/PlistBuddy -c "Set :com.apple.security.cs.disable-library-validation true" "$ENT" >/dev/null \
    || vm_die "could not add the library-validation bypass to $ENT"
  APP_SIGN+=(--entitlements "$ENT")
fi

# Inside-out re-sign: every nested Mach-O first, then the bundle (never --deep).
# No exec-bit filter: a framework dylib shipped without u+x would keep its stale
# signature and fail Library Validation at launch; `file` alone decides.
while IFS= read -r f; do
  file -b "$f" | grep -q Mach-O || continue
  codesign "${NESTED_SIGN[@]}" "$f" 2>/dev/null || vm_die "codesign failed on ${f#$STAGE/}"
done < <(find "$STAGE/mattstack.app/Contents" -type f -not -path '*/Info.plist')
codesign "${APP_SIGN[@]}" "$STAGE/mattstack.app"

# Postconditions, not trust: both of these are invisible to `codesign --verify --deep --strict`,
# which passes on a bundle that installs and then cannot run.
if [ "$SIGN" = "-" ]; then
  codesign -d --entitlements :- "$STAGE/mattstack.app" 2>/dev/null \
    | grep -q 'com.apple.security.cs.disable-library-validation' \
    || vm_die "the re-signed app has no library-validation bypass; it would install and then crash at launch"
fi
if codesign -d --entitlements :- "$APP/Contents/MacOS/rt" 2>/dev/null | grep -q 'allow-jit'; then
  codesign -d --entitlements :- "$STAGE/mattstack.app/Contents/MacOS/rt" 2>/dev/null | grep -q 'allow-jit' \
    || vm_die "the re-sign dropped the JIT entitlements from Contents/MacOS/rt; the updated app's daemon would be killed on its first JIT page"
fi

rm -f "$OUT"/mattstack-*.zip "$OUT"/appcast.xml
REL="$VM_ROOT/../../scripts/release"
if [ -x "$REL/make-zip.sh" ]; then
  "$REL/make-zip.sh" "$STAGE/mattstack.app" "$OUT/mattstack-$NEWV.zip"
else
  (cd "$STAGE" && ditto -c -k --sequesterRsrc --keepParent mattstack.app "$OUT/mattstack-$NEWV.zip")
fi
"$GEN" --ed-key-file "$KEY" --download-url-prefix "http://127.0.0.1:$VM_APPCAST_PORT/" -o "$OUT/appcast.xml" "$OUT"
vm_log "appcast → $OUT/appcast.xml (enclosure mattstack-$NEWV.zip, build $NEWB)"
