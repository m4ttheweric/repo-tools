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
t "walkthrough --dry-run"        env VM_ARTIFACTS=/tmp/vmcheck-art bash run/walkthrough.sh --ver 26 --app ../mattstack.app --dry-run
t "walkthrough usage"            bash -c '! bash run/walkthrough.sh >/dev/null 2>&1'
t "team-setup status (no pat)"   env MATTSTACK_VMTEST_PAT= bash run/team-setup.sh status
t "team-setup invite stub (no gh, no pat)" env PATH="/usr/bin:/bin" MATTSTACK_VMTEST_PAT= bash run/team-setup.sh invite --handle vmcheck --out /tmp/vmcheck-invite.txt
t "team-setup reset refuses non-vmtest org"  bash -c '! env MATTSTACK_VMTEST_PAT=x MATTSTACK_VMTEST_ORG=someorg MATTSTACK_VMTEST_ORG_CONFIRM= bash run/team-setup.sh reset >/dev/null 2>&1'
t "team-setup reset guard message names CONFIRM" bash -c 'env MATTSTACK_VMTEST_PAT=x MATTSTACK_VMTEST_ORG=someorg bash run/team-setup.sh reset 2>&1 | grep -q MATTSTACK_VMTEST_ORG_CONFIRM'
t "second-user create"           bash run/second-user.sh create

mkdir -p /tmp/vmcheck-ax/in /tmp/vmcheck-ax/logs
printf '{"graphics":0}\n' > /tmp/vmcheck-ax/in/params.json
t "ax.sh refuses when GUEST_RUN unmounted"        bash -c '! (env -u GUEST_RUN AX_APP=x bash run/guest/ax.sh >/dev/null 2>&1)'
t "ax.sh sources + fails clean against no app"    env GUEST_RUN=/tmp/vmcheck-ax AX_APP=definitely-not-running bash -c 'source run/guest/ax.sh && ! ax_wait_window x 1 && ! ax_find setup.welcome.screen >/dev/null 2>&1 && ! ax_wait_screen welcome 1'
t "ax_shot skips instantly under --no-graphics"   env GUEST_RUN=/tmp/vmcheck-ax AX_APP=x bash -c 'source run/guest/ax.sh; s=$SECONDS; ax_shot probe >/dev/null; [ $((SECONDS-s)) -le 3 ] && grep -q "skipped (--no-graphics)" "$AX_LOG"'
t "drive-setup.sh refuses when GUEST_RUN unmounted" bash -c '! (env -u GUEST_RUN AX_APP=x bash run/guest/drive-setup.sh create >/dev/null 2>&1)'
t "drive-setup.sh rejects unknown scenario"       bash -c '! (env GUEST_RUN=/tmp/vmcheck-ax AX_APP=x bash run/guest/drive-setup.sh bogus >/dev/null 2>&1)'
t "drive-setup.sh rejects unknown flag"           bash -c '! (env GUEST_RUN=/tmp/vmcheck-ax AX_APP=x bash run/guest/drive-setup.sh create --nope >/dev/null 2>&1)'

t "e2e-cleanroom usage"          bash -c '! bash ../../scripts/e2e-cleanroom.sh >/dev/null 2>&1'
t "winid compiles"               swiftc -O -o /tmp/vmcheck-winid run/host/winid.swift
t "appcast-server compiles"      bun build --compile run/helpers/appcast-server.ts --outfile /tmp/vmcheck-appcast
rm -rf /tmp/vmcheck-art /tmp/vmcheck-winid /tmp/vmcheck-appcast /tmp/vmcheck.out /tmp/vmcheck-invite.txt /tmp/vmcheck-ax
echo; [ "$fails" -eq 0 ] && echo "  all vm checks ok" || { echo "  $fails check(s) failed"; exit 1; }
