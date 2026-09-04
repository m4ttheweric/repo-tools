#!/bin/bash
# Sparkle vN → vN+1 inside the guest, with the appcast served on loopback.
# Usage: trigger-update.sh <update-dir> <expect-new-version>
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; source "$HERE/ax.sh" || exit 1
UPD="${1:-}"; NEWV="${2:-}"
[ -d "$UPD" ] && [ -f "$UPD/appcast.xml" ] && [ -x "$UPD/appcast-server" ] && [ -n "$NEWV" ] \
  && echo "$NEWV" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' \
  || { echo "usage: trigger-update.sh <update-dir with appcast.xml + zip + appcast-server> <new-version X.Y.Z>"; exit 1; }
: "${VM_APPCAST_PORT:=8765}"
LOGS="$GUEST_RUN/logs"; mkdir -p "$LOGS" || { echo "trigger-update.sh: cannot write $LOGS" >&2; exit 2; }
export PATH="$HOME/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
SOCK="$HOME/.mattstack/rt/tray.sock"
fails=0; ok() { echo "ASSERT ok   $1"; }; bad() { echo "ASSERT FAIL $1"; fails=$((fails+1)); }
finish() {  # <exit-code> — always leaves the same artifacts assert-installed.sh does, even on an early exit
  cp "$LOGS/appcast-server.log" "$LOGS/appcast-server.final.log" 2>/dev/null || true
  echo "$fails" > "$LOGS/update-fails.txt"
  exit "$1"
}

# Bounded, non-fatal click-by-name: `with timeout` caps the AppleEvent so a quitting/relaunching
# mattstack can't stall a retry loop on the ~60s System Events default.
click_button() {  # <name>
  local nm; nm=$(ax_esc "$1")
  ax_osa "with timeout of 5 seconds
    tell application \"System Events\" to tell process \"$AX_APP\" to click (first button of window 1 whose name is \"$nm\")
  end timeout" >/dev/null 2>&1
}

# Exec from guest-local disk: the compiled server is ~60MB and demand-paging it
# over the virtiofs share can take longer than any single reachability probe.
cp "$UPD/appcast-server" /tmp/appcast-server && chmod +x /tmp/appcast-server
/tmp/appcast-server "$UPD" "$VM_APPCAST_PORT" 2>>"$LOGS/appcast-server.log" &
SRV=$!; trap 'kill $SRV 2>/dev/null || true' EXIT INT TERM HUP
up=""
for i in $(seq 1 15); do
  if curl -s --max-time 2 "http://127.0.0.1:$VM_APPCAST_PORT/appcast.xml" | grep -q '<rss'; then up=1; break; fi
  kill -0 "$SRV" 2>/dev/null || break
  sleep 2
done
[ -n "$up" ] && ok "appcast served on loopback" || { bad "appcast server not reachable ($( [ -n "$(cat "$LOGS/appcast-server.log" 2>/dev/null)" ] && tail -c 200 "$LOGS/appcast-server.log" || echo "server wrote nothing, alive=$(kill -0 $SRV 2>/dev/null && echo yes || echo no)"))"; finish 1; }

before_pid=$(launchctl print "gui/$(id -u)/com.mattstack.daemon" 2>/dev/null | grep -oE 'pid = [0-9]+' | head -1 | awk '{print $3}')
before_ver=$(curl -s --max-time 3 --unix-socket "$SOCK" http://localhost/version 2>/dev/null | tr -d '\n')
ax_log "before: daemon pid=${before_pid:-none} version=${before_ver:-?}"

curl -s --max-time 10 --unix-socket "$SOCK" -X POST http://localhost/update/check > "$LOGS/update-check.json" 2>/dev/null
grep -q '"ok": *true' "$LOGS/update-check.json" && ok "POST /update/check" || bad "POST /update/check failed: $(cat "$LOGS/update-check.json")"
ax_shot 06-update-check

# The status item has no NSMenu — a click toggles an NSPopover — and the update entry lives at axid
# menu.gear.checkForUpdates inside the panel's gear menu. One bounded, non-fatal UI attempt only:
# POST /update/check above already fired the real trigger, so a failed click here is not fatal.
ui_triggered=0
if ax_osa "with timeout of 10 seconds
  tell application \"System Events\" to tell process \"$AX_APP\" to click menu bar item 1 of menu bar 2
end timeout" >/dev/null 2>&1; then
  if ax_osa "$AX_WALK_AS
    with timeout of 10 seconds
      tell application \"System Events\" to tell process \"$AX_APP\"
        set r to my walk(window 1, \"menu.gear.checkForUpdates\")
        if r is missing value then error \"axid not found\"
        click r
      end tell
    end timeout" >/dev/null 2>&1; then
    ax_log "clicked menu.gear.checkForUpdates"; ui_triggered=1
  else
    ax_log "menu.gear.checkForUpdates not found/clickable after opening the popover"
    ax_dump_ids 2>/dev/null | sed 's/^/  id: /' >>"$AX_LOG" || true
  fi
else
  ax_log "could not open the status item popover"
fi
ax_log "update trigger path: $([ "$ui_triggered" = 1 ] && echo 'gear menu click + POST /update/check' || echo 'POST /update/check only')"

# Sparkle's update window: "Install Update" then "Install and Relaunch" (names are Sparkle's).
clicked=0
for _ in $(seq 1 60); do
  click_button "Install Update" && { clicked=1; break; }
  click_button "Install and Relaunch" && { clicked=1; break; }
  sleep 2
done
if [ "$clicked" = 1 ]; then ax_log "clicked Install Update/Install and Relaunch"
else ax_log "Install Update/Install and Relaunch never appeared after 60 tries"; ax_dump_ids 2>/dev/null | sed 's/^/  id: /' >>"$AX_LOG" || true
fi
ax_shot 06-update-installing
clicked2=0
for _ in $(seq 1 30); do click_button "Install and Relaunch" && { clicked2=1; break; }; sleep 2; done
if [ "$clicked2" = 1 ]; then ax_log "clicked Install and Relaunch"
else ax_log "Install and Relaunch never appeared after 30 more tries"; ax_dump_ids 2>/dev/null | sed 's/^/  id: /' >>"$AX_LOG" || true
fi

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

after_pid=$(launchctl print "gui/$(id -u)/com.mattstack.daemon" 2>/dev/null | grep -oE 'pid = [0-9]+' | head -1 | awk '{print $3}')
[ -n "$after_pid" ] && [ "$after_pid" != "${before_pid:-}" ] && ok "daemon restarted (pid $before_pid → $after_pid)" || bad "daemon did not restart (pid ${before_pid:-none} → ${after_pid:-none})"
# rt --version prints "rt <version>" (cli.ts) — compare the trailing token, not the whole line.
rv=$(rt --version 2>/dev/null | awk '{print $NF}'); [ "$rv" = "$NEWV" ] && ok "rt --version == $NEWV" || bad "rt --version is '$rv'"
finish "$([ "$fails" -eq 0 ] && echo 0 || echo 1)"
