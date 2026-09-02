#!/bin/bash
# Offline check of everything under rt-tray/vm: syntax, unit tests, dry-runs. No tart, no network.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; cd "$HERE"
fails=0
t() { printf '  %-48s' "$1"; shift; if "$@" >/tmp/vmcheck.out 2>&1; then echo ok; else echo FAIL; sed 's/^/      /' /tmp/vmcheck.out | head -20; fails=$((fails+1)); fi; }
for f in lib/common.sh golden/*.sh run/*.sh run/guest/*.sh run/host/*.sh ../../scripts/e2e-cleanroom.sh check-vm-scripts.sh; do
  t "bash -n $f" bash -n "$f"
done
t "common.test.sh"               bash lib/__tests__/common.test.sh
t "appcast-server.test.ts"       bun test run/helpers/__tests__/appcast-server.test.ts
t "build-golden --dry-run"       bash golden/build-golden.sh 26 --dry-run
t "build-golden --xcode --dry-run selects the xcode image" bash -c \
  'out=$(bash golden/build-golden.sh 26 --xcode --dry-run 2>&1) && printf "%s" "$out" | grep -q "clone ghcr.io/cirruslabs/macos-tahoe-xcode:latest mattstack-golden-26-xcode"'
t "walkthrough --dry-run"        env VM_ARTIFACTS=/tmp/vmcheck-art bash run/walkthrough.sh --ver 26 --app ../mattstack.app --dry-run
t "walkthrough usage"            bash -c '! bash run/walkthrough.sh >/dev/null 2>&1'
t "xcuitest.sh usage (missing args)" bash -c \
  'out=$(bash run/xcuitest.sh 2>&1); rc=$?; [ "$rc" -ne 0 ] && printf "%s" "$out" | grep -q "usage: xcuitest.sh"'
# --ver 99 keeps this deterministic: no ghcr image maps to 99, so no real -xcode golden can
# ever exist for it, and the gate must skip on every host regardless of Xcode/project.yml state.
t "xcuitest.sh gates clean without a built -xcode golden" bash -c '
  rm -rf /tmp/vmcheck-xcui-art; touch /tmp/vmcheck-xcui.dmg
  out=$(env VM_ARTIFACTS=/tmp/vmcheck-xcui-art bash run/xcuitest.sh --ver 99 --dmg /tmp/vmcheck-xcui.dmg 2>&1); rc=$?
  rm -rf /tmp/vmcheck-xcui-art /tmp/vmcheck-xcui.dmg
  [ "$rc" -eq 0 ] && printf "%s" "$out" | grep -q "gate skipped:"
'
t "team-setup status (no pat)"   env MATTSTACK_VMTEST_PAT= bash run/team-setup.sh status
t "team-setup invite stub (no gh, no pat)" env PATH="/usr/bin:/bin" MATTSTACK_VMTEST_PAT= bash run/team-setup.sh invite --handle vmcheck --out /tmp/vmcheck-invite.txt
t "team-setup reset refuses non-vmtest org"  bash -c '! env MATTSTACK_VMTEST_PAT=x MATTSTACK_VMTEST_ORG=someorg MATTSTACK_VMTEST_ORG_CONFIRM= bash run/team-setup.sh reset >/dev/null 2>&1'
t "team-setup reset guard message names CONFIRM" bash -c 'env MATTSTACK_VMTEST_PAT=x MATTSTACK_VMTEST_ORG=someorg bash run/team-setup.sh reset 2>&1 | grep -q MATTSTACK_VMTEST_ORG_CONFIRM'
t "second-user create"           bash run/second-user.sh create

mkdir -p /tmp/vmcheck-ax/in /tmp/vmcheck-ax/logs
printf '{"graphics":0}\n' > /tmp/vmcheck-ax/in/params.json
t "ax.sh refuses when GUEST_RUN unmounted"        bash -c '! (env -u GUEST_RUN AX_APP=x bash run/guest/ax.sh >/dev/null 2>&1)'
# The "no syntax error" half of this assertion is load-bearing, not decoration: osascript exits 1
# on both a clean "not found" runtime error and a broken-script compile error alike, so an
# exit-code-only check can green-light a walk() AppleScript that never even compiles.
t "ax.sh sources + fails clean against no app"    env GUEST_RUN=/tmp/vmcheck-ax AX_APP=definitely-not-running bash -c 'source run/guest/ax.sh && ! ax_wait_window x 1 && ! ax_find setup.welcome.screen >/dev/null 2>&1 && ! ax_wait_screen welcome 1 && ! grep -qi "script error\|Expected \|syntax error" "$AX_LOG"'
t "ax_shot skips instantly under --no-graphics"   env GUEST_RUN=/tmp/vmcheck-ax AX_APP=x bash -c 'source run/guest/ax.sh; s=$SECONDS; ax_shot probe >/dev/null; [ $((SECONDS-s)) -le 3 ] && grep -q "skipped (--no-graphics)" "$AX_LOG"'
t "ax_admin_auth_once returns fast with no SecurityAgent" env GUEST_RUN=/tmp/vmcheck-ax AX_APP=x bash -c 'source run/guest/ax.sh; s=$SECONDS; ax_admin_auth_once; rc=$?; [ "$rc" -eq 1 ] && [ $((SECONDS-s)) -le 3 ]'
t "ax_set_field escapes an embedded quote/backslash" env GUEST_RUN=/tmp/vmcheck-ax AX_APP=definitely-not-running bash -c 'source run/guest/ax.sh; ( ax_set_field setup.team.create.name "weird\"value\\here" ) 2>/dev/null; [ $? -eq 1 ] && ! grep -qi "script error\|Expected \|syntax error" "$AX_LOG"'
t "drive-setup.sh refuses when GUEST_RUN unmounted" bash -c '! (env -u GUEST_RUN AX_APP=x bash run/guest/drive-setup.sh create >/dev/null 2>&1)'
t "drive-setup.sh rejects unknown scenario"       bash -c '! (env GUEST_RUN=/tmp/vmcheck-ax AX_APP=x bash run/guest/drive-setup.sh bogus >/dev/null 2>&1)'
t "drive-setup.sh rejects unknown forge"          bash -c '! (env GUEST_RUN=/tmp/vmcheck-ax AX_APP=x bash run/guest/drive-setup.sh create --forge bitbucket >/dev/null 2>&1)'
t "drive-setup.sh derives gitlab from the remote" bash -c 'env GUEST_RUN=/tmp/vmcheck-ax AX_APP=x TEAM_REMOTE=https://gitlab.com/g/r.git bash run/guest/drive-setup.sh create 2>&1 | grep -q "forge=gitlab"'
t "drive-setup.sh rejects unknown flag"           bash -c '! (env GUEST_RUN=/tmp/vmcheck-ax AX_APP=x bash run/guest/drive-setup.sh create --nope >/dev/null 2>&1)'

rm -rf /tmp/vmcheck-tu
mkdir -p /tmp/vmcheck-tu/upd
: > /tmp/vmcheck-tu/upd/appcast.xml
t "trigger-update.sh usage (no update-dir)"       bash -c 'out=$(GUEST_RUN=/tmp/vmcheck-ax bash run/guest/trigger-update.sh /nonexistent 1.2.3 2>&1); rc=$?; [ "$rc" -eq 1 ] && printf "%s" "$out" | grep -q "^usage: trigger-update.sh"'
t "trigger-update.sh usage (appcast-server missing/not executable)" bash -c 'out=$(GUEST_RUN=/tmp/vmcheck-ax bash run/guest/trigger-update.sh /tmp/vmcheck-tu/upd 1.2.3 2>&1); rc=$?; [ "$rc" -eq 1 ] && printf "%s" "$out" | grep -q "^usage: trigger-update.sh"'
touch /tmp/vmcheck-tu/upd/appcast-server; chmod +x /tmp/vmcheck-tu/upd/appcast-server
t "trigger-update.sh usage (missing new-version arg)" bash -c 'out=$(GUEST_RUN=/tmp/vmcheck-ax bash run/guest/trigger-update.sh /tmp/vmcheck-tu/upd 2>&1); rc=$?; [ "$rc" -eq 1 ] && printf "%s" "$out" | grep -q "^usage: trigger-update.sh"'
t "trigger-update.sh usage (malformed new-version)" bash -c 'out=$(GUEST_RUN=/tmp/vmcheck-ax bash run/guest/trigger-update.sh /tmp/vmcheck-tu/upd 2.9 2>&1); rc=$?; [ "$rc" -eq 1 ] && printf "%s" "$out" | grep -q "^usage: trigger-update.sh"'
t "trigger-update.sh ax.sh mount guard actually aborts" bash -c 'out=$(env GUEST_RUN=/tmp/vmcheck-tu-nonexistent bash run/guest/trigger-update.sh /tmp/vmcheck-tu/upd 1.2.3 2>&1); rc=$?; [ "$rc" -eq 1 ] && printf "%s" "$out" | grep -q "is not mounted" && ! printf "%s" "$out" | grep -q ASSERT'

t "e2e-cleanroom usage"          bash -c '! bash ../../scripts/e2e-cleanroom.sh >/dev/null 2>&1'
t "winid compiles"               swiftc -O -o /tmp/vmcheck-winid run/host/winid.swift
t "appcast-server compiles"      bun build --compile run/helpers/appcast-server.ts --outfile /tmp/vmcheck-appcast
rm -rf /tmp/vmcheck-art /tmp/vmcheck-winid /tmp/vmcheck-appcast /tmp/vmcheck.out /tmp/vmcheck-invite.txt /tmp/vmcheck-ax /tmp/vmcheck-tu /tmp/vmcheck-tu-nonexistent
echo; [ "$fails" -eq 0 ] && echo "  all vm checks ok" || { echo "  $fails check(s) failed"; exit 1; }
