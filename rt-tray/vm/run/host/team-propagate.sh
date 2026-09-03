#!/bin/bash
# After a joiner reached Done: the owner runs members sync and waits for the
# team-sync daemon to push; the joiner runs team pull; the joiner's
# propagation is asserted. Both the push and the pull go through the daemon,
# not this script.
# Usage: team-propagate.sh <owner-vm> <joiner-vm> <expect.json> [--slug vmtest] [--rt <dist/rt>] [--logs <dir>]
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; source "$HERE/../../lib/common.sh"
OWNER="${1:?owner vm}"; JOINER="${2:?joiner vm}"; EXPECT="${3:?expect.json}"; shift 3
SLUG=vmtest; RT_BIN="$VM_ROOT/../../dist/rt"; LOGS="$PWD"
while [ $# -gt 0 ]; do case "$1" in
  --slug) SLUG="$2"; shift 2;; --rt) RT_BIN="$2"; shift 2;; --logs) LOGS="$2"; shift 2;;
  *) vm_die "unknown arg $1";; esac; done
[ -f "$EXPECT" ] || vm_die "no expect file: $EXPECT"
mkdir -p "$LOGS"

vm_log "owner: members sync, then wait for the daemon's push"
vm_scp "$VM_TESTER_USER" "$OWNER" "$RT_BIN" /tmp/rt-new
vm_ssh "$VM_TESTER_USER" "$OWNER" "SLUG='$SLUG' VM_TESTER_PASS='$VM_TESTER_PASS' bash -s" <<'GUEST' | tee "$LOGS/propagate-owner.log"
set -euo pipefail
export PATH="$HOME/.local/bin:/Applications/mattstack.app/Contents/Helpers:/usr/bin:/bin:/usr/sbin:/sbin"
RT=/tmp/rt-new; chmod +x "$RT"
security unlock-keychain -p "$VM_TESTER_PASS" "$HOME/Library/Keychains/login.keychain-db"
SYNC_JSON=$("$RT" team members sync --team "$SLUG" --json 2>/dev/null | tail -1)
echo "$SYNC_JSON"
SYNC_AT=$(printf '%s' "$SYNC_JSON" | jq -r '.at')

elapsed=0
PUSHED=""
STATUS_JSON=""
while [ "$elapsed" -lt 180 ]; do
  STATUS_JSON=$("$RT" team status --team "$SLUG" --json 2>/dev/null | tail -1) || true
  PUSHED=$(printf '%s' "${STATUS_JSON:-}" | jq -r '.lastPushAt // empty' 2>/dev/null) || true
  if [ -n "$PUSHED" ] && [[ "$PUSHED" > "$SYNC_AT" ]]; then
    break
  fi
  PUSHED=""
  sleep 5
  elapsed=$((elapsed+5))
done
if [ -z "$PUSHED" ]; then
  echo "owner: daemon never pushed"
  echo "$STATUS_JSON"
  exit 1
fi
echo "owner: daemon pushed at $PUSHED"
GUEST

vm_log "joiner: team pull (daemon) + assert"
vm_scp "$VM_TESTER_USER" "$JOINER" "$RT_BIN" /tmp/rt-new
vm_scp "$VM_TESTER_USER" "$JOINER" "$EXPECT" /tmp/team-expect.json
vm_scp "$VM_TESTER_USER" "$JOINER" "$VM_ROOT/run/guest/assert-team.sh" /tmp/assert-team.sh
vm_ssh "$VM_TESTER_USER" "$JOINER" "SLUG='$SLUG' VM_TESTER_PASS='$VM_TESTER_PASS' bash -s" <<'GUEST' | tee "$LOGS/propagate-joiner.log"
set -euo pipefail
export PATH="$HOME/.local/bin:/Applications/mattstack.app/Contents/Helpers:/usr/bin:/bin:/usr/sbin:/sbin"
RT=/tmp/rt-new; chmod +x "$RT" /tmp/assert-team.sh
security unlock-keychain -p "$VM_TESTER_PASS" "$HOME/Library/Keychains/login.keychain-db"
cd "$HOME/.mattstack/teams/$SLUG"

set +e
PULL_JSON=$("$RT" team pull --team "$SLUG" --json 2>/dev/null | tail -1)
PULL_RC=$?
set -e
echo "$PULL_JSON"
[ "$PULL_RC" -eq 0 ] || exit 1

echo "joiner clone at $(git rev-parse --short HEAD)"
bash /tmp/assert-team.sh "$SLUG" /tmp/team-expect.json
GUEST
