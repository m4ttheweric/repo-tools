#!/bin/bash
# Exercises lib/common.sh without tart: names, run dirs, phase ledger, report.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
source "$HERE/../common.sh"

fails=0
check() { if eval "$2"; then echo "  ok   $1"; else echo "  FAIL $1"; fails=$((fails+1)); fi; }

check "golden name"            '[ "$(vm_golden_name 26)" = "mattstack-golden-26" ]'
check "image for 14"           '[ "$(vm_image_for 14)" = "ghcr.io/cirruslabs/macos-sonoma-vanilla:latest" ]'
check "image for 15"           '[ "$(vm_image_for 15)" = "ghcr.io/cirruslabs/macos-sequoia-vanilla:latest" ]'
check "image for 26"           '[ "$(vm_image_for 26)" = "ghcr.io/cirruslabs/macos-tahoe-vanilla:latest" ]'
check "image for 99 dies"      '! (vm_image_for 99 2>/dev/null)'
check "golden name xcuitest flavour"   '[ "$(vm_golden_name 26 xcuitest)" = "mattstack-golden-26-xcode" ]'
check "image for xcuitest flavour"     '[ "$(vm_image_for 26 xcuitest)" = "ghcr.io/cirruslabs/macos-tahoe-xcode:latest" ]'
check "unknown flavour dies (name)"    '! (vm_golden_name 26 bogus 2>/dev/null)'
check "unknown flavour dies (image)"   '! (vm_image_for 26 bogus 2>/dev/null)'

export VM_ARTIFACTS="$(mktemp -d)"
vm_run_init unit
check "run dir created"        '[ -d "$VM_RUN_DIR/screenshots" ] && [ -d "$VM_RUN_DIR/logs" ] && [ -d "$VM_RUN_DIR/in" ]'
check "run.json written"       'grep -q "\"label\": *\"unit\"" "$VM_RUN_DIR/run.json"'

vm_phase_begin alpha; vm_phase_end alpha pass
vm_phase_begin beta;  vm_phase_end beta skip "no dmg given" "screenshots/x.png"
vm_phase_begin gamma; vm_phase_end gamma fail "boom"
check "three ledger lines"     '[ "$(wc -l < "$VM_RUN_DIR/phases.jsonl")" -eq 3 ]'
check "skip carries reason"    'grep -q "\"phase\":\"beta\",\"status\":\"skip\",\"reason\":\"no dmg given\"" "$VM_RUN_DIR/phases.jsonl"'
check "skip carries shot"      'grep -q "\"screenshots\":\[\"screenshots/x.png\"\]" "$VM_RUN_DIR/phases.jsonl"'
check "failed count is 1"      '[ "$(vm_phases_failed)" -eq 1 ]'
vm_render_report
check "report lists skip"      'grep -q "beta.*skip.*no dmg given" "$VM_RUN_DIR/report.md"'
check "report says 1 failed"   'grep -q "1 failed" "$VM_RUN_DIR/report.md"'

# reason with an embedded quote must round-trip through the JSON-escaping
# writer and the report's unescaping reader without truncating the row.
vm_phase_begin delta; vm_phase_end delta fail 'said "no" once'
check "ledger escapes embedded quote" 'grep -qF "\"phase\":\"delta\",\"status\":\"fail\",\"reason\":\"said \\\"no\\\" once\"" "$VM_RUN_DIR/phases.jsonl"'
vm_render_report
check "report unescapes quoted reason" 'grep -q "delta.*fail.*said \"no\" once" "$VM_RUN_DIR/report.md"'
check "report has no raw json passthrough" '! grep -q "{\"phase\":\"delta\"" "$VM_RUN_DIR/report.md"'

# vm_ssh_try must fail non-fatally (return, not vm_die's exit) so vm_wait_ssh
# can retry through the boot window instead of killing the caller.
check "vm_ssh_try fails without killing script"  '! vm_ssh_try tester no-such-vm-xyz true 2>/dev/null'
check "vm_wait_ssh times out without dying"      '! vm_wait_ssh tester no-such-vm-xyz 2'

# verify-golden.sh's t()/a() helpers must accumulate failures via vm_ssh_try
# and keep running the remaining checks — vm_ssh (which vm_die's on failure)
# would silently abort the whole verifier after the first red check.
check "t()-style helper counts failures without exiting"  '
  out=$(
    vm_ssh_try() { return 1; }
    fails=0
    ok()  { :; }
    bad() { fails=$((fails+1)); }
    t()   { if vm_ssh_try tester dummy-vm "$2" >/dev/null 2>&1; then ok "$1"; else bad "$1"; fi; }
    t "check one" "true"
    t "check two" "true"
    printf "%s" "$fails"
  )
  [ "$out" = "2" ]
'

rm -rf "$VM_ARTIFACTS"
[ "$fails" -eq 0 ] && echo "common.test.sh: all ok" || { echo "common.test.sh: $fails failed"; exit 1; }
