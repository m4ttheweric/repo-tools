#!/bin/bash
# Runs INSIDE the guest as admin (NOPASSWD sudo). Idempotent.
# Args: <ver> <tester_pass> <pubkey>
set -euo pipefail
VER="$1"; TESTER_PASS="$2"; PUBKEY="$3"
TESTER=tester

say() { printf '  [guest] %s\n' "$*"; }

# SKIP_CLEANROOM=1 is the xcuitest flavour (see lib/common.sh vm_golden_name/vm_image_for).
if [ "${SKIP_CLEANROOM:-0}" != 1 ]; then
  # 1. No Apple command line tools (the vanilla templates install them).
  if [ -d /Library/Developer/CommandLineTools ]; then
    sudo rm -rf /Library/Developer/CommandLineTools
    sudo pkgutil --forget com.apple.pkg.CLTools_Executables 2>/dev/null || true
    say "removed CommandLineTools"
  fi
  if xcode-select -p >/dev/null 2>&1; then echo "CLT still present" >&2; exit 1; fi

  # 2. No Homebrew.
  for d in /opt/homebrew /usr/local/Homebrew; do
    [ -d "$d" ] && { sudo rm -rf "$d"; say "removed $d"; }
  done
  command -v brew >/dev/null 2>&1 && { echo "brew still on PATH" >&2; exit 1; }
  sed -i '' '/brew shellenv/d' ~/.zprofile 2>/dev/null || true

  # 3. Gatekeeper back ON (vanilla images disable it).
  sudo spctl --global-enable 2>/dev/null || true
  spctl --status | grep -q 'assessments enabled' || { echo "Gatekeeper still disabled" >&2; exit 1; }
fi

# 4. Standard user 'tester' = the console/auto-login user the walkthrough drives.
if ! id "$TESTER" >/dev/null 2>&1; then
  sudo sysadminctl -addUser "$TESTER" -fullName "mattstack tester" -password "$TESTER_PASS" 2>/dev/null
  say "created standard user $TESTER"
fi
dseditgroup -o checkmember -m "$TESTER" admin | grep -q "is a member" && { echo "tester must not be admin" >&2; exit 1; }
sudo mkdir -p "/Users/$TESTER/.ssh"
echo "$PUBKEY" | sudo tee "/Users/$TESTER/.ssh/authorized_keys" >/dev/null
sudo chown -R "$TESTER:staff" "/Users/$TESTER/.ssh"; sudo chmod 700 "/Users/$TESTER/.ssh"; sudo chmod 600 "/Users/$TESTER/.ssh/authorized_keys"
mkdir -p ~/.ssh; echo "$PUBKEY" > ~/.ssh/authorized_keys; chmod 700 ~/.ssh; chmod 600 ~/.ssh/authorized_keys

# Remote Login for everyone (vanilla enables it for admin only by default group).
sudo systemsetup -setremotelogin on >/dev/null 2>&1 || true
sudo dseditgroup -o edit -a "$TESTER" -t user com.apple.access_ssh 2>/dev/null || true

# 5. Auto-login as tester; no sleep, no screensaver, no lock.
# kcpassword holds the XOR-obfuscated password; the vanilla image wrote admin's.
/usr/bin/python3 -c 'pass' >/dev/null 2>&1 && { echo "python3 resolved — CLT?" >&2; exit 1; }
sudo defaults write /Library/Preferences/com.apple.loginwindow autoLoginUser "$TESTER"
sudo /bin/sh -c "$(cat <<'EOS'
kc() { # kcpassword encoder, pure sh: XOR with the Apple 11-byte key, pad to 12.
  key="7d 89 52 23 d2 bc dd ea a3 b9 1f"; pw="$1"; out=""; i=0
  pwlen=${#pw}; padded=$(( (pwlen/12+1)*12 ))
  while [ $i -lt $padded ]; do
    ch=0; [ $i -lt $pwlen ] && ch=$(printf '%d' "'$(printf '%s' "$pw" | cut -c$((i+1)))")
    k=$(echo $key | cut -d' ' -f$((i%11+1))); out="$out$(printf '%02x' $(( ch ^ 0x$k )))"; i=$((i+1))
  done
  printf '%s' "$out"
}
printf '%s' "$(kc "$1")" | xxd -r -p > /etc/kcpassword; chmod 600 /etc/kcpassword
EOS
)" sh "$TESTER_PASS"
sudo systemsetup -setsleep Off >/dev/null 2>&1 || true
sudo systemsetup -setcomputersleep Off >/dev/null 2>&1 || true
sudo defaults write /Library/Preferences/com.apple.screensaver loginWindowIdleTime 0
sudo -u "$TESTER" defaults -currentHost write com.apple.screensaver idleTime 0
sudo -u "$TESTER" defaults write NSGlobalDomain AppleKeyboardUIMode -int 3
# screenLock off must run in the user's session; done post-login by build-golden via ssh-as-tester.

# 6. Marker.
FLAVOUR=cleanroom; [ "${SKIP_CLEANROOM:-0}" = 1 ] && FLAVOUR=xcuitest
printf '{ "ver": "%s", "builtAt": "%s", "provisionRev": 2, "consoleUser": "%s", "flavour": "%s" }\n' \
  "$VER" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$TESTER" "$FLAVOUR" | sudo tee /Users/Shared/mattstack-golden.json >/dev/null
say "provisioned (ver $VER)"
