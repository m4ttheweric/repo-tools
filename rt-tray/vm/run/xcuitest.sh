#!/bin/bash
# XCUITest-driven walkthrough inside an -xcode golden. Gated on Xcode + L3's project.yml.
# Usage: xcuitest.sh --ver <14|15|26> --dmg <path> [--keep]
set -uo pipefail
source "$(cd "$(dirname "$0")/.." && pwd)/lib/common.sh"
VER=""; DMG=""; KEEP=0
while [ $# -gt 0 ]; do case "$1" in --ver) VER="$2"; shift 2;; --dmg) DMG="$2"; shift 2;; --keep) KEEP=1; shift;; *) vm_die "unknown arg $1";; esac; done
[ -n "$VER" ] && [ -f "${DMG:-}" ] || vm_die "usage: xcuitest.sh --ver <v> --dmg <path> [--keep]"
vm_run_init "xcuitest-$VER"
GOLDEN="$(vm_golden_name "$VER" xcuitest)"; RUN_VM="mattstack-xcui-$VER-$(date +%H%M%S)"
GUEST_RUN="/Volumes/My Shared Files/run"

vm_phase_begin gate
case "$(xcode-select -p 2>/dev/null)" in /Applications/Xcode*.app/*) ;; *) vm_phase_end gate skip "Xcode not installed on the host (xcode-select -p)"; vm_render_report; exit 0;; esac
[ -f "$VM_ROOT/../project.yml" ] || { vm_phase_end gate skip "rt-tray/project.yml absent (L3 deliverable)"; vm_render_report; exit 0; }
tart list 2>/dev/null | awk '{print $2}' | grep -qx "$GOLDEN" || { vm_phase_end gate skip "golden $GOLDEN missing — build-golden.sh $VER --xcode"; vm_render_report; exit 0; }
vm_phase_end gate pass

TART_PID=""
cleanup() { [ "$KEEP" = 1 ] || { tart stop "$RUN_VM" 2>/dev/null; [ -n "$TART_PID" ] && wait "$TART_PID" 2>/dev/null; tart delete "$RUN_VM" 2>/dev/null; }; vm_render_report; exit "$([ "$(vm_phases_failed)" -eq 0 ] && echo 0 || echo 1)"; }
trap cleanup EXIT

vm_phase_begin clone; tart clone "$GOLDEN" "$RUN_VM" >>"$VM_RUN_DIR/logs/tart.log" 2>&1 && vm_phase_end clone pass || { vm_phase_end clone fail "tart clone"; exit 1; }
vm_phase_begin boot
tart run "$RUN_VM" --no-audio "--dir=run:$VM_RUN_DIR" >>"$VM_RUN_DIR/logs/tart.log" 2>&1 & TART_PID=$!
vm_wait_ssh "$VM_TESTER_USER" "$RUN_VM" 420 && vm_phase_end boot pass || { vm_phase_end boot fail "ssh"; exit 1; }

vm_phase_begin stage
cp "$DMG" "$VM_RUN_DIR/in/mattstack.dmg"; cp -R "$VM_ROOT/run/guest" "$VM_RUN_DIR/in/guest"
mkdir -p "$VM_RUN_DIR/in/src"; rsync -a --exclude .build --exclude '*.app' --exclude vm "$VM_ROOT/../" "$VM_RUN_DIR/in/src/rt-tray/"
vm_ssh_try "$VM_TESTER_USER" "$RUN_VM" "rm -rf ~/src && cp -R '$GUEST_RUN/in/src' ~/src && cd ~/src/rt-tray && (command -v xcodegen >/dev/null || brew install xcodegen) && xcodegen generate && touch '$GUEST_RUN/logs/.write-probe' && rm -f '$GUEST_RUN/logs/.write-probe'" >>"$VM_RUN_DIR/logs/stage.log" 2>&1 \
  && vm_phase_end stage pass || { vm_phase_end stage fail "xcodegen generate or virtiofs share not writable by tester (logs/stage.log)"; exit 1; }

vm_phase_begin install
vm_ssh_try "$VM_ADMIN_USER" "$RUN_VM" "GUEST_RUN='$GUEST_RUN' bash '$GUEST_RUN/in/guest/install-app.sh' copy '$GUEST_RUN/in/mattstack.dmg' --no-quarantine" >>"$VM_RUN_DIR/logs/install.log" 2>&1 \
  && vm_phase_end install pass || { vm_phase_end install fail "copy (logs/install.log)"; exit 1; }

vm_phase_begin xcuitest
if vm_ssh_try "$VM_TESTER_USER" "$RUN_VM" "cd ~/src/rt-tray && xcodebuild test -project mattstack.xcodeproj -scheme mattstack -destination 'platform=macOS' -only-testing:mattstackUITests -resultBundlePath '$GUEST_RUN/logs/xcuitest.xcresult' CODE_SIGN_IDENTITY=\"-\" CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM=\"\" ENABLE_HARDENED_RUNTIME=NO" >"$VM_RUN_DIR/logs/xcodebuild.log" 2>&1; then
  vm_phase_end xcuitest pass
else vm_phase_end xcuitest fail "xcodebuild test failed (logs/xcodebuild.log)"; fi
vm_ssh_try "$VM_TESTER_USER" "$RUN_VM" "xcrun xcresulttool export attachments --path '$GUEST_RUN/logs/xcuitest.xcresult' --output-path '$GUEST_RUN/screenshots' 2>/dev/null || true" >/dev/null 2>&1

vm_phase_begin assert
vm_ssh_try "$VM_TESTER_USER" "$RUN_VM" "GUEST_RUN='$GUEST_RUN' bash '$GUEST_RUN/in/guest/assert-installed.sh'" >"$VM_RUN_DIR/logs/assert.log" 2>&1 && vm_phase_end assert pass || vm_phase_end assert fail "see logs/assert.log"
