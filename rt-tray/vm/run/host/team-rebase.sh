#!/bin/bash
# The two propagation paths team-propagate.sh does not reach: a joiner whose own
# held commit is rebased onto the owner's daemon push, and a same-key edit on
# both sides that surfaces as the team.sync needs-you row and clears after a
# reset to origin. Every commit, push, pull and rebase is the daemon's; this
# script only writes settings and reads verbs back.
# Usage: team-rebase.sh <owner-vm> <joiner-vm> [--slug vmtest] [--rt <dist/rt>] [--logs <dir>]
#
# The joiner account needs push rights on the team repo (GitLab Developer, 30)
# AND an unprotected default branch: multi-writer is the design, a Reporter
# joiner fails scenario A with "not allowed to push code to this project", and
# a protected `main` (GitLab's default for a new project, Maintainers only)
# fails it with "not allowed to push code to protected branches".
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; source "$HERE/../../lib/common.sh"
OWNER="${1:?owner vm}"; JOINER="${2:?joiner vm}"; shift 2
SLUG=vmtest; RT_BIN="$VM_ROOT/../../dist/rt"; LOGS="$PWD"
while [ $# -gt 0 ]; do case "$1" in
  --slug) SLUG="$2"; shift 2;; --rt) RT_BIN="$2"; shift 2;; --logs) LOGS="$2"; shift 2;;
  *) vm_die "unknown arg $1";; esac; done
[ -x "$RT_BIN" ] || vm_die "no compiled rt at $RT_BIN (bun build --compile ./cli.ts --outfile dist/rt)"
mkdir -p "$LOGS"
# The tally at the end counts TEAM FAIL rows across this run's logs; a previous
# run's logs in the same --logs dir would be counted as this run's failures.
rm -f "$LOGS"/rebase-*.log

# One host-side stamp, so both guests write and assert the same literals.
TS="$(date -u +%Y%m%d-%H%M%S)"
JOIN_PREFIX="JOIN-$TS"; OWNER_TITLE="owner-$TS"; OWNER2_TITLE="owner2-$TS"; JOINER_TITLE="joiner-$TS"

# guest <vm> <tag> <env-prefix>, guest script on stdin, tee'd to
# $LOGS/rebase-<tag>.log. Deliberately never dies: a failed assertion has to
# leave the pushDelaySec restore and the remaining steps their turn, so every
# outcome is a row in a log rather than an exit status here.
guest() {
  local vm="$1" tag="$2" envs="$3"
  local log="$LOGS/rebase-$tag.log" rc
  vm_log "$tag"
  set +e
  vm_ssh_try "$VM_TESTER_USER" "$vm" "$envs bash -s" 2>&1 | tee "$log"
  rc=${PIPESTATUS[0]}
  set -e
  if [ "$rc" -ne 0 ]; then
    echo "TEAM FAIL $tag: guest block exited $rc" | tee -a "$log"
  fi
}

# The joiner's hold spans three guest blocks, so no single block can own the
# restore; this runs from the EXIT trap when a block dies early, and directly
# as scenario B's last step otherwise.
RESTORED=0
restore_hold() {
  if [ "$RESTORED" = 1 ]; then return 0; fi
  RESTORED=1
  vm_log "joiner: restore pushDelaySec 60"
  vm_ssh_try "$VM_TESTER_USER" "$JOINER" "VM_TESTER_PASS='$VM_TESTER_PASS' bash -s" <<'GUEST' >>"$LOGS/rebase-restore.log" 2>&1 \
    || vm_warn "could not restore pushDelaySec on $JOINER... set rt.teamSnapshot pushDelaySec back to 60 there by hand"
set -euo pipefail
export PATH="$HOME/.local/bin:/Applications/mattstack.app/Contents/Helpers:/usr/bin:/bin:/usr/sbin:/sbin"
RT=/tmp/rt-new; chmod +x "$RT"
security unlock-keychain -p "$VM_TESTER_PASS" "$HOME/Library/Keychains/login.keychain-db"
"$RT" settings set rt.teamSnapshot '{"pushDelaySec": 60}' --scope machine
GUEST
}

vm_scp "$VM_TESTER_USER" "$OWNER" "$RT_BIN" /tmp/rt-new
vm_scp "$VM_TESTER_USER" "$JOINER" "$RT_BIN" /tmp/rt-new

# ── shared guest blocks ─────────────────────────────────────────────────────

# Hold the joiner's pushes, write one team-scope key, wait for the daemon's
# local commit. The hold is written BEFORE the key: schedulePush reads
# pushDelaySec when the commit arms the timer, not when the timer fires.
HOLD_AND_WRITE=$(cat <<'GUEST'
set -euo pipefail
export PATH="$HOME/.local/bin:/Applications/mattstack.app/Contents/Helpers:/usr/bin:/bin:/usr/sbin:/sbin"
RT=/tmp/rt-new; chmod +x "$RT"
security unlock-keychain -p "$VM_TESTER_PASS" "$HOME/Library/Keychains/login.keychain-db"
TEAM="$HOME/.mattstack/teams/$SLUG"

"$RT" settings set rt.teamSnapshot '{"pushDelaySec": 900}' --scope machine
"$RT" settings set "$KEY" "$VALUE" --scope team --team "$SLUG"

elapsed=0; AHEAD=""
while [ "$elapsed" -lt 90 ]; do
  AHEAD=$(git -C "$TEAM" rev-list --count origin/main..HEAD 2>/dev/null) || AHEAD=""
  if [ "${AHEAD:-}" = "1" ]; then break; fi
  AHEAD=""
  sleep 5; elapsed=$((elapsed+5))
done
if [ "${AHEAD:-}" = "1" ]; then
  echo "  joiner HEAD $(git -C "$TEAM" rev-parse --short HEAD)"
  echo "TEAM ok   $ROW"
else
  NOW=$(git -C "$TEAM" rev-list --count origin/main..HEAD 2>/dev/null) || NOW="?"
  echo "TEAM FAIL $ROW: no local commit within 90s (ahead=$NOW)"
fi
GUEST
)

# Write one team-scope key on the owner and wait for the daemon to push it.
# The wait compares lastPushAt against its own value from before the write
# rather than a wall-clock stamp: the two come from the same field in the same
# format, so no second/millisecond mismatch can make a real push read as old.
OWNER_WRITE=$(cat <<'GUEST'
set -euo pipefail
export PATH="$HOME/.local/bin:/Applications/mattstack.app/Contents/Helpers:/usr/bin:/bin:/usr/sbin:/sbin"
RT=/tmp/rt-new; chmod +x "$RT"
security unlock-keychain -p "$VM_TESTER_PASS" "$HOME/Library/Keychains/login.keychain-db"

BEFORE=$("$RT" team status --team "$SLUG" --json 2>/dev/null | tail -1 | jq -r '.lastPushAt // empty' 2>/dev/null) || BEFORE=""
"$RT" settings set board.title "$VALUE" --scope team --team "$SLUG"

elapsed=0; PUSHED=""; STATUS_JSON=""
while [ "$elapsed" -lt 180 ]; do
  STATUS_JSON=$("$RT" team status --team "$SLUG" --json 2>/dev/null | tail -1) || STATUS_JSON=""
  PUSHED=$(printf '%s' "${STATUS_JSON:-}" | jq -r '.lastPushAt // empty' 2>/dev/null) || PUSHED=""
  if [ -n "$PUSHED" ] && [[ "$PUSHED" > "$BEFORE" ]]; then break; fi
  PUSHED=""
  sleep 5; elapsed=$((elapsed+5))
done
if [ -n "$PUSHED" ]; then
  echo "TEAM ok   $ROW"
else
  echo "$STATUS_JSON"
  echo "TEAM FAIL $ROW: daemon never pushed within 180s (lastPushAt still ${BEFORE:-null})"
fi
GUEST
)

# ── scenario A: the joiner's held commit rebases onto the owner's push ──────

trap restore_hold EXIT
guest "$JOINER" a1-joiner-hold \
  "SLUG='$SLUG' VM_TESTER_PASS='$VM_TESTER_PASS' KEY='board.ticketPrefixes' VALUE='[\"$JOIN_PREFIX\"]' ROW='joiner committed locally, push held'" \
  <<<"$HOLD_AND_WRITE"

guest "$OWNER" a2-owner-push \
  "SLUG='$SLUG' VM_TESTER_PASS='$VM_TESTER_PASS' VALUE='\"$OWNER_TITLE\"' ROW='owner daemon pushed'" \
  <<<"$OWNER_WRITE"

guest "$JOINER" a3-joiner-rebase \
  "SLUG='$SLUG' VM_TESTER_PASS='$VM_TESTER_PASS' OWNER_TITLE='$OWNER_TITLE'" <<'GUEST'
set -euo pipefail
export PATH="$HOME/.local/bin:/Applications/mattstack.app/Contents/Helpers:/usr/bin:/bin:/usr/sbin:/sbin"
RT=/tmp/rt-new; chmod +x "$RT"
security unlock-keychain -p "$VM_TESTER_PASS" "$HOME/Library/Keychains/login.keychain-db"
TEAM="$HOME/.mattstack/teams/$SLUG"

set +e
PULL_JSON=$("$RT" team pull --team "$SLUG" --json 2>&1 | tail -1)
set -e
echo "$PULL_JSON"
OUTCOME=$(printf '%s' "${PULL_JSON:-}" | jq -r '.outcome // empty' 2>/dev/null) || OUTCOME=""

AHEAD=$(git -C "$TEAM" rev-list --count origin/main..HEAD 2>/dev/null) || AHEAD=""
git -C "$TEAM" log --oneline origin/main..HEAD 2>/dev/null | sed 's/^/  ahead: /' || true
git -C "$TEAM" show HEAD --stat --format='  %h %s' 2>/dev/null | head -5 || true
# -U0: both edits live in mattstack/settings.team.jsonc, so a default diff's
# context lines would report the owner's board.title as touched by the
# joiner's own commit.
TOUCHED=$(git -C "$TEAM" show HEAD -U0 --format= -- mattstack/settings.team.jsonc 2>/dev/null | grep -c '^[+-].*board\.title') || TOUCHED=0
TITLE_NOW=$("$RT" settings get board.title --json 2>/dev/null | tail -1 | jq -r '.value // empty' 2>/dev/null) || TITLE_NOW=""

if [ "$OUTCOME" = "rebased" ] && [ "${AHEAD:-}" = "1" ] && [ "${TOUCHED:-0}" -eq 0 ] && [ "$TITLE_NOW" = "$OWNER_TITLE" ]; then
  echo "TEAM ok   joiner rebased onto the owner's push"
else
  echo "TEAM FAIL joiner rebase: outcome=${OUTCOME:-none} ahead=${AHEAD:-?} board.title-lines=${TOUCHED:-?} board.title=${TITLE_NOW:-unset} (wanted rebased / 1 / 0 / $OWNER_TITLE)"
fi
GUEST

guest "$JOINER" a4-joiner-push \
  "SLUG='$SLUG' VM_TESTER_PASS='$VM_TESTER_PASS'" <<'GUEST'
set -euo pipefail
export PATH="$HOME/.local/bin:/Applications/mattstack.app/Contents/Helpers:/usr/bin:/bin:/usr/sbin:/sbin"
RT=/tmp/rt-new; chmod +x "$RT"
security unlock-keychain -p "$VM_TESTER_PASS" "$HOME/Library/Keychains/login.keychain-db"
TEAM="$HOME/.mattstack/teams/$SLUG"

"$RT" settings set rt.teamSnapshot '{"pushDelaySec": 60}' --scope machine

# The push timer was armed at 900 s when the commit landed and a settings write
# does not re-arm it, so only a later cycle that re-schedules can land this
# through the daemon; `rt team publish` is the documented hand path, taken here
# once the daemon has had 120 s.
elapsed=0; LANDED=""; VIA=""; AHEAD=""
while [ "$elapsed" -lt 240 ]; do
  AHEAD=$(git -C "$TEAM" rev-list --count origin/main..HEAD 2>/dev/null) || AHEAD=""
  if [ "${AHEAD:-}" = "0" ]; then LANDED=yes; VIA="${VIA:-daemon}"; break; fi
  if [ "$elapsed" -ge 120 ] && [ -z "$VIA" ]; then
    VIA=publish
    "$RT" team publish --team "$SLUG" --json 2>/dev/null | tail -1 || true
  fi
  sleep 5; elapsed=$((elapsed+5))
done
if [ "$LANDED" = yes ]; then
  echo "  landed via $VIA"
  echo "TEAM ok   joiner's rebased commit pushed"
else
  echo "TEAM FAIL joiner's rebased commit never reached origin within 240s (ahead=${AHEAD:-?}, tried ${VIA:-daemon})"
fi
GUEST

guest "$OWNER" a5-owner-sees \
  "SLUG='$SLUG' VM_TESTER_PASS='$VM_TESTER_PASS' JOIN_PREFIX='$JOIN_PREFIX'" <<'GUEST'
set -euo pipefail
export PATH="$HOME/.local/bin:/Applications/mattstack.app/Contents/Helpers:/usr/bin:/bin:/usr/sbin:/sbin"
RT=/tmp/rt-new; chmod +x "$RT"
security unlock-keychain -p "$VM_TESTER_PASS" "$HOME/Library/Keychains/login.keychain-db"

set +e
PULL_JSON=$("$RT" team pull --team "$SLUG" --json 2>&1 | tail -1)
set -e
echo "$PULL_JSON"
OUTCOME=$(printf '%s' "${PULL_JSON:-}" | jq -r '.outcome // empty' 2>/dev/null) || OUTCOME=""
PREFIXES=$("$RT" settings get board.ticketPrefixes --json 2>/dev/null | tail -1 | jq -c '.value // empty' 2>/dev/null) || PREFIXES=""
WANT="[\"$JOIN_PREFIX\"]"

# up-to-date is as good as fast-forwarded here: the owner's own interval pull
# may already have taken the joiner's commit.
if { [ "$OUTCOME" = "fast-forwarded" ] || [ "$OUTCOME" = "up-to-date" ]; } && [ "$PREFIXES" = "$WANT" ]; then
  echo "TEAM ok   owner sees the joiner's edit"
else
  echo "TEAM FAIL owner pull: outcome=${OUTCOME:-none} board.ticketPrefixes=${PREFIXES:-unset} (wanted fast-forwarded|up-to-date and $WANT)"
fi
GUEST

# ── scenario B: same-key edits, the needs-you row, and the recovery ─────────

guest "$JOINER" b1-joiner-hold \
  "SLUG='$SLUG' VM_TESTER_PASS='$VM_TESTER_PASS' KEY='board.title' VALUE='\"$JOINER_TITLE\"' ROW='joiner committed a conflicting title, push held'" \
  <<<"$HOLD_AND_WRITE"

guest "$OWNER" b2-owner-push \
  "SLUG='$SLUG' VM_TESTER_PASS='$VM_TESTER_PASS' VALUE='\"$OWNER2_TITLE\"' ROW='owner daemon pushed the competing title'" \
  <<<"$OWNER_WRITE"

guest "$JOINER" b3-joiner-conflict \
  "SLUG='$SLUG' VM_TESTER_PASS='$VM_TESTER_PASS'" <<'GUEST'
set -euo pipefail
export PATH="$HOME/.local/bin:/Applications/mattstack.app/Contents/Helpers:/usr/bin:/bin:/usr/sbin:/sbin"
RT=/tmp/rt-new; chmod +x "$RT"
security unlock-keychain -p "$VM_TESTER_PASS" "$HOME/Library/Keychains/login.keychain-db"
TEAM="$HOME/.mattstack/teams/$SLUG"

set +e
PULL_JSON=$("$RT" team pull --team "$SLUG" --json 2>&1 | tail -1)
set -e
echo "$PULL_JSON"
OUTCOME=$(printf '%s' "${PULL_JSON:-}" | jq -r '.outcome // empty' 2>/dev/null) || OUTCOME=""
STATUS_JSON=$("$RT" team status --team "$SLUG" --json 2>/dev/null | tail -1) || STATUS_JSON=""
CONFLICTED=$(printf '%s' "${STATUS_JSON:-}" | jq -r '.conflicted.at // empty' 2>/dev/null) || CONFLICTED=""
BRANCH=$(git -C "$TEAM" symbolic-ref --short HEAD 2>/dev/null) || BRANCH=""

GITDIR=$(git -C "$TEAM" rev-parse --git-dir 2>/dev/null) || GITDIR=".git"
case "$GITDIR" in /*) ;; *) GITDIR="$TEAM/$GITDIR" ;; esac
REBASING=no
if [ -d "$GITDIR/rebase-merge" ] || [ -d "$GITDIR/rebase-apply" ]; then REBASING=yes; fi

if [ "$OUTCOME" = "conflict" ] && [ -n "$CONFLICTED" ] && [ -n "$BRANCH" ] && [ "$REBASING" = no ]; then
  echo "TEAM ok   conflict detected"
else
  echo "TEAM FAIL conflict: outcome=${OUTCOME:-none} conflicted=${CONFLICTED:-null} branch=${BRANCH:-detached} rebase-in-progress=$REBASING (wanted conflict / set / a branch / no)"
fi

SETUP_JSON=$("$RT" setup status --json 2>/dev/null | tail -1) || SETUP_JSON=""
ROW=$(printf '%s' "${SETUP_JSON:-}" | jq -c '.groups[]?.rows[]? | select(.id == "team.sync")' 2>/dev/null | head -1) || ROW=""
ROW_STATUS=$(printf '%s' "${ROW:-}" | jq -r '.status // empty' 2>/dev/null) || ROW_STATUS=""
ROW_DETAIL=$(printf '%s' "${ROW:-}" | jq -r '.detail // empty' 2>/dev/null) || ROW_DETAIL=""
echo "  team.sync: ${ROW_STATUS:-absent} ${ROW_DETAIL:-}"
if [ "$ROW_STATUS" = "needs-you" ] \
  && printf '%s' "$ROW_DETAIL" | grep -q 'rebase conflict' \
  && printf '%s' "$ROW_DETAIL" | grep -q "$SLUG"; then
  echo "TEAM ok   team.sync needs-you names the clone"
else
  echo "TEAM FAIL team.sync row ${ROW_STATUS:-absent}: ${ROW_DETAIL:-none} (wanted needs-you naming $SLUG and a rebase conflict)"
fi
GUEST

guest "$JOINER" b4-joiner-recover \
  "SLUG='$SLUG' VM_TESTER_PASS='$VM_TESTER_PASS' OWNER2_TITLE='$OWNER2_TITLE'" <<'GUEST'
set -euo pipefail
export PATH="$HOME/.local/bin:/Applications/mattstack.app/Contents/Helpers:/usr/bin:/bin:/usr/sbin:/sbin"
RT=/tmp/rt-new; chmod +x "$RT"
security unlock-keychain -p "$VM_TESTER_PASS" "$HOME/Library/Keychains/login.keychain-db"
TEAM="$HOME/.mattstack/teams/$SLUG"

# The marker clears on the next pull only once the branch is no longer ahead of
# origin, so the reset flavor of the recovery is what this asserts; a hand
# rebase would still leave the replayed commit ahead.
git -C "$TEAM" reset -q --hard origin/main
echo "  joiner reset to $(git -C "$TEAM" rev-parse --short HEAD)"

set +e
PULL_JSON=$("$RT" team pull --team "$SLUG" --json 2>&1 | tail -1)
set -e
echo "$PULL_JSON"
OUTCOME=$(printf '%s' "${PULL_JSON:-}" | jq -r '.outcome // empty' 2>/dev/null) || OUTCOME=""
TITLE_NOW=$("$RT" settings get board.title --json 2>/dev/null | tail -1 | jq -r '.value // empty' 2>/dev/null) || TITLE_NOW=""
if [ "$OUTCOME" = "up-to-date" ] && [ "$TITLE_NOW" = "$OWNER2_TITLE" ]; then
  echo "TEAM ok   conflict cleared after reset"
else
  echo "TEAM FAIL after reset: outcome=${OUTCOME:-none} board.title=${TITLE_NOW:-unset} (wanted up-to-date and $OWNER2_TITLE)"
fi

STATUS_JSON=$("$RT" team status --team "$SLUG" --json 2>/dev/null | tail -1) || STATUS_JSON=""
CONFLICTED=$(printf '%s' "${STATUS_JSON:-}" | jq -r '.conflicted.at // empty' 2>/dev/null) || CONFLICTED=""
SETUP_JSON=$("$RT" setup status --json 2>/dev/null | tail -1) || SETUP_JSON=""
ROW=$(printf '%s' "${SETUP_JSON:-}" | jq -c '.groups[]?.rows[]? | select(.id == "team.sync")' 2>/dev/null | head -1) || ROW=""
ROW_STATUS=$(printf '%s' "${ROW:-}" | jq -r '.status // empty' 2>/dev/null) || ROW_STATUS=""
ROW_DETAIL=$(printf '%s' "${ROW:-}" | jq -r '.detail // empty' 2>/dev/null) || ROW_DETAIL=""
echo "  team.sync: ${ROW_STATUS:-absent} ${ROW_DETAIL:-}"
if [ "$ROW_STATUS" = "ready" ] && [ -z "$CONFLICTED" ]; then
  echo "TEAM ok   team.sync ready again"
else
  echo "TEAM FAIL team.sync row ${ROW_STATUS:-absent} after reset: ${ROW_DETAIL:-none} (conflicted=${CONFLICTED:-null})"
fi
GUEST

restore_hold

FAILS=$(cat "$LOGS"/rebase-*.log 2>/dev/null | grep -c '^TEAM FAIL' || true)
echo "TEAM fails=${FAILS:-0}"
[ "${FAILS:-0}" -eq 0 ]
