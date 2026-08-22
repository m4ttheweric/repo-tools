#!/bin/bash
# Sparkle vN → vN+1 inside the guest, with the appcast served on loopback.
# Usage: trigger-update.sh <update-dir> <expect-new-version>
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; source "$HERE/ax.sh"
UPD="${1:-}"; NEWV="${2:-}"
[ -d "$UPD" ] && [ -f "$UPD/appcast.xml" ] && [ -x "$UPD/appcast-server" ] && [ -n "$NEWV" ] \
  || { echo "usage: trigger-update.sh <update-dir with appcast.xml + zip + appcast-server> <new-version>"; exit 1; }
LOGS="$GUEST_RUN/logs"; export PATH="$HOME/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
SOCK="$HOME/.mattstack/rt/tray.sock"
fails=0; ok() { echo "ASSERT ok   $1"; }; bad() { echo "ASSERT FAIL $1"; fails=$((fails+1)); }

"$UPD/appcast-server" "$UPD" 8765 2>>"$LOGS/appcast-server.log" &
SRV=$!; trap 'kill $SRV 2>/dev/null || true' EXIT
sleep 1
curl -s --max-time 3 http://127.0.0.1:8765/appcast.xml | grep -q '<rss' && ok "appcast served on loopback" || { bad "appcast server not reachable"; exit 1; }

before_pid=$(launchctl print "gui/$(id -u)/com.mattstack.daemon" 2>/dev/null | grep -oE 'pid = [0-9]+' | awk '{print $3}')
before_ver=$(curl -s --unix-socket "$SOCK" http://localhost/version 2>/dev/null | tr -d '\n')
ax_log "before: daemon pid=${before_pid:-none} version=${before_ver:-?}"

curl -s --max-time 10 --unix-socket "$SOCK" -X POST http://localhost/update/check > "$LOGS/update-check.json" 2>/dev/null
grep -q '"ok": *true' "$LOGS/update-check.json" && ok "POST /update/check" || bad "POST /update/check failed: $(cat "$LOGS/update-check.json")"
ax_shot 06-update-check

# Sparkle UI: the status-item menu shows "Update available…"; clicking it opens Sparkle's window.
for _ in $(seq 1 30); do
  if ax_osa 'tell application "System Events" to tell process "mattstack" to click menu bar item 1 of menu bar 2' >/dev/null 2>&1; then
    if ax_osa 'tell application "System Events" to tell process "mattstack" to click (first menu item of menu 1 of menu bar item 1 of menu bar 2 whose name contains "Update available")' >/dev/null 2>&1; then
      ax_log "opened Sparkle from the menu"; break
    fi
    ax_osa 'tell application "System Events" to key code 53' >/dev/null 2>&1   # escape the menu
  fi
  sleep 2
done
# Sparkle's update window: "Install Update" then "Install and Relaunch" (names are Sparkle's).
for _ in $(seq 1 60); do
  ax_click_button_named "Install Update" mattstack 2>/dev/null && break
  ax_click_button_named "Install and Relaunch" mattstack 2>/dev/null && break
  sleep 2
done
ax_shot 06-update-installing
for _ in $(seq 1 30); do ax_click_button_named "Install and Relaunch" mattstack 2>/dev/null && break; sleep 2; done

# Wait for the new version on the socket (the app relaunches; the socket disappears then returns).
new_ver=""
for _ in $(seq 1 120); do
  new_ver=$(curl -s --max-time 2 --unix-socket "$SOCK" http://localhost/version 2>/dev/null | grep -oE '"version": *"[^"]+"' | cut -d'"' -f4)
  [ "$new_ver" = "$NEWV" ] && break
  sleep 2
done
[ "$new_ver" = "$NEWV" ] && ok "tray /version == $NEWV" || bad "tray /version is '${new_ver:-?}', wanted $NEWV"
# CFBundleVersion is numeric major*1000000+minor*1000+patch (L4 scheme); /version.build is a number.
want_build=$(echo "$NEWV" | awk -F. '{ printf "%d", $1*1000000 + $2*1000 + $3 }')
got_build=$(curl -s --max-time 2 --unix-socket "$SOCK" http://localhost/version 2>/dev/null | grep -oE '"build": *[0-9]+' | grep -oE '[0-9]+$')
[ "${got_build:-}" = "$want_build" ] && ok "tray /version.build == $want_build" || bad "tray /version.build is '${got_build:-?}', wanted $want_build"
ax_shot 06-update-done

after_pid=$(launchctl print "gui/$(id -u)/com.mattstack.daemon" 2>/dev/null | grep -oE 'pid = [0-9]+' | awk '{print $3}')
[ -n "$after_pid" ] && [ "$after_pid" != "${before_pid:-}" ] && ok "daemon restarted (pid $before_pid → $after_pid)" || bad "daemon did not restart (pid ${before_pid:-none} → ${after_pid:-none})"
rv=$(rt --version 2>/dev/null | tr -d '\n'); [ "$rv" = "$NEWV" ] && ok "rt --version == $NEWV" || bad "rt --version is '$rv'"
cp "$LOGS/appcast-server.log" "$LOGS/appcast-server.final.log" 2>/dev/null || true
echo "$fails" > "$LOGS/update-fails.txt"
[ "$fails" -eq 0 ]
