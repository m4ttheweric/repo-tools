#!/bin/bash
# Clean-room walkthrough: clone golden → install DMG → five screens → assert → Sparkle update → teardown.
set -uo pipefail
source "$(cd "$(dirname "$0")/.." && pwd)/lib/common.sh"

usage() { sed -n '2,3p' "$0"; cat <<'EOF'
usage: walkthrough.sh --ver <14|15|26> (--dmg <path> | --app <mattstack.app>)
         [--scenario create|join|headless] [--team-slug vmtest] [--pat-env MATTSTACK_VMTEST_PAT]
         [--invite-code-file <p>] [--update-dir <dir>] [--update-version <v>]
         [--no-quarantine] [--no-graphics] [--keep] [--dry-run] [--verify-golden]
EOF
exit 2; }

VER=""; DMG=""; APP=""; SCENARIO=create; SLUG=vmtest; PAT_ENV=MATTSTACK_VMTEST_PAT; CODE_FILE=""
UPD=""; UPDV=""; QUAR=1; GRAPHICS=1; KEEP=0; DRY=0; VERIFY_GOLDEN=0
while [ $# -gt 0 ]; do case "$1" in
  --ver) VER="$2"; shift 2;; --dmg) DMG="$2"; shift 2;; --app) APP="$2"; shift 2;;
  --scenario) SCENARIO="$2"; shift 2;; --team-slug) SLUG="$2"; shift 2;; --pat-env) PAT_ENV="$2"; shift 2;;
  --invite-code-file) CODE_FILE="$2"; shift 2;; --update-dir) UPD="$2"; shift 2;; --update-version) UPDV="$2"; shift 2;;
  --no-quarantine) QUAR=0; shift;; --no-graphics) GRAPHICS=0; shift;; --keep) KEEP=1; shift;; --dry-run) DRY=1; shift;;
  --verify-golden) VERIFY_GOLDEN=1; shift;; -h|--help) usage;; *) vm_warn "unknown arg $1"; usage;; esac; done
[ -n "$VER" ] || usage
[ -n "$DMG" ] || [ -n "$APP" ] || usage

GOLDEN=$(vm_golden_name "$VER")
vm_run_init "walk-$VER-$SCENARIO"
RUN_VM="mattstack-run-$VER-$(date +%H%M%S)"
GUEST_RUN="/Volumes/My Shared Files/run"
GUEST_BIN="/Users/$VM_TESTER_USER/vmrun"
TART_PID=""; SHOT_PID=""
APP_VERSION=""

cleanup() {
  [ -n "$SHOT_PID" ] && kill "$SHOT_PID" 2>/dev/null
  if [ "$DRY" = 0 ]; then
    collect_logs || true
    if [ "$KEEP" = 1 ]; then vm_warn "keeping $RUN_VM running (--keep); stop with: tart stop $RUN_VM && tart delete $RUN_VM"
    else tart stop "$RUN_VM" 2>/dev/null || true; [ -n "$TART_PID" ] && wait "$TART_PID" 2>/dev/null; tart delete "$RUN_VM" 2>/dev/null || true; fi
  fi
  vm_render_report
  local f; f=$(vm_phases_failed)
  vm_log "done: $(grep -c '"status":"pass"' "$VM_RUN_DIR/phases.jsonl" || true) passed, $f failed, $(grep -c '"status":"skip"' "$VM_RUN_DIR/phases.jsonl" || true) skipped → $VM_RUN_DIR/report.md"
  exit "$([ "${f:-0}" -eq 0 ] && echo 0 || echo 1)"
}
trap cleanup EXIT

collect_logs() {
  vm_ssh "$VM_TESTER_USER" "$RUN_VM" 'tar -C "$HOME" -czf - .mattstack/rt/logs .mattstack/deck/logs Library/Logs/mattstack 2>/dev/null' > "$VM_RUN_DIR/logs/guest-home-logs.tgz" 2>/dev/null || true
  vm_ssh "$VM_TESTER_USER" "$RUN_VM" 'log show --last 45m --predicate '"'"'process == "mattstack" OR process == "rt" OR subsystem CONTAINS "com.mattstack" OR process == "smd" OR process == "backgroundtaskmanagementd"'"'"' --style compact 2>/dev/null | tail -5000' > "$VM_RUN_DIR/logs/guest-unified.log" 2>/dev/null || true
  vm_ssh "$VM_TESTER_USER" "$RUN_VM" 'launchctl print gui/$(id -u) 2>/dev/null | grep -iE "mattstack|com\.rt\." ' > "$VM_RUN_DIR/logs/guest-launchctl-grep.txt" 2>/dev/null || true
}

shot_watcher() {  # host loop: in/shot-<name>.req → screenshots/<name>.png
  while :; do
    for req in "$VM_RUN_DIR"/in/shot-*.req; do
      [ -e "$req" ] || continue
      name=$(basename "$req" .req); name=${name#shot-}
      "$VM_ROOT/run/host/capture.sh" "$RUN_VM" "$VM_RUN_DIR/screenshots/$name.png" >>"$VM_RUN_DIR/logs/capture.log" 2>&1 || true
      rm -f "$req"; : > "$VM_RUN_DIR/in/shot-$name.done"
    done
    sleep 0.5
  done
}

skip_if_dry() { [ "$DRY" = 1 ] && { vm_phase_end "$1" skip "dry-run"; return 0; }; return 1; }

# ── preflight ────────────────────────────────────────────────────────────────
vm_phase_begin preflight
if [ "$DRY" = 0 ]; then
  vm_require_cmd tart "brew install openai/tools/tart"
  tart list 2>/dev/null | awk '{print $2}' | grep -qx "$GOLDEN" || { vm_phase_end preflight fail "golden $GOLDEN missing — run golden/build-golden.sh $VER"; exit 1; }
  [ -f "$VM_SSH_KEY" ] || { vm_phase_end preflight fail "no ssh key at $VM_SSH_KEY (built by build-golden.sh)"; exit 1; }
fi
if [ -z "$DMG" ]; then
  DMG="$VM_RUN_DIR/in/mattstack.dmg"
  [ "$DRY" = 1 ] || "$VM_ROOT/run/make-dmg.sh" "$APP" "$DMG" || { vm_phase_end preflight fail "make-dmg failed"; exit 1; }
fi
[ "$DRY" = 1 ] || [ -f "$DMG" ] || { vm_phase_end preflight fail "no dmg at $DMG"; exit 1; }
if [ "$DRY" = 0 ]; then
  cp "$DMG" "$VM_RUN_DIR/in/mattstack.dmg" 2>/dev/null || true
  T=$(mktemp -d); hdiutil attach "$DMG" -nobrowse -quiet -mountpoint "$T/m" && APP_VERSION=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$T/m/mattstack.app/Contents/Info.plist" 2>/dev/null); hdiutil detach "$T/m" -quiet 2>/dev/null; rm -rf "$T"
fi
if [ -n "$UPD" ]; then
  if [ ! -f "$UPD/appcast.xml" ] || ! ls "$UPD"/mattstack-*.zip >/dev/null 2>&1 || [ -z "$UPDV" ]; then
    vm_phase_end preflight fail "--update-dir needs appcast.xml + mattstack-<v>.zip and --update-version"; exit 1; fi
  if [ "$DRY" = 0 ]; then
    mkdir -p "$VM_RUN_DIR/in/update"; cp "$UPD"/appcast.xml "$UPD"/mattstack-*.zip "$VM_RUN_DIR/in/update/"
    bun build --compile "$VM_ROOT/run/helpers/appcast-server.ts" --outfile "$VM_RUN_DIR/in/update/appcast-server" >/dev/null 2>&1 || { vm_phase_end preflight fail "bun build --compile appcast-server failed"; exit 1; }
  fi
fi
[ "$SCENARIO" = join ] && [ ! -f "${CODE_FILE:-/nonexistent}" ] && { vm_phase_end preflight fail "join needs --invite-code-file"; exit 1; }
if [ "$SCENARIO" != headless ] && [ -z "${!PAT_ENV:-}" ]; then vm_warn "\$$PAT_ENV empty — the GitHub account row cannot be connected; the screens phase will fail there if the app shows it"; fi
cp -R "$VM_ROOT/run/guest" "$VM_RUN_DIR/in/guest"; cp "$VM_ROOT/../../scripts/e2e-cleanroom.sh" "$VM_RUN_DIR/in/guest/" 2>/dev/null || true
printf '{"ver":"%s","scenario":"%s","dmg":"%s","appVersion":"%s","updateVersion":"%s","quarantine":%s,"graphics":%s}\n' \
  "$VER" "$SCENARIO" "$DMG" "$APP_VERSION" "$UPDV" "$QUAR" "$GRAPHICS" > "$VM_RUN_DIR/in/params.json"
vm_phase_end preflight pass
if [ "$DRY" = 1 ]; then
  vm_log "[dry-run] would: tart clone $GOLDEN $RUN_VM; tart run $RUN_VM --dir=run:$VM_RUN_DIR $([ $GRAPHICS = 0 ] && echo --no-graphics); wait ssh; stage; install; $([ $SCENARIO = headless ] && echo e2e-cleanroom || echo 'five screens'); assert; $([ -n "$UPD" ] && echo update || echo 'update(skip)'); teardown"
  for p in clone boot stage install launch screens assert update teardown; do vm_phase_begin $p; skip_if_dry $p; done
  exit 0
fi

# ── clone + boot ─────────────────────────────────────────────────────────────
vm_phase_begin clone
tart clone "$GOLDEN" "$RUN_VM" >>"$VM_RUN_DIR/logs/tart.log" 2>&1 && vm_phase_end clone pass || { vm_phase_end clone fail "tart clone failed (see logs/tart.log)"; exit 1; }

vm_phase_begin boot
RUN_ARGS=(--no-audio "--dir=run:$VM_RUN_DIR"); [ "$GRAPHICS" = 0 ] && RUN_ARGS+=(--no-graphics)
tart run "$RUN_VM" "${RUN_ARGS[@]}" >>"$VM_RUN_DIR/logs/tart.log" 2>&1 &
TART_PID=$!
if vm_wait_ssh "$VM_TESTER_USER" "$RUN_VM" 420; then
  [ "$GRAPHICS" = 1 ] && { shot_watcher & SHOT_PID=$!; }
  if [ "$VERIFY_GOLDEN" = 1 ]; then "$VM_ROOT/golden/verify-golden.sh" "$VER" "$RUN_VM" >>"$VM_RUN_DIR/logs/verify-golden.log" 2>&1 || { vm_phase_end boot fail "golden verification failed in the clone"; exit 1; }; fi
  vm_phase_end boot pass
else vm_phase_end boot fail "ssh as tester never came up"; exit 1; fi

# ── stage ────────────────────────────────────────────────────────────────────
vm_phase_begin stage
vm_ssh "$VM_TESTER_USER" "$RUN_VM" "mkdir -p $GUEST_BIN && cp -R '$GUEST_RUN/in/guest/.' $GUEST_BIN/ && chmod +x $GUEST_BIN/*.sh && test -f '$GUEST_RUN/in/mattstack.dmg'" \
  && vm_phase_end stage pass || { vm_phase_end stage fail "virtiofs share not visible in guest"; exit 1; }

# ── install (admin copies) + launch (tester) ─────────────────────────────────
vm_phase_begin install
QFLAG=--quarantine; [ "$QUAR" = 0 ] && QFLAG=--no-quarantine
vm_ssh "$VM_ADMIN_USER" "$RUN_VM" "GUEST_RUN='$GUEST_RUN' bash '$GUEST_RUN/in/guest/install-app.sh' copy '$GUEST_RUN/in/mattstack.dmg' $QFLAG" >>"$VM_RUN_DIR/logs/install.log" 2>&1 \
  && vm_phase_end install pass || { vm_phase_end install fail "copy failed (logs/install.log)"; exit 1; }

vm_phase_begin launch
# Prod builds honour MATTSTACK_APPCAST_URL only with --allow-appcast-override (L3 T10); the same env/arg is
# replayed by drive-setup.sh on any driver-initiated relaunch (DRIVER_LAUNCH_ARGS).
LAUNCH_ARGS=""; [ -n "$UPD" ] && LAUNCH_ARGS="--env MATTSTACK_APPCAST_URL=http://127.0.0.1:8765/appcast.xml --arg --allow-appcast-override"
vm_ssh "$VM_TESTER_USER" "$RUN_VM" "GUEST_RUN='$GUEST_RUN' bash $GUEST_BIN/install-app.sh launch $LAUNCH_ARGS" >>"$VM_RUN_DIR/logs/install.log" 2>&1
rc=$?
: > "$VM_RUN_DIR/in/shot-00-first-launch.req"; sleep 3
case $rc in
  0) vm_phase_end launch pass "" screenshots/00-first-launch.png ;;
  2) vm_phase_end launch fail "Gatekeeper blocked the app (unnotarised build? rerun with --no-quarantine)" screenshots/00-first-launch.png; exit 1 ;;
  *) vm_phase_end launch fail "app did not start (logs/install.log)" screenshots/00-first-launch.png; exit 1 ;;
esac

# ── screens / headless ───────────────────────────────────────────────────────
vm_phase_begin screens
if [ "$SCENARIO" = headless ]; then
  if vm_ssh "$VM_TESTER_USER" "$RUN_VM" "GUEST_RUN='$GUEST_RUN' bash $GUEST_BIN/e2e-cleanroom.sh --app /Applications/mattstack.app --allow-existing-install --artifacts-dir '$GUEST_RUN/logs/cleanroom'" >>"$VM_RUN_DIR/logs/screens.log" 2>&1; then
    vm_phase_end screens pass "headless: scripts/e2e-cleanroom.sh in guest"
  else vm_phase_end screens fail "headless recipe failed (logs/screens.log)"; fi
else
  CODE_ARG=""; [ -n "$CODE_FILE" ] && { cp "$CODE_FILE" "$VM_RUN_DIR/in/invite-code.txt"; CODE_ARG="--invite-code-file '$GUEST_RUN/in/invite-code.txt'"; }
  if vm_ssh "$VM_TESTER_USER" "$RUN_VM" "GUEST_RUN='$GUEST_RUN' VM_ADMIN_PASS='$VM_ADMIN_PASS' DRIVER_LAUNCH_ARGS='$LAUNCH_ARGS' $PAT_ENV='${!PAT_ENV:-}' bash $GUEST_BIN/drive-setup.sh $SCENARIO --team-slug $SLUG --pat-env $PAT_ENV $CODE_ARG" >>"$VM_RUN_DIR/logs/screens.log" 2>&1; then
    vm_phase_end screens pass "" $(cd "$VM_RUN_DIR" && ls screenshots/0[1-5]-*.png 2>/dev/null)
  else
    vm_phase_end screens fail "$(tail -1 "$VM_RUN_DIR/logs/drive.log" 2>/dev/null || echo 'see logs/screens.log')" $(cd "$VM_RUN_DIR" && ls screenshots/*.png 2>/dev/null)
  fi
fi

# ── assert ───────────────────────────────────────────────────────────────────
vm_phase_begin assert
HFLAG=""; [ "$SCENARIO" = headless ] && HFLAG=--headless
if vm_ssh "$VM_TESTER_USER" "$RUN_VM" "GUEST_RUN='$GUEST_RUN' bash $GUEST_BIN/assert-installed.sh --expect-version '$APP_VERSION' $HFLAG" >"$VM_RUN_DIR/logs/assert.log" 2>&1; then
  vm_phase_end assert pass
else vm_phase_end assert fail "$(grep -c 'ASSERT FAIL' "$VM_RUN_DIR/logs/assert.log") assertion(s) failed (logs/assert.log)"; fi

# ── update ───────────────────────────────────────────────────────────────────
vm_phase_begin update
if [ -z "$UPD" ]; then vm_phase_end update skip "no --update-dir (L4 artifacts + L3 MATTSTACK_APPCAST_URL hook required)"
elif [ "$(vm_phases_failed)" -gt 0 ]; then vm_phase_end update skip "earlier phase failed"
else
  if vm_ssh "$VM_TESTER_USER" "$RUN_VM" "GUEST_RUN='$GUEST_RUN' bash $GUEST_BIN/trigger-update.sh '$GUEST_RUN/in/update' '$UPDV'" >"$VM_RUN_DIR/logs/update.log" 2>&1; then
    vm_phase_end update pass "" $(cd "$VM_RUN_DIR" && ls screenshots/06-*.png 2>/dev/null)
  else vm_phase_end update fail "$(grep -c 'ASSERT FAIL' "$VM_RUN_DIR/logs/update.log") assertion(s) failed (logs/update.log)" $(cd "$VM_RUN_DIR" && ls screenshots/06-*.png 2>/dev/null); fi
fi

vm_phase_begin teardown
vm_phase_end teardown pass
