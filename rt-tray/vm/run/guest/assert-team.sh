#!/bin/bash
# Joiner-side propagation assertions against a fixture's expect.json:
# the team clone, every tracked repo cloned, every team plugin installed,
# every team secret decryptable with THIS machine's age key, and every
# deck-managed job actually running. Run as tester in the joiner guest.
# Usage: assert-team.sh <slug> <expect.json>
set -uo pipefail
SLUG="${1:?slug}"; EXPECT="${2:?expect.json}"
export PATH="$HOME/.local/bin:/Applications/mattstack.app/Contents/Helpers:/usr/bin:/bin:/usr/sbin:/sbin"
RT="${RT:-/tmp/rt-new}"; [ -x "$RT" ] || RT=rt
fails=0
ok()  { echo "TEAM ok   $1"; }
bad() { echo "TEAM FAIL $1"; fails=$((fails+1)); }
TEAM="$HOME/.mattstack/teams/$SLUG"

[ -d "$TEAM/.git" ] && ok "team clone at $TEAM ($(git -C "$TEAM" rev-parse --short HEAD))" || bad "no team clone at $TEAM"

# The setup checklist's team.sync row is the daemon's own readiness signal.
SETUP_JSON=$("$RT" setup status --json 2>/dev/null | tail -1)
ROW=$(printf '%s' "$SETUP_JSON" | jq -c '.groups[]?.rows[]? | select(.id == "team.sync")' 2>/dev/null | head -1)
if [ -n "$ROW" ]; then
  ROW_STATUS=$(printf '%s' "$ROW" | jq -r '.status')
  ROW_DETAIL=$(printf '%s' "$ROW" | jq -r '.detail // empty')
  if [ "$ROW_STATUS" = "ready" ]; then ok "team.sync row ready"; else bad "team.sync row $ROW_STATUS: $ROW_DETAIL"; fi
else
  bad "team.sync row absent"
fi

# Without a global identity every commit on this Mac, the snapshot daemon's
# included, carries git's auto-derived author instead of the operator's own.
GIT_NAME=$(git config --global user.name 2>/dev/null)
GIT_EMAIL=$(git config --global user.email 2>/dev/null)
if [ -n "$GIT_NAME" ] && [ -n "$GIT_EMAIL" ]; then ok "git identity: $GIT_NAME <$GIT_EMAIL>"; else bad "git identity not configured"; fi

# Tracked repos: repos.clone puts each under the first rt.repoRoots entry.
ROOT=$("$RT" settings get rt.repoRoots --json 2>/dev/null | jq -r '.value[0] // empty')
for repo in $(jq -r '.repos[]?' "$EXPECT"); do
  if [ -n "$ROOT" ] && [ -d "$ROOT/$repo/.git" ]; then ok "tracked repo cloned: $ROOT/$repo"; else bad "tracked repo not cloned: $repo (repoRoots[0]=${ROOT:-unset})"; fi
done

# Team plugins: installed (never auto-enabled) through the claude CLI.
INSTALLED="$HOME/.claude/plugins/installed_plugins.json"
for plugin in $(jq -r '.plugins[]?' "$EXPECT"); do
  if [ -f "$INSTALLED" ] && jq -e --arg p "$plugin" '.plugins[$p] != null' "$INSTALLED" >/dev/null 2>&1; then ok "team plugin installed: $plugin"; else bad "team plugin not installed: $plugin"; fi
done

# Team secrets: decrypt with the joiner's own key, straight through sops, so
# "listed" (keys are plaintext in a sops file) never passes for "readable".
n=$(jq '.secrets | length' "$EXPECT")
if [ "$n" -gt 0 ]; then
  AGE_KEY=$("$RT" home key export 2>/dev/null | grep -o 'AGE-SECRET-KEY-1[A-Z0-9]*' | head -1)
  [ -n "$AGE_KEY" ] || bad "no age key exportable on the joiner"
  for i in $(seq 0 $((n-1))); do
    d=$(jq -r ".secrets[$i].domain" "$EXPECT"); k=$(jq -r ".secrets[$i].key" "$EXPECT"); want=$(jq -r ".secrets[$i].value" "$EXPECT")
    file="$TEAM/mattstack/secrets/$d.json"
    if [ ! -f "$file" ]; then bad "team secret file missing: mattstack/secrets/$d.json"; continue; fi
    got=$(cd "$TEAM" && SOPS_AGE_KEY="$AGE_KEY" sops -d --input-type json --output-type json "$file" 2>/tmp/sops.err | jq -r --arg k "$k" '.[$k] // empty')
    if [ "$got" = "$want" ]; then ok "team secret $d/$k decrypts on the joiner"; else bad "team secret $d/$k not readable on the joiner: $(head -c 200 /tmp/sops.err | tr '\n' ' ')"; fi
  done
fi

# Every deck-managed job must hold a pid: a spawn-failed job (exit 78) is
# a crash loop launchd never logs.
for label in $(launchctl print "gui/$(id -u)" 2>/dev/null | grep -oE 'com\.mattstack\.deck\.[a-z]+' | sort -u); do
  if launchctl print "gui/$(id -u)/$label" 2>/dev/null | grep -qE '^\s*pid = [0-9]+'; then ok "$label running"; else bad "$label not running ($(launchctl print "gui/$(id -u)/$label" 2>/dev/null | grep -oE 'last exit code = [^,]*' | head -1))"; fi
done

# Linear MCP: the entry the pack skills call by name, plus rt's own proof the key
# behind it works. The credential check is account.linear's row rather than a curl
# from here: rt makes the api.linear.app call itself.
if jq -e '.linearMcp == true' "$EXPECT" >/dev/null 2>&1; then
  CJ="$HOME/.claude.json"
  if [ -f "$CJ" ] && jq -e '.mcpServers.linear.url == "https://mcp.linear.app/mcp"' "$CJ" >/dev/null 2>&1; then
    ok "linear MCP entry present in ~/.claude.json"
  else
    bad "no linear MCP entry in ~/.claude.json"
  fi
  for id in tool.linear-mcp account.linear; do
    ROW=$(printf '%s' "$SETUP_JSON" | jq -c --arg id "$id" '.groups[]?.rows[]? | select(.id == $id)' 2>/dev/null | head -1)
    if [ -z "$ROW" ]; then bad "$id row absent"; continue; fi
    S=$(printf '%s' "$ROW" | jq -r '.status'); D=$(printf '%s' "$ROW" | jq -r '.detail // empty')
    if [ "$S" = "ready" ]; then ok "$id row ready"; else bad "$id row $S: $D"; fi
  done
fi

echo "TEAM fails=$fails"
[ "$fails" -eq 0 ]
