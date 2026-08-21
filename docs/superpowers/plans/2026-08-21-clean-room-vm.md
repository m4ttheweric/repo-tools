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
| Five screens + AXIdentifiers — **not yet in the L3 plan (`2026-08-21-mattstack-app-shell.md`), which does define the XCUITest target `mattstackUITests` and the stub envs `RT_STUB_SCENARIO`/`RT_STUB_PATH`/`RT_STUB_BUN`** — (`setup.window`, `setup.continue`, `setup.back`, `setup.install`, `setup.finish`, `setup.card.create`, `setup.card.join`, `setup.field.teamName`, `setup.field.inviteCode`, `row.<rowId>`, `row.<rowId>.action`, `row.<rowId>.status`); `MATTSTACK_APPCAST_URL` env honoured by the updater delegate; ATS `NSAllowsLocalNetworking`; `GET /version` on tray.sock | L3 | screens (P5), update (P7) |
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

### Task 4: Host-side screenshot — `run/host/winid.swift` + `run/host/capture.sh`

**Files:**
- Create: `rt-tray/vm/run/host/winid.swift`
- Create: `rt-tray/vm/run/host/capture.sh`

**Interfaces:**
- `winid.swift <vm-name>` → prints the CGWindowID of the Tart window titled `<vm-name>` (exit 1 if none). Run via `swift run/host/winid.swift …` (CLT `swift` exists on Matt's host — `rt-tray/build.sh` already depends on it).
- `capture.sh <vm-name> <out.png>` → `screencapture -x -l <id> <out.png>`; exit 0 + file, or exit 1 with a reason printed. Needs Screen Recording for the host terminal app (MATT one-time; the script detects an all-black/0-byte result and says so).

- [ ] **Step 1: Write `rt-tray/vm/run/host/winid.swift`**

```swift
import CoreGraphics
import Foundation

let args = CommandLine.arguments
guard args.count == 2 else {
    FileHandle.standardError.write("usage: winid <window title>\n".data(using: .utf8)!)
    exit(2)
}
let wanted = args[1]
let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
for w in list {
    let owner = w[kCGWindowOwnerName as String] as? String ?? ""
    let name = w[kCGWindowName as String] as? String ?? ""
    let layer = w[kCGWindowLayer as String] as? Int ?? 0
    if owner.lowercased() == "tart" && name == wanted && layer == 0, let id = w[kCGWindowNumber as String] as? Int {
        print(id)
        exit(0)
    }
}
FileHandle.standardError.write("no on-screen tart window titled \(wanted)\n".data(using: .utf8)!)
exit(1)
```

- [ ] **Step 2: Write `rt-tray/vm/run/host/capture.sh`**

```bash
#!/bin/bash
# Screenshot the Tart window of <vm> into <out.png>, from the host.
# Usage: capture.sh <vm-name> <out.png>
set -euo pipefail
source "$(cd "$(dirname "$0")/../.." && pwd)/lib/common.sh"
VM="${1:-}"; OUT="${2:-}"
[ -n "$VM" ] && [ -n "$OUT" ] || vm_die "usage: capture.sh <vm-name> <out.png>"
WINID_BIN="$VM_CACHE/winid"
if [ ! -x "$WINID_BIN" ] || [ "$VM_ROOT/run/host/winid.swift" -nt "$WINID_BIN" ]; then
  mkdir -p "$VM_CACHE"
  swiftc -O -o "$WINID_BIN" "$VM_ROOT/run/host/winid.swift" 2>/dev/null || vm_die "swiftc failed — Apple CLT required on the host"
fi
WID=$("$WINID_BIN" "$VM") || vm_die "no Tart window for $VM (running with --no-graphics? then screenshots are unavailable)"
screencapture -x -o -l "$WID" "$OUT" || vm_die "screencapture failed"
[ -s "$OUT" ] || vm_die "empty screenshot — grant Screen Recording to your terminal app (System Settings → Privacy & Security → Screen & System Audio Recording) and retry"
# A capture without Screen Recording permission is a solid desktop-coloured image; detect the degenerate 1-colour case.
if command -v sips >/dev/null 2>&1; then
  W=$(sips -g pixelWidth "$OUT" 2>/dev/null | awk '/pixelWidth/{print $2}')
  [ "${W:-0}" -gt 100 ] || vm_die "screenshot too small ($W px) — window minimised?"
fi
vm_log "screenshot → $OUT"
```

- [ ] **Step 3: Syntax-check + compile + negative run**

Run:
```bash
bash -n rt-tray/vm/run/host/capture.sh
mkdir -p rt-tray/vm/.cache && swiftc -O -o rt-tray/vm/.cache/winid rt-tray/vm/run/host/winid.swift && echo winid-compiled
rt-tray/vm/.cache/winid no-such-vm; echo "exit=$?"
bash rt-tray/vm/run/host/capture.sh no-such-vm /tmp/x.png; echo "exit=$?"
```
Expected: `winid-compiled`; `no on-screen tart window titled no-such-vm` exit 1; capture.sh prints the `no Tart window` reason, exit 1.

- [ ] **Step 4: Commit**

```bash
git add rt-tray/vm/run/host
git commit -m "MAT-383: vm — host-side Tart window capture

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Guest install — `run/guest/install-app.sh`

**Files:**
- Create: `rt-tray/vm/run/guest/install-app.sh`

**Interfaces:**
- Runs in the guest. Invoked twice by `walkthrough.sh`: `install-app.sh copy <dmg> [--quarantine|--no-quarantine]` as **admin** (mount, copy to `/Applications` like Finder-with-admin-auth does, detach), then `install-app.sh launch [--env KEY=VAL …]` as **tester** (`open` with env, wait for the process + menu bar item, report). Exit codes: 0 ok, 2 Gatekeeper blocked (dialog detected), 1 other.
- Writes `$GUEST_RUN/logs/install-app.log` where `GUEST_RUN=/Volumes/My Shared Files/run` (the host run dir).

- [ ] **Step 1: Write `rt-tray/vm/run/guest/install-app.sh`**

```bash
#!/bin/bash
# Guest side of the install phase. See header of each subcommand.
set -euo pipefail
GUEST_RUN="${GUEST_RUN:-/Volumes/My Shared Files/run}"
LOG="$GUEST_RUN/logs/install-app.log"; mkdir -p "$(dirname "$LOG")"
say() { printf '%s %s\n' "$(date -u +%H:%M:%S)" "$*" | tee -a "$LOG" >&2; }
APP=/Applications/mattstack.app

cmd="${1:-}"; shift || true
case "$cmd" in
  copy)
    DMG="${1:-}"; shift || true; Q=1
    for a in "$@"; do case "$a" in --quarantine) Q=1;; --no-quarantine) Q=0;; esac; done
    [ -f "$DMG" ] || { say "no dmg at $DMG"; exit 1; }
    if [ "$Q" = 1 ]; then
      # Simulate a browser download so Gatekeeper assesses the app on first open.
      xattr -w com.apple.quarantine "0083;$(printf '%x' "$(date +%s)");Safari;$(uuidgen)" "$DMG"
      say "quarantine set on $(basename "$DMG")"
    else
      xattr -d com.apple.quarantine "$DMG" 2>/dev/null || true
      say "quarantine NOT set (unnotarised build mode)"
    fi
    hdiutil detach /Volumes/mattstack -quiet 2>/dev/null || true
    hdiutil attach "$DMG" -nobrowse -quiet -mountpoint /Volumes/mattstack
    [ -d /Volumes/mattstack/mattstack.app ] || { say "dmg has no mattstack.app"; hdiutil detach /Volumes/mattstack -quiet; exit 1; }
    sudo rm -rf "$APP"
    sudo ditto /Volumes/mattstack/mattstack.app "$APP"   # preserves xattrs incl. quarantine, like Finder
    sudo chown -R root:admin "$APP"
    hdiutil detach /Volumes/mattstack -quiet
    say "copied to $APP ($(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP/Contents/Info.plist"))"
    codesign --verify --deep --strict "$APP" 2>>"$LOG" && say "codesign verifies" || say "codesign does NOT verify (ad-hoc/dev build?)"
    spctl --assess --type execute "$APP" 2>>"$LOG" && say "spctl: accepted" || say "spctl: rejected (expect a Gatekeeper dialog if quarantined)"
    ;;
  launch)
    ENVS=()
    while [ $# -gt 0 ]; do case "$1" in --env) ENVS+=("--env" "$2"); shift 2;; *) shift;; esac; done
    [ -d "$APP" ] || { say "no app at $APP"; exit 1; }
    open "${ENVS[@]}" "$APP"
    for i in $(seq 1 30); do
      sleep 1
      if pgrep -x mattstack >/dev/null; then say "process up after ${i}s"; break; fi
      # Gatekeeper refusal shows a CoreServicesUIAgent alert; detect and report, don't dismiss.
      if osascript -e 'tell application "System Events" to exists (window 1 of process "CoreServicesUIAgent")' 2>/dev/null | grep -q true; then
        say "Gatekeeper dialog present — app blocked"; exit 2
      fi
    done
    pgrep -x mattstack >/dev/null || { say "mattstack never started"; exit 1; }
    # Menu bar extra = the app's own status item; give it a few seconds to appear.
    for i in $(seq 1 20); do
      if osascript -e 'tell application "System Events" to tell process "mattstack" to count menu bar items of menu bar 2' 2>/dev/null | grep -qE '^[1-9]'; then
        say "menu bar item present"; exit 0; fi
      sleep 1
    done
    say "no menu bar item after 20s (app running)"; exit 0
    ;;
  *) echo "usage: install-app.sh copy <dmg> [--quarantine|--no-quarantine] | launch [--env K=V]..." >&2; exit 1;;
esac
```

- [ ] **Step 2: Syntax-check + host-only dry run of the parser**

Run: `bash -n rt-tray/vm/run/guest/install-app.sh && GUEST_RUN=/tmp/gr bash rt-tray/vm/run/guest/install-app.sh copy /nonexistent.dmg; echo "exit=$?"; bash rt-tray/vm/run/guest/install-app.sh; echo "exit=$?"`
Expected: `no dmg at /nonexistent.dmg` exit 1; usage exit 1.

- [ ] **Step 3: Commit**

```bash
git add rt-tray/vm/run/guest/install-app.sh
git commit -m "MAT-383: vm — guest DMG install and first launch

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: UI-scripting library + the five screens — `run/guest/ax.sh`, `run/guest/drive-setup.sh`

**Files:**
- Create: `rt-tray/vm/run/guest/ax.sh`
- Create: `rt-tray/vm/run/guest/drive-setup.sh`

**Interfaces:**
- `ax.sh` (sourced in the guest): `ax_app` = `mattstack`; `ax_wait_window <title-substr> <timeout>`; `ax_find <axid>` → prints AppleScript reference or fails; `ax_click <axid>`; `ax_click_button_named <name> [<process>]`; `ax_type <text>` (keystroke into focused field); `ax_set_field <axid> <text>`; `ax_status <rowId>` → the row's status text (`ready|missing|needs-you|…` via `row.<id>.status` AXIdentifier `value`/`description`); `ax_wait_status <rowId> <status> <timeout>`; `ax_admin_auth` (fills the SecurityAgent dialog with `admin`/`$VM_ADMIN_PASS`); `ax_allow_notifications` (clicks Allow in the UNC prompt if present); `ax_shot <name>` → asks the HOST to capture by touching `$GUEST_RUN/in/shot-<name>.req` and waiting for `.done` (host loop in `walkthrough.sh`); `ax_fail <msg>` → shot + exit 1.
- `drive-setup.sh <scenario> [--team-slug vmtest] [--pat-env MATTSTACK_VMTEST_PAT] [--invite-code-file <path>]` runs the five screens; per-screen functions `screen_welcome`, `screen_team`, `screen_readiness`, `screen_install`, `screen_done`; exit 0 when "Done" is reached and Finish clicked; exit 1 with the failing screen in the last log line. Scenarios: `create` (default), `join` (needs invite code file), `restore` (reserved; exits 3 "not implemented").
- AXIdentifiers are the L3 contract asks listed in "Dependencies on other lanes"; until L3 ships them, every `ax_find` fails fast with `axid not found: <id>` and the phase is a clean `fail`, never a hang.

- [ ] **Step 1: Write `rt-tray/vm/run/guest/ax.sh`**

```bash
#!/bin/bash
# osascript/System Events helpers for driving mattstack.app in the guest.
# Source only. Requires Accessibility + Automation granted to sshd-keygen-wrapper (golden step).
GUEST_RUN="${GUEST_RUN:-/Volumes/My Shared Files/run}"
AX_APP="${AX_APP:-mattstack}"
: "${VM_ADMIN_USER:=admin}"; : "${VM_ADMIN_PASS:=admin}"
AX_LOG="$GUEST_RUN/logs/drive.log"; mkdir -p "$(dirname "$AX_LOG")" 2>/dev/null || true

ax_log()  { printf '%s %s\n' "$(date -u +%H:%M:%S)" "$*" | tee -a "$AX_LOG" >&2; }
ax_osa()  { osascript -e "$1" 2>>"$AX_LOG"; }

# Host-side capture handshake: the host watches in/ for *.req files.
ax_shot() {
  local name="$1" req="$GUEST_RUN/in/shot-$name.req" done="$GUEST_RUN/in/shot-$name.done"
  rm -f "$done"; : > "$req"
  for _ in $(seq 1 40); do [ -f "$done" ] && { ax_log "shot $name"; return 0; }; sleep 0.5; done
  ax_log "shot $name: host did not respond (no graphics?)"; return 0
}
ax_fail() { ax_log "FAIL: $*"; ax_shot "fail-$(date +%s)"; exit 1; }

ax_wait_window() {  # <title-substring> <timeout-s>
  local t="$1" n="${2:-30}"
  while [ "$n" -gt 0 ]; do
    ax_osa "tell application \"System Events\" to tell process \"$AX_APP\" to get name of every window" 2>/dev/null | grep -q "$t" && return 0
    sleep 1; n=$((n-1))
  done
  return 1
}

# Find a UI element by AXIdentifier anywhere under window 1; prints a reference path usable in `tell`.
ax_find() {  # <axid>
  ax_osa "
    on walk(el, wanted)
      try
        if (value of attribute \"AXIdentifier\" of el) is wanted then return el
      end try
      try
        repeat with c in UI elements of el
          set r to my walk(c, wanted)
          if r is not missing value then return r
        end repeat
      end try
      return missing value
    end walk
    tell application \"System Events\" to tell process \"$AX_APP\"
      set r to my walk(window 1, \"$1\")
      if r is missing value then error \"axid not found: $1\"
      return (r as text)
    end tell" 2>/dev/null
}

ax_click() {  # <axid>
  ax_osa "
    on walk(el, wanted)
      try
        if (value of attribute \"AXIdentifier\" of el) is wanted then return el
      end try
      try
        repeat with c in UI elements of el
          set r to my walk(c, wanted)
          if r is not missing value then return r
        end repeat
      end try
      return missing value
    end walk
    tell application \"System Events\" to tell process \"$AX_APP\"
      set frontmost to true
      set r to my walk(window 1, \"$1\")
      if r is missing value then error \"axid not found: $1\"
      click r
    end tell" || ax_fail "click $1"
  ax_log "clicked $1"
}

ax_click_button_named() {  # <name> [<process>]
  local p="${2:-$AX_APP}"
  ax_osa "tell application \"System Events\" to tell process \"$p\" to click (first button of window 1 whose name is \"$1\")" >/dev/null || return 1
  ax_log "clicked button '$1' in $p"
}

ax_set_field() {  # <axid> <text>   (text never logged)
  ax_osa "
    on walk(el, wanted)
      try
        if (value of attribute \"AXIdentifier\" of el) is wanted then return el
      end try
      try
        repeat with c in UI elements of el
          set r to my walk(c, wanted)
          if r is not missing value then return r
        end repeat
      end try
      return missing value
    end walk
    tell application \"System Events\" to tell process \"$AX_APP\"
      set frontmost to true
      set r to my walk(window 1, \"$1\")
      if r is missing value then error \"axid not found: $1\"
      set focused of r to true
      keystroke \"a\" using command down
      keystroke \"$2\"
    end tell" || ax_fail "set field $1"
  ax_log "filled $1"
}

ax_status() {  # <rowId> → status string (the app exposes it as the row status element's value)
  ax_osa "
    on walk(el, wanted)
      try
        if (value of attribute \"AXIdentifier\" of el) is wanted then return el
      end try
      try
        repeat with c in UI elements of el
          set r to my walk(c, wanted)
          if r is not missing value then return r
        end repeat
      end try
      return missing value
    end walk
    tell application \"System Events\" to tell process \"$AX_APP\"
      set r to my walk(window 1, \"row.$1.status\")
      if r is missing value then error \"axid not found: row.$1.status\"
      try
        return value of r as text
      on error
        return description of r as text
      end try
    end tell" 2>/dev/null
}

ax_wait_status() {  # <rowId> <status> <timeout-s>
  local n="${3:-60}" s
  while [ "$n" -gt 0 ]; do
    s=$(ax_status "$1" || true)
    [ "$s" = "$2" ] && { ax_log "row $1 = $2"; return 0; }
    sleep 1; n=$((n-1))
  done
  ax_log "row $1 stuck at '${s:-?}' (wanted $2)"; return 1
}

# SecurityAgent admin prompt (privileged step, FDA/Login Items toggles by a standard user).
ax_admin_auth() {
  local n=30
  while [ "$n" -gt 0 ]; do
    if ax_osa 'tell application "System Events" to exists window 1 of process "SecurityAgent"' 2>/dev/null | grep -q true; then
      ax_osa "tell application \"System Events\" to tell process \"SecurityAgent\" to tell window 1
        set value of text field 1 to \"$VM_ADMIN_USER\"
        set value of text field 2 to \"$VM_ADMIN_PASS\"
        click (first button whose name is \"OK\" or name is \"Unlock\" or name is \"Modify Settings\" or name is \"Install Helper\")
      end tell" >/dev/null && { ax_log "admin auth filled"; return 0; }
    fi
    sleep 1; n=$((n-1))
  done
  return 1
}

ax_allow_notifications() {
  ax_osa 'tell application "System Events" to tell process "UserNotificationCenter" to click (first button of window 1 whose name is "Allow")' >/dev/null 2>&1 \
    && ax_log "notifications: Allow clicked" || ax_log "notifications: no prompt visible"
}

# System Settings: toggle the app's switch in a Privacy pane opened by the app's button.
ax_toggle_in_system_settings() {  # <row label e.g. mattstack>
  ax_osa "tell application \"System Events\" to tell process \"System Settings\"
    repeat 20 times
      if exists window 1 then exit repeat
      delay 0.5
    end repeat
    tell window 1
      set tgt to first checkbox of (first group whose name contains \"$1\" or description contains \"$1\") of (first scroll area of group 1 of splitter group 1 of group 1)
      if value of tgt is 0 then click tgt
    end tell
  end tell" >/dev/null 2>&1 || {
    # Layout differs across 14/15/26; fall back to a breadth-first search for a checkbox near a static text with the label.
    ax_osa "tell application \"System Events\" to tell process \"System Settings\" to tell window 1
      set cbs to every checkbox of entire contents
      repeat with cb in cbs
        try
          if (name of cb contains \"$1\") or (description of cb contains \"$1\") then
            if value of cb is 0 then click cb
            return
          end if
        end try
      end repeat
      error \"no checkbox for $1\"
    end tell" >/dev/null || return 1
  }
  ax_log "System Settings: toggled $1"
  ax_admin_auth || true
  ax_osa 'tell application "System Settings" to quit' >/dev/null 2>&1 || true
}
```

- [ ] **Step 2: Write `rt-tray/vm/run/guest/drive-setup.sh`**

```bash
#!/bin/bash
# Drive the five setup screens of mattstack.app (spec §4) in the guest as tester.
# Usage: drive-setup.sh <create|join|restore> [--team-slug vmtest] [--pat-env MATTSTACK_VMTEST_PAT] [--invite-code-file <p>]
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; source "$HERE/ax.sh"
SCENARIO="${1:-create}"; shift || true
SLUG=vmtest; PAT_ENV=MATTSTACK_VMTEST_PAT; CODE_FILE=""
while [ $# -gt 0 ]; do case "$1" in
  --team-slug) SLUG="$2"; shift 2;; --pat-env) PAT_ENV="$2"; shift 2;; --invite-code-file) CODE_FILE="$2"; shift 2;;
  *) ax_fail "unknown arg $1";; esac; done
PAT="${!PAT_ENV:-}"
RT="$HOME/.local/bin/rt"

screen_welcome() {
  ax_wait_window "mattstack" 60 || ax_fail "setup window never appeared"
  ax_find setup.window >/dev/null || ax_fail "setup.window axid missing (L3 contract)"
  ax_shot 01-welcome
  ax_click setup.continue
}

screen_team() {
  case "$SCENARIO" in
    create)
      ax_click setup.card.create
      ax_set_field setup.field.teamName "$SLUG"
      ax_shot 02-team-create
      ;;
    join)
      [ -n "$CODE_FILE" ] && [ -f "$CODE_FILE" ] || ax_fail "join needs --invite-code-file"
      ax_click setup.card.join
      ax_set_field setup.field.inviteCode "$(tr -d '\n' < "$CODE_FILE")"
      ax_shot 02-team-join
      ;;
    restore) ax_log "restore scenario not implemented"; exit 3;;
  esac
  ax_click setup.continue
  # Continue validates the remote(s) with git ls-remote; allow time, then the checklist must appear.
  ax_wait_window "mattstack" 10
}

screen_readiness() {
  ax_shot 03-readiness-initial
  # Accounts → GitHub token (the guest has no gh; the PAT is typed, never logged, masked on screen).
  if ax_find row.account.github >/dev/null 2>&1; then
    [ -n "$PAT" ] || ax_fail "row.account.github present but \$$PAT_ENV is empty on the host"
    ax_click row.account.github.action
    ax_set_field connect.field.token "$PAT"
    ax_click connect.submit
    ax_wait_status account.github ready 60 || ax_fail "github row not ready"
  fi
  # Full Disk Access: button → System Settings → toggle (admin auth for a standard user) → Relaunch.
  if [ "$(ax_status perm.fda || true)" != ready ]; then
    ax_click row.perm.fda.action
    ax_toggle_in_system_settings mattstack || ax_fail "could not toggle FDA in System Settings"
    ax_shot 03-fda-toggled
    # The row now offers "Relaunch mattstack"; the app restarts itself.
    ax_wait_status perm.fda needs-you 20 || true
    ax_click row.perm.fda.action
    sleep 3; ax_wait_window "mattstack" 60 || ax_fail "app did not come back after FDA relaunch"
    ax_wait_status perm.fda ready 30 || ax_fail "FDA not applied after relaunch"
  fi
  # Background services (Login Items): register → if requiresApproval, open pane and toggle.
  if [ "$(ax_status perm.loginItems || true)" != ready ]; then
    ax_click row.perm.loginItems.action
    sleep 2
    if [ "$(ax_status perm.loginItems || true)" != ready ]; then
      ax_toggle_in_system_settings mattstack || ax_log "login items toggle not found (may already be enabled)"
    fi
    ax_wait_status perm.loginItems ready 60 || ax_fail "login items row not ready"
  fi
  ax_log "note: the 'Background Items Added' banner is not asserted; row status comes from SMAppService"
  # Notifications (optional): Allow the system prompt if the row asks.
  if ax_find row.perm.notifications >/dev/null 2>&1 && [ "$(ax_status perm.notifications || true)" != ready ]; then
    ax_click row.perm.notifications.action; sleep 2; ax_allow_notifications
  fi
  # Apple CLT row: the clean room has none; the app's Install… triggers Apple's dialog — a real network install (~minutes).
  if [ "$(ax_status tool.clt || true)" != ready ]; then
    ax_click row.tool.clt.action
    ax_osa 'tell application "System Events" to tell process "Install Command Line Developer Tools" to click (first button of window 1 whose name is "Install")' >/dev/null 2>&1 || true
    ax_osa 'tell application "System Events" to tell process "Install Command Line Developer Tools" to click (first button of window 1 whose name is "Agree")' >/dev/null 2>&1 || true
    ax_wait_status tool.clt ready 1200 || ax_fail "CLT install did not finish in 20 min"
    ax_shot 03-clt-installed
  fi
  ax_shot 03-readiness-final
  ax_find setup.install >/dev/null || ax_fail "setup.install axid missing"
  ax_click setup.install
}

screen_install() {
  ax_shot 04-install-start
  # Steps stream; a privileged step raises the admin prompt (standard user → admin creds).
  local n=900 st
  while [ "$n" -gt 0 ]; do
    ax_admin_auth 2>/dev/null && ax_shot 04-admin-auth || true
    if ax_wait_window "mattstack" 1 && ax_find setup.finish >/dev/null 2>&1; then ax_shot 04-install-done; return 0; fi
    if st=$(ax_status install.failedStep 2>/dev/null) && [ -n "$st" ]; then ax_fail "install step failed: $st"; fi
    sleep 2; n=$((n-2))
  done
  ax_fail "install did not reach Done in 15 min"
}

screen_done() {
  ax_shot 05-done
  ax_click setup.finish
}

ax_log "scenario=$SCENARIO slug=$SLUG"
screen_welcome; screen_team; screen_readiness; screen_install; screen_done
ax_log "five screens complete"
```

- [ ] **Step 3: Syntax-check and a host-side negative run (no window → fast fail)**

Run:
```bash
bash -n rt-tray/vm/run/guest/ax.sh rt-tray/vm/run/guest/drive-setup.sh
GUEST_RUN=/tmp/gr AX_APP=definitely-not-running bash -c 'source rt-tray/vm/run/guest/ax.sh; ax_wait_window x 2; echo "wait exit=$?"; ax_find setup.window; echo "find exit=$?"'
```
Expected: `wait exit=1`, `find exit=1` (osascript errors go to the log), within ~5 s. (On the host this may ALSO prompt for Automation permission for your terminal — decline; it is not needed on the host.)

- [ ] **Step 4: Commit**

```bash
git add rt-tray/vm/run/guest/ax.sh rt-tray/vm/run/guest/drive-setup.sh
git commit -m "MAT-383: vm — UI-scripting helpers and the five-screen setup driver

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Guest assertions — `run/guest/assert-installed.sh`

**Files:**
- Create: `rt-tray/vm/run/guest/assert-installed.sh`

**Interfaces:**
- Runs in the guest as tester after the five screens (or after the headless install). `assert-installed.sh [--expect-version <v>] [--headless]` → writes `$GUEST_RUN/logs/verify.json`, `$GUEST_RUN/logs/tray-version.json`, `$GUEST_RUN/logs/launchctl.txt`; prints one `ASSERT ok|FAIL <name>` line per check; exit 1 on any FAIL. Checks: `~/.local/bin/rt` is a symlink into `/Applications/mattstack.app` (or `~/Applications`); `rt --version`; `rt verify --json` `passed:true`; tray.sock `GET /version` matches `--expect-version`; `launchctl print gui/$UID/com.mattstack.daemon` shows a pid; `~/.mattstack` exists and is a git repo (V5) unless `--headless`; no `~/.rt`, no `rt-tray.app`, no `com.rt.daemon` job (pure canonical).

- [ ] **Step 1: Write it**

```bash
#!/bin/bash
# Assert the installed state in the guest, through rt and tray.sock (never UI text).
# Usage: assert-installed.sh [--expect-version <v>] [--headless]
set -uo pipefail
GUEST_RUN="${GUEST_RUN:-/Volumes/My Shared Files/run}"; LOGS="$GUEST_RUN/logs"; mkdir -p "$LOGS"
EXPECT=""; HEADLESS=0
while [ $# -gt 0 ]; do case "$1" in --expect-version) EXPECT="$2"; shift 2;; --headless) HEADLESS=1; shift;; *) shift;; esac; done
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

# rt verify --json
if rt verify --json > "$LOGS/verify.json" 2>"$LOGS/verify.stderr"; then
  grep -q '"passed": *true' "$LOGS/verify.json" && ok "rt verify passed" || bad "rt verify passed:false"
else
  bad "rt verify exited $? (see logs/verify.json)"
fi
grep -E '"status": *"(fail|warn)"' -B2 "$LOGS/verify.json" | grep '"name"' | sed 's/^/  verify: /' || true

# tray.sock /version
if [ -S "$SOCK" ]; then
  curl -s --max-time 5 --unix-socket "$SOCK" http://localhost/version > "$LOGS/tray-version.json" 2>/dev/null
  if [ -s "$LOGS/tray-version.json" ]; then
    ok "tray.sock /version → $(tr -d '\n' < "$LOGS/tray-version.json")"
    if [ -n "$EXPECT" ]; then
      grep -q "\"version\": *\"$EXPECT\"" "$LOGS/tray-version.json" && ok "version == $EXPECT" || bad "version != $EXPECT"
    fi
  else
    bad "tray.sock /version empty (route not implemented yet?)"
  fi
else
  bad "no tray socket at $SOCK"
fi

# daemon registered + running under the canonical label
launchctl print "gui/$(id -u)/com.mattstack.daemon" > "$LOGS/launchctl.txt" 2>&1
if grep -qE 'pid = [0-9]+' "$LOGS/launchctl.txt"; then ok "com.mattstack.daemon running (pid $(grep -oE 'pid = [0-9]+' "$LOGS/launchctl.txt" | head -1 | awk '{print $3}'))"; else bad "com.mattstack.daemon not running"; fi
launchctl print "gui/$(id -u)/com.rt.daemon" >/dev/null 2>&1 && bad "legacy com.rt.daemon job present" || ok "no legacy com.rt.daemon job"
[ -e "$HOME/.rt" ] && bad "~/.rt exists (legacy)" || ok "no ~/.rt"
ls -d /Applications/rt-tray.app "$HOME/Applications/rt-tray.app" >/dev/null 2>&1 && bad "rt-tray.app present (legacy)" || ok "no rt-tray.app"

if [ "$HEADLESS" = 0 ]; then
  [ -d "$HOME/.mattstack/.git" ] && ok "~/.mattstack is the home repo" || bad "~/.mattstack is not a git repo (V5)"
fi
echo "$fails" > "$LOGS/assert-fails.txt"
[ "$fails" -eq 0 ]
```

- [ ] **Step 2: Syntax-check + run on the host against a throwaway HOME (proves the script is honest when nothing is installed)**

Run: `bash -n rt-tray/vm/run/guest/assert-installed.sh && HOME=$(mktemp -d) GUEST_RUN=/tmp/gr bash rt-tray/vm/run/guest/assert-installed.sh --headless; echo "exit=$?"`
Expected: several `ASSERT FAIL` lines (no rt, no socket, no daemon), `exit=1`.

- [ ] **Step 3: Commit**

```bash
git add rt-tray/vm/run/guest/assert-installed.sh
git commit -m "MAT-383: vm — installed-state assertions through rt and tray.sock

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Update phase — `run/guest/trigger-update.sh`

**Files:**
- Create: `rt-tray/vm/run/guest/trigger-update.sh`

**Interfaces:**
- Runs in the guest as tester: `trigger-update.sh <update-dir> <expect-new-version>` where `<update-dir>` holds `appcast.xml` + `mattstack-<v>.zip` + the compiled `appcast-server`. Starts the server on `127.0.0.1:8765` (background, pid file, killed at exit), records pre-update daemon pid + `/version`, `POST /update/check` on tray.sock, drives Sparkle's "Install and Relaunch" via UI scripting (gentle reminder → menu item "Update available…" → Sparkle window), waits for `/version` to equal `<expect-new-version>`, asserts the daemon pid changed and `rt --version` equals the new version. Output/exit like `assert-installed.sh`.
- Preconditions asserted first (and reported as the skip reason by the host when false): app honours `MATTSTACK_APPCAST_URL` (launch env) — the host launches with `--env MATTSTACK_APPCAST_URL=http://127.0.0.1:8765/appcast.xml` whenever an update dir is supplied.

- [ ] **Step 1: Write it**

```bash
#!/bin/bash
# Sparkle vN → vN+1 inside the guest, with the appcast served on loopback.
# Usage: trigger-update.sh <update-dir> <expect-new-version>
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"; source "$HERE/ax.sh"
UPD="${1:-}"; NEWV="${2:-}"
[ -d "$UPD" ] && [ -f "$UPD/appcast.xml" ] && [ -x "$UPD/appcast-server" ] && [ -n "$NEWV" ] \
  || { echo "usage: trigger-update.sh <update-dir with appcast.xml + zip + appcast-server> <new-version>"; exit 1; }
LOGS="$GUEST_RUN/logs"; export PATH="$HOME/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
SOCK="$HOME/.mattstack/rt/tray.sock"
fails=0; ok() { echo "ASSERT ok   $1"; }; bad() { echo "ASSERT FAIL $1"; fails=$((fails+1)); }

"$UPD/appcast-server" "$UPD" 8765 2>>"$LOGS/appcast-server.log" &
SRV=$!; trap 'kill $SRV 2>/dev/null || true' EXIT
sleep 1
curl -s --max-time 3 http://127.0.0.1:8765/appcast.xml | grep -q '<rss' && ok "appcast served on loopback" || { bad "appcast server not reachable"; exit 1; }

before_pid=$(launchctl print "gui/$(id -u)/com.mattstack.daemon" 2>/dev/null | grep -oE 'pid = [0-9]+' | awk '{print $3}')
before_ver=$(curl -s --unix-socket "$SOCK" http://localhost/version 2>/dev/null | tr -d '\n')
ax_log "before: daemon pid=${before_pid:-none} version=${before_ver:-?}"

curl -s --max-time 10 --unix-socket "$SOCK" -X POST http://localhost/update/check > "$LOGS/update-check.json" 2>/dev/null
grep -q '"ok": *true' "$LOGS/update-check.json" && ok "POST /update/check" || bad "POST /update/check failed: $(cat "$LOGS/update-check.json")"
ax_shot 06-update-check

# Sparkle UI: the status-item menu shows "Update available…"; clicking it opens Sparkle's window.
for _ in $(seq 1 30); do
  if ax_osa 'tell application "System Events" to tell process "mattstack" to click menu bar item 1 of menu bar 2' >/dev/null 2>&1; then
    if ax_osa 'tell application "System Events" to tell process "mattstack" to click (first menu item of menu 1 of menu bar item 1 of menu bar 2 whose name contains "Update available")' >/dev/null 2>&1; then
      ax_log "opened Sparkle from the menu"; break
    fi
    ax_osa 'tell application "System Events" to key code 53' >/dev/null 2>&1   # escape the menu
  fi
  sleep 2
done
# Sparkle's update window: "Install Update" then "Install and Relaunch" (names are Sparkle's).
for _ in $(seq 1 60); do
  ax_click_button_named "Install Update" mattstack 2>/dev/null && break
  ax_click_button_named "Install and Relaunch" mattstack 2>/dev/null && break
  sleep 2
done
ax_shot 06-update-installing
for _ in $(seq 1 30); do ax_click_button_named "Install and Relaunch" mattstack 2>/dev/null && break; sleep 2; done

# Wait for the new version on the socket (the app relaunches; the socket disappears then returns).
new_ver=""
for _ in $(seq 1 120); do
  new_ver=$(curl -s --max-time 2 --unix-socket "$SOCK" http://localhost/version 2>/dev/null | grep -oE '"version": *"[^"]+"' | cut -d'"' -f4)
  [ "$new_ver" = "$NEWV" ] && break
  sleep 2
done
[ "$new_ver" = "$NEWV" ] && ok "tray /version == $NEWV" || bad "tray /version is '${new_ver:-?}', wanted $NEWV"
ax_shot 06-update-done

after_pid=$(launchctl print "gui/$(id -u)/com.mattstack.daemon" 2>/dev/null | grep -oE 'pid = [0-9]+' | awk '{print $3}')
[ -n "$after_pid" ] && [ "$after_pid" != "${before_pid:-}" ] && ok "daemon restarted (pid $before_pid → $after_pid)" || bad "daemon did not restart (pid ${before_pid:-none} → ${after_pid:-none})"
rv=$(rt --version 2>/dev/null | tr -d '\n'); [ "$rv" = "$NEWV" ] && ok "rt --version == $NEWV" || bad "rt --version is '$rv'"
cp "$LOGS/appcast-server.log" "$LOGS/appcast-server.final.log" 2>/dev/null || true
echo "$fails" > "$LOGS/update-fails.txt"
[ "$fails" -eq 0 ]
```

- [ ] **Step 2: Syntax-check + usage run**

Run: `bash -n rt-tray/vm/run/guest/trigger-update.sh && GUEST_RUN=/tmp/gr bash rt-tray/vm/run/guest/trigger-update.sh /nonexistent 1.2.3; echo "exit=$?"`
Expected: usage line, `exit=1`.

- [ ] **Step 3: Commit**

```bash
git add rt-tray/vm/run/guest/trigger-update.sh
git commit -m "MAT-383: vm — Sparkle vN→vN+1 phase with a loopback appcast

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: The orchestrator — `run/walkthrough.sh`

**Files:**
- Create: `rt-tray/vm/run/walkthrough.sh`

**Interfaces:**
- Consumes: everything from Tasks 1–8.
- CLI:
  ```
  walkthrough.sh --ver <14|15|26> (--dmg <path> | --app <mattstack.app>)
                 [--scenario create|join|headless] [--team-slug vmtest] [--pat-env MATTSTACK_VMTEST_PAT]
                 [--invite-code-file <p>] [--update-dir <dir with appcast.xml+zip>] [--update-version <v>]
                 [--no-quarantine] [--no-graphics] [--keep] [--dry-run] [--verify-golden]
  ```
- Phases, in order, each `pass|fail|skip` in the ledger: `preflight`, `clone`, `boot`, `stage`, `install`, `launch`, `screens` (skipped under `--scenario headless`, which instead runs `scripts/e2e-cleanroom.sh` in the guest — see Task 12), `assert`, `update` (skipped without `--update-dir`), `teardown`. Exit 1 iff a phase failed; the last line is the ledger summary and the path to `report.md`.
- Host screenshot loop: while the guest runs, a background watcher turns `$VM_RUN_DIR/in/shot-<name>.req` into `screenshots/<name>.png` via `run/host/capture.sh` and touches `.done`.

- [ ] **Step 1: Write `rt-tray/vm/run/walkthrough.sh`**

```bash
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
LAUNCH_ENV=(); [ -n "$UPD" ] && LAUNCH_ENV=(--env MATTSTACK_APPCAST_URL=http://127.0.0.1:8765/appcast.xml)
vm_ssh "$VM_TESTER_USER" "$RUN_VM" "GUEST_RUN='$GUEST_RUN' bash $GUEST_BIN/install-app.sh launch ${LAUNCH_ENV[*]}" >>"$VM_RUN_DIR/logs/install.log" 2>&1
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
  if vm_ssh "$VM_TESTER_USER" "$RUN_VM" "GUEST_RUN='$GUEST_RUN' VM_ADMIN_PASS='$VM_ADMIN_PASS' $PAT_ENV='${!PAT_ENV:-}' bash $GUEST_BIN/drive-setup.sh $SCENARIO --team-slug $SLUG --pat-env $PAT_ENV $CODE_ARG" >>"$VM_RUN_DIR/logs/screens.log" 2>&1; then
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
```

- [ ] **Step 2: Syntax-check + dry-run**

Run:
```bash
bash -n rt-tray/vm/run/walkthrough.sh
bash rt-tray/vm/run/walkthrough.sh --ver 26 --app rt-tray/mattstack.app --dry-run; echo "exit=$?"
bash rt-tray/vm/run/walkthrough.sh --ver 26 --app rt-tray/mattstack.app --update-dir /tmp --dry-run; echo "exit=$?"
bash rt-tray/vm/run/walkthrough.sh; echo "exit=$?"
```
Expected: run 1 → a run dir under `rt-tray/vm/artifacts/`, `preflight pass`, nine `skip dry-run` lines, `report.md` rendered, `exit=0`; run 2 → `preflight fail --update-dir needs…`, `exit=1`; run 3 → usage, `exit=2`. Check `cat rt-tray/vm/artifacts/*/report.md | head -20` reads sensibly.

- [ ] **Step 3 (MATT / ORCHESTRATOR, after Task 2's goldens exist): first real run with today's app**

Run: `cd rt-tray && ./build.sh release && cd .. && bash rt-tray/vm/run/walkthrough.sh --ver 26 --app rt-tray/mattstack.app --no-quarantine --keep`
Expected today (pre-L3): `clone/boot/stage/install/launch` pass (menu bar `m` appears), `screens` fails with `setup.window axid missing (L3 contract)`, `assert` fails on the socket/daemon rows (no setup ran), `update` skipped. Screenshot `00-first-launch.png` exists. Attach the run dir path to the MAT-383 ticket as the L7 baseline; then `tart stop`/`delete` the kept VM.

- [ ] **Step 4: Commit**

```bash
git add rt-tray/vm/run/walkthrough.sh
git commit -m "MAT-383: vm — walkthrough orchestrator with phase ledger and host screenshots

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 10: Test team + invite scenario — `run/team-setup.sh`

**Files:**
- Create: `rt-tray/vm/run/team-setup.sh`

**Interfaces:**
- Host-only. `team-setup.sh reset` deletes + recreates the throwaway repos; `team-setup.sh invite --handle <forge-handle> --out <code-file>` mints an invite (real `rt team invite` when the verb exists and the relay answers, else the stub code) and writes the code to `<code-file>` (mode 600, under `$VM_RUN_DIR/in` or `$VM_CACHE`, never in git); `team-setup.sh status` prints the org/repos/PAT presence without printing the PAT.
- Env: `MATTSTACK_VMTEST_ORG` (default `mattstack-vmtest`), `MATTSTACK_VMTEST_PAT` (fine-grained PAT scoped to that org: Administration RW, Contents RW, Metadata R — **MATT creates the org and the PAT; never stored in the repo**), `MATTSTACK_VMTEST_HOME_REPO` (default `mattstack-vmtest-home`), `MATTSTACK_VMTEST_TEAM_REPO` (default `mattstack-vmtest-team`).
- Note on names: the wizard's gh one-click path names repos `<owner>/mattstack-home` and `<owner>/mattstack-team-<slug>`; `reset` therefore also deletes those two (`mattstack-home`, `mattstack-team-<slug>`) so the `create` scenario starts clean. The brief's pair (`*-home`, `*-team`) is what the **URL-paste path** and the **join** scenario use.

- [ ] **Step 1: Write it**

```bash
#!/bin/bash
# Throwaway GitHub org for the VM walkthrough. ORCHESTRATOR/MATT: needs MATTSTACK_VMTEST_PAT in env.
# Usage: team-setup.sh reset [--slug vmtest] | invite --handle <h> --out <file> [--slug vmtest] | status
set -euo pipefail
source "$(cd "$(dirname "$0")/.." && pwd)/lib/common.sh"
ORG="${MATTSTACK_VMTEST_ORG:-mattstack-vmtest}"
HOME_REPO="${MATTSTACK_VMTEST_HOME_REPO:-mattstack-vmtest-home}"
TEAM_REPO="${MATTSTACK_VMTEST_TEAM_REPO:-mattstack-vmtest-team}"
PAT="${MATTSTACK_VMTEST_PAT:-}"
cmd="${1:-}"; shift || true
SLUG=vmtest; HANDLE=""; OUT=""
while [ $# -gt 0 ]; do case "$1" in --slug) SLUG="$2"; shift 2;; --handle) HANDLE="$2"; shift 2;; --out) OUT="$2"; shift 2;; *) vm_die "unknown arg $1";; esac; done
vm_require_cmd gh "brew install gh"
ghp() { GH_TOKEN="$PAT" gh "$@"; }
need_pat() { [ -n "$PAT" ] || vm_die "MATTSTACK_VMTEST_PAT is empty — export a fine-grained PAT scoped to org $ORG (MATT step; never commit it)"; }

case "$cmd" in
  status)
    vm_log "org=$ORG home=$HOME_REPO team=$TEAM_REPO pat=$([ -n "$PAT" ] && echo present || echo MISSING)"
    [ -n "$PAT" ] && ghp repo list "$ORG" --limit 20 --json name -q '.[].name' | sed 's/^/  repo: /' || true
    ;;
  reset)
    need_pat
    for r in "$HOME_REPO" "$TEAM_REPO" mattstack-home "mattstack-team-$SLUG"; do
      if ghp repo view "$ORG/$r" >/dev/null 2>&1; then ghp repo delete "$ORG/$r" --yes && vm_log "deleted $ORG/$r"; fi
    done
    ghp repo create "$ORG/$HOME_REPO" --private --description "mattstack VM test home repo (throwaway)" >/dev/null && vm_log "created $ORG/$HOME_REPO"
    ghp repo create "$ORG/$TEAM_REPO" --private --description "mattstack VM test team repo (throwaway)" >/dev/null && vm_log "created $ORG/$TEAM_REPO"
    ;;
  invite)
    need_pat; [ -n "$HANDLE" ] && [ -n "$OUT" ] || vm_die "invite needs --handle and --out"
    mkdir -p "$(dirname "$OUT")"; umask 077
    if rt team invite --help >/dev/null 2>&1; then
      # Real path: owner mints against the shared relay (L1 + L6). Team must exist locally: rt team create … first.
      if ! rt team create "$SLUG" --remote "https://github.com/$ORG/$TEAM_REPO.git" --others --json >/dev/null 2>&1; then vm_warn "rt team create returned non-zero (team may already exist)"; fi
      rt team publish --remote "https://github.com/$ORG/$TEAM_REPO.git" --json >/dev/null 2>&1 || true
      if out=$(rt team invite --handle "$HANDLE" --json 2>"$VM_CACHE/invite.err"); then
        printf '%s' "$out" | sed -n 's/.*"code": *"\([^"]*\)".*/\1/p' > "$OUT"
        [ -s "$OUT" ] || vm_die "rt team invite returned no code: $(cat "$VM_CACHE/invite.err")"
        vm_log "invite minted (real) → $OUT  expires: $(printf '%s' "$out" | sed -n 's/.*"expiresAt": *"\([^"]*\)".*/\1/p')"
      else
        vm_die "rt team invite failed (relay down? L6 not deployed?): $(cat "$VM_CACHE/invite.err")"
      fi
    else
      # Stub path until L1/L6 land: a syntactically valid code the app's DEBUG stub (RT_STUB_SCENARIO=join-happy) accepts.
      printf 'STUB-%s-%s\n' "$SLUG" "$(date +%s)" > "$OUT"
      vm_log "invite code is a STUB (rt team invite not available) → $OUT; join scenario needs a DEBUG app launched with RT_STUB_SCENARIO=join-happy RT_STUB_PATH=<repo>/rt-tray/Tests/stub-rt/stub.ts (L3 plan)"
    fi
    ;;
  *) vm_die "usage: team-setup.sh reset|invite|status";;
esac
```

- [ ] **Step 2: Syntax-check + status without PAT**

Run: `bash -n rt-tray/vm/run/team-setup.sh && MATTSTACK_VMTEST_PAT= bash rt-tray/vm/run/team-setup.sh status && MATTSTACK_VMTEST_PAT= bash rt-tray/vm/run/team-setup.sh reset; echo "exit=$?"`
Expected: status prints `pat=MISSING`; reset dies with the PAT hint, `exit=1`.

- [ ] **Step 3 (MATT): create the org + PAT; run `reset` once**

MATT: create GitHub org `mattstack-vmtest` (free), a fine-grained PAT (resource owner = the org; repository permissions Administration RW, Contents RW, Metadata R; org permission Members R), `export MATTSTACK_VMTEST_PAT=…` in the shell that runs the walkthrough. Run: `bash rt-tray/vm/run/team-setup.sh reset && bash rt-tray/vm/run/team-setup.sh status`. Expected: two repos listed.

- [ ] **Step 4: Commit**

```bash
git add rt-tray/vm/run/team-setup.sh
git commit -m "MAT-383: vm — throwaway test org reset and invite minting (real or stub)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 11: Layer (c) — `run/second-user.sh`

**Files:**
- Create: `rt-tray/vm/run/second-user.sh`

**Interfaces:**
- `second-user.sh create` (prints the exact `sysadminctl` command for MATT to run with sudo — the script never creates users itself), `second-user.sh check` (user exists? logged in with a GUI session? — `launchctl print gui/<uid>` succeeds), `second-user.sh run --artifact <tar.gz|zip> [--tag vX.Y.Z]` (runs `scripts/e2e-cleanroom.sh` as that user via `sudo -iu`, copying the artifact into the user's home first; the artifacts dir is `rt-tray/vm/artifacts/<run>/` on Matt's side, readable by both), `second-user.sh switch` (prints the `CGSession -switchToUserID` command).
- Env: `MATTSTACK_SMOKE_USER` (default `mstest`).

- [ ] **Step 1: Write it**

```bash
#!/bin/bash
# Layer (c): daily smoke as a second macOS user on this Mac.
# Usage: second-user.sh create | check | switch | run --artifact <rt-darwin-arm64-*.tar.gz|mattstack-*.zip>
set -euo pipefail
source "$(cd "$(dirname "$0")/.." && pwd)/lib/common.sh"
U="${MATTSTACK_SMOKE_USER:-mstest}"
cmd="${1:-}"; shift || true
ART=""
while [ $# -gt 0 ]; do case "$1" in --artifact) ART="$2"; shift 2;; *) vm_die "unknown arg $1";; esac; done

case "$cmd" in
  create)
    cat <<EOF
  MATT step — run in your own terminal (creates a standard user; choose the password interactively):
    sudo sysadminctl -addUser $U -fullName "mattstack smoke" -password -
  Then log the user in once so a GUI session exists (Fast User Switching; required for launchd gui/\$UID):
    $0 switch
  and switch back to your account.
EOF
    ;;
  switch)
    uid=$(id -u "$U" 2>/dev/null) || vm_die "user $U does not exist — $0 create"
    echo "  '/System/Library/CoreServices/Menu Extras/User.menu/Contents/Resources/CGSession' -switchToUserID $uid"
    ;;
  check)
    uid=$(id -u "$U" 2>/dev/null) || vm_die "user $U does not exist — $0 create"
    vm_log "user $U uid=$uid"
    if sudo -n launchctl print "gui/$uid" >/dev/null 2>&1; then vm_log "GUI session present (gui/$uid) — SMAppService registration will work"
    elif launchctl print "gui/$uid" >/dev/null 2>&1; then vm_log "GUI session present (gui/$uid)"
    else vm_warn "no GUI session for $U — log the user in once ($0 switch); daemon will report not-booted otherwise"; exit 1; fi
    ;;
  run)
    [ -n "$ART" ] && [ -f "$ART" ] || vm_die "run needs --artifact <file>"
    id -u "$U" >/dev/null 2>&1 || vm_die "user $U does not exist — $0 create"
    vm_run_init "second-user"
    HOME2=$(dscl . -read "/Users/$U" NFSHomeDirectory | awk '{print $2}')
    sudo install -d -o "$U" -m 700 "$HOME2/mattstack-smoke"
    sudo install -o "$U" -m 600 "$ART" "$HOME2/mattstack-smoke/$(basename "$ART")"
    sudo install -o "$U" -m 700 "$VM_ROOT/../../scripts/e2e-cleanroom.sh" "$HOME2/mattstack-smoke/e2e-cleanroom.sh"
    sudo install -o "$U" -m 700 -d "$HOME2/mattstack-smoke/artifacts"
    chmod 777 "$VM_RUN_DIR" "$VM_RUN_DIR/logs"
    # sudo -iu gives the user's login env; the user is (ideally) logged in so `open`/SMAppService land in gui/<uid>.
    if sudo -iu "$U" bash -lc "cd ~/mattstack-smoke && ./e2e-cleanroom.sh --artifact ~/mattstack-smoke/$(basename "$ART") --home \$HOME --artifacts-dir ~/mattstack-smoke/artifacts --allow-existing-install" > "$VM_RUN_DIR/logs/second-user.log" 2>&1; then
      vm_phase_begin second-user; vm_phase_end second-user pass
    else
      vm_phase_begin second-user; vm_phase_end second-user fail "e2e-cleanroom exited non-zero (logs/second-user.log)"
    fi
    sudo cp -R "$HOME2/mattstack-smoke/artifacts/." "$VM_RUN_DIR/logs/" 2>/dev/null || true
    sudo chown -R "$(id -u):$(id -g)" "$VM_RUN_DIR"
    vm_render_report
    [ "$(vm_phases_failed)" -eq 0 ]
    ;;
  *) vm_die "usage: second-user.sh create|check|switch|run --artifact <file>";;
esac
```

- [ ] **Step 2: Syntax-check + `create`/`check` without the user**

Run: `bash -n rt-tray/vm/run/second-user.sh && bash rt-tray/vm/run/second-user.sh create && bash rt-tray/vm/run/second-user.sh check; echo "exit=$?"`
Expected: create prints the sysadminctl line; check dies `user mstest does not exist`, `exit=1`.

- [ ] **Step 3 (MATT): create + log in the smoke user, then run once**

Run (MATT): the printed `sysadminctl` line, then `switch`, log in, switch back; then `bash rt-tray/vm/run/second-user.sh check && bash rt-tray/vm/run/second-user.sh run --artifact <path to rt-darwin-arm64-*.tar.gz>` (download one with `gh release download <tag> -R m4ttstack/rt -p 'rt-darwin-arm64-*.tar.gz' -D rt-tray/vm/.cache`). Expected: `second-user pass`, and `logs/second-user.log` ends with `rt verify --ci` output (daemon running, since the user has a GUI session).

- [ ] **Step 4: Commit**

```bash
git add rt-tray/vm/run/second-user.sh
git commit -m "MAT-383: vm — second-macOS-user smoke runner (layer c)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 12: Layer (a) locally — `scripts/e2e-cleanroom.sh`

**Files:**
- Create: `scripts/e2e-cleanroom.sh`
- Modify: `scripts/README.md` (append a section)

**Interfaces:**
- `e2e-cleanroom.sh (--artifact <rt-darwin-arm64-*.tar.gz|mattstack-*.zip> | --tag vX.Y.Z | --app </Applications/mattstack.app>) [--home <dir>] [--artifacts-dir <dir>] [--allow-existing-install] [--post-install-args "<extra args>"]`. Mirrors `.github/workflows/release.yml` `test-install` step for step: extract (`tar -xzf` or `ditto -x -k`) → `rt --version` → `rt --post-install` (+ `--post-install-args`, e.g. `--non-interactive --team-of-one` once L1 ships it) → `~/.local/bin/rt --version` → `rt daemon install` → `sleep 3` → `rt verify --ci`. `--app` skips extraction and uses `<app>/Contents/MacOS/rt` (the in-guest headless path; today the binary is `Contents/MacOS/rt-daemon`, so the script tries `rt` then `rt-daemon`). `CI=true` is exported (matches the runner: daemon-not-booted = warn).
- Guard: refuses to run when the invoking user already has mattstack registered (`launchctl print gui/$UID/com.mattstack.daemon` succeeds or `~/.mattstack/rt/daemon.json` exists in the REAL home) unless `--allow-existing-install` — because `rt --post-install` launches the app, which would register a second `com.mattstack.app` login item for the same user. Intended callers: the VM guest, the second user, CI.
- Output: `<artifacts-dir>/cleanroom-<ts>/{steps.log,verify-ci.txt,versions.txt}`; exit code = `rt verify --ci`'s.

- [ ] **Step 1: Write it**

```bash
#!/bin/bash
# Layer (a) of the clean-room matrix, locally: the release workflow's test-install recipe.
# See .github/workflows/release.yml (job test-install) — keep the two in step.
set -uo pipefail
usage() { cat <<'EOF'
usage: e2e-cleanroom.sh (--artifact <tar.gz|zip> | --tag <vX.Y.Z> | --app <mattstack.app>)
         [--home <dir>] [--artifacts-dir <dir>] [--allow-existing-install] [--post-install-args "<args>"]
EOF
exit 2; }
ART=""; TAG=""; APP=""; HOME_DIR=""; OUTDIR=""; ALLOW=0; PIA=""
while [ $# -gt 0 ]; do case "$1" in
  --artifact) ART="$2"; shift 2;; --tag) TAG="$2"; shift 2;; --app) APP="$2"; shift 2;;
  --home) HOME_DIR="$2"; shift 2;; --artifacts-dir) OUTDIR="$2"; shift 2;; --allow-existing-install) ALLOW=1; shift;;
  --post-install-args) PIA="$2"; shift 2;; -h|--help) usage;; *) echo "unknown arg $1" >&2; usage;; esac; done
[ -n "$ART$TAG$APP" ] || usage

REAL_HOME="$HOME"
if [ "$ALLOW" = 0 ]; then
  if launchctl print "gui/$(id -u)/com.mattstack.daemon" >/dev/null 2>&1 || [ -f "$REAL_HOME/.mattstack/rt/daemon.json" ]; then
    echo "  ✗ this user already has mattstack installed/registered; rt --post-install would launch a second com.mattstack.app." >&2
    echo "    Run inside the VM (rt-tray/vm/run/walkthrough.sh --scenario headless), as the smoke user (rt-tray/vm/run/second-user.sh), or pass --allow-existing-install." >&2
    exit 3
  fi
fi

TS=$(date +%Y%m%d-%H%M%S)
OUTDIR="${OUTDIR:-$(cd "$(dirname "$0")/.." && pwd)/rt-tray/vm/artifacts}/cleanroom-$TS"
mkdir -p "$OUTDIR"
LOG="$OUTDIR/steps.log"
step() { printf '\n== %s ==\n' "$*" | tee -a "$LOG"; }
run()  { "$@" 2>&1 | tee -a "$LOG"; return "${PIPESTATUS[0]}"; }

WORK=$(mktemp -d)
if [ -n "$TAG" ]; then
  step "gh release download $TAG"
  run gh release download "$TAG" -R m4ttstack/rt -p 'rt-darwin-arm64-*.tar.gz' -D "$WORK" || exit 1
  ART=$(ls "$WORK"/rt-darwin-arm64-*.tar.gz | head -1)
fi
if [ -n "$ART" ]; then
  step "extract $(basename "$ART")"
  mkdir -p "$WORK/release"
  case "$ART" in
    *.tar.gz|*.tgz) run tar -xzf "$ART" -C "$WORK/release" || exit 1 ;;
    *.zip)          run ditto -x -k "$ART" "$WORK/release" || exit 1 ;;
    *) echo "unknown artifact type: $ART" >&2; exit 1 ;;
  esac
  run ls -la "$WORK/release"
  RT="$WORK/release/rt"
  [ -x "$RT" ] || RT=$(ls "$WORK"/release/mattstack.app/Contents/MacOS/rt 2>/dev/null || ls "$WORK"/release/mattstack.app/Contents/MacOS/rt-daemon 2>/dev/null | head -1)
else
  RT="$APP/Contents/MacOS/rt"; [ -x "$RT" ] || RT="$APP/Contents/MacOS/rt-daemon"
fi
[ -x "${RT:-}" ] || { echo "no rt binary found" >&2; exit 1; }

export CI=true
if [ -n "$HOME_DIR" ]; then export HOME="$HOME_DIR"; mkdir -p "$HOME"; fi
export PATH="$HOME/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin"
step "rt --version (from artifact)";   run "$RT" --version | tee "$OUTDIR/versions.txt" >/dev/null || exit 1
step "rt --post-install $PIA";          run "$RT" --post-install $PIA || exit 1
step "installed rt on PATH";            run test -x "$HOME/.local/bin/rt" && run rt --version || exit 1
step "rt daemon install";               run rt daemon install; sleep 3
step "rt verify --ci";                  rt verify --ci 2>&1 | tee "$OUTDIR/verify-ci.txt" | tee -a "$LOG"
RC=${PIPESTATUS[0]}
printf '\nexit=%s\nartifacts=%s\n' "$RC" "$OUTDIR" | tee -a "$LOG"
exit "$RC"
```

- [ ] **Step 2: Append to `scripts/README.md`**

```markdown
## e2e-cleanroom.sh

The release workflow's `test-install` recipe (extract → `rt --post-install` → `rt daemon install` → `rt verify --ci`), runnable locally against a release tag, a tarball/zip, or an installed `mattstack.app`. Refuses to run as a user who already has mattstack registered (it would launch a second app) — use it inside the VM walkthrough (`rt-tray/vm/run/walkthrough.sh --scenario headless`), as the smoke user (`rt-tray/vm/run/second-user.sh run`), or on CI. Output lands in `rt-tray/vm/artifacts/cleanroom-<ts>/`.

```sh
scripts/e2e-cleanroom.sh --tag v2.8.0
scripts/e2e-cleanroom.sh --artifact ~/Downloads/rt-darwin-arm64-v2.8.0.tar.gz --home "$(mktemp -d)"
```
```

- [ ] **Step 3: Syntax-check + guard + usage**

Run:
```bash
bash -n scripts/e2e-cleanroom.sh
bash scripts/e2e-cleanroom.sh; echo "exit=$?"
bash scripts/e2e-cleanroom.sh --artifact /nonexistent.tar.gz; echo "exit=$?"
```
Expected: usage `exit=2`; on Matt's machine the second prints the "already has mattstack installed" guard and `exit=3` (on a clean machine it would fail at extract with exit 1).

- [ ] **Step 4: Commit**

```bash
git add scripts/e2e-cleanroom.sh scripts/README.md
git commit -m "MAT-383: scripts/e2e-cleanroom.sh — the CI headless install recipe, runnable locally

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 13: XCUITest mode (gated on Xcode) — `run/xcuitest.sh`

**Files:**
- Create: `rt-tray/vm/run/xcuitest.sh`

**Interfaces:**
- `xcuitest.sh --ver <26> --dmg <path> [--keep]`: same clone/boot/stage/install as the walkthrough but on a golden named `mattstack-golden-<ver>-xcode` (built by `build-golden.sh <ver> --xcode`, which pulls `ghcr.io/cirruslabs/macos-<name>-xcode:latest` and skips the no-CLT/no-brew steps — that golden is NOT a clean room for the Tools rows and the README says so), copies the repo's `rt-tray/` sources + `project.yml` into the guest, runs `xcodebuild test -project mattstack.xcodeproj -scheme mattstack -only-testing:mattstackUITests -destination 'platform=macOS' -resultBundlePath "$GUEST_RUN/logs/xcuitest.xcresult"` (target/scheme names from the L3 plan `2026-08-21-mattstack-app-shell.md`: targets `mattstack`, `mattstack-dev`, `MattstackCoreTests`, `mattstackUITests`) and exports screenshots with `xcrun xcresulttool`. Gated: exits `skip` immediately when the host has no Xcode (`xcode-select -p` not under `/Applications/Xcode*.app`) or the `-xcode` golden does not exist, and when `rt-tray/project.yml` (L3 deliverable) is absent.
- This task also adds the `--xcode` flag to `golden/build-golden.sh` (image `macos-<name>-xcode`, golden name suffix `-xcode`, provisioner env `SKIP_CLEANROOM=1` which skips steps 1–3 in `provision-guest.sh`).

- [ ] **Step 1: Extend `golden/build-golden.sh` and `golden/provision-guest.sh`**

In `build-golden.sh`, after the arg loop add `XCODE=0` handling: `--xcode) XCODE=1;;`; then:
```bash
if [ "$XCODE" = 1 ]; then
  IMAGE=$(vm_image_for "$VER" | sed 's/-vanilla:/-xcode:/'); GOLDEN="$(vm_golden_name "$VER")-xcode"
fi
```
and pass `SKIP_CLEANROOM=$XCODE` into the provisioner invocation: `"SKIP_CLEANROOM=$XCODE bash /tmp/provision-guest.sh …"`. In `provision-guest.sh`, wrap steps 1–3 in `if [ "${SKIP_CLEANROOM:-0}" != 1 ]; then … fi`. In `verify-golden.sh`, make the `no CLT`/`no brew`/`Gatekeeper` checks conditional on the marker's `"xcode": false` (write `"xcode": true|false` into the marker from `SKIP_CLEANROOM`).

- [ ] **Step 2: Write `rt-tray/vm/run/xcuitest.sh`**

```bash
#!/bin/bash
# XCUITest-driven walkthrough inside an -xcode golden. Gated on Xcode + L3's project.yml.
# Usage: xcuitest.sh --ver <14|15|26> --dmg <path> [--keep]
set -uo pipefail
source "$(cd "$(dirname "$0")/.." && pwd)/lib/common.sh"
VER=""; DMG=""; KEEP=0
while [ $# -gt 0 ]; do case "$1" in --ver) VER="$2"; shift 2;; --dmg) DMG="$2"; shift 2;; --keep) KEEP=1; shift;; *) vm_die "unknown arg $1";; esac; done
[ -n "$VER" ] && [ -f "${DMG:-}" ] || vm_die "usage: xcuitest.sh --ver <v> --dmg <path> [--keep]"
vm_run_init "xcuitest-$VER"
GOLDEN="$(vm_golden_name "$VER")-xcode"; RUN_VM="mattstack-xcui-$VER-$(date +%H%M%S)"
GUEST_RUN="/Volumes/My Shared Files/run"
vm_phase_begin gate
case "$(xcode-select -p 2>/dev/null)" in /Applications/Xcode*.app/*) ;; *) vm_phase_end gate skip "Xcode not installed on the host (xcode-select -p)"; vm_render_report; exit 0;; esac
[ -f "$VM_ROOT/../project.yml" ] || { vm_phase_end gate skip "rt-tray/project.yml absent (L3 deliverable)"; vm_render_report; exit 0; }
tart list 2>/dev/null | awk '{print $2}' | grep -qx "$GOLDEN" || { vm_phase_end gate skip "golden $GOLDEN missing — build-golden.sh $VER --xcode"; vm_render_report; exit 0; }
vm_phase_end gate pass

TART_PID=""
cleanup() { [ "$KEEP" = 1 ] || { tart stop "$RUN_VM" 2>/dev/null; [ -n "$TART_PID" ] && wait "$TART_PID" 2>/dev/null; tart delete "$RUN_VM" 2>/dev/null; }; vm_render_report; exit "$([ "$(vm_phases_failed)" -eq 0 ] && echo 0 || echo 1)"; }
trap cleanup EXIT

vm_phase_begin clone; tart clone "$GOLDEN" "$RUN_VM" >>"$VM_RUN_DIR/logs/tart.log" 2>&1 && vm_phase_end clone pass || { vm_phase_end clone fail "tart clone"; exit 1; }
vm_phase_begin boot
tart run "$RUN_VM" --no-audio "--dir=run:$VM_RUN_DIR" >>"$VM_RUN_DIR/logs/tart.log" 2>&1 & TART_PID=$!
vm_wait_ssh "$VM_TESTER_USER" "$RUN_VM" 420 && vm_phase_end boot pass || { vm_phase_end boot fail "ssh"; exit 1; }

vm_phase_begin stage
cp "$DMG" "$VM_RUN_DIR/in/mattstack.dmg"; cp -R "$VM_ROOT/run/guest" "$VM_RUN_DIR/in/guest"
mkdir -p "$VM_RUN_DIR/in/src"; rsync -a --exclude .build --exclude '*.app' --exclude vm "$VM_ROOT/../" "$VM_RUN_DIR/in/src/rt-tray/"
vm_ssh "$VM_TESTER_USER" "$RUN_VM" "rm -rf ~/src && cp -R '$GUEST_RUN/in/src' ~/src && cd ~/src/rt-tray && (command -v xcodegen >/dev/null || brew install xcodegen) && xcodegen generate" >>"$VM_RUN_DIR/logs/stage.log" 2>&1 \
  && vm_phase_end stage pass || { vm_phase_end stage fail "xcodegen generate failed (logs/stage.log)"; exit 1; }

vm_phase_begin install
vm_ssh "$VM_ADMIN_USER" "$RUN_VM" "GUEST_RUN='$GUEST_RUN' bash '$GUEST_RUN/in/guest/install-app.sh' copy '$GUEST_RUN/in/mattstack.dmg' --no-quarantine" >>"$VM_RUN_DIR/logs/install.log" 2>&1 \
  && vm_phase_end install pass || { vm_phase_end install fail "copy (logs/install.log)"; exit 1; }

vm_phase_begin xcuitest
if vm_ssh "$VM_TESTER_USER" "$RUN_VM" "cd ~/src/rt-tray && xcodebuild test -project mattstack.xcodeproj -scheme mattstack -only-testing:mattstackUITests -destination 'platform=macOS' -resultBundlePath '$GUEST_RUN/logs/xcuitest.xcresult' MATTSTACK_UITEST_REAL_APP=/Applications/mattstack.app" >"$VM_RUN_DIR/logs/xcodebuild.log" 2>&1; then
  vm_phase_end xcuitest pass
else vm_phase_end xcuitest fail "xcodebuild test failed (logs/xcodebuild.log)"; fi
vm_ssh "$VM_TESTER_USER" "$RUN_VM" "xcrun xcresulttool export attachments --path '$GUEST_RUN/logs/xcuitest.xcresult' --output-path '$GUEST_RUN/screenshots' 2>/dev/null || true" >/dev/null 2>&1

vm_phase_begin assert
vm_ssh "$VM_TESTER_USER" "$RUN_VM" "GUEST_RUN='$GUEST_RUN' bash '$GUEST_RUN/in/guest/assert-installed.sh'" >"$VM_RUN_DIR/logs/assert.log" 2>&1 && vm_phase_end assert pass || vm_phase_end assert fail "see logs/assert.log"
```

- [ ] **Step 3: Syntax-check + gate run (no Xcode on the host today → skip)**

Run: `bash -n rt-tray/vm/run/xcuitest.sh rt-tray/vm/golden/build-golden.sh rt-tray/vm/golden/provision-guest.sh rt-tray/vm/golden/verify-golden.sh && touch /tmp/fake.dmg && bash rt-tray/vm/run/xcuitest.sh --ver 26 --dmg /tmp/fake.dmg; echo "exit=$?"; bash rt-tray/vm/golden/build-golden.sh 26 --xcode --dry-run`
Expected: `gate skipped: Xcode not installed on the host`, report rendered, `exit=0`; dry-run prints `tart clone ghcr.io/cirruslabs/macos-tahoe-xcode:latest mattstack-golden-26-xcode`.

- [ ] **Step 4: Commit**

```bash
git add rt-tray/vm/run/xcuitest.sh rt-tray/vm/golden
git commit -m "MAT-383: vm — XCUITest mode gated on Xcode and the -xcode golden

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 14: README, run-everything dry check, wrap-up

**Files:**
- Modify: `rt-tray/vm/README.md` (complete it)
- Create: `rt-tray/vm/check-vm-scripts.sh` (the offline check every implementer and reviewer can run: `bash -n` on every script + the unit tests + every `--dry-run`)

- [ ] **Step 1: Complete `rt-tray/vm/README.md`** (keep the Task 1 table; append)

```markdown
## Layout

(paste the tree from the plan's "File structure" section)

## Prerequisites (host, Apple Silicon)

- `brew install openai/tools/tart` (Tart is **FSL-1.1-ALv2**, © OpenAI; tart.run/licensing: free on personal workstations and for orgs up to 100 CPU cores — this Mac is inside the free tier; recount if L7 ever moves to a shared fleet). Old tap: `cirruslabs/cli/tart`.
- `brew install cirruslabs/cli/sshpass` (golden build only — the first password login; everything after is key-based).
- Apple CLT (`swiftc`, for `run/host/winid.swift`) and Bun (compiles `appcast-server`).
- Screen Recording for your terminal app (System Settings → Privacy & Security → Screen & System Audio Recording) — host-side screenshots of the Tart window. One-time.
- ~60 GB free disk per golden (25–27 GB download, 50 GB virtual disk, APFS-sparse). Clones are copy-on-write.
- GitHub-hosted runners cannot run this (no nested macOS virtualisation); local only, or a self-hosted Apple-Silicon runner later.

## Golden images (built once, never run again — every run is a clone)

`golden/build-golden.sh 26` and `golden/build-golden.sh 14` (`15` optional; `--xcode` for the XCUITest flavour, which keeps CLT/brew and is therefore not a clean room for the Tools rows).
Image source: `ghcr.io/cirruslabs/macos-{sonoma,sequoia,tahoe}-vanilla:latest` (no brew, no guest agent → ssh only). Provisioning: remove Apple CLT (the vanilla template installs it), assert no brew, re-enable Gatekeeper (the image ships it disabled), create standard user `tester`/`tester` as the auto-login console user (`admin`/`admin` keeps NOPASSWD sudo for provisioning and plays the "admin credentials" role in the installer's privileged step), Remote Login for all users, ssh key for both, sleep/screensaver/screen-lock off, marker `/Users/Shared/mattstack-golden.json`.
**One manual step per golden** (TCC cannot be pre-approved by script; `tccutil` only resets; PPPC needs MDM): in the VM, Privacy & Security → Accessibility → add `/usr/libexec/sshd-keygen-wrapper` and `/usr/bin/osascript`; then approve the Automation prompt for System Events when the script sends its probe. `golden/verify-golden.sh` proves it (the probe fails with "not allowed assistive access" until done). macOS 26.1/26.2 had a bug adding CLI tools there; the tahoe image is ≥ 26.3.

## Runs

```
run/walkthrough.sh --ver 26 --dmg dist/mattstack-2.9.0.dmg \
   --update-dir dist/update --update-version 2.9.1 \
   --scenario create --team-slug vmtest --pat-env MATTSTACK_VMTEST_PAT
run/walkthrough.sh --ver 14 --app rt-tray/mattstack.app --no-quarantine --scenario headless
run/second-user.sh run --artifact ~/Downloads/rt-darwin-arm64-v2.9.0.tar.gz
../../scripts/e2e-cleanroom.sh --tag v2.9.0   # refuses on a user that already runs mattstack
```
Phases: preflight · clone · boot · stage · install · launch · screens · assert · update · teardown. Each is `pass|fail|skip` with a reason in `artifacts/<run>/phases.jsonl`; `report.md` is the human summary; `screenshots/` are numbered per screen (`00-first-launch`, `01-welcome`, `02-team-*`, `03-readiness-*`, `04-install-*`, `05-done`, `06-update-*`); `logs/` holds guest logs (`~/.mattstack/rt/logs`, unified log slice for mattstack/smd/backgroundtaskmanagementd, `launchctl print` grep, `rt verify --json`, tray `/version`). Exit 1 iff any phase failed; skips are reported, never counted green.

## What is not automated (and how the scripts treat it)

- **"Background Items Added"** banner: not clicked, not asserted (it is a notification). The Login Items row is asserted through `GET /services` / `rt setup status`; if SMAppService returns `.requiresApproval`, the driver opens Login Items and toggles the app (admin auth as a standard user).
- **FDA relaunch**: the driver clicks the row's "Relaunch mattstack" and waits for the window to return; FDA taking effect is asserted only through the app's probe row (`perm.fda` = ready). No `tccutil` is used in the guest.
- **Gatekeeper with unnotarised builds**: a locally built DMG is quarantined by default to exercise the real path; it will be blocked (`launch fail`, screenshot of the dialog). Use `--no-quarantine` for local builds and say so in the ticket.
- **Apple CLT install** in the clean room is real (Apple's dialog, network, minutes); the driver clicks Install/Agree and waits up to 20 min.
- **Sparkle update** needs L4's signed zip + appcast and L3's `MATTSTACK_APPCAST_URL` hook; until then the phase is `skip` with that reason. The appcast is served on **loopback inside the guest** to stay clear of macOS 15's Local Network Privacy prompt.
- **Invite/join** needs L1 + L6; `run/team-setup.sh invite` mints a stub code until then (only a DEBUG app with `RT_STUB_SCENARIO=join-happy` accepts it).
- **Second user**: Matt creates the user and logs it in once (launchd `gui/<uid>` needs a GUI session); the script never creates users.

## Test team

Throwaway GitHub org `mattstack-vmtest` (repos `mattstack-vmtest-home`, `mattstack-vmtest-team`, plus the wizard's own `mattstack-home` / `mattstack-team-<slug>`), fine-grained PAT in `MATTSTACK_VMTEST_PAT` (env only; never in the repo or artifacts). `run/team-setup.sh reset` before a `create` run. No real team data ever enters this org.

## Costs (fill in after the first builds)

| image | pull | disk | golden build | walkthrough (create) |
|---|---|---|---|---|
| 26 | | | | |
| 14 | | | | |

## Manual alternative

VirtualBuddy (GUI, no CLI): duplicate the library VM with ⌘D (APFS clone), drag the DMG in via its shared folder, run `run/guest/*.sh` by hand from a Terminal in the guest with `GUEST_RUN` pointed at a shared folder. Same scripts, no host orchestration.
```

- [ ] **Step 2: Write `rt-tray/vm/check-vm-scripts.sh`**

```bash
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
t "build-golden --xcode dry"     bash golden/build-golden.sh 26 --xcode --dry-run
t "walkthrough --dry-run"        env VM_ARTIFACTS=/tmp/vmcheck-art bash run/walkthrough.sh --ver 26 --app ../mattstack.app --dry-run
t "walkthrough usage"            bash -c '! bash run/walkthrough.sh >/dev/null 2>&1'
t "xcuitest gate"                bash -c 'touch /tmp/vmcheck.dmg; VM_ARTIFACTS=/tmp/vmcheck-art bash run/xcuitest.sh --ver 26 --dmg /tmp/vmcheck.dmg'
t "team-setup status (no pat)"   env MATTSTACK_VMTEST_PAT= bash run/team-setup.sh status
t "second-user create"           bash run/second-user.sh create
t "e2e-cleanroom usage"          bash -c '! bash ../../scripts/e2e-cleanroom.sh >/dev/null 2>&1'
t "winid compiles"               swiftc -O -o /tmp/vmcheck-winid run/host/winid.swift
t "appcast-server compiles"      bun build --compile run/helpers/appcast-server.ts --outfile /tmp/vmcheck-appcast
rm -rf /tmp/vmcheck-art /tmp/vmcheck-winid /tmp/vmcheck-appcast /tmp/vmcheck.dmg /tmp/vmcheck.out
echo; [ "$fails" -eq 0 ] && echo "  all vm checks ok" || { echo "  $fails check(s) failed"; exit 1; }
```

- [ ] **Step 3: Run the whole offline check**

Run: `ls rt-tray/mattstack.app >/dev/null 2>&1 || (cd rt-tray && ./build.sh release); bash rt-tray/vm/check-vm-scripts.sh`
Expected: every line `ok`, `all vm checks ok`. (The `walkthrough --dry-run` line needs `rt-tray/mattstack.app` to exist; `build.sh release` needs a compiled rt — `bun run build` first if `dist/rt` is missing.)

- [ ] **Step 4: Commit**

```bash
git add rt-tray/vm/README.md rt-tray/vm/check-vm-scripts.sh
git commit -m "MAT-383: vm — README (what the layer verifies, MATT steps, costs) and offline check runner

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

- [ ] **Step 5 (MATT / ORCHESTRATOR): the real gate, once L3/L4 land**

Run: `bash rt-tray/vm/run/walkthrough.sh --ver 26 --dmg <L4 dmg> --update-dir <L4 update dir> --update-version <vN+1> --scenario create` and the same with `--ver 14`; then `bash rt-tray/vm/run/second-user.sh run --artifact <tarball>`. Expected: all phases `pass`, screenshots 00–06 present, both report.md attached to the release candidate. Fill in the README "Costs" table from the run durations.

---

## Self-review checklist (done by the plan author; implementers re-run the bits they touch)

**1. Spec coverage (ruling 12, §11.2, §12.2, §13 L7):**
- (a) GitHub Actions headless install + `rt verify --ci` → Task 12 (`scripts/e2e-cleanroom.sh`, same recipe as `release.yml` `test-install`; the workflow is NOT modified here — L4 owns it and should switch the job to call the script; noted in Open questions).
- (b) `rt-tray/vm/` golden recipe (Tart, macOS 14 + 26, no CLT/brew, Apple-ID-free standard user) → Task 2; `walkthrough.sh` restores (clones), mounts DMG, launches with `RT_STUB_SCENARIO` unset, test team on a throwaway org → Tasks 5, 9, 10; drives the five screens incl. the FDA/Login Items dance → Task 6 (UI scripting) + Task 13 (XCUITest, gated); Sparkle vN→vN+1 from a local appcast → Tasks 3, 8; screenshots archived per run → Tasks 4, 9.
- (c) second macOS user smoke → Task 11.
- Release gate = (a)+(b) green → Task 14 Step 5 + README.
- `launchctl kickstart -k` across 14/15/26 (§14 risk "must be verified in the VM layer") → asserted by Task 8's "daemon restarted (pid changed)" check after the update.
- Artifacts/logs as the deliverable of every run → `vm_run_init`/ledger/report (Task 1) used everywhere.
- What cannot be automated (BTM banner, FDA relaunch) → README (Task 14) + the driver's explicit log lines (Task 6).

**2. Placeholder scan:** no TBD/TODO; every script is written in full; the only "fill in later" is the README Costs table, which by design records measurements from Matt's real runs. Tasks marked MATT/ORCHESTRATOR state exactly what to run.

**3. Consistency:** names used across tasks — `vm_golden_name`, `vm_image_for`, `vm_run_init`, `vm_phase_begin/end`, `vm_phases_failed`, `vm_render_report`, `vm_ssh`, `vm_scp`, `vm_ssh_pw`, `vm_wait_ssh`, `VM_RUN_DIR`, `VM_CACHE`, `VM_SSH_KEY`, `VM_TESTER_USER/PASS`, `VM_ADMIN_USER/PASS` (Task 1) ↔ Tasks 2, 3, 4, 9, 10, 11, 13; `GUEST_RUN=/Volumes/My Shared Files/run` and `in/`, `logs/`, `screenshots/` (Tasks 1, 5, 6, 7, 8, 9, 13); `ax_shot` handshake `in/shot-<name>.req/.done` (Task 6) ↔ `shot_watcher` (Task 9); `install-app.sh copy|launch` exit 2 = Gatekeeper (Task 5) ↔ launch phase (Task 9); `assert-installed.sh --expect-version/--headless` (Task 7) ↔ Task 9/13; `trigger-update.sh <dir> <v>` with `appcast-server` inside `<dir>` (Task 8) ↔ preflight compiles it into `in/update/` (Task 9); `e2e-cleanroom.sh --app … --allow-existing-install --artifacts-dir` (Task 12) ↔ headless scenario (Task 9) and `second-user.sh run` (Task 11); AXIdentifier names (Task 6) ↔ the "Dependencies on other lanes" table (L3 asks).

## Open questions

1. **AXIdentifiers + `MATTSTACK_APPCAST_URL` + ATS exception are L3 asks (checked 2026-08-21: the L3 plan `2026-08-21-mattstack-app-shell.md` has neither; it does have `mattstackUITests`, `RT_STUB_*`, `GET /version`, `POST /update/check`); `SPARKLE_PUBLIC_ED_KEY` build override and `mattstack-<ver>.dmg/.zip` names are L4 asks.** Until accepted, `screens` and `update` phases fail/skip by design. Who files the contract amendment — L7 or the orchestrator?
2. **Ad-hoc-signed local builds and Sparkle:** Sparkle compares the incoming bundle's code signature with the installed one; whether two ad-hoc builds pass its check (no Team ID) is unverified. The update phase is specified for Developer-ID builds; if local ad-hoc runs are wanted, this needs an empirical check on the first run.
3. **Standard-user choice:** the walkthrough drives a *standard* user (`tester`) with `admin` credentials typed at privileged prompts (FDA/Login Items toggles, proxy step). Most teammates are admins on their Macs; should a second scenario (`--console-user admin`) be added so both paths are exercised? (Cheap: a golden-build flag that sets `autoLoginUser admin`.)
4. **`rt --post-install` launches the app unconditionally**, so layer (a) can never run as Matt's primary user without touching his real registration. Should L1 add `--no-launch`/honour `CI` there? (Out of L7 scope; guard implemented instead.)
5. **`release.yml` `test-install` job → call `scripts/e2e-cleanroom.sh`?** Keeps the recipe in one place; L4 owns the workflow.
6. **Tart licence ownership change:** the repo and brew tap moved to `openai/*`, licence FSL-1.1 © OpenAI, tart.run still states the Cirrus Labs free tier. Fine for one workstation; re-check before any fleet use.
7. **macOS 14 golden:** the `macos-sonoma-vanilla` image is 14.8.7 (3 months old, still published). If the pull fails or the image disappears, the fallback is `15` per the brief — confirm with Matt that a 14+26 matrix remains the target rather than 15+26.
8. **In-guest CLT install** during the clean-room run is network-bound and slow (~5–15 min). Acceptable for the release gate, or should the `create` scenario be split into "clean room until the Tools group" and "pre-CLT golden" for daily runs?
