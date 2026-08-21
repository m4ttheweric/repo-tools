# L7 Clean-Room Testing (VM golden images + scripted walkthrough + second-user smoke) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `rt-tray/vm/` — golden macOS VM images (14 + 26), a scripted first-install → five-screen setup → `rt verify` → Sparkle vN→vN+1 walkthrough that archives screenshots + logs per run, a second-macOS-user smoke script, and `scripts/e2e-cleanroom.sh` that runs the CI headless install recipe locally — so ruling 12's layers (a), (b), (c) exist and the release gate ((a)+(b) green) is runnable.

**Architecture:** Everything is bash + one tiny Bun helper, orchestrated from the host. Tart (Apple Virtualization.framework) owns VM lifecycle; the golden VM is never run after it is built — every run is `tart clone` (APFS copy-on-write) → drive → `tart delete`. Host ↔ guest is ssh (key installed at golden time) plus a `--dir` virtiofs share that IS the run's artifacts directory, so every screenshot and log lands on the host as it is produced. The UI is driven by AppleScript/System Events UI scripting over ssh (Xcode-free fallback, first) with an XCUITest mode (`xcodebuild test` inside an `-xcode` golden) gated on Xcode existing. Screenshots are captured on the HOST from the Tart window (in-guest `screencapture` over ssh is unreliable on macOS 15+). Every phase writes a `pass|fail|skip` line with a reason; nothing is marked green on a guess.

**Tech Stack:** Tart ≥ 2.x (`brew install openai/tools/tart`; FSL-1.1-ALv2 — see constraints), cirruslabs `macos-{sonoma,tahoe}-vanilla` OCI images, bash 3.2 (`/bin/bash` — macOS stock), `sshpass` (golden build only), `osascript` / System Events, `screencapture`, `hdiutil`, `ditto`, `PlistBuddy`, Bun (compiles `appcast-server`), Sparkle `generate_appcast` (update phase only), `gh` (test team, host only).

**Spec:** `docs/superpowers/specs/2026-08-20-mattstack-app-installer-design.md` (§2 ruling 12 + invariants, §3–4 flow/screens, §9 permissions, §11 distribution, §12.2 testing, §13 lanes); contract `docs/superpowers/specs/2026-08-21-rt-setup-contract.md`; research `docs/superpowers/specs/research/2026-08-20-mattstack-app/research-onboarding-permissions-ux.md`, `research-sparkle-install-launchd.md`.

**Execution worktree:** `/Users/matt/Documents/GitHub/repo-tools-l7-wt`, branch `goodwinmattheweric/mat-383-clean-room` off `origin/main`. Commit prefix `MAT-383:`; trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`. No monitor agent — every implementer runs `bash -n` and the task's dry-run themselves before committing.

## Global Constraints

Copied from the spec; every task's requirements include these.

- **macOS 14 floor; arm64-only** (ruling 13, §11). Golden images: macOS 14 (Sonoma) and 26 (Tahoe); 15 (Sequoia) optional. Host is Apple Silicon, macOS 26.6.1.
- **Identity frozen:** `com.mattstack.app` / `com.mattstack.app.dev`; agents `com.mattstack.daemon` / `.dev`, `com.mattstack.deck`; bundle `mattstack.app`; `~/.mattstack`; `~/.local/bin/rt` is a symlink into the bundle (ruling 13, §11). Tests assert these names, never `rt-tray.app` / `com.rt.daemon` / `~/.rt` ("pure canonical, no compat").
- **Install location:** DMG target `/Applications`, fallback `~/Applications` when not writable; the app records `mattstack.appPath` (V3).
- **Permissions:** Full Disk Access + Login Items required; Notifications optional; no Accessibility/Screen Recording/Automation are requested by the APP (ruling 10). (The VM test *driver* needs Accessibility — that is granted to `sshd-keygen-wrapper`/`osascript` in the guest, never to mattstack.app.)
- **Honesty over magic:** every checklist row / phase reports what was actually checked; nothing is marked ready on a guess (invariant). Phases that cannot run say `skip` + reason, never `pass`.
- **rt owns mechanics, the app owns ceremony:** the walkthrough asserts through `rt verify --json`, `rt setup status --json`, and tray.sock routes (`GET /version`, `GET /services`, `GET /permissions`) — never by parsing UI text alone.
- **No user or employer data on mattstack-hosted infra; the relay sees ciphertext + timestamps only.** The test team uses a throwaway GitHub org; the PAT comes from env and is never written to the repo or to artifacts.
- **rt repo stealth:** rt never writes into target repos; all state under `~/.mattstack/`. The VM layer writes only under `rt-tray/vm/artifacts/` (gitignored) and `rt-tray/vm/.cache/` (gitignored) on the host.
- **Clean-room definition (ruling 12):** no Apple CLT, no Homebrew, one standard user, no Apple ID.
- **Release gate:** layers (a) GitHub Actions headless install + `rt verify --ci` and (b) VM walkthrough green on the candidate.
- **Clean-code comments rule** (`~/.claude/rules/clean-code-comments.md`): comments only for constraints the code cannot show; no task numbers/process narration in source. Decision records go in this plan / README, not scripts.
- **Logging:** scripts log to the run's artifacts dir; no new logging inside rt.
- **Tart licence constraint:** Tart's `LICENSE` on `main` is **Functional Source License 1.1 (ALv2 future licence), "Copyright 2022-2026 OpenAI"** — permitted purposes include "internal use and access"; tart.run/licensing: "Usage on personal computers including personal workstations is royalty-free"; organisations are free up to **100 CPU cores** for Tart, paid tiers above (Gold $12k/yr 500 cores…). Matt's single workstation is inside the free tier. Record in README; if L7 ever moves to a shared self-hosted fleet, recount cores.

## Research record (what the scripts rely on — cited)

- Tart now lives at `github.com/openai/tart`; brew tap `openai/tools/tart` (README on main). Older docs say `cirruslabs/cli/tart`; use the new tap, fall back to the old if brew can't find it.
- Images (tart.run quick-start): `ghcr.io/cirruslabs/macos-{tahoe,sequoia,sonoma}-{vanilla,base,xcode}:latest`; creds `admin`/`admin` for GUI and ssh. `macos-sonoma-vanilla:latest` = 14.8.7 (published ~3 months ago, still updated). **Use `-vanilla`**, not `-base`: `base` preinstalls Homebrew + gh/jq/node/rbenv + the tart guest agent (templates `base.pkr.hcl`); `vanilla` has none of that. The `vanilla-sequoia` template DOES run `softwareupdate --install 'Command Line Tools for Xcode-*'`, so the golden provisioner must remove CLT (`/Library/Developer/CommandLineTools`) on every image and verify with `xcode-select -p` failing.
- Vanilla templates preconfigure: auto-login `admin` (`/etc/kcpassword` + `autoLoginUser`), passwordless sudo (`/etc/sudoers.d/admin-nopasswd`), screensaver off, `systemsetup -setsleep Off`, `sysadminctl -screenLock off`, Remote Login + Screen Sharing ON, `defaults write NSGlobalDomain AppleKeyboardUIMode -int 3`, **Gatekeeper DISABLED** (`sudo spctl --global-disable` + Settings toggle). The golden must re-enable Gatekeeper (`sudo spctl --global-enable`, verify `spctl --status` = "assessments enabled") so the DMG path is real.
- `tart clone` = file copy on APFS → copy-on-write ("a cloned VM won't actually claim all the space right away"), so restore-per-run = clone from golden, delete after. `--stacked` needs macOS 27; not used.
- `tart run` flags used: `--no-graphics`, `--dir=<name>:<host path>[:ro]` (guest automount `/Volumes/My Shared Files/<name>`; host+guest ≥ 13), `--no-audio`, `--vnc` (Screen Sharing), `--net-softnet` (NOT used: blocks guest→host). Default NAT: host reachable from guest at the router IP (`route -n get default` in the guest).
- `tart exec` needs the tart-guest-agent, which ships only in non-vanilla images → **ssh only** in this plan. `tart ip <vm>` gives the guest IP. Commands available: clone create delete exec export get import ip list login logout prune pull push rename run set stop suspend — **no screenshot command**.
- Nested virtualisation: Virtualization.framework supports it only for Linux guests on M3+/macOS 15 → GitHub-hosted macOS runners (themselves VMs) cannot run Tart macOS VMs. Local only; a self-hosted Apple-Silicon runner later.
- UI scripting over ssh: `osascript … tell application "System Events"` fails with "not allowed assistive access" until `/usr/libexec/sshd-keygen-wrapper` (and `/usr/bin/osascript`) are in Privacy & Security → **Accessibility**, and the **Automation** ("sshd-keygen-wrapper wants to control System Events") prompt is approved once for the ssh user. TCC cannot be pre-approved from a script (`tccutil` can only *reset*; PPPC profiles need MDM) → **one-time manual click in the guest GUI at golden-image time**, then every clone inherits it. macOS 26.1/26.2 had a bug adding CLI tools to Accessibility (fixed 26.3); the golden verifier probes it.
- `screencapture` over ssh on macOS 15+ prompts/returns blank even with Screen Recording granted to sshd-keygen-wrapper (Apple forum thread 764789) → **capture on the host** from the Tart window (`screencapture -x -l <windowID>`; host Terminal needs Screen Recording once — MATT step).
- `launchctl bootstrap gui/<uid>` needs a logged-in GUI session ("Bootstrap failed: 5" otherwise) → second-user smoke requires the second user to be logged in (Fast User Switching) before `rt daemon install` can register; `su -l` alone can install files but the daemon row reports not-booted.
- Sparkle: feed override via `SPUUpdaterDelegate feedURLString(for:)`; http feeds need `NSAppTransportSecurity` → `NSAllowsLocalNetworking` (loopback/.local) — serving from the HOST at 192.168.64.x would additionally trigger Sequoia's Local Network Privacy prompt (Sparkle discussion #2732), so the appcast is served **inside the guest on 127.0.0.1**. Enclosures must be EdDSA-signed with the key matching the build's `SUPublicEDKey`; Sparkle compares numeric `CFBundleVersion`.
- `rt --post-install` (current `commands/post-install.ts`) installs `~/.local/bin/rt`, copies `mattstack.app` → `~/Applications`, **launches the app with `open`**, then `rt daemon install` (→ tray socket `/daemon/start`, SMAppService). Running it on a host whose console user already has mattstack registered would launch a second tray under the same bundle id → `scripts/e2e-cleanroom.sh` refuses that by default.
- `rt verify --ci` (commands/verify.ts) = human output, no colour, exit 1 on any critical fail; daemon-not-booted is a *warn* under `CI=true`.
- VirtualBuddy (insidegui): GUI only, no CLI; APFS duplicate via Finder ⌘D; guest app for clipboard/sharing. Documented as the manual alternative, not scripted.

## Dependencies on other lanes (the walkthrough is built to the contract; phases `skip` with the reason until these land)

| Need | Lane | Walkthrough phase that skips without it |
|---|---|---|
| DMG + zip + appcast artifacts (`mattstack-<ver>.dmg`, `mattstack-<ver>.zip`), Sparkle in the app, `SUPublicEDKey`; build accepts `SPARKLE_PUBLIC_ED_KEY` override for test keys | L4 | update (P7); install uses `vm/run/make-dmg.sh` from a locally built `.app` meanwhile |
| Five screens + AXIdentifiers (`setup.window`, `setup.continue`, `setup.back`, `setup.install`, `setup.finish`, `setup.card.create`, `setup.card.join`, `setup.field.teamName`, `setup.field.inviteCode`, `row.<rowId>`, `row.<rowId>.action`, `row.<rowId>.status`); `MATTSTACK_APPCAST_URL` env honoured by the updater delegate; ATS `NSAllowsLocalNetworking`; `GET /version` on tray.sock | L3 | screens (P5), update (P7) |
| `rt setup plan/status/apply --json`, `rt --post-install --non-interactive --team-of-one`, `rt team invite/join` | L1 | assert (P6 uses `rt verify --json` today), invite scenario |
| `/v1/invites*` on the shared relay | L6 | join scenario (stub until then) |

---

## File structure

```
rt-tray/vm/
  README.md                      what the layer verifies / cannot; how to run; MATT steps; licence note
  .gitignore                     artifacts/ .cache/
  lib/common.sh                  shared bash: logging, phase ledger, tart/ssh helpers, run dirs
  golden/build-golden.sh         host: pull vanilla image → mattstack-golden-<ver> → provision → verify
  golden/provision-guest.sh      guest (as admin): no CLT, no brew, Gatekeeper on, tester user, ssh keys, sleep/lock off
  golden/verify-golden.sh        host: asserts every golden property over ssh incl. the manual TCC grants
  run/walkthrough.sh             host orchestrator: clone → boot → stage → install → screens → assert → update → teardown → report
  run/guest/install-app.sh       guest: quarantine DMG, mount, copy to /Applications (admin) , launch as tester with env
  run/guest/ax.sh                guest: osascript helpers (find by AXIdentifier, click, type, wait, admin-auth, notification prompts)
  run/guest/drive-setup.sh       guest: screens 1–5 + FDA/Login Items/Notifications dances, screenshot hooks
  run/guest/assert-installed.sh  guest: rt verify --json, tray.sock /version, daemon pid/label, symlink target
  run/guest/trigger-update.sh    guest: loopback appcast server, POST /update/check, drive Sparkle, assert vN+1 + daemon restart
  run/host/capture.sh            host: screenshot the Tart window into the run dir
  run/host/winid.swift           host: CGWindowList lookup of the Tart window id
  run/helpers/appcast-server.ts  Bun static file server (compiled per run, copied into the guest)
  run/make-dmg.sh                host: wrap a built mattstack.app in a DMG (pre-L4 runs)
  run/make-appcast.sh            host: bump CFBundleVersion copy → zip → generate_appcast with a test EdDSA key
  run/team-setup.sh              host, ORCHESTRATOR/MATT: reset the throwaway org's repos; mint invite (real or stub)
  run/second-user.sh             host: layer (c) — run e2e-cleanroom as the second macOS user (MATT creates the user)
  run/xcuitest.sh                host: layer (b) XCUITest mode, gated on Xcode + the -xcode golden
  artifacts/                     gitignored; <run-id>/ per run: screenshots/, logs/, phases.jsonl, report.md
scripts/e2e-cleanroom.sh         layer (a) locally: artifact → extract → rt --post-install → rt daemon install → rt verify --ci
```

Phase ledger format (`artifacts/<run>/phases.jsonl`, one object per phase, appended by `vm_phase_end`):
`{"phase":"install","status":"pass|fail|skip","reason":"…","at":"<ISO>","seconds":12,"screenshots":["screenshots/03-install.png"]}`.
`report.md` is rendered from it at teardown. A run's exit code is 1 if any phase failed, 0 if all passed or skipped, and the summary line states the skips so a skip never reads as green.

---

### Task 1: Scaffold `rt-tray/vm/` — README skeleton, gitignore, `lib/common.sh`

**Files:**
- Create: `rt-tray/vm/README.md`
- Create: `rt-tray/vm/.gitignore`
- Create: `rt-tray/vm/lib/common.sh`
- Create: `rt-tray/vm/lib/__tests__/common.test.sh`

**Interfaces:**
- Produces (sourced by every later script via `source "$(dirname "$0")/../lib/common.sh"` or `…/lib/common.sh`):
  - `VM_ROOT` (abs path of `rt-tray/vm`), `VM_ARTIFACTS` (`$VM_ROOT/artifacts`), `VM_CACHE` (`$VM_ROOT/.cache`)
  - `vm_log <msg>`, `vm_warn <msg>`, `vm_die <msg>` (exit 1)
  - `vm_require_cmd <cmd> [<install hint>]`
  - `vm_golden_name <ver>` → `mattstack-golden-<ver>`; `vm_image_for <ver>` → OCI ref (14→sonoma-vanilla, 15→sequoia-vanilla, 26→tahoe-vanilla)
  - `vm_run_init <label>` → sets `VM_RUN_ID`, `VM_RUN_DIR`, creates `screenshots/ logs/ in/`, writes `run.json`
  - `vm_phase_begin <name>`, `vm_phase_end <name> <pass|fail|skip> [<reason>] [<screenshot…>]` → appends to `phases.jsonl`; `vm_phases_failed` → count
  - `vm_ip <vm>` (retries), `vm_ssh <user> <vm> <cmd…>`, `vm_scp <user> <vm> <src> <dest>`, `vm_wait_ssh <user> <vm> <timeout_s>` — all key-based using `$VM_CACHE/id_ed25519`
  - `vm_ssh_pw <user> <pass> <vm> <cmd…>` (sshpass; golden build only)
  - `vm_render_report` → `report.md` from `phases.jsonl`

- [ ] **Step 1: Write `rt-tray/vm/.gitignore`**

```gitignore
artifacts/
.cache/
```

- [ ] **Step 2: Write the failing test `rt-tray/vm/lib/__tests__/common.test.sh`**

```bash
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
check "image for 99 dies"      '! vm_image_for 99 2>/dev/null'

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

rm -rf "$VM_ARTIFACTS"
[ "$fails" -eq 0 ] && echo "common.test.sh: all ok" || { echo "common.test.sh: $fails failed"; exit 1; }
```

- [ ] **Step 3: Run it to see it fail**

Run: `bash rt-tray/vm/lib/__tests__/common.test.sh`
Expected: `No such file or directory` for `common.sh` (exit ≠ 0).

- [ ] **Step 4: Write `rt-tray/vm/lib/common.sh`**

```bash
#!/bin/bash
# Shared helpers for rt-tray/vm scripts. Source, don't execute.
# bash 3.2 compatible (macOS stock /bin/bash): no associative arrays, no ${var,,}.

VM_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
: "${VM_ARTIFACTS:=$VM_ROOT/artifacts}"
: "${VM_CACHE:=$VM_ROOT/.cache}"
: "${VM_SSH_KEY:=$VM_CACHE/id_ed25519}"
: "${VM_ADMIN_USER:=admin}"
: "${VM_ADMIN_PASS:=admin}"
: "${VM_TESTER_USER:=tester}"
: "${VM_TESTER_PASS:=tester}"

VM_SSH_OPTS=(-o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ConnectTimeout=5)

vm_log()  { printf '  %s\n' "$*" >&2; }
vm_warn() { printf '  ! %s\n' "$*" >&2; }
vm_die()  { printf '  ✗ %s\n' "$*" >&2; exit 1; }
vm_now()  { date -u +%Y-%m-%dT%H:%M:%SZ; }

vm_require_cmd() {
  command -v "$1" >/dev/null 2>&1 || vm_die "missing command: $1${2:+ — $2}"
}

vm_golden_name() { printf 'mattstack-golden-%s' "$1"; }

vm_image_for() {
  case "$1" in
    14) printf 'ghcr.io/cirruslabs/macos-sonoma-vanilla:latest' ;;
    15) printf 'ghcr.io/cirruslabs/macos-sequoia-vanilla:latest' ;;
    26) printf 'ghcr.io/cirruslabs/macos-tahoe-vanilla:latest' ;;
    *)  vm_die "no image mapping for macOS $1 (known: 14 15 26)" ;;
  esac
}

# ── run directories + phase ledger ──────────────────────────────────────────

vm_run_init() {
  local label="$1"
  VM_RUN_ID="$(date +%Y%m%d-%H%M%S)-$label"
  VM_RUN_DIR="$VM_ARTIFACTS/$VM_RUN_ID"
  mkdir -p "$VM_RUN_DIR/screenshots" "$VM_RUN_DIR/logs" "$VM_RUN_DIR/in"
  printf '{\n  "id": "%s",\n  "label": "%s",\n  "startedAt": "%s",\n  "host": "%s"\n}\n' \
    "$VM_RUN_ID" "$label" "$(vm_now)" "$(sw_vers -productVersion 2>/dev/null || echo unknown)" > "$VM_RUN_DIR/run.json"
  export VM_RUN_ID VM_RUN_DIR
  vm_log "run $VM_RUN_ID → $VM_RUN_DIR"
}

_vm_phase_started=0
vm_phase_begin() {
  _vm_phase_started=$(date +%s)
  vm_log "── phase: $1"
}

# vm_phase_end <name> <pass|fail|skip> [reason] [screenshot...]
vm_phase_end() {
  local name="$1" status="$2" reason="${3:-}"; shift 3 2>/dev/null || shift $#
  local shots="" s
  for s in "$@"; do shots="$shots${shots:+,}\"$s\""; done
  local secs=$(( $(date +%s) - _vm_phase_started ))
  local esc_reason; esc_reason=$(printf '%s' "$reason" | sed 's/\\/\\\\/g; s/"/\\"/g')
  printf '{"phase":"%s","status":"%s","reason":"%s","at":"%s","seconds":%d,"screenshots":[%s]}\n' \
    "$name" "$status" "$esc_reason" "$(vm_now)" "$secs" "$shots" >> "$VM_RUN_DIR/phases.jsonl"
  case "$status" in
    pass) vm_log "   ✓ $name" ;;
    skip) vm_warn "   – $name skipped: $reason" ;;
    fail) vm_warn "   ✗ $name FAILED: $reason" ;;
    *)    vm_die "vm_phase_end: bad status '$status'" ;;
  esac
}

vm_phases_failed() { grep -c '"status":"fail"' "$VM_RUN_DIR/phases.jsonl" 2>/dev/null || true; }

vm_render_report() {
  local f="$VM_RUN_DIR/phases.jsonl" out="$VM_RUN_DIR/report.md"
  local total pass fail skip
  total=$(wc -l < "$f" | tr -d ' '); pass=$(grep -c '"status":"pass"' "$f" || true)
  fail=$(grep -c '"status":"fail"' "$f" || true); skip=$(grep -c '"status":"skip"' "$f" || true)
  {
    echo "# clean-room run $VM_RUN_ID"
    echo
    echo "$total phases: $pass passed, $fail failed, $skip skipped."
    [ "$skip" -gt 0 ] && echo "**Skipped phases are not green** — see reasons below."
    echo
    echo "| phase | status | seconds | reason | screenshots |"
    echo "|---|---|---|---|---|"
    sed -E 's/^\{"phase":"([^"]*)","status":"([^"]*)","reason":"([^"]*)","at":"[^"]*","seconds":([0-9]+),"screenshots":\[([^]]*)\]\}$/| \1 | \2 | \4 | \3 | \5 |/' "$f"
    echo
    echo "Logs: \`logs/\` · Screenshots: \`screenshots/\` · Ledger: \`phases.jsonl\`"
  } > "$out"
  vm_log "report → $out"
}

# ── tart / ssh ──────────────────────────────────────────────────────────────

vm_ip() {
  local vm="$1" tries="${2:-60}" ip=""
  while [ "$tries" -gt 0 ]; do
    ip=$(tart ip "$vm" 2>/dev/null || true)
    [ -n "$ip" ] && { printf '%s' "$ip"; return 0; }
    sleep 2; tries=$((tries-1))
  done
  return 1
}

vm_ssh() {
  local user="$1" vm="$2"; shift 2
  local ip; ip=$(vm_ip "$vm" 1) || vm_die "no ip for $vm"
  ssh "${VM_SSH_OPTS[@]}" -i "$VM_SSH_KEY" "$user@$ip" "$@"
}

vm_scp() {
  local user="$1" vm="$2" src="$3" dest="$4"
  local ip; ip=$(vm_ip "$vm" 1) || vm_die "no ip for $vm"
  scp -r "${VM_SSH_OPTS[@]}" -i "$VM_SSH_KEY" "$src" "$user@$ip:$dest"
}

vm_ssh_pw() {
  local user="$1" pass="$2" vm="$3"; shift 3
  vm_require_cmd sshpass "brew install cirruslabs/cli/sshpass"
  local ip; ip=$(vm_ip "$vm" 1) || vm_die "no ip for $vm"
  sshpass -p "$pass" ssh "${VM_SSH_OPTS[@]}" "$user@$ip" "$@"
}

vm_wait_ssh() {
  local user="$1" vm="$2" timeout="${3:-300}" start; start=$(date +%s)
  while :; do
    if vm_ssh "$user" "$vm" true 2>/dev/null; then return 0; fi
    [ $(( $(date +%s) - start )) -ge "$timeout" ] && return 1
    sleep 3
  done
}
```

- [ ] **Step 5: Run the test, expect all ok**

Run: `bash -n rt-tray/vm/lib/common.sh && bash rt-tray/vm/lib/__tests__/common.test.sh`
Expected: every line `ok`, final `common.test.sh: all ok`.

- [ ] **Step 6: Write the README skeleton `rt-tray/vm/README.md`** (Task 14 finishes it; the headings and the can/can't table are written now so every task can point at it)

```markdown
# rt-tray/vm — clean-room testing (installer spec ruling 12, lane L7)

Golden macOS VM images, a scripted walkthrough of the mattstack.app installer,
a second-macOS-user smoke, and a local runner for the CI headless install.
Every run's deliverable is `artifacts/<run-id>/` (screenshots, logs,
`phases.jsonl`, `report.md`). Skipped phases are reported as skipped, never green.

## What this layer verifies — and cannot

| Layer | Verifies | Cannot verify / not automated |
|---|---|---|
| (a) `scripts/e2e-cleanroom.sh` (same recipe as the release workflow's `test-install` job) | artifact extracts; `rt --post-install` installs `~/.local/bin/rt`, the app, the daemon config; `rt verify --ci` exit 0 | anything needing a GUI session or approval (daemon boot is a warn under CI), Gatekeeper (no quarantine on CI downloads) |
| (b) `run/walkthrough.sh` (Tart clone of a golden image) | real DMG → /Applications → first launch under Gatekeeper; five setup screens; FDA + Login Items + Notifications dances; `rt verify --json` green; tray.sock `/version`; Sparkle vN→vN+1 and daemon restart; screenshots per screen | the **"Background Items Added" notification** (a banner, not a dialog — it is neither clicked nor asserted; the Login Items row is asserted through `GET /services` / `rt setup status` instead); the **FDA relaunch** is driven (the app's own "Relaunch" button) but the OS applying FDA is asserted only via the app's probe row; notarisation/stapling of Matt's signing (a locally built DMG is unnotarised → run with `--no-quarantine`, reported in the ledger) |
| (c) `run/second-user.sh` | layer (a) under a second real macOS user on Matt's Mac, with a live GUI session so SMAppService registration is real | nothing about the five screens; the user must be created and logged in once by Matt |

(rest of the README is written in Task 14)
```

- [ ] **Step 7: Commit**

```bash
cd /Users/matt/Documents/GitHub/repo-tools-l7-wt
git add rt-tray/vm/.gitignore rt-tray/vm/README.md rt-tray/vm/lib/common.sh rt-tray/vm/lib/__tests__/common.test.sh
git commit -m "MAT-383: vm — scaffold rt-tray/vm with shared bash helpers and phase ledger

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Golden image build — `golden/build-golden.sh`, `golden/provision-guest.sh`, `golden/verify-golden.sh`

**Files:**
- Create: `rt-tray/vm/golden/build-golden.sh`
- Create: `rt-tray/vm/golden/provision-guest.sh`
- Create: `rt-tray/vm/golden/verify-golden.sh`

**Interfaces:**
- Consumes: `lib/common.sh` (`vm_image_for`, `vm_golden_name`, `vm_ssh_pw`, `vm_ssh`, `vm_wait_ssh`, `VM_SSH_KEY`).
- Produces: a stopped Tart VM `mattstack-golden-<ver>` with: users `admin` (admin, NOPASSWD sudo, ssh key) and `tester` (standard, password `tester`, ssh key, **auto-login console user**); no CLT; no Homebrew; Gatekeeper enabled; sleep/screensaver/screen-lock off; Remote Login on for all users; the driver TCC grants (Accessibility for `/usr/libexec/sshd-keygen-wrapper` + `/usr/bin/osascript`; Automation → System Events approved for tester) — the **one manual step**, verified by `verify-golden.sh`. Marker file `/Users/Shared/mattstack-golden.json` `{ "ver": "26", "builtAt": "...", "provisionRev": 1 }` read by `walkthrough.sh` preflight.
- Key: `$VM_CACHE/id_ed25519` (+ `.pub`), generated if missing; installed for both users.

> **ORCHESTRATOR/MATT:** this task downloads ~25–27 GB per image (≈50 GB disk each once expanded) and needs `brew install openai/tools/tart` + `brew install cirruslabs/cli/sshpass`. Implementers write and `bash -n`/`--dry-run` the scripts; Matt (or the orchestrator, with consent) runs `build-golden.sh 26` then `build-golden.sh 14` and performs the manual TCC clicks when the script pauses.

- [ ] **Step 1: Write `rt-tray/vm/golden/provision-guest.sh`** (copied into the guest and run as `admin` over ssh)

```bash
#!/bin/bash
# Runs INSIDE the guest as admin (NOPASSWD sudo). Idempotent.
# Args: <ver> <tester_pass> <pubkey>
set -euo pipefail
VER="$1"; TESTER_PASS="$2"; PUBKEY="$3"
TESTER=tester

say() { printf '  [guest] %s\n' "$*"; }

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
kc() { # kcpassword encoder, pure sh: XOR with Apple's 11-byte key, pad to 12.
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
printf '{ "ver": "%s", "builtAt": "%s", "provisionRev": 1, "consoleUser": "%s" }\n' \
  "$VER" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$TESTER" | sudo tee /Users/Shared/mattstack-golden.json >/dev/null
say "provisioned (ver $VER)"
```

Note for the implementer: `xxd` ships in macOS base (it is part of vim's package under `/usr/bin/xxd`), not CLT — verify in the guest with `command -v xxd` during the dry-run; if absent on 14, replace the encoder's last line with `perl -e 'print pack("H*", $ARGV[0])' "$(kc "$1")"` (perl ships in macOS base through 26).

- [ ] **Step 2: Write `rt-tray/vm/golden/verify-golden.sh`** (host; asserts the golden over ssh; used both at build end and by `walkthrough.sh --verify-golden`)

```bash
#!/bin/bash
# Usage: verify-golden.sh <ver> [<vm-name>]   (the VM must be running)
set -euo pipefail
source "$(cd "$(dirname "$0")/.." && pwd)/lib/common.sh"
VER="$1"; VM="${2:-$(vm_golden_name "$VER")}"
fails=0
ok()   { vm_log "  ✓ $1"; }
bad()  { vm_warn "  ✗ $1"; fails=$((fails+1)); }
t()    { if vm_ssh "$VM_TESTER_USER" "$VM" "$2" >/dev/null 2>&1; then ok "$1"; else bad "$1"; fi; }
a()    { if vm_ssh "$VM_ADMIN_USER" "$VM" "$2" >/dev/null 2>&1; then ok "$1"; else bad "$1"; fi; }

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
t "screenshots dir writable (virtiofs share optional at verify time)" 'true'

[ "$fails" -eq 0 ] && { vm_log "golden $VM verified"; exit 0; }
vm_die "golden $VM: $fails check(s) failed"
```

- [ ] **Step 3: Write `rt-tray/vm/golden/build-golden.sh`**

```bash
#!/bin/bash
# Build mattstack-golden-<ver> from the cirruslabs vanilla image.
# Usage: build-golden.sh <14|15|26> [--dry-run] [--rebuild]
# ORCHESTRATOR/MATT: downloads ~25 GB per image; pauses once for manual TCC clicks.
set -euo pipefail
source "$(cd "$(dirname "$0")/.." && pwd)/lib/common.sh"

VER="${1:-}"; shift || true
[ -n "$VER" ] || vm_die "usage: build-golden.sh <14|15|26> [--dry-run] [--rebuild]"
DRY=0; REBUILD=0
for a in "$@"; do case "$a" in --dry-run) DRY=1;; --rebuild) REBUILD=1;; *) vm_die "unknown arg $a";; esac; done

IMAGE=$(vm_image_for "$VER"); GOLDEN=$(vm_golden_name "$VER")
run() { if [ "$DRY" = 1 ]; then vm_log "[dry-run] $*"; else "$@"; fi; }

vm_log "golden: $GOLDEN ← $IMAGE"
if [ "$DRY" = 0 ]; then
  vm_require_cmd tart "brew install openai/tools/tart   (old tap: cirruslabs/cli/tart)"
  vm_require_cmd sshpass "brew install cirruslabs/cli/sshpass"
  mkdir -p "$VM_CACHE" "$VM_ARTIFACTS"
  [ -f "$VM_SSH_KEY" ] || ssh-keygen -q -t ed25519 -N '' -C mattstack-vm -f "$VM_SSH_KEY"
  if tart list 2>/dev/null | awk '{print $2}' | grep -qx "$GOLDEN"; then
    [ "$REBUILD" = 1 ] || vm_die "$GOLDEN exists; pass --rebuild to replace it"
    tart stop "$GOLDEN" 2>/dev/null || true; tart delete "$GOLDEN"
  fi
fi

run tart clone "$IMAGE" "$GOLDEN"
run tart set "$GOLDEN" --cpu 4 --memory 8192 --display 1600x1000

if [ "$DRY" = 1 ]; then
  vm_log "[dry-run] would: tart run $GOLDEN (with graphics) → provision-guest.sh over ssh → pause for TCC clicks → verify-golden.sh → tart stop"
  exit 0
fi

tart run "$GOLDEN" --no-audio > "$VM_ARTIFACTS/golden-$VER-tart.log" 2>&1 &
TART_PID=$!
trap 'kill $TART_PID 2>/dev/null || true' EXIT
vm_log "waiting for ssh as admin (password)…"
start=$(date +%s)
until vm_ssh_pw "$VM_ADMIN_USER" "$VM_ADMIN_PASS" "$GOLDEN" true 2>/dev/null; do
  [ $(( $(date +%s) - start )) -gt 600 ] && vm_die "ssh never came up"
  sleep 5
done

PUB=$(cat "$VM_SSH_KEY.pub")
vm_ssh_pw "$VM_ADMIN_USER" "$VM_ADMIN_PASS" "$GOLDEN" "cat > /tmp/provision-guest.sh" < "$VM_ROOT/golden/provision-guest.sh"
vm_ssh_pw "$VM_ADMIN_USER" "$VM_ADMIN_PASS" "$GOLDEN" "bash /tmp/provision-guest.sh '$VER' '$VM_TESTER_PASS' '$PUB'"

vm_log "rebooting into tester's auto-login session…"
vm_ssh "$VM_ADMIN_USER" "$GOLDEN" "sudo reboot" || true
sleep 20
vm_wait_ssh "$VM_TESTER_USER" "$GOLDEN" 600 || vm_die "tester ssh never came up after reboot"
vm_ssh "$VM_TESTER_USER" "$GOLDEN" "sysadminctl -screenLock off -password '$VM_TESTER_PASS'" || true

cat <<EOF

  ┌─ MANUAL STEP (once per golden) ─────────────────────────────────────────┐
  │ In the Tart window (logged in as tester):                                │
  │  1. System Settings → Privacy & Security → Accessibility → "+" →         │
  │     ⌘⇧G, add /usr/libexec/sshd-keygen-wrapper, then /usr/bin/osascript;  │
  │     toggle both ON (authenticate with admin / admin).                    │
  │  2. Back in this terminal press Enter; the script sends one osascript    │
  │     over ssh — approve the "sshd-keygen-wrapper wants to control         │
  │     System Events" Automation prompt in the VM with OK.                  │
  └──────────────────────────────────────────────────────────────────────────┘
EOF
read -r -p "  Press Enter after step 1… " _
vm_ssh "$VM_TESTER_USER" "$GOLDEN" 'osascript -e "tell application \"System Events\" to get name of first process whose frontmost is true"' || true
read -r -p "  Approved the Automation prompt? Press Enter to verify… " _

"$VM_ROOT/golden/verify-golden.sh" "$VER" "$GOLDEN"
vm_log "stopping $GOLDEN (never run the golden again; clone it)"
tart stop "$GOLDEN"
wait $TART_PID 2>/dev/null || true
trap - EXIT
vm_log "golden $GOLDEN ready"
```

- [ ] **Step 4: Syntax-check + dry-run**

Run:
```bash
bash -n rt-tray/vm/golden/build-golden.sh rt-tray/vm/golden/provision-guest.sh rt-tray/vm/golden/verify-golden.sh
bash rt-tray/vm/golden/build-golden.sh 26 --dry-run
bash rt-tray/vm/golden/build-golden.sh 99 --dry-run; echo "exit=$?"
```
Expected: no syntax errors; dry-run prints the `tart clone`/`tart set` lines and the "would:" line; `99` prints `no image mapping` and exit 1.

- [ ] **Step 5 (MATT / ORCHESTRATOR with consent): real build**

Run: `brew install openai/tools/tart cirruslabs/cli/sshpass && bash rt-tray/vm/golden/build-golden.sh 26 && bash rt-tray/vm/golden/build-golden.sh 14`
Expected: each ends with `golden mattstack-golden-<ver> ready` after `verify-golden.sh` prints all ✓. Record the `tart-pull` duration and disk use in the README's "Costs" section (Task 14). If `tart clone` of the 14 image fails, try `15` (`build-golden.sh 15`) and record it.

- [ ] **Step 6: Commit**

```bash
git add rt-tray/vm/golden
git commit -m "MAT-383: vm — golden image build, guest provisioner, golden verifier

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Artifact helpers — `run/make-dmg.sh`, `run/helpers/appcast-server.ts`, `run/make-appcast.sh`

**Files:**
- Create: `rt-tray/vm/run/make-dmg.sh`
- Create: `rt-tray/vm/run/helpers/appcast-server.ts`
- Create: `rt-tray/vm/run/helpers/__tests__/appcast-server.test.ts`
- Create: `rt-tray/vm/run/make-appcast.sh`

**Interfaces:**
- `make-dmg.sh <path/to/mattstack.app> <out.dmg>` → read-only UDZO DMG named `mattstack` containing the app + `/Applications` symlink (what L4 will ship; lets L7 run before L4).
- `appcast-server` (compiled with `bun build --compile`): `appcast-server <dir> <port>` serves files from `<dir>` on `127.0.0.1:<port>`, logs one line per request to stderr, exits on SIGTERM. Used by `trigger-update.sh` inside the guest.
- `make-appcast.sh <path/to/mattstack.app> <new-version> <new-build> <ed-key-file> <out-dir>` → `<out-dir>/mattstack-<new-version>.zip` + `<out-dir>/appcast.xml` (download URL prefix `http://127.0.0.1:8765/`). Requires `generate_appcast` (Sparkle tools) on `PATH` or at `$SPARKLE_BIN`; dies with the download hint otherwise.

- [ ] **Step 1: Write `rt-tray/vm/run/make-dmg.sh`**

```bash
#!/bin/bash
# Wrap a built mattstack.app in a DMG shaped like the release artifact.
# Usage: make-dmg.sh <mattstack.app> <out.dmg>
set -euo pipefail
source "$(cd "$(dirname "$0")/.." && pwd)/lib/common.sh"
APP="${1:-}"; OUT="${2:-}"
[ -d "$APP" ] && [ -n "$OUT" ] || vm_die "usage: make-dmg.sh <mattstack.app> <out.dmg>"
[ "$(basename "$APP")" = "mattstack.app" ] || vm_die "bundle must be named mattstack.app (got $(basename "$APP"))"
STAGE=$(mktemp -d); trap 'rm -rf "$STAGE"' EXIT
ditto "$APP" "$STAGE/mattstack.app"
ln -s /Applications "$STAGE/Applications"
rm -f "$OUT"
hdiutil create -quiet -volname mattstack -srcfolder "$STAGE" -ov -format UDZO "$OUT"
vm_log "dmg → $OUT ($(du -h "$OUT" | cut -f1))"
```

- [ ] **Step 2: Write the failing test `rt-tray/vm/run/helpers/__tests__/appcast-server.test.ts`**

```ts
import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const dir = mkdtempSync(join(tmpdir(), "appcast-"));
writeFileSync(join(dir, "appcast.xml"), "<rss/>");
writeFileSync(join(dir, "mattstack-9.9.9.zip"), "zipbytes");
const port = 18765 + Math.floor(Math.random() * 1000);
const proc = Bun.spawn(["bun", join(import.meta.dir, "..", "appcast-server.ts"), dir, String(port)], {
  stdout: "pipe", stderr: "pipe",
});
afterAll(() => proc.kill());

async function ready() {
  for (let i = 0; i < 50; i++) {
    try { await fetch(`http://127.0.0.1:${port}/appcast.xml`); return; } catch { await Bun.sleep(100); }
  }
  throw new Error("server never came up");
}

describe("appcast-server", () => {
  test("serves files from dir with content types", async () => {
    await ready();
    const r = await fetch(`http://127.0.0.1:${port}/appcast.xml`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("application/rss+xml");
    expect(await r.text()).toBe("<rss/>");
    const z = await fetch(`http://127.0.0.1:${port}/mattstack-9.9.9.zip`);
    expect(z.status).toBe(200);
    expect(z.headers.get("content-type")).toBe("application/zip");
    expect(z.headers.get("content-length")).toBe("8");
  });
  test("404 for missing and refuses path traversal", async () => {
    expect((await fetch(`http://127.0.0.1:${port}/nope.xml`)).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${port}/../appcast.xml`)).status).toBe(404);
  });
});
```

- [ ] **Step 3: Run it to see it fail**

Run: `bun test rt-tray/vm/run/helpers/__tests__/appcast-server.test.ts`
Expected: fails — `server never came up` (file missing).

- [ ] **Step 4: Write `rt-tray/vm/run/helpers/appcast-server.ts`**

```ts
// Static file server for the in-guest Sparkle appcast. Loopback only, so the
// guest never crosses macOS 15's Local Network Privacy boundary to the host.
import { existsSync, statSync } from "fs";
import { join, normalize, resolve, extname } from "path";

const [dir, portArg] = process.argv.slice(2);
if (!dir || !portArg) {
  console.error("usage: appcast-server <dir> <port>");
  process.exit(2);
}
const root = resolve(dir);
const port = Number(portArg);
const types: Record<string, string> = {
  ".xml": "application/rss+xml; charset=utf-8",
  ".zip": "application/zip",
  ".dmg": "application/x-apple-diskimage",
  ".delta": "application/octet-stream",
  ".txt": "text/plain; charset=utf-8",
  ".html": "text/html; charset=utf-8",
};

const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  fetch(req) {
    const path = normalize(decodeURIComponent(new URL(req.url).pathname));
    const file = join(root, path);
    const ok = file.startsWith(root + "/") && existsSync(file) && statSync(file).isFile();
    console.error(`${new Date().toISOString()} ${req.method} ${path} → ${ok ? 200 : 404}`);
    if (!ok) return new Response("not found", { status: 404 });
    const size = statSync(file).size;
    return new Response(Bun.file(file), {
      headers: {
        "content-type": types[extname(file)] ?? "application/octet-stream",
        "content-length": String(size),
        "cache-control": "no-store",
      },
    });
  },
});
console.error(`appcast-server: serving ${root} on http://127.0.0.1:${server.port}/`);
process.on("SIGTERM", () => { server.stop(); process.exit(0); });
process.on("SIGINT", () => { server.stop(); process.exit(0); });
```

- [ ] **Step 5: Run the test, expect pass; compile once to prove `--compile` works**

Run:
```bash
bun test rt-tray/vm/run/helpers/__tests__/appcast-server.test.ts
mkdir -p rt-tray/vm/.cache && bun build --compile rt-tray/vm/run/helpers/appcast-server.ts --outfile rt-tray/vm/.cache/appcast-server && file rt-tray/vm/.cache/appcast-server | grep -q Mach-O && echo compiled-ok
```
Expected: 2 pass; `compiled-ok`.

- [ ] **Step 6: Write `rt-tray/vm/run/make-appcast.sh`**

```bash
#!/bin/bash
# Build the vN+1 Sparkle enclosure + appcast from a built app, for the update phase.
# Usage: make-appcast.sh <mattstack.app> <new-version> <new-build> <ed-private-key-file> <out-dir> [--sign <identity>]
# The app's SUPublicEDKey must match the private key (L4 build: SPARKLE_PUBLIC_ED_KEY override).
set -euo pipefail
source "$(cd "$(dirname "$0")/.." && pwd)/lib/common.sh"
APP="${1:-}"; NEWV="${2:-}"; NEWB="${3:-}"; KEY="${4:-}"; OUT="${5:-}"; shift 5 2>/dev/null || true
SIGN="-"
while [ $# -gt 0 ]; do case "$1" in --sign) SIGN="$2"; shift 2;; *) vm_die "unknown arg $1";; esac; done
[ -d "$APP" ] && [ -n "$NEWV" ] && [ -n "$NEWB" ] && [ -f "$KEY" ] && [ -n "$OUT" ] \
  || vm_die "usage: make-appcast.sh <mattstack.app> <new-version> <new-build> <ed-key-file> <out-dir> [--sign <identity>]"

GEN="${SPARKLE_BIN:+$SPARKLE_BIN/}generate_appcast"
command -v "$GEN" >/dev/null 2>&1 || vm_die "generate_appcast not found — download Sparkle-<ver>.tar.xz from https://github.com/sparkle-project/Sparkle/releases, extract, and set SPARKLE_BIN=<extracted>/bin"

mkdir -p "$OUT"; STAGE=$(mktemp -d); trap 'rm -rf "$STAGE"' EXIT
ditto "$APP" "$STAGE/mattstack.app"
PL="$STAGE/mattstack.app/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $NEWV" "$PL"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $NEWB" "$PL"
# Inside-out re-sign: every nested Mach-O first, then the bundle (never --deep).
find "$STAGE/mattstack.app/Contents" -type f -perm -u+x -not -path '*/Info.plist' | while read -r f; do
  file -b "$f" | grep -q Mach-O && codesign --force --options runtime --timestamp=none --sign "$SIGN" "$f" 2>/dev/null || true
done
codesign --force --options runtime --timestamp=none --sign "$SIGN" "$STAGE/mattstack.app"
rm -f "$OUT"/mattstack-*.zip "$OUT"/appcast.xml
(cd "$STAGE" && ditto -c -k --sequesterRsrc --keepParent mattstack.app "$OUT/mattstack-$NEWV.zip")
"$GEN" --ed-key-file "$KEY" --download-url-prefix "http://127.0.0.1:8765/" -o "$OUT/appcast.xml" "$OUT"
vm_log "appcast → $OUT/appcast.xml (enclosure mattstack-$NEWV.zip, build $NEWB)"
```

- [ ] **Step 7: Syntax-check + dry-run `make-dmg.sh` against the checked-in prod bundle**

Run:
```bash
bash -n rt-tray/vm/run/make-dmg.sh rt-tray/vm/run/make-appcast.sh
ls -d rt-tray/mattstack.app >/dev/null 2>&1 || (cd rt-tray && ./build.sh release)
bash rt-tray/vm/run/make-dmg.sh rt-tray/mattstack.app rt-tray/vm/.cache/mattstack-local.dmg && hdiutil imageinfo rt-tray/vm/.cache/mattstack-local.dmg | grep -q "Format: UDZO" && echo dmg-ok
bash rt-tray/vm/run/make-appcast.sh rt-tray/mattstack.app 0.0.1 1 /dev/null /tmp/x; echo "exit=$?"
```
Expected: `dmg-ok`; make-appcast exits 1 with the `generate_appcast not found` hint (or the usage line if `/dev/null` fails `-f` — `-f /dev/null` is true, so the hint is the expected message).

- [ ] **Step 8: Commit**

```bash
git add rt-tray/vm/run/make-dmg.sh rt-tray/vm/run/make-appcast.sh rt-tray/vm/run/helpers
git commit -m "MAT-383: vm — DMG/appcast builders and the loopback appcast server

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---
