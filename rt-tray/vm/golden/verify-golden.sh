#!/bin/bash
# Usage: verify-golden.sh <ver> [<vm-name>]   (the VM must be running)
set -euo pipefail
source "$(cd "$(dirname "$0")/.." && pwd)/lib/common.sh"
VER="$1"; VM="${2:-$(vm_golden_name "$VER")}"
fails=0
ok()   { vm_log "  ✓ $1"; }
bad()  { vm_warn "  ✗ $1"; fails=$((fails+1)); }
t()    { if vm_ssh_try "$VM_TESTER_USER" "$VM" "$2" >/dev/null 2>&1; then ok "$1"; else bad "$1"; fi; }
a()    { if vm_ssh_try "$VM_ADMIN_USER" "$VM" "$2" >/dev/null 2>&1; then ok "$1"; else bad "$1"; fi; }

a "ssh as admin (key)"                 'true'
t "ssh as tester (key)"                'true'
t "tester is not admin"                '! dseditgroup -o checkmember -m tester admin | grep -q "is a member"'
t "no CLT"                             '! xcode-select -p'
t "no brew"                            '! command -v brew && [ ! -d /opt/homebrew ]'
t "Gatekeeper enabled"                 'spctl --status | grep -q "assessments enabled"'
t "auto-login user is tester"          '[ "$(defaults read /Library/Preferences/com.apple.loginwindow autoLoginUser)" = tester ]'
t "console user is tester"             '[ "$(stat -f%Su /dev/console)" = tester ]'
t "sleep off"                          'pmset -g | grep -E "^ *sleep" | grep -q " 0"'
t "screen lock off"                    '[ "$(sysadminctl -screenLock status 2>&1 | grep -c off)" -ge 1 ]'
t "marker present"                     "grep -q '\"ver\": \"$VER\"' /Users/Shared/mattstack-golden.json"
t "macOS major matches"                "[ \"\$(sw_vers -productVersion | cut -d. -f1)\" = $VER ]"
# The manual TCC grants: UI scripting from an ssh session must work as tester.
t "UI scripting allowed (Accessibility + Automation for sshd-keygen-wrapper)" \
  'osascript -e "tell application \"System Events\" to get name of first process whose frontmost is true"'

[ "$fails" -eq 0 ] && { vm_log "golden $VM verified"; exit 0; }
vm_die "golden $VM: $fails check(s) failed"
