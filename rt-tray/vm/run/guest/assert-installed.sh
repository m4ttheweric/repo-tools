#!/bin/bash
# Assert the installed state in the guest, through rt and tray.sock (never UI text).
# Usage: assert-installed.sh [--expect-version <v>] [--headless] [--expect-untrusted]
#
# --expect-untrusted is the declined-certificate scenario: the install ran, the
# user said no to macOS's trust prompt, and the claim under test is that the
# proxy still serves, the checklist says so, and the trust verb clears it.
set -uo pipefail
GUEST_RUN="${GUEST_RUN:-/Volumes/My Shared Files/run}"; LOGS="$GUEST_RUN/logs"
mkdir -p "$LOGS" || { echo "assert-installed.sh: cannot write $LOGS" >&2; exit 2; }
EXPECT=""; HEADLESS=0; UNTRUSTED=0
while [ $# -gt 0 ]; do case "$1" in --expect-version) [ -n "${2:-}" ] || { echo "assert-installed.sh: --expect-version needs a value" >&2; exit 2; }; EXPECT="$2"; shift 2;; --headless) HEADLESS=1; shift;; --expect-untrusted) UNTRUSTED=1; shift;; *) shift;; esac; done
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

# rt verify --ci --json: the machine-gate contract (bare-machine absences —
# FDA's human click, no herdr/claude/Chrome, team-of-one — are not failures).
# The daemon stays strictly asserted below via launchctl, so --ci's daemon
# leniency costs nothing here.
if rt verify --ci --json > "$LOGS/verify.json" 2>"$LOGS/verify.stderr"; then
  grep -q '"passed": *true' "$LOGS/verify.json" && ok "rt verify --ci passed" || bad "rt verify --ci passed:false"
else
  bad "rt verify --ci exited $? (see logs/verify.json)"
fi
grep -E '"status": *"(fail|warn)"' -B2 "$LOGS/verify.json" | grep '"name"' | sed 's/^/  verify: /' || true

# tray.sock /version
if [ -S "$SOCK" ]; then
  curl -sf --max-time 5 --unix-socket "$SOCK" http://localhost/version > "$LOGS/tray-version.json" 2>/dev/null
  if [ -s "$LOGS/tray-version.json" ] && grep -q '"version"' "$LOGS/tray-version.json"; then
    ok "tray.sock /version → $(tr -d '\n' < "$LOGS/tray-version.json")"
    if [ -n "$EXPECT" ]; then
      grep -q "\"version\": *\"$EXPECT\"" "$LOGS/tray-version.json" && ok "version == $EXPECT" || bad "version != $EXPECT"
    fi
  else
    bad "tray.sock /version empty or errored (route not implemented yet?)"
  fi
  # /services: daemon always; deck only when the bundle ships Contents/Helpers/deck (L1 registers it conditionally).
  curl -sf --max-time 5 --unix-socket "$SOCK" http://localhost/services > "$LOGS/tray-services.json" 2>/dev/null
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
  curl -sf --max-time 5 --unix-socket "$SOCK" http://localhost/permissions > "$LOGS/tray-permissions.json" 2>/dev/null
  grep -q '"fda"' "$LOGS/tray-permissions.json" 2>/dev/null && ok "tray.sock /permissions → $(tr -d '\n ' < "$LOGS/tray-permissions.json" | cut -c1-160)" || bad "tray.sock /permissions empty or missing fda"
else
  bad "no tray socket at $SOCK"
fi

# mattstack.appPath (V3): the app records where it runs from. --json is the only stable, undecorated form of `rt settings get`.
AP=$(rt settings get mattstack.appPath --json 2>/dev/null)
case "$AP" in
  *'"value":"/Applications/mattstack.app"'*) ok "mattstack.appPath = /Applications/mattstack.app";;
  *"\"value\":\"$HOME/Applications/mattstack.app\""*) ok "mattstack.appPath = $HOME/Applications/mattstack.app";;
  *) bad "mattstack.appPath is not the canonical path (wanted /Applications/mattstack.app): $AP";;
esac

# daemon registered + running under the canonical label
launchctl print "gui/$(id -u)/com.mattstack.daemon" > "$LOGS/launchctl.txt" 2>&1
if grep -qE 'pid = [0-9]+' "$LOGS/launchctl.txt"; then ok "com.mattstack.daemon running (pid $(grep -oE 'pid = [0-9]+' "$LOGS/launchctl.txt" | head -1 | awk '{print $3}'))"; else bad "com.mattstack.daemon not running"; fi
launchctl print "gui/$(id -u)/com.rt.daemon" >/dev/null 2>&1 && bad "legacy com.rt.daemon job present" || ok "no legacy com.rt.daemon job"
# Every deck-managed job holds a pid: a spawn-failed job (exit 78, e.g. a
# missing WorkingDirectory) is a crash loop launchd never logs anywhere.
for label in $(launchctl print "gui/$(id -u)" 2>/dev/null | grep -oE 'com\.mattstack\.deck\.[a-z]+' | sort -u); do
  if launchctl print "gui/$(id -u)/$label" 2>/dev/null | grep -qE '^\s*pid = [0-9]+'; then ok "$label running"; else bad "$label not running ($(launchctl print "gui/$(id -u)/$label" 2>/dev/null | grep -oE 'last exit code = [^,]*' | head -1))"; fi
done
[ -e "$HOME/.rt" ] && bad "~/.rt exists (legacy)" || ok "no ~/.rt"
if [ -e /Applications/rt-tray.app ] || [ -e "$HOME/Applications/rt-tray.app" ]; then bad "rt-tray.app present (legacy)"; else ok "no rt-tray.app"; fi

if [ "$HEADLESS" = 0 ]; then
  [ -d "$HOME/.mattstack/user/.git" ] && ok "~/.mattstack/user is the home repo" || bad "~/.mattstack/user is not a git repo (home-repo re-root ruling)"

  # ── the local HTTPS proxy ──────────────────────────────────────────────────
  # Headless has no app to answer proxy.install's need, so the whole block is
  # inside the same gate as the home repo rather than reporting a bare-machine
  # absence as a defect.
  #
  # jq is not on this PATH: only DEFAULT_EXPOSED (rt, deck, gitq, fast-browser)
  # is linked into ~/.local/bin, so the bundle's own copy is the one to use.
  JQ=/Applications/mattstack.app/Contents/Helpers/jq
  # `setup status --json` is a Plan (groups/rows), not a step ledger: apply's
  # step states are streamed as NDJSON and never persisted. tool.proxy is the
  # row that reads back what proxy.install left behind: `ready` only when the
  # plist is there, the deployed VERSION matches the bundle's pin, and the CA
  # is trusted.
  proxy_row() {  # <log basename>
    rt setup status --json 2>/dev/null | tail -1 > "$LOGS/$1.json"
    [ -x "$JQ" ] && "$JQ" -r '.groups[].rows[]|select(.id=="tool.proxy")|.status + ": " + (.detail // "")' < "$LOGS/$1.json" 2>/dev/null
  }
  # `remove` identifies the System-keychain entry to delete from this
  # root-owned copy, never from the console user's own ~/.portless/ca.pem, so
  # a machine whose certificate IS trusted has to carry one.
  assert_trust_record() {
    [ -f "/Library/Application Support/mattstack/proxy/ca.pem" ] \
      && ok "the trusted certificate is recorded in the root-owned tree" \
      || bad "no proxy/ca.pem beside VERSION: uninstall would leave the CA trusted"
  }
  row=$(proxy_row setup-status)
  if [ "$UNTRUSTED" = 1 ]; then
    # The whole point of the scenario: declining the certificate leaves a
    # working proxy and a row that says what is missing, not a failed install.
    case "$row" in
      needs-you:*certificate*) ok "certificate declined, and the row says so: tool.proxy $row";;
      "")                      bad "no tool.proxy row in rt setup status --json (see logs/setup-status.json)";;
      *)                       bad "expected the untrusted-certificate row: tool.proxy $row";;
    esac
  else
    case "$row" in
      ready:*) ok "proxy installed: tool.proxy $row"; assert_trust_record;;
      "")      bad "no tool.proxy row in rt setup status --json (see logs/setup-status.json)";;
      *)       bad "proxy not installed: tool.proxy $row";;
    esac
  fi
  [ -f /Library/LaunchDaemons/sh.portless.proxy.plist ] && ok "portless LaunchDaemon plist present" || bad "portless plist missing"
  # `launchctl print system/<label>` answers a standard user with "Could not
  # find service" whether the service is absent or merely unreadable, and the
  # tester has no passwordless sudo to get past it. The domain listing IS
  # readable, and its `<pid> <status> <label>` rows separate loaded-and-running
  # (a pid) from loaded-but-dead (0) without any privilege at all.
  launchctl print system > "$LOGS/portless-launchctl.txt" 2>&1
  proxy_pid=$(awk '$NF == "sh.portless.proxy" { print $1; exit }' "$LOGS/portless-launchctl.txt")
  case "$proxy_pid" in
    ""|0) bad "portless daemon not running (launchctl print system pid: ${proxy_pid:-not listed})";;
    *)    ok "portless daemon running (pid $proxy_pid)";;
  esac
  # The end-to-end fact: an app domain resolving to loopback (the root daemon
  # rewrites /etc/hosts from routes.json) and answering TLS with a host cert it
  # mints on demand under the CA the installer trusted.
  #
  # The hostname comes from the route table, not a literal. Which apps hold a
  # .mattstack route is deck's business: `deck adopt` reconciles one per managed
  # record, and deck's own `deck.mattstack` comes from `deck setup`, which rt
  # never runs. Hard-coding one app would assert deck's registrations, not this
  # proxy. Both halves are still asserted: a route has to exist, and it has to
  # answer.
  cat "$HOME/.portless/routes.json" > "$LOGS/proxy-routes.json" 2>&1
  served=$([ -x "$JQ" ] && "$JQ" -r '.[].hostname | select(endswith(".mattstack"))' < "$LOGS/proxy-routes.json" 2>/dev/null | head -1)
  if [ -z "$served" ]; then
    bad "no .mattstack route in ~/.portless/routes.json for the proxy to serve"
  elif [ "$UNTRUSTED" = 1 ]; then
    # Serving and being trusted are separate claims, and this scenario needs
    # both halves proven: the proxy answers, and the CA is genuinely not
    # trusted (curl without --insecure is the same trust store a browser uses).
    curl -fsS --insecure --max-time 10 "https://$served" >/dev/null 2>&1 \
      && ok "$served answers over https through the untrusted proxy" \
      || bad "$served is routed but does not answer through the proxy"
    curl -fsS --max-time 10 "https://$served" >/dev/null 2>&1 \
      && bad "$served verified against the system trust store, so the certificate was not declined" \
      || ok "$served is not trusted yet, as the declined scenario expects"
  elif curl -fsS --max-time 10 "https://$served" >/dev/null 2>&1; then
    ok "$served answers over https through the proxy"
  else
    bad "$served is routed but does not answer through the proxy"
  fi

  # The remedy the row offers, exercised end to end: the tray's own escalator
  # runs the helper's trust verb, both dialogs get answered, and the row that
  # asked for it clears.
  if [ "$UNTRUSTED" = 1 ] && [ -S "$SOCK" ]; then
    AX_TRUST_DECLINE=0
    source "$(cd "$(dirname "$0")" && pwd)/ax.sh"
    curl -sS -X POST --max-time 300 --unix-socket "$SOCK" http://localhost/privileged/proxy-trust > "$LOGS/proxy-trust.json" 2>&1 &
    trust_pid=$!
    n=90
    while kill -0 "$trust_pid" 2>/dev/null && [ "$n" -gt 0 ]; do ax_admin_auth_once >/dev/null 2>&1; sleep 2; n=$((n-1)); done
    wait "$trust_pid"
    grep -q '"ok":true' "$LOGS/proxy-trust.json" 2>/dev/null \
      && ok "the trust verb ran through /privileged/proxy-trust" \
      || bad "/privileged/proxy-trust: $(tr -d '\n' < "$LOGS/proxy-trust.json" 2>/dev/null | cut -c1-200)"
    grep -q 'MATTSTACK_TRUST=ok' "$LOGS/proxy-trust.json" 2>/dev/null \
      && ok "the helper reported MATTSTACK_TRUST=ok" \
      || bad "the helper did not report MATTSTACK_TRUST=ok"
    row=$(proxy_row setup-status-after-trust)
    case "$row" in
      ready:*) ok "the certificate row cleared: tool.proxy $row"; assert_trust_record;;
      *)       bad "tool.proxy did not clear after the trust verb: ${row:-no row}";;
    esac
    curl -fsS --max-time 10 "https://$served" >/dev/null 2>&1 \
      && ok "$served now answers with a trusted certificate" \
      || bad "$served still fails against the system trust store after trusting"
  fi

  # Evidence for the proxy assertions above, whether they passed or failed:
  # what the daemon was told to serve, what it published to the resolver, and
  # what it said while doing it.
  sed -n '/# portless-start/,/# portless-end/p' /etc/hosts > "$LOGS/proxy-hosts.txt" 2>&1
  ls -la "$HOME/.portless" "$HOME/.portless/host-certs" > "$LOGS/proxy-statedir.txt" 2>&1
  curl -sS -o /dev/null -D - --max-time 10 "https://${served:-deck.mattstack}" > "$LOGS/proxy-curl.txt" 2>&1
  tail -100 "/Library/Application Support/mattstack/proxy/log/service.log" > "$LOGS/proxy-service.log" 2>&1
  cat "$HOME/.mattstack/deck/platform.json" "$HOME/.mattstack/deck/registry.json" > "$LOGS/proxy-deck-state.json" 2>&1
fi
echo "$fails" > "$LOGS/assert-fails.txt"
[ "$fails" -eq 0 ]
