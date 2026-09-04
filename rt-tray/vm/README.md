# rt-tray/vm — clean-room testing (installer spec ruling 12, lane L7)

Golden macOS VM images, a scripted walkthrough of the mattstack.app installer,
a second-macOS-user smoke, and a local runner for the CI headless install.
Every run's deliverable is `artifacts/<run-id>/` (screenshots, logs,
`phases.jsonl`, `report.md`). Skipped phases are reported as skipped, never green.

## What this layer verifies — and cannot

| Layer | Verifies | Cannot verify / not automated |
|---|---|---|
| (a) `scripts/e2e-cleanroom.sh` (same recipe as the release workflow's "Clean-room install + verify" step) | artifact extracts; Gatekeeper accepts the app with `com.apple.quarantine` stamped on the way a browser download would; `rt --post-install` installs `~/.local/bin/rt`, the app, the daemon config; `rt verify --ci` exit 0; every bundled helper runs from inside the signed bundle | anything needing a GUI session or approval (daemon boot is a warn under CI); Gatekeeper **where the xattr cannot be written** — that prints `Gatekeeper path NOT exercised` and the run still passes, so a green run is not proof it was tested |
| (b) `run/walkthrough.sh` (Tart clone of a golden image) | real DMG → /Applications → first launch under Gatekeeper; five setup screens; FDA + Login Items + Notifications dances; `rt verify --json` green; tray.sock `/version`; Sparkle vN→vN+1 and daemon restart; screenshots per screen | the **"Background Items Added" notification** (a banner, not a dialog — it is neither clicked nor asserted; the Login Items row is asserted through `GET /services` / `rt setup status` instead); the **FDA relaunch** is driven (the app's own "Relaunch" button) but the OS applying FDA is asserted only via the app's probe row; notarisation/stapling of Matt's signing (a locally built DMG is unnotarised → run with `--no-quarantine`, reported in the ledger) |
| (c) `run/second-user.sh` | layer (a) under a second real macOS user on Matt's Mac, with a live GUI session so SMAppService registration is real | nothing about the five screens; the user must be created and logged in once by Matt |

## Status

`--scenario create` is green end to end on the `mattstack-golden-26` image
on GitHub (run `20260901-232641`) and GitLab (run `20260902-110714`):
every setup screen, the FDA dance with the app's own relaunch, the Apple
CLT install, the herdr and Claude Code vendor installs, the full Install
pipeline, and the Done screen. `--scenario join` is green unattended on a
second guest (run `20260902-114519`, `--forge gitlab`), and the team-level
pass is green too: an owner guest loads `fixtures/team-minimal` through
`run/host/team-load.sh` (one tracked repo, one team plugin, one team
secret), two joiners join from fresh guests, and
`run/host/team-propagate.sh` + `run/guest/assert-team.sh` prove the repo
cloned, the plugin installed, and the secret decrypting with each joiner's
own key (runs `20260902-121519`, `20260902-124007`), and
`fixtures/team-kitchen-sink` (two private repos, two team plugins plus a
team-chosen public-marketplace plugin, three secrets in two domains) is
green on both joiners (runs `20260902-125703`, `20260902-130744`).
`--scenario headless` is green too. Still unproven: the `update` phase
(`--update-dir`).

The team pass now runs only `members sync` on the owner and waits for the
daemon's push, then `rt team pull` on the joiner: the daemon moves every
byte, and `team-propagate.sh` runs no git commit/push/pull of its own. That
pass is green on the kitchen-sink fixture with the team-clone snapshot daemon
doing the work (owner `20260902-211149`, joiners `20260902-212248` and
`20260902-213612`; the second joiner also proves Install's `git.identity`
step wrote the global git identity from the GitLab profile).

`run/host/team-rebase.sh <owner-vm> <joiner-vm>` proves the other two paths on
the same two kept guests: a joiner whose own commit is held back (its
`rt.teamSnapshot` `pushDelaySec` raised) is rebased onto the owner's daemon
push and its edit reaches the owner, and a same-key edit on both sides
surfaces as the `team.sync` needs-you row, leaves no rebase in progress, and
clears once the joiner resets to origin. It writes settings and reads verbs
back; every commit, push, pull and rebase is the daemon's.
The team repo has to actually admit a member's push for that pass: on GitLab
that means Developer (30) on the project AND an unprotected default branch,
since a new project protects `main` for Maintainers only and every member's
daemon pushes straight to it.

Facts a join run depends on:

- One PAT per run, the joiner's own, through `--pat-env`; `--forge gitlab`
  when the invite is not derivable from a remote. Invite codes come from
  `team-load.sh` (`--out <dir>/code-<handle>.txt`) or, for the bare
  scaffold, `rt team invite --handle <h> --json` over ssh in the kept owner
  guest with a scp'd `dist/rt` (a stderr reminder line precedes the JSON).
- Never replace the bundle's `rt` inside a guest to replay a step:
  SMAppService's code requirement stops matching and the daemon spawn-fails
  with exit 78, which reads exactly like a product bug. scp a fresh binary
  to `/tmp` and run verbs from there, or rebuild the app and rerun.

Facts a create run depends on:

- **Every create run needs an EMPTY team repo** (`rt team create` refuses a
  remote with commits). `run/team-setup.sh reset` retires and recreates the
  standard pair; or create a fresh one (`gh repo create <org>/<name>
  --private`, or the GitLab projects API) and pass `--team-remote <url>`
  (the walkthrough otherwise derives a GitHub URL from
  `MATTSTACK_VMTEST_TEAM_REPO`). A pasted remote leaves
  `rtMayManageMembership` off, so grant the joiners on the forge yourself.
- Prefer `--no-graphics`: the Tart window otherwise takes keyboard focus on
  the host mid-run (a stray keystroke lands in the token field), and every
  failure already logs the windows and AXIdentifiers on screen.
- The privileged proxy helper (`mattstack-proxy-install`) has not shipped, so
  the Install pipeline's `proxy.install` step reports `skipped` with that
  reason; apps serve on ports until it lands.

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
- **Homebrew-only tools no longer block a brew-less guest.** Every tool `rt
  verify` needs now ships inside the bundle under `Contents/Helpers/` per
  `deps.lock` — jq, bun, node, gh, glab, gitq, age-keygen, sops, and
  fast-browser — and `check-bundle.sh` asserts each one actually *runs* from
  inside the signed bundle. `--scenario headless` is not gated on any of them.
  It has still never been run end to end against a golden image; that is the
  outstanding verification, not a known failure.
- **`scripts/e2e-cleanroom.sh --allow-existing-install`** is still only safe
  on a disposable target (inside the VM, or the smoke user `second-user.sh`
  drives) — never on a real, already-used account, where it would install
  over a live setup. `rt --post-install` does now parse `--non-interactive`,
  `--team-of-one`, and `--no-launch`, so the flags the clean room passes are
  no longer inert.
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

Every path above exists on this branch today. `run/guest/ax.sh`, `run/guest/drive-setup.sh`, and `run/guest/trigger-update.sh` are in the tree and staged into every walkthrough run; the `screens` and `update` phases still run gated on L3 (see Status above), not on anything missing from this directory.

## Prerequisites (host, Apple Silicon)

- `brew install openai/tools/tart` (Tart is **FSL-1.1-ALv2**, © OpenAI; tart.run/licensing: free on personal workstations and for orgs up to 100 CPU cores — this Mac is inside the free tier; recount if L7 ever moves to a shared fleet). Old tap: `cirruslabs/cli/tart`.
- `brew install cirruslabs/cli/sshpass` (golden build only — the first password login; everything after is key-based).
- Apple CLT (`swiftc`, for `run/host/winid.swift`) and Bun (compiles `appcast-server`).
- Screen Recording for your terminal app (System Settings → Privacy & Security → Screen & System Audio Recording) — host-side screenshots of the Tart window. One-time.
- ~60 GB free disk per **cleanroom** golden (25–27 GB download, 50 GB virtual disk, APFS-sparse). An **`--xcode`** golden needs substantially more — the `-xcode` image bundles a full Xcode install on top of the base OS, so budget well beyond the vanilla figures above (exact numbers not yet measured; see Costs below). Clones are copy-on-write either way.
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
../../scripts/e2e-cleanroom.sh ~/Downloads/mattstack-2.9.0.zip --home "$(mktemp -d)"   # local run: --home keeps this off your real ~ (release.yml passes no --home; its runner IS the throwaway machine)
```
Today, the first line's `screens` phase and both lines' `update` phase report `fail`/`skip` honestly (see Status above). `--scenario headless` (line 2) is no longer blocked by anything known, but no scenario has yet been run end to end against a golden image, so none is *known* green either. `--dry-run` exercises the whole orchestrator (phase ledger, report) against any golden name without Tart or a real DMG/app.

Phases: preflight · clone · boot · stage · install · launch · screens · assert · update · teardown. Each is `pass|fail|skip` with a reason in `artifacts/<run>/phases.jsonl`; `report.md` is the human summary; `screenshots/` are numbered per screen (`00-first-launch`, `01-welcome`, `02-team-*`, `03-readiness-*`, `04-install-*`, `05-done`, `06-update-*`); `logs/` holds guest logs (`~/.mattstack/rt/logs`, unified log slice for mattstack/smd/backgroundtaskmanagementd, `launchctl print` grep, `rt verify --json`, tray `/version`). Exit 1 iff any phase failed; skips are reported, never counted green.

## What is not automated (and how the scripts treat it)

- **"Background Items Added" banner**: not clicked, not asserted (it is a notification). The design (once `run/guest/drive-setup.sh` lands, T6) is: the Login Items row is asserted through `GET /services` / `rt setup status`; if SMAppService returns `.requiresApproval`, the driver opens Login Items and toggles the app (admin auth as a standard user).
- **FDA relaunch**: same T6 gate. Once built, the driver clicks "Relaunch mattstack" (`setup.checklist.relaunch`) and waits for the window to return (the app re-execs with its own args + env, so the appcast override survives; if it does not come back the driver relaunches it with the same `--env`/`--arg`); FDA taking effect is asserted only through the app's probe row (`perm.fda` = ready). No `tccutil` is used in the guest.
- **Gatekeeper with unnotarised builds**: real today, in `run/guest/install-app.sh`. A locally built DMG is quarantined by default to exercise the real path; it will be blocked (`launch fail`, screenshot of the dialog). Use `--no-quarantine` for local builds and say so in the ticket.
- **Apple CLT install** in the clean room is real (Apple's dialog, network, minutes) once T6 lands; the driver clicks Install/Agree and waits up to 20 min.
- **Sparkle update** needs L4's signed zip + appcast, L3's `MATTSTACK_APPCAST_URL` hook (prod builds honour it only when launched with `--allow-appcast-override`), and `run/guest/trigger-update.sh` (T8); until all three land the phase is `skip` with that reason. The appcast is served on **loopback inside the guest** to stay clear of macOS 15's Local Network Privacy prompt; the real feed is the GitHub Release asset `https://github.com/m4ttstack/rt/releases/latest/download/appcast.xml`. `CFBundleVersion` follows L4's `major*1000000+minor*1000+patch`.
- **Invite/join**: `run/team-setup.sh invite` mints a real code through `rt team invite` on the host (the stub path is its fallback when that verb is absent); the join scenario itself has not been run yet.
- **Second user**: Matt creates the user and logs it in once (launchd `gui/<uid>` needs a GUI session); the script never creates users.

## Test team

Throwaway GitHub org (default `mattstack-vmtest`; override with `MATTSTACK_VMTEST_ORG`, and if the name lacks `vmtest` also set `MATTSTACK_VMTEST_ORG_CONFIRM=<org>`), repos `mattstack-vmtest-home`, `mattstack-vmtest-team`, plus the wizard's own `mattstack-home` / `mattstack-team-<slug>`. Token in `MATTSTACK_VMTEST_PAT` (env only; never in the repo or artifacts) — the `repo` scope is enough (`gh auth token` works): `reset` retires existing repos by rename+archive (`trash-<name>-<stamp>`), never deletes. Run `run/team-setup.sh reset` before a `create` run. No real team data ever enters this org.

A Linear API key for `team-propagate.sh`'s Linear leg lives at
`$HOME/.mattstack/vmtest/linear-api-key.txt` on the host by default; override
the path with `MATTSTACK_VMTEST_LINEAR_KEY_FILE`. Its content travels to the
joiner by `vm_scp` into a joiner-owned 0700 directory, over stdin into
`rt setup linear connect --json`, and is removed on every exit path (an EXIT
trap in the guest session, plus an eager remove after the connect attempt). It is never echoed, never in argv, never committed, and a run
with no key file at that path simply skips the Linear leg rather than
failing. On a successful connect, the joiner also resumes Install from
`linear.mcp` (`rt setup apply --from linear.mcp --json`) so the
`mcpServers.linear` entry actually gets written: Install already ran once at
join time, before the key existed, so `linear.mcp` skipped it then and
nothing else re-runs Install. Setting `"linearMcp": true` in a fixture's
`expect.json` is what turns the `assert-team.sh` Linear MCP block on; every
other fixture leaves it unset and the block stays inert.

## Costs (fill in after the first builds)

| image | pull | disk | golden build | walkthrough (create) |
|---|---|---|---|---|
| 26 | | | | |
| 14 | | | | |
| 26 `--xcode` | | | | (n/a — `run/xcuitest.sh` instead) |

## Manual alternative

VirtualBuddy (GUI, no CLI): duplicate the library VM with ⌘D (APFS clone), drag the DMG in via its shared folder, run `run/guest/*.sh` by hand from a Terminal in the guest with `GUEST_RUN` pointed at a shared folder. Same scripts, no host orchestration.

## Offline check

`bash check-vm-scripts.sh` runs every offline gate in this directory — `bash -n` on every script, the two unit-test suites, and every `--dry-run`/usage-only path — with no Tart and no network. It is what implementers and reviewers run on this branch; it does not (and cannot) exercise a real VM.
