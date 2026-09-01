#!/bin/bash
# Assert the installed state in the guest, through rt and tray.sock (never UI text).
# Usage: assert-installed.sh [--expect-version <v>] [--headless]
set -uo pipefail
GUEST_RUN="${GUEST_RUN:-/Volumes/My Shared Files/run}"; LOGS="$GUEST_RUN/logs"
mkdir -p "$LOGS" || { echo "assert-installed.sh: cannot write $LOGS" >&2; exit 2; }
EXPECT=""; HEADLESS=0
while [ $# -gt 0 ]; do case "$1" in --expect-version) [ -n "${2:-}" ] || { echo "assert-installed.sh: --expect-version needs a value" >&2; exit 2; }; EXPECT="$2"; shift 2;; --headless) HEADLESS=1; shift;; *) shift;; esac; done
export PATH="$HOME/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
fails=0
ok()   { echo "ASSERT ok   $1"; }
bad()  { echo "ASSERT FAIL $1"; fails=$((fails+1)); }
SOCK="$HOME/.mattstack/rt/tray.sock"

# rt on PATH, symlink into the bundle
if [ -L "$HOME/.local/bin/rt" ]; then
  tgt=$(readlink "$HOME/.local/bin/rt")
  case "$tgt" in /Applications/mattstack.app/*|"$HOME"/Applications/mattstack.app/*) ok "rt symlink → $tgt";; *) bad "rt symlink points outside the bundle: $tgt";; esac
elif [ -x "$HOME/.local/bin/rt" ]; then
  ok "rt installed as a binary (pre-L4 layout)"
else
  bad "no ~/.local/bin/rt"
fi
V=$(rt --version 2>/dev/null | tr -d '\n'); [ -n "$V" ] && ok "rt --version = $V" || bad "rt --version"

# rt verify --ci --json: the machine-gate contract (bare-machine absences —
# FDA's human click, no herdr/claude/Chrome, team-of-one — are not failures).
# The daemon stays strictly asserted below via launchctl, so --ci's daemon
# leniency costs nothing here.
if rt verify --ci --json > "$LOGS/verify.json" 2>"$LOGS/verify.stderr"; then
  grep -q '"passed": *true' "$LOGS/verify.json" && ok "rt verify --ci passed" || bad "rt verify --ci passed:false"
else
  bad "rt verify --ci exited $? (see logs/verify.json)"
fi
grep -E '"status": *"(fail|warn)"' -B2 "$LOGS/verify.json" | grep '"name"' | sed 's/^/  verify: /' || true

# tray.sock /version
if [ -S "$SOCK" ]; then
  curl -sf --max-time 5 --unix-socket "$SOCK" http://localhost/version > "$LOGS/tray-version.json" 2>/dev/null
  if [ -s "$LOGS/tray-version.json" ] && grep -q '"version"' "$LOGS/tray-version.json"; then
    ok "tray.sock /version → $(tr -d '\n' < "$LOGS/tray-version.json")"
    if [ -n "$EXPECT" ]; then
      grep -q "\"version\": *\"$EXPECT\"" "$LOGS/tray-version.json" && ok "version == $EXPECT" || bad "version != $EXPECT"
    fi
  else
    bad "tray.sock /version empty or errored (route not implemented yet?)"
  fi
  # /services: daemon always; deck only when the bundle ships Contents/Helpers/deck (L1 registers it conditionally).
  curl -sf --max-time 5 --unix-socket "$SOCK" http://localhost/services > "$LOGS/tray-services.json" 2>/dev/null
  if grep -q '"com.mattstack.daemon' "$LOGS/tray-services.json" 2>/dev/null; then
    ok "tray.sock /services lists the daemon ($(tr -d '\n ' < "$LOGS/tray-services.json" | cut -c1-160))"
    if [ -x /Applications/mattstack.app/Contents/Helpers/deck ]; then
      grep -q '"com.mattstack.deck' "$LOGS/tray-services.json" && ok "tray.sock /services lists deck" || bad "deck is bundled but /services does not list com.mattstack.deck"
    else
      ok "deck not bundled — not expected in /services"
    fi
  else
    bad "tray.sock /services does not list com.mattstack.daemon"
  fi
  curl -sf --max-time 5 --unix-socket "$SOCK" http://localhost/permissions > "$LOGS/tray-permissions.json" 2>/dev/null
  grep -q '"fda"' "$LOGS/tray-permissions.json" 2>/dev/null && ok "tray.sock /permissions → $(tr -d '\n ' < "$LOGS/tray-permissions.json" | cut -c1-160)" || bad "tray.sock /permissions empty or missing fda"
else
  bad "no tray socket at $SOCK"
fi

# mattstack.appPath (V3): the app records where it runs from. --json is the only stable, undecorated form of `rt settings get`.
AP=$(rt settings get mattstack.appPath --json 2>/dev/null)
case "$AP" in
  *'"value":"/Applications/mattstack.app"'*) ok "mattstack.appPath = /Applications/mattstack.app";;
  *"\"value\":\"$HOME/Applications/mattstack.app\""*) ok "mattstack.appPath = $HOME/Applications/mattstack.app";;
  *) bad "mattstack.appPath is not the canonical path (wanted /Applications/mattstack.app): $AP";;
esac

# daemon registered + running under the canonical label
launchctl print "gui/$(id -u)/com.mattstack.daemon" > "$LOGS/launchctl.txt" 2>&1
if grep -qE 'pid = [0-9]+' "$LOGS/launchctl.txt"; then ok "com.mattstack.daemon running (pid $(grep -oE 'pid = [0-9]+' "$LOGS/launchctl.txt" | head -1 | awk '{print $3}'))"; else bad "com.mattstack.daemon not running"; fi
launchctl print "gui/$(id -u)/com.rt.daemon" >/dev/null 2>&1 && bad "legacy com.rt.daemon job present" || ok "no legacy com.rt.daemon job"
[ -e "$HOME/.rt" ] && bad "~/.rt exists (legacy)" || ok "no ~/.rt"
if [ -e /Applications/rt-tray.app ] || [ -e "$HOME/Applications/rt-tray.app" ]; then bad "rt-tray.app present (legacy)"; else ok "no rt-tray.app"; fi

if [ "$HEADLESS" = 0 ]; then
  [ -d "$HOME/.mattstack/user/.git" ] && ok "~/.mattstack/user is the home repo" || bad "~/.mattstack/user is not a git repo (home-repo re-root ruling)"
fi
echo "$fails" > "$LOGS/assert-fails.txt"
[ "$fails" -eq 0 ]
