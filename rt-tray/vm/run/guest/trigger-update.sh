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
APP=/Applications/mattstack.app
fails=0; ok() { echo "ASSERT ok   $1"; }; bad() { echo "ASSERT FAIL $1"; fails=$((fails+1)); }
finish() {  # <exit-code> ... always leaves the same artifacts assert-installed.sh does, even on an early exit
  cp "$LOGS/appcast-server.log" "$LOGS/appcast-server.final.log" 2>/dev/null || true
  echo "$fails" > "$LOGS/update-fails.txt"
  exit "$1"
}

tray_json()  { curl -s --max-time 2 --unix-socket "$SOCK" http://localhost/version 2>/dev/null; }
tray_ver()   { tray_json | grep -oE '"version": *"[^"]+"' | cut -d'"' -f4; }
tray_build() { tray_json | grep -oE '"build": *[0-9]+' | grep -oE '[0-9]+$'; }
bundle_ver() { /usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist" 2>/dev/null; }
daemon_pid() { launchctl print "gui/$(id -u)/com.mattstack.daemon" 2>/dev/null | grep -oE 'pid = [0-9]+' | head -1 | awk '{print $3}'; }

# Bounded, non-fatal click-by-name: `with timeout` caps the AppleEvent so a quitting/relaunching
# mattstack can't stall a retry loop on the ~60s System Events default.
click_button() {  # <name>
  local nm; nm=$(ax_esc "$1")
  ax_osa "with timeout of 5 seconds
    tell application \"System Events\" to tell process \"$AX_APP\" to click (first button of window 1 whose name is \"$nm\")
  end timeout" >/dev/null 2>&1
}

# install-app.sh copies the app in as root:admin, so Sparkle cannot replace the bundle as
# the standard `tester` user: it calls AuthorizationCopyRights, which blocks the app's MAIN
# THREAD behind a SecurityAgent prompt. Nothing in the app answers while that is up -- not
# /update/check, not a quit AppleEvent -- so every wait below answers the prompt each pass.
# The two clicks cover Sparkle's own alert if its user driver puts one up before installing;
# they are best-effort and never fatal.
pump() {
  ax_admin_auth_once >/dev/null 2>&1 && ax_log "answered a SecurityAgent admin prompt"
  click_button "Install Update"       && ax_log "clicked Sparkle's Install Update"
  click_button "Install and Relaunch" && ax_log "clicked Sparkle's Install and Relaunch"
  return 0
}

# Wall-clock wait for the tray socket to report <version>. The socket disappears while
# Sparkle swaps the bundle and comes back when the new app launches, so an empty read is
# "still going", never a failure.
wait_ver() {  # <want> <timeout-s>
  local deadline=$((SECONDS + $2))
  while [ "$SECONDS" -lt "$deadline" ]; do
    [ "$(tray_ver)" = "$1" ] && return 0
    pump
    sleep 2
  done
  return 1
}

quit_app() {
  ax_osa "with timeout of 20 seconds
    tell application \"System Events\" to tell process \"$AX_APP\" to quit
  end timeout" >/dev/null 2>&1
}

relaunch_app() {  # same shape as install-app.sh launch, with walkthrough.sh's update flags
  open --env "MATTSTACK_APPCAST_URL=http://127.0.0.1:$VM_APPCAST_PORT/appcast.xml" \
       "$APP" --args --allow-appcast-override
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

before_app=$(pgrep -x mattstack | head -1)
before_pid=$(daemon_pid)
before_ver=$(tray_json | tr -d '\n')
ax_log "before: app pid=${before_app:-none} daemon pid=${before_pid:-none} bundle=$(bundle_ver) version=${before_ver:-?}"

# A SecurityAgent prompt left over from an earlier phase would block the main thread, and
# then /update/check below just times out with an empty body. Clear it first.
pump

curl -s --max-time 10 --unix-socket "$SOCK" -X POST http://localhost/update/check > "$LOGS/update-check.json" 2>/dev/null
grep -q '"ok": *true' "$LOGS/update-check.json" && ok "POST /update/check" \
  || bad "POST /update/check failed: '$(cat "$LOGS/update-check.json")' (an empty body means the app's main thread is blocked; on-screen buttons: $(ax_osa "tell application \"System Events\" to tell process \"$AX_APP\" to get name of every button of window 1" 2>/dev/null | tr '\n' ' '))"
ax_shot 06-update-check

# There is no "Install and Relaunch" button to wait on: UpdaterController's
# willInstallUpdateOnQuit hands Sparkle immediateInstallHandler() as soon as the download
# lands and UpdatePolicy.allowsImmediateInstall holds (setup not running, no key window),
# so headless the app installs and relaunches itself. Driving the app's own UI here would
# defeat that -- the status-item popover is a key window, which flips allowsImmediateInstall
# to false and defers the install to a quit that never comes -- so this leg touches no app UI.
install_path=""
if wait_ver "$NEWV" 300; then
  install_path="installed in place, app relaunched itself"
else
  ax_log "no new version after 300s (bundle on disk is $(bundle_ver)); falling back to the install-on-quit path"
  quit_app
  d=$((SECONDS + 90))
  while [ "$SECONDS" -lt "$d" ]; do pgrep -x mattstack >/dev/null || break; pump; sleep 2; done
  pgrep -x mattstack >/dev/null && ax_log "app still running after quit" || ax_log "app quit"
  if wait_ver "$NEWV" 120; then
    install_path="installed on quit, app relaunched itself"
  else
    ax_log "relaunching $APP the way install-app.sh launch does"
    relaunch_app
    if wait_ver "$NEWV" 120; then install_path="installed on quit, relaunched by the harness"
    else install_path="never reached $NEWV (bundle on disk is $(bundle_ver))"; fi
  fi
fi
ax_log "install path: $install_path"

new_ver=$(tray_ver)
[ "$new_ver" = "$NEWV" ] && ok "tray /version == $NEWV" || bad "tray /version is '${new_ver:-?}', wanted $NEWV"
# CFBundleVersion is numeric major*1000000+minor*1000+patch (L4 scheme); /version.build is a number.
want_build=$(echo "$NEWV" | awk -F. '{ printf "%d", $1*1000000 + $2*1000 + $3 }')
got_build=$(tray_build)
[ "${got_build:-}" = "$want_build" ] && ok "tray /version.build == $want_build" || bad "tray /version.build is '${got_build:-?}', wanted $want_build"
ax_shot 06-update-done

after_pid=$(daemon_pid)
[ -n "$after_pid" ] && [ "$after_pid" != "${before_pid:-}" ] && ok "daemon restarted (pid $before_pid → $after_pid)" || bad "daemon did not restart (pid ${before_pid:-none} → ${after_pid:-none})"
# rt --version prints "rt <version>" (cli.ts) ... compare the trailing token, not the whole line.
rv=$(rt --version 2>/dev/null | awk '{print $NF}'); [ "$rv" = "$NEWV" ] && ok "rt --version == $NEWV" || bad "rt --version is '$rv'"
ax_log "after: app pid=$(pgrep -x mattstack | head -1) daemon pid=${after_pid:-none} bundle=$(bundle_ver)"
finish "$([ "$fails" -eq 0 ] && echo 0 || echo 1)"
