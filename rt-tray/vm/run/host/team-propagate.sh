#!/bin/bash
# After a joiner reached Done: the owner collects the joiner's key and
# publishes; the joiner pulls; the joiner's propagation is asserted.
# Usage: team-propagate.sh <owner-vm> <joiner-vm> <expect.json> --pat-env <VAR> [--slug vmtest] [--rt <dist/rt>] [--logs <dir>]
#
# The owner's commit and the joiner's pull are done by hand here: RT-30's
# snapshot daemon covers only the home repo, so nothing in the product does
# either yet. They are what that feature will replace, not part of the
# assertion. The joiner's pull carries its forge token the way rt's own
# clones do (env, never argv).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; source "$HERE/../../lib/common.sh"
OWNER="${1:?owner vm}"; JOINER="${2:?joiner vm}"; EXPECT="${3:?expect.json}"; shift 3
SLUG=vmtest; PAT_ENV=""; RT_BIN="$VM_ROOT/../../dist/rt"; LOGS="$PWD"
while [ $# -gt 0 ]; do case "$1" in
  --pat-env) PAT_ENV="$2"; shift 2;; --slug) SLUG="$2"; shift 2;; --rt) RT_BIN="$2"; shift 2;; --logs) LOGS="$2"; shift 2;;
  *) vm_die "unknown arg $1";; esac; done
[ -n "$PAT_ENV" ] && [ -n "${!PAT_ENV:-}" ] || vm_die "--pat-env <VAR> must name a non-empty variable (the joiner's forge token)"
[ -f "$EXPECT" ] || vm_die "no expect file: $EXPECT"
mkdir -p "$LOGS"

vm_log "owner: members sync + commit + publish"
vm_scp "$VM_TESTER_USER" "$OWNER" "$RT_BIN" /tmp/rt-new
vm_ssh "$VM_TESTER_USER" "$OWNER" "SLUG='$SLUG' VM_TESTER_PASS='$VM_TESTER_PASS' bash -s" <<'GUEST' | tee "$LOGS/propagate-owner.log"
set -euo pipefail
export PATH="$HOME/.local/bin:/Applications/mattstack.app/Contents/Helpers:/usr/bin:/bin:/usr/sbin:/sbin"
RT=/tmp/rt-new; chmod +x "$RT"
security unlock-keychain -p "$VM_TESTER_PASS" "$HOME/Library/Keychains/login.keychain-db"
"$RT" team members sync --team "$SLUG" --json 2>/dev/null | tail -1
cd "$HOME/.mattstack/teams/$SLUG"
git add -A; git -c user.name=vmtest -c user.email=vmtest@example.invalid commit -q -m "team: members sync" || true
"$RT" team publish --team "$SLUG" --json | tail -1
GUEST

vm_log "joiner: pull + assert"
vm_scp "$VM_TESTER_USER" "$JOINER" "$RT_BIN" /tmp/rt-new
vm_scp "$VM_TESTER_USER" "$JOINER" "$EXPECT" /tmp/team-expect.json
vm_scp "$VM_TESTER_USER" "$JOINER" "$VM_ROOT/run/guest/assert-team.sh" /tmp/assert-team.sh
vm_ssh "$VM_TESTER_USER" "$JOINER" "SLUG='$SLUG' RT_GIT_TOKEN='${!PAT_ENV}' VM_TESTER_PASS='$VM_TESTER_PASS' bash -s" <<'GUEST' | tee "$LOGS/propagate-joiner.log"
set -euo pipefail
export PATH="$HOME/.local/bin:/Applications/mattstack.app/Contents/Helpers:/usr/bin:/bin:/usr/sbin:/sbin"
chmod +x /tmp/rt-new /tmp/assert-team.sh
security unlock-keychain -p "$VM_TESTER_PASS" "$HOME/Library/Keychains/login.keychain-db"
cd "$HOME/.mattstack/teams/$SLUG"
RT_GIT_USER=x-access-token GIT_TERMINAL_PROMPT=0 git -c credential.helper= \
  -c 'credential.helper=!f() { echo username=$RT_GIT_USER; echo password=$RT_GIT_TOKEN; }; f' pull -q --ff-only
echo "joiner clone at $(git rev-parse --short HEAD)"
bash /tmp/assert-team.sh "$SLUG" /tmp/team-expect.json
GUEST
