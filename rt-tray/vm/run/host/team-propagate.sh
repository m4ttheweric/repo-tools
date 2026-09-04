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
# Owner-path default so the harness is not welded to one machine's filesystem; most runs have no key file at all.
LINEAR_KEY_FILE="${MATTSTACK_VMTEST_LINEAR_KEY_FILE:-$HOME/.mattstack/vmtest/linear-api-key.txt}"
if [ -f "$LINEAR_KEY_FILE" ]; then
  vm_scp "$VM_TESTER_USER" "$JOINER" "$LINEAR_KEY_FILE" /tmp/linear-key.txt
else
  vm_log "joiner: no Linear key file at $LINEAR_KEY_FILE, skipping the Linear leg"
fi
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

# Connect runs after team pull: the verb validates the key against the
# team's declared mattstack.integrations.linear.teamKey, which only exists
# once the clone has landed. The key must not outlive its use on the guest,
# so rm -f runs whether or not the connect succeeded; its own output is
# suppressed since a failure envelope could carry the value back into the log.
if [ -f /tmp/linear-key.txt ]; then
  if RT_BATCH=1 "$RT" setup linear connect --json < /tmp/linear-key.txt >/dev/null 2>&1; then
    echo "joiner: linear connected"
    # --from resumes Install from linear.mcp onward (fastbrowser.setup,
    # herdr.integration, extension.install, services.start, snapshot.push,
    # verify on this branch), not just the one step: Install already ran
    # once at join time, before this key existed, so linear.mcp skipped and
    # never wrote the mcpServers entry. This is what makes it write it now.
    RT_BATCH=1 "$RT" setup apply --from linear.mcp --json >/dev/null 2>&1 \
      && echo "joiner: linear.mcp applied" || echo "joiner: linear.mcp apply failed"
  else
    echo "joiner: linear connect failed"
  fi
  rm -f /tmp/linear-key.txt
fi

bash /tmp/assert-team.sh "$SLUG" /tmp/team-expect.json
GUEST
