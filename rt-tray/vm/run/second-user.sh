#!/bin/bash
# Layer (c): daily smoke as a second macOS user on this Mac.
# Usage: second-user.sh create | check | switch | run --artifact <mattstack-*.zip|mattstack-*.dmg>
set -euo pipefail
source "$(cd "$(dirname "$0")/.." && pwd)/lib/common.sh"
U="${MATTSTACK_SMOKE_USER:-mstest}"
cmd="${1:-}"; shift || true
ART=""
while [ $# -gt 0 ]; do case "$1" in --artifact) ART="$2"; shift 2;; *) vm_die "unknown arg $1";; esac; done

case "$cmd" in
  create)
    cat <<EOF
  MATT step — run in your own terminal (creates a standard user; choose the password interactively):
    sudo sysadminctl -addUser $U -fullName "mattstack smoke" -password -
  Then log the user in once so a GUI session exists (Fast User Switching; required for launchd gui/\$UID):
    $0 switch
  and switch back to your account.
EOF
    ;;
  switch)
    uid=$(id -u "$U" 2>/dev/null) || vm_die "user $U does not exist — $0 create"
    echo "  '/System/Library/CoreServices/Menu Extras/User.menu/Contents/Resources/CGSession' -switchToUserID $uid"
    ;;
  check)
    uid=$(id -u "$U" 2>/dev/null) || vm_die "user $U does not exist — $0 create"
    vm_log "user $U uid=$uid"
    if sudo -n true >/dev/null 2>&1; then
      if sudo -n launchctl print "gui/$uid" >/dev/null 2>&1; then
        vm_log "GUI session present (gui/$uid) — SMAppService registration will work"
      else
        vm_warn "no GUI session for $U — log the user in once ($0 switch); daemon will report not-booted otherwise"; exit 1
      fi
    elif launchctl print "gui/$uid" >/dev/null 2>&1; then
      vm_log "GUI session present (gui/$uid)"
    else
      vm_warn "cannot verify GUI session without sudo — run: sudo launchctl print gui/$uid"; exit 1
    fi
    ;;
  run)
    [ "$U" != "$(id -un)" ] || vm_die "refusing to run against your own account ($U)"
    case "$U" in mstest*|*smoke*) ;; *) vm_die "refusing to run against non-smoke user $U" ;; esac
    [ -n "$ART" ] && [ -f "$ART" ] || vm_die "run needs --artifact <file>"
    [ -f "$VM_ROOT/../../scripts/e2e-cleanroom.sh" ] || vm_die "scripts/e2e-cleanroom.sh not found (layer (a) recipe not present in this checkout)"
    uid=$(id -u "$U" 2>/dev/null) || vm_die "user $U does not exist — $0 create"
    vm_run_init "second-user"
    # Layer (c) exists only to prove SMAppService against a live GUI session — never let CI=true demote this away.
    GUI_OK=0
    if sudo -n true >/dev/null 2>&1; then
      sudo -n launchctl print "gui/$uid" >/dev/null 2>&1 || GUI_OK=1
    elif launchctl print "gui/$uid" >/dev/null 2>&1; then
      GUI_OK=0
    else
      GUI_OK=2
    fi
    if [ "$GUI_OK" -ne 0 ]; then
      vm_phase_begin second-user
      if [ "$GUI_OK" -eq 2 ]; then
        vm_phase_end second-user skip "cannot verify GUI session for $U without sudo — run: sudo launchctl print gui/$uid"
      else
        vm_phase_end second-user skip "no GUI session for $U — log the user in once ($0 switch); a smoke run without one proves nothing about SMAppService"
      fi
      vm_render_report
      exit 1
    fi
    HOME2=$(dscl . -read "/Users/$U" NFSHomeDirectory | awk '{print $2}')
    case "$HOME2" in /Users/*) ;; *) vm_die "unexpected home dir for $U: '$HOME2' (expected /Users/*)" ;; esac
    sudo install -d -o "$U" -m 700 "$HOME2/mattstack-smoke"
    sudo install -o "$U" -m 600 "$ART" "$HOME2/mattstack-smoke/$(basename "$ART")"
    sudo install -o "$U" -m 700 "$VM_ROOT/../../scripts/e2e-cleanroom.sh" "$HOME2/mattstack-smoke/e2e-cleanroom.sh"
    sudo install -o "$U" -m 700 -d "$HOME2/mattstack-smoke/artifacts"
    # sudo -iu gives the user's login env; the user is (ideally) logged in so `open`/SMAppService land in gui/<uid>.
    if sudo -iu "$U" bash -lc "cd ~/mattstack-smoke && ./e2e-cleanroom.sh --artifact ~/mattstack-smoke/$(basename "$ART") --home \$HOME --artifacts-dir ~/mattstack-smoke/artifacts --allow-existing-install" > "$VM_RUN_DIR/logs/second-user.log" 2>&1; then
      vm_phase_begin second-user; vm_phase_end second-user pass
    else
      vm_phase_begin second-user; vm_phase_end second-user fail "e2e-cleanroom exited non-zero (logs/second-user.log)"
    fi
    sudo cp -R "$HOME2/mattstack-smoke/artifacts/." "$VM_RUN_DIR/logs/" 2>/dev/null || true
    sudo chown -R "$(id -u):$(id -g)" "$VM_RUN_DIR"
    vm_render_report
    [ "$(vm_phases_failed)" -eq 0 ]
    ;;
  *) vm_die "usage: second-user.sh create|check|switch|run --artifact <file>";;
esac
