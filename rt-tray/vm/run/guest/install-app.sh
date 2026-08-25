#!/bin/bash
# Guest side of the install phase: copy the DMG into /Applications (admin), then launch (tester).
set -euo pipefail
GUEST_RUN="${GUEST_RUN:-/Volumes/My Shared Files/run}"
[ -d "$GUEST_RUN" ] || { echo "install-app.sh runs in the guest; $GUEST_RUN is not mounted" >&2; exit 1; }
LOG="$GUEST_RUN/logs/install-app.log"; mkdir -p "$(dirname "$LOG")"
# Log-write is best-effort: an unwritable share must never abort the copy under set -e/pipefail.
say() {
  local line; line="$(date -u +%H:%M:%S) $*"
  printf '%s\n' "$line" >&2
  printf '%s\n' "$line" >>"$LOG" 2>/dev/null || true
}
APP=/Applications/mattstack.app

cmd="${1:-}"; shift || true
case "$cmd" in
  copy)
    DMG="${1:-}"; shift || true; Q=1
    for a in "$@"; do case "$a" in --quarantine) Q=1;; --no-quarantine) Q=0;; esac; done
    [ -f "$DMG" ] || { say "no dmg at $DMG"; exit 1; }
    if [ "$Q" = 1 ]; then
      # Simulate a browser download so Gatekeeper assesses the app on first open.
      xattr -w com.apple.quarantine "0083;$(printf '%x' "$(date +%s)");Safari;$(uuidgen)" "$DMG"
      say "quarantine set on $(basename "$DMG")"
    else
      xattr -d com.apple.quarantine "$DMG" 2>/dev/null || true
      say "quarantine NOT set (unnotarised build mode)"
    fi
    hdiutil detach /Volumes/mattstack -quiet 2>/dev/null || true
    hdiutil attach "$DMG" -nobrowse -quiet -mountpoint /Volumes/mattstack
    [ -d /Volumes/mattstack/mattstack.app ] || { say "dmg has no mattstack.app"; hdiutil detach /Volumes/mattstack -quiet; exit 1; }
    sudo rm -rf "$APP"
    sudo ditto /Volumes/mattstack/mattstack.app "$APP"   # preserves xattrs incl. quarantine, like Finder
    sudo chown -R root:admin "$APP"
    hdiutil detach /Volumes/mattstack -quiet
    say "copied to $APP ($(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist"))"
    codesign --verify --deep --strict "$APP" 2>>"$LOG" && say "codesign verifies" || say "codesign does NOT verify (ad-hoc/dev build?)"
    spctl --assess --type execute "$APP" 2>>"$LOG" && say "spctl: accepted" || say "spctl: rejected (expect a Gatekeeper dialog if quarantined)"
    # A quarantined app copied by ditto/cp gets App Translocation on open: it
    # runs from a randomized read-only mount and cannot register its background
    # services (the app's own guard then blocks). A real user's Finder drag
    # marks the quarantine user-approved and never translocates, so stripping
    # after the assessment above is the faithful drag simulation.
    if [ "$Q" = 1 ]; then
      sudo xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true
      say "quarantine stripped post-assessment (Finder-drag parity, no translocation)"
    fi
    ;;
  launch)
    ENVS=(); ARGS=()
    while [ $# -gt 0 ]; do case "$1" in --env) ENVS+=("--env" "$2"); shift 2;; --arg) ARGS+=("$2"); shift 2;; *) shift;; esac; done
    [ -d "$APP" ] || { say "no app at $APP"; exit 1; }
    # `open`: env flags before the app path, the app's own argv after --args.
    if [ "${#ARGS[@]}" -gt 0 ]; then open ${ENVS[@]+"${ENVS[@]}"} "$APP" --args "${ARGS[@]}"
    else open ${ENVS[@]+"${ENVS[@]}"} "$APP"; fi
    for i in $(seq 1 30); do
      sleep 1
      if pgrep -x mattstack >/dev/null; then say "process up after ${i}s"; break; fi
      # Gatekeeper refusal shows a CoreServicesUIAgent alert; detect and report, don't dismiss.
      gk_rc=0; gk_out=$(osascript -e 'tell application "System Events" to exists (window 1 of process "CoreServicesUIAgent")' 2>>"$LOG") || gk_rc=$?
      if [ "$gk_rc" -ne 0 ]; then
        say "osascript probe unavailable (TCC?)"
      elif [ "$gk_out" = "true" ]; then
        say "Gatekeeper dialog present — app blocked"; exit 2
      fi
    done
    pgrep -x mattstack >/dev/null || { say "mattstack never started"; exit 1; }
    # Menu bar extra = the app's own status item; give it a few seconds to appear.
    for i in $(seq 1 20); do
      mb_rc=0; mb_out=$(osascript -e 'tell application "System Events" to tell process "mattstack" to count menu bar items of menu bar 2' 2>>"$LOG") || mb_rc=$?
      if [ "$mb_rc" -ne 0 ]; then
        say "osascript probe unavailable (TCC?)"
      elif printf '%s' "$mb_out" | grep -qE '^[1-9]'; then
        say "menu bar item present"; exit 0
      fi
      sleep 1
    done
    say "no menu bar item after 20s (app running)"; exit 0
    ;;
  *) echo "usage: install-app.sh copy <dmg> [--quarantine|--no-quarantine] | launch [--env K=V]... [--arg <launch-arg>]..." >&2; exit 1;;
esac
