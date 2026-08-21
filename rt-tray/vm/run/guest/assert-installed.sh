#!/bin/bash
# Assert the installed state in the guest, through rt and tray.sock (never UI text).
# Usage: assert-installed.sh [--expect-version <v>] [--headless]
set -uo pipefail
GUEST_RUN="${GUEST_RUN:-/Volumes/My Shared Files/run}"; LOGS="$GUEST_RUN/logs"; mkdir -p "$LOGS"
EXPECT=""; HEADLESS=0
while [ $# -gt 0 ]; do case "$1" in --expect-version) EXPECT="$2"; shift 2;; --headless) HEADLESS=1; shift;; *) shift;; esac; done
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

# rt verify --json
if rt verify --json > "$LOGS/verify.json" 2>"$LOGS/verify.stderr"; then
  grep -q '"passed": *true' "$LOGS/verify.json" && ok "rt verify passed" || bad "rt verify passed:false"
else
  bad "rt verify exited $? (see logs/verify.json)"
fi
grep -E '"status": *"(fail|warn)"' -B2 "$LOGS/verify.json" | grep '"name"' | sed 's/^/  verify: /' || true

# tray.sock /version
if [ -S "$SOCK" ]; then
  curl -s --max-time 5 --unix-socket "$SOCK" http://localhost/version > "$LOGS/tray-version.json" 2>/dev/null
  if [ -s "$LOGS/tray-version.json" ]; then
    ok "tray.sock /version → $(tr -d '\n' < "$LOGS/tray-version.json")"
    if [ -n "$EXPECT" ]; then
      grep -q "\"version\": *\"$EXPECT\"" "$LOGS/tray-version.json" && ok "version == $EXPECT" || bad "version != $EXPECT"
    fi
  else
    bad "tray.sock /version empty (route not implemented yet?)"
  fi
  # /services: daemon always; deck only when the bundle ships Contents/Helpers/deck (L1 registers it conditionally).
  curl -s --max-time 5 --unix-socket "$SOCK" http://localhost/services > "$LOGS/tray-services.json" 2>/dev/null
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
  curl -s --max-time 5 --unix-socket "$SOCK" http://localhost/permissions > "$LOGS/tray-permissions.json" 2>/dev/null
  grep -q '"fda"' "$LOGS/tray-permissions.json" 2>/dev/null && ok "tray.sock /permissions → $(tr -d '\n ' < "$LOGS/tray-permissions.json" | cut -c1-160)" || bad "tray.sock /permissions empty or missing fda"
else
  bad "no tray socket at $SOCK"
fi

# mattstack.appPath (V3): the app records where it runs from.
AP=$(rt settings get mattstack.appPath --scope machine 2>/dev/null | tr -d '\n"')
case "$AP" in /Applications/mattstack.app|"$HOME"/Applications/mattstack.app) ok "mattstack.appPath = $AP";; *) bad "mattstack.appPath is '${AP:-unset}' (wanted /Applications/mattstack.app)";; esac

# daemon registered + running under the canonical label
launchctl print "gui/$(id -u)/com.mattstack.daemon" > "$LOGS/launchctl.txt" 2>&1
if grep -qE 'pid = [0-9]+' "$LOGS/launchctl.txt"; then ok "com.mattstack.daemon running (pid $(grep -oE 'pid = [0-9]+' "$LOGS/launchctl.txt" | head -1 | awk '{print $3}'))"; else bad "com.mattstack.daemon not running"; fi
launchctl print "gui/$(id -u)/com.rt.daemon" >/dev/null 2>&1 && bad "legacy com.rt.daemon job present" || ok "no legacy com.rt.daemon job"
[ -e "$HOME/.rt" ] && bad "~/.rt exists (legacy)" || ok "no ~/.rt"
ls -d /Applications/rt-tray.app "$HOME/Applications/rt-tray.app" >/dev/null 2>&1 && bad "rt-tray.app present (legacy)" || ok "no rt-tray.app"

if [ "$HEADLESS" = 0 ]; then
  [ -d "$HOME/.mattstack/.git" ] && ok "~/.mattstack is the home repo" || bad "~/.mattstack is not a git repo (V5)"
fi
echo "$fails" > "$LOGS/assert-fails.txt"
[ "$fails" -eq 0 ]
