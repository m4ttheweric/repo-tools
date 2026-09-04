#!/bin/bash
# Load a team fixture into a kept OWNER guest, publish it, and mint invites.
# Usage: team-load.sh <owner-vm> <fixture-dir> --handles a,b [--slug vmtest] [--out <dir>] [--rt <dist/rt>]
#
# The owner guest reached Done with the bare scaffold; this is what a real
# owner does next by hand (settings, a plugin, a secret, push, invite). Every
# rt verb runs from a freshly copied `dist/rt` so the pass exercises main,
# not the bundle the guest was installed from. Invite codes land in --out as
# code-<handle>.txt and are never echoed.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; source "$HERE/../../lib/common.sh"
VM="${1:?owner vm}"; FIX="${2:?fixture dir}"; shift 2
SLUG=vmtest; HANDLES=""; OUT="$PWD"; RT_BIN="$VM_ROOT/../../dist/rt"
while [ $# -gt 0 ]; do case "$1" in
  --handles) HANDLES="$2"; shift 2;; --slug) SLUG="$2"; shift 2;; --out) OUT="$2"; shift 2;; --rt) RT_BIN="$2"; shift 2;;
  *) vm_die "unknown arg $1";; esac; done
[ -n "$HANDLES" ] || vm_die "--handles a,b is required"
[ -d "$FIX" ] || vm_die "no fixture dir: $FIX"
[ -x "$RT_BIN" ] || vm_die "no compiled rt at $RT_BIN (bun build --compile ./cli.ts --outfile dist/rt)"
mkdir -p "$OUT"

TGZ="$(mktemp -t team-fixture).tgz"; tar -czf "$TGZ" -C "$FIX" .
vm_scp "$VM_TESTER_USER" "$VM" "$RT_BIN" /tmp/rt-new
vm_scp "$VM_TESTER_USER" "$VM" "$TGZ" /tmp/team-fixture.tgz
rm -f "$TGZ"

# One guest-side script: unlock the keychain for the ssh session, apply the
# fixture to the team clone, publish, mint. jq is the bundle's own.
vm_ssh "$VM_TESTER_USER" "$VM" "SLUG='$SLUG' HANDLES='$HANDLES' VM_TESTER_PASS='$VM_TESTER_PASS' bash -s" <<'GUEST'
set -euo pipefail
export PATH="$HOME/.local/bin:/Applications/mattstack.app/Contents/Helpers:/usr/bin:/bin:/usr/sbin:/sbin"
RT=/tmp/rt-new; chmod +x "$RT"
security unlock-keychain -p "$VM_TESTER_PASS" "$HOME/Library/Keychains/login.keychain-db"
TEAM="$HOME/.mattstack/teams/$SLUG"; [ -d "$TEAM/.git" ] || { echo "no team clone at $TEAM" >&2; exit 1; }
FIX=/tmp/team-fixture; rm -rf "$FIX"; mkdir -p "$FIX"; tar -xzf /tmp/team-fixture.tgz -C "$FIX"

if [ -d "$FIX/plugins" ]; then
  mkdir -p "$TEAM/plugins"; cp -R "$FIX/plugins/." "$TEAM/plugins/"
  jq --slurpfile add "$FIX/marketplace.plugins.json" '.plugins = ((.plugins // []) + $add[0])' \
    "$TEAM/.claude-plugin/marketplace.json" > "$TEAM/.claude-plugin/marketplace.json.new"
  mv "$TEAM/.claude-plugin/marketplace.json.new" "$TEAM/.claude-plugin/marketplace.json"
fi
if [ -f "$FIX/settings.team.json" ]; then
  # Object values deep-merge over the team's current value (fixture wins):
  # a wholesale set would clobber what team create already declared under the
  # same key, e.g. the forge inside mattstack.integrations.
  for key in $(jq -r 'keys[]' "$FIX/settings.team.json"); do
    VAL=$(jq -c --arg k "$key" '.[$k]' "$FIX/settings.team.json")
    CUR=$("$RT" settings get "$key" --json 2>/dev/null | tail -1 | jq -c '.value // empty' 2>/dev/null || true)
    if [ -n "$CUR" ] && printf '%s' "$CUR" | jq -e 'type=="object"' >/dev/null 2>&1 \
        && printf '%s' "$VAL" | jq -e 'type=="object"' >/dev/null 2>&1; then
      VAL=$(jq -cn --argjson a "$CUR" --argjson b "$VAL" '$a * $b')
    fi
    "$RT" settings set "$key" "$VAL" --scope team --team "$SLUG"
  done
fi
if [ -f "$FIX/secrets.json" ]; then
  n=$(jq 'length' "$FIX/secrets.json")
  for i in $(seq 0 $((n-1))); do
    d=$(jq -r ".[$i].domain" "$FIX/secrets.json"); k=$(jq -r ".[$i].key" "$FIX/secrets.json")
    jq -r ".[$i].value" "$FIX/secrets.json" | RT_BATCH=1 "$RT" secrets set "$d" "$k" --team "$SLUG" --stdin
  done
fi
cd "$TEAM"; git add -A; git -c user.name=vmtest -c user.email=vmtest@example.invalid commit -q -m "team: load fixture" || true
"$RT" team publish --team "$SLUG" --json | tail -1
for h in ${HANDLES//,/ }; do
  "$RT" team invite --handle "$h" --team "$SLUG" --json 2>/dev/null | tail -1 | jq -r .code > "/tmp/code-$h.txt"
  [ -s "/tmp/code-$h.txt" ] || { echo "no invite code for $h" >&2; exit 1; }
done
git status --short | sed 's/^/  dirty after publish: /' || true
echo "loaded: $(git rev-parse --short HEAD)"
GUEST

for h in ${HANDLES//,/ }; do
  vm_scp_from "$VM_TESTER_USER" "$VM" "/tmp/code-$h.txt" "$OUT/code-$h.txt"
  vm_ssh "$VM_TESTER_USER" "$VM" "rm -f /tmp/code-$h.txt"
done
vm_log "invites → $OUT/code-<handle>.txt for: $HANDLES"
