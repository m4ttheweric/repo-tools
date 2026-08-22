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

## Status: what's built vs. gated

Everything below is written and runnable today except the two pieces still
gated on other lanes:

- **`run/guest/ax.sh` + `run/guest/drive-setup.sh`** (screens 1–5, FDA/Login
  Items/Notifications dances) — gated on L3 landing its setup screens and
  `AccessibilityIDs.swift`. Until then `--scenario create`/`join` will reach
  the `screens` phase and fail there (guest script not staged); `--scenario
  headless` does not depend on this, but it fails too today — see fzf below.
- **`run/guest/trigger-update.sh`** (drives Sparkle, asserts vN→vN+1 +
  daemon restart) — beyond the appcast server and `--update-dir` preflight
  that `walkthrough.sh` already carries, the update phase reports `skip`
  ("no --update-dir…") until this and L3's `MATTSTACK_APPCAST_URL` hook land.

`run/xcuitest.sh` (layer (b) via XCUITest instead of AppleScript) is in the
tree and runnable today; it self-gates at runtime rather than depending on
another lane. Its gate phase checks, in order: the host has Xcode
(`xcode-select -p` under `/Applications/Xcode*.app/`), `rt-tray/project.yml`
exists (L3), and a `-xcode`-flavour golden has been built
(`golden/build-golden.sh <ver> --xcode`) — any miss renders a clean `skip`,
never a failure. **The `-xcode` golden is not a clean room**: it keeps CLT,
brew, and Gatekeeper-as-shipped so `xcodebuild` can run, and
`verify-golden.sh` skips the `no CLT`/`no brew`/`Gatekeeper enabled` checks
against it (see Golden images below). The XCUITest phase drives the same
stub-driven suite the host build uses (`XCUIApplication()` + `RT_STUB_PATH`,
per L3's `SetupFlowUITests.swift`) against the sources staged into the
guest — not the DMG the `install` phase copies into `/Applications`; driving
the *installed* bundle from XCUITest is future L3-side work.

A few other things worth knowing before running this layer:
- **fzf**: confirmed not provisioned into any golden or clean-room guest, and
  no closer exists yet (no `Contents/Helpers`, no `fzf`, no `scripts/release/`
  bundling step). `rt verify` fails the fzf check at critical severity on a
  Homebrew-less guest, so **`--scenario headless` currently fails at the
  `screens` and `assert` phases** — it is not an end-to-end-green path today.
  The intended closer is L4 bundling fzf under `Contents/Helpers/` with a
  `deps.lock`; until it lands, every clean-room run and golden-image
  provisioning trips this.
- **`scripts/e2e-cleanroom.sh --allow-existing-install`**: pre-L1, `rt
  --post-install` launches the app unconditionally and discards post-install
  args, so this flag is only safe on a disposable target (inside the VM, or
  the smoke user `second-user.sh` drives) — never on a real, already-used
  account. The guard is merge order: L1's post-install rewrite (team-of-one,
  `--no-launch` under CI) must land before `--allow-existing-install` is used
  outside the VM/smoke-user paths.
- These vm scripts are not wired into any repo CI gate yet. `bash
  check-vm-scripts.sh` (below) is the whole offline check today; run it by
  hand.

## Layout

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

Not yet in the tree (see Status above): `run/guest/ax.sh` + `run/guest/drive-setup.sh` (gated on L3's screens), `run/guest/trigger-update.sh` (gated on L3/L4's Sparkle hooks). Every other path above, including `run/xcuitest.sh`, exists on this branch today.

## Prerequisites (host, Apple Silicon)

- `brew install openai/tools/tart` (Tart is **FSL-1.1-ALv2**, © OpenAI; tart.run/licensing: free on personal workstations and for orgs up to 100 CPU cores — this Mac is inside the free tier; recount if L7 ever moves to a shared fleet). Old tap: `cirruslabs/cli/tart`.
- `brew install cirruslabs/cli/sshpass` (golden build only — the first password login; everything after is key-based).
- Apple CLT (`swiftc`, for `run/host/winid.swift`) and Bun (compiles `appcast-server`).
- Screen Recording for your terminal app (System Settings → Privacy & Security → Screen & System Audio Recording) — host-side screenshots of the Tart window. One-time.
- ~60 GB free disk per golden (25–27 GB download, 50 GB virtual disk, APFS-sparse). Clones are copy-on-write.
- GitHub-hosted runners cannot run this (no nested macOS virtualisation); local only, or a self-hosted Apple-Silicon runner later.

## Golden images (built once, never run again — every run is a clone)

`golden/build-golden.sh 26` and `golden/build-golden.sh 14` (`15` optional). `build-golden.sh` takes `<14|15|26> [--xcode] [--dry-run] [--rebuild]`.
Image source: `ghcr.io/cirruslabs/macos-{sonoma,sequoia,tahoe}-vanilla:latest` (no brew, no guest agent → ssh only). Provisioning: remove Apple CLT (the vanilla template installs it), assert no brew, re-enable Gatekeeper (the image ships it disabled), create standard user `tester`/`tester` as the auto-login console user (`admin`/`admin` keeps NOPASSWD sudo for provisioning and plays the "admin credentials" role in the installer's privileged step), Remote Login for all users, ssh key for both, sleep/screensaver/screen-lock off, marker `/Users/Shared/mattstack-golden.json`.
**`--xcode`** builds `mattstack-golden-<ver>-xcode` from `ghcr.io/cirruslabs/macos-{sonoma,sequoia,tahoe}-xcode:latest` instead, and skips the CLT-removal/brew-removal/Gatekeeper-reenable steps (`SKIP_CLEANROOM=1`) so `xcodebuild` has what it needs. **This golden is not a clean room for the Tools rows** — it legitimately carries CLT, brew, and Gatekeeper-as-shipped; the marker records `"flavour": "xcuitest"` and `verify-golden.sh` reads it back to skip the `no CLT`/`no brew`/`Gatekeeper enabled` checks only for that golden. It exists to run `run/xcuitest.sh` (layer (b) via XCUITest), gated on Xcode being present on the host. Hand-running `verify-golden.sh` against it needs either the explicit VM name (`verify-golden.sh 26 mattstack-golden-26-xcode`) or `--xcode` (`verify-golden.sh 26 --xcode`) — the bare `verify-golden.sh 26` targets the cleanroom name.
**One manual step per golden** (TCC cannot be pre-approved by script; `tccutil` only resets; PPPC needs MDM): in the VM, Privacy & Security → Accessibility → add `/usr/libexec/sshd-keygen-wrapper` and `/usr/bin/osascript`; then approve the Automation prompt for System Events when the script sends its probe. `golden/verify-golden.sh` proves it (the probe fails with "not allowed assistive access" until done). macOS 26.1/26.2 had a bug adding CLI tools there; the tahoe image is ≥ 26.3.

## Runs

```
run/walkthrough.sh --ver 26 --dmg dist/mattstack-2.9.0.dmg \
   --update-dir dist/update --update-version 2.9.1 \
   --scenario create --team-slug vmtest --pat-env MATTSTACK_VMTEST_PAT
run/walkthrough.sh --ver 14 --app rt-tray/mattstack.app --no-quarantine --scenario headless
run/second-user.sh run --artifact ~/Downloads/mattstack-2.9.0.zip
../../scripts/e2e-cleanroom.sh --tag v2.9.0   # refuses on a user that already runs mattstack
../../scripts/e2e-cleanroom.sh ~/Downloads/mattstack-2.9.0.zip --home "$(mktemp -d)"   # what release.yml runs
```
Today, the first line's `screens` phase and both lines' `update` phase report `fail`/`skip` honestly (see Status above) — `--scenario headless` (line 2) also fails today, at its `screens` and `assert` phases, because fzf is not provisioned (see fzf above); no scenario currently runs fully green end to end. `--dry-run` exercises the whole orchestrator (phase ledger, report) against any golden name without Tart or a real DMG/app.

Phases: preflight · clone · boot · stage · install · launch · screens · assert · update · teardown. Each is `pass|fail|skip` with a reason in `artifacts/<run>/phases.jsonl`; `report.md` is the human summary; `screenshots/` are numbered per screen (`00-first-launch`, `01-welcome`, `02-team-*`, `03-readiness-*`, `04-install-*`, `05-done`, `06-update-*`); `logs/` holds guest logs (`~/.mattstack/rt/logs`, unified log slice for mattstack/smd/backgroundtaskmanagementd, `launchctl print` grep, `rt verify --json`, tray `/version`). Exit 1 iff any phase failed; skips are reported, never counted green.

## What is not automated (and how the scripts treat it)

- **"Background Items Added" banner**: not clicked, not asserted (it is a notification). The design (once `run/guest/drive-setup.sh` lands, T6) is: the Login Items row is asserted through `GET /services` / `rt setup status`; if SMAppService returns `.requiresApproval`, the driver opens Login Items and toggles the app (admin auth as a standard user).
- **FDA relaunch**: same T6 gate. Once built, the driver clicks "Relaunch mattstack" (`setup.checklist.relaunch`) and waits for the window to return (the app re-execs with its own args + env, so the appcast override survives; if it does not come back the driver relaunches it with the same `--env`/`--arg`); FDA taking effect is asserted only through the app's probe row (`perm.fda` = ready). No `tccutil` is used in the guest.
- **Gatekeeper with unnotarised builds**: real today, in `run/guest/install-app.sh`. A locally built DMG is quarantined by default to exercise the real path; it will be blocked (`launch fail`, screenshot of the dialog). Use `--no-quarantine` for local builds and say so in the ticket.
- **Apple CLT install** in the clean room is real (Apple's dialog, network, minutes) once T6 lands; the driver clicks Install/Agree and waits up to 20 min.
- **Sparkle update** needs L4's signed zip + appcast, L3's `MATTSTACK_APPCAST_URL` hook (prod builds honour it only when launched with `--allow-appcast-override`), and `run/guest/trigger-update.sh` (T8); until all three land the phase is `skip` with that reason. The appcast is served on **loopback inside the guest** to stay clear of macOS 15's Local Network Privacy prompt; the real feed is the GitHub Release asset `https://github.com/m4ttstack/rt/releases/latest/download/appcast.xml`. `CFBundleVersion` follows L4's `major*1000000+minor*1000+patch`.
- **Invite/join** needs L1 + L6; `run/team-setup.sh invite` mints a stub code today (only a DEBUG app with `RT_STUB_SCENARIO=join-happy` accepts it).
- **Second user**: Matt creates the user and logs it in once (launchd `gui/<uid>` needs a GUI session); the script never creates users.

## Test team

Throwaway GitHub org (default `mattstack-vmtest`; override with `MATTSTACK_VMTEST_ORG`, and if the name lacks `vmtest` also set `MATTSTACK_VMTEST_ORG_CONFIRM=<org>`), repos `mattstack-vmtest-home`, `mattstack-vmtest-team`, plus the wizard's own `mattstack-home` / `mattstack-team-<slug>`. Token in `MATTSTACK_VMTEST_PAT` (env only; never in the repo or artifacts) — the `repo` scope is enough (`gh auth token` works): `reset` retires existing repos by rename+archive (`trash-<name>-<stamp>`), never deletes. Run `run/team-setup.sh reset` before a `create` run. No real team data ever enters this org.

## Costs (fill in after the first builds)

| image | pull | disk | golden build | walkthrough (create) |
|---|---|---|---|---|
| 26 | | | | |
| 14 | | | | |

## Manual alternative

VirtualBuddy (GUI, no CLI): duplicate the library VM with ⌘D (APFS clone), drag the DMG in via its shared folder, run `run/guest/*.sh` by hand from a Terminal in the guest with `GUEST_RUN` pointed at a shared folder. Same scripts, no host orchestration.

## Offline check

`bash check-vm-scripts.sh` runs every offline gate in this directory — `bash -n` on every script, the two unit-test suites, and every `--dry-run`/usage-only path — with no Tart and no network. It is what implementers and reviewers run on this branch; it does not (and cannot) exercise a real VM.
