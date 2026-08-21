#!/bin/bash
# Build mattstack-golden-<ver> from the cirruslabs vanilla image.
# Usage: build-golden.sh <14|15|26> [--dry-run] [--rebuild]
# ORCHESTRATOR/MATT: downloads ~25 GB per image; pauses once for manual TCC clicks.
set -euo pipefail
source "$(cd "$(dirname "$0")/.." && pwd)/lib/common.sh"

VER="${1:-}"; shift || true
[ -n "$VER" ] || vm_die "usage: build-golden.sh <14|15|26> [--dry-run] [--rebuild]"
DRY=0; REBUILD=0
for a in "$@"; do case "$a" in --dry-run) DRY=1;; --rebuild) REBUILD=1;; *) vm_die "unknown arg $a";; esac; done

IMAGE=$(vm_image_for "$VER"); GOLDEN=$(vm_golden_name "$VER")
run() { if [ "$DRY" = 1 ]; then vm_log "[dry-run] $*"; else "$@"; fi; }

vm_log "golden: $GOLDEN ← $IMAGE"
if [ "$DRY" = 0 ]; then
  vm_require_cmd tart "brew install openai/tools/tart   (old tap: cirruslabs/cli/tart)"
  vm_require_cmd sshpass "brew install cirruslabs/cli/sshpass"
  mkdir -p "$VM_CACHE" "$VM_ARTIFACTS"
  [ -f "$VM_SSH_KEY" ] || ssh-keygen -q -t ed25519 -N '' -C mattstack-vm -f "$VM_SSH_KEY"
  if tart list 2>/dev/null | awk '{print $2}' | grep -qx "$GOLDEN"; then
    [ "$REBUILD" = 1 ] || vm_die "$GOLDEN exists; pass --rebuild to replace it"
    tart stop "$GOLDEN" 2>/dev/null || true; tart delete "$GOLDEN"
  fi
fi

run tart clone "$IMAGE" "$GOLDEN"
run tart set "$GOLDEN" --cpu 4 --memory 8192 --display 1600x1000

if [ "$DRY" = 1 ]; then
  vm_log "[dry-run] would: tart run $GOLDEN (with graphics) → provision-guest.sh over ssh → pause for TCC clicks → verify-golden.sh → tart stop"
  exit 0
fi

tart run "$GOLDEN" --no-audio > "$VM_ARTIFACTS/golden-$VER-tart.log" 2>&1 &
TART_PID=$!
trap 'kill $TART_PID 2>/dev/null || true' EXIT
vm_log "waiting for ssh as admin (password)…"
start=$(date +%s)
until vm_ssh_pw "$VM_ADMIN_USER" "$VM_ADMIN_PASS" "$GOLDEN" true 2>/dev/null; do
  [ $(( $(date +%s) - start )) -gt 600 ] && vm_die "ssh never came up"
  sleep 5
done

PUB=$(cat "$VM_SSH_KEY.pub")
vm_ssh_pw "$VM_ADMIN_USER" "$VM_ADMIN_PASS" "$GOLDEN" "cat > /tmp/provision-guest.sh" < "$VM_ROOT/golden/provision-guest.sh"
vm_ssh_pw "$VM_ADMIN_USER" "$VM_ADMIN_PASS" "$GOLDEN" "bash /tmp/provision-guest.sh '$VER' '$VM_TESTER_PASS' '$PUB'"

vm_log "rebooting into tester's auto-login session…"
vm_ssh "$VM_ADMIN_USER" "$GOLDEN" "sudo reboot" || true
sleep 20
vm_wait_ssh "$VM_TESTER_USER" "$GOLDEN" 600 || vm_die "tester ssh never came up after reboot"
vm_ssh "$VM_TESTER_USER" "$GOLDEN" "sysadminctl -screenLock off -password '$VM_TESTER_PASS'" || true

cat <<EOF

  ┌─ MANUAL STEP (once per golden) ─────────────────────────────────────────┐
  │ In the Tart window (logged in as tester):                                │
  │  1. System Settings → Privacy & Security → Accessibility → "+" →         │
  │     ⌘⇧G, add /usr/libexec/sshd-keygen-wrapper, then /usr/bin/osascript;  │
  │     toggle both ON (authenticate with admin / admin).                    │
  │  2. Back in this terminal press Enter; the script sends one osascript    │
  │     over ssh — approve the "sshd-keygen-wrapper wants to control         │
  │     System Events" Automation prompt in the VM with OK.                  │
  └──────────────────────────────────────────────────────────────────────────┘
EOF
read -r -p "  Press Enter after step 1… " _
vm_ssh "$VM_TESTER_USER" "$GOLDEN" 'osascript -e "tell application \"System Events\" to get name of first process whose frontmost is true"' || true
read -r -p "  Approved the Automation prompt? Press Enter to verify… " _

"$VM_ROOT/golden/verify-golden.sh" "$VER" "$GOLDEN"
vm_log "stopping $GOLDEN (never run the golden again; clone it)"
tart stop "$GOLDEN"
wait $TART_PID 2>/dev/null || true
trap - EXIT
vm_log "golden $GOLDEN ready"
