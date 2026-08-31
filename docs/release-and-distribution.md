# Release & distribution — the mac app and everything it ships

The maintenance reference for mattstack.app's release pipeline and bundle.
CLAUDE.md carries the always-on rules (isolated HOME, never re-sign blessed
bundles, module registry, bytecode); this file is the map of how a release
actually works and the traps that were found by running it for real.
MAT-386 (Linear, mattstack workspace) is the historical record of how each
piece was proven; `docs/architecture.md` links the governing design docs.

## What a release ships

One tag (`v*`) produces, via `.github/workflows/release.yml` on macos-15:

- `rt-darwin-{arm64,x64}-<tag>.tar.gz` — the compiled rt CLI (what
  `rt --post-install` and mattstack.app install)
- `mattstack-<ver>.dmg` and `.zip` — the app, signed + notarized + stapled
  (`scripts/release/make-dmg.sh`, `make-zip.sh`)
- `appcast.xml` — the Sparkle feed (`scripts/release/appcast.sh`)
- the published plugin marketplace (`scripts/release/marketplace.sh`,
  generated from `marketplace/marketplace.json`; url-pinned sources resolve
  at generation time, `--refresh` re-resolves)

`workflow_dispatch` runs everything **except publish** — the standing dry
run. A dispatch's DMG lands as the `release-dry-run` artifact and is fully
notarized/stapled when the Developer ID secrets are configured (ad-hoc
signed with a warning when they are not; a **tag** hard-fails without them).

## Secrets and gates

- Developer ID cert + notarization creds: required on tags, optional
  (ad-hoc) on dispatch. `scripts/release/notarize.sh` does submit + staple
  for the app AND the dmg; the workflow then asserts Gatekeeper accepts the
  stapled app — that assertion is what a user's machine enforces offline,
  so it runs after notarize, never before.
- `MARKETPLACE_TOKEN` — pushes the generated marketplace. Must exist before
  the next tag (MAT-386 §10).
- `scripts/bench-startup.ts` gates startup regressions in the workflow
  (see CLAUDE.md "Module registry" for what usually causes them).

## Signing rules that cost real time to learn

- Everything under `Contents/Helpers` is nested code: one unsigned file
  fails the outer seal. Helpers arrive via `rt-tray/deps.lock` (pinned
  url + sha256 per tool); `rt-tray/check-bundle.sh` asserts presence AND
  runs every helper from inside the signed bundle (`--version` smoke).
  Adding a helper = a deps.lock entry; check-bundle picks it up from the
  lock, no script edit.
- Never rebuild, re-sign, or reinstall a bundle macOS has blessed
  (`/Applications/mattstack.app`, `rt-tray/mattstack-dev.app`) — re-signing
  silently invalidates Login Items and TCC/FDA grants. Build into scratch.
- Updating the installed app (Sparkle or manual) costs the FDA grant —
  quit the app first, expect to re-grant after.

## The clean-room proof (what "it installs" means here)

Two layers, both green as of 2026-08-24:

1. **CI**: `scripts/e2e-cleanroom.sh` under a simulated HOME — the full
   20-step install: `rt --post-install` → daemon → `rt verify --ci` →
   `check-bundle --app` → Gatekeeper via quarantine. Note it needs bun
   (check-bundle parses deps.lock with it) — CI's setup-bun provides it.
2. **Real VM**: `rt-tray/vm/` (its README is the harness reference).
   Golden image lifecycle: `golden/build-golden.sh <ver>` pulls the
   cirruslabs image, provisions, pauses ONCE for manual clicks —
   Accessibility grants AND the Gatekeeper policy toggle (below) — then
   `verify-golden.sh` asserts 13 invariants. A golden is never booted
   again; runs clone it (`run/walkthrough.sh --ver 26 --dmg <dmg>
   --scenario headless`).

VM truths that only a real run surfaced (all encoded in the harness now):

- cirruslabs images ship Gatekeeper **App-Store-only** (`developer id
  disabled`) — a notarized Developer ID app is rejected with the "not
  downloaded from the App Store" dialog. Stricter than any real Mac; the
  toggle is Settings-UI/MDM-only (SIP blocks every CLI route), so it is a
  build-golden manual step and a verify-golden assertion.
- A `ditto`-copied quarantined app **translocates** on open (runs from a
  randomized read-only mount; background services can't register). Finder
  drags never translocate, so the harness strips quarantine after the
  spctl assessment — and verifies the strip took.
- `softwareupdate` label format is `Command Line Tools for Xcode 26.6-26.6`
  (space form), catalog order ≠ version order, and a freshly-poked catalog
  needs one scan cycle before CLT labels appear.

## Install-time product contracts

- `rt --post-install` refuses transient roots (DMG/translocated), sweeps
  legacy installs, then runs `rt setup apply --non-interactive
  --team-of-one` (commands/post-install.ts documents the order and why).
- Non-interactive apply gates on **hard preconditions only** —
  `tool.macos` + `tool.clt` (`commands/setup.ts`, HARD_PRECONDITION_IDS):
  git is required (settings and the home repo are git-backed), everything
  else (herdr, claude…) degrades gracefully. `--force` bypasses.
- `rt tools install apple-clt` installs Command Line Tools headlessly via
  the softwareupdate trigger-file flow — no dialog, works as a non-root
  admin, ~2 min, success claimed only after a green `git --version`
  re-probe (`lib/setup/tools-install.ts`). Dialog trigger is the fallback
  and reports `ok: false` (progress, not completion).

### Flavor exclusivity

mattstack enforces one registered flavor pair per machine (prod
`com.mattstack.daemon` XOR dev `com.mattstack.daemon.dev`) via
`mattstack.mode`, a machine-scope setting; the daemon and tray self-heal to
whichever flavor the setting (or, when unset, the CLI wrapper) declares,
standing down on a mismatch rather than racing to bind. Full design:
`docs/superpowers/specs/2026-08-25-flavor-exclusivity-design.md`.

Two constraints hold for the migration window, both because old code does
not carry the gate:

- Until **both** bundles ship the new code, an already-installed pre-gate
  prod tray still unlinks-and-rebinds `tray.sock` unconditionally at
  launch — a new-code tray's socket ownership is not durable against it,
  so don't treat ownership as settled until prod itself has moved past
  this release.
- Once the new prod bundle ships, a machine whose CLI wrapper is dev-mode
  will have its prod tray stand itself down at login (alert, or a silent
  notification + unregister, depending on launch origin) — expected
  behavior under the gate, not a regression, and worth knowing before the
  release tag goes out.

Machines already sitting in a half-state (both flavors registered, or the
wrong one holding `rt.sock`/`tray.sock`) need a one-time cleanup once the
new code lands: run `rt settings dev-mode <mode>` once (its repair path
now covers a dead tray), or manually `launchctl bootout
gui/$UID/<wrong-label>`.

## Sparkle / updates

`appcast.sh` signs the feed; the appcast URL is baked prod-side, and a
prod build honours `MATTSTACK_APPCAST_URL` only with
`--allow-appcast-override` (the VM walkthrough's update leg uses this).
The update path end-to-end (Create Release → appcast → installed app
updates) has NOT run yet — it needs the first real tag; treat its first
run as a verification exercise, not a routine.

## App-bundle CI (bundle-apps.yml)

`.github/workflows/bundle-apps.yml` builds the managed mattstack apps from
source and pins them into `rt-tray/deps.lock`. Manual dispatch only: inputs
are `apps` (comma-separated names, or `all`) and `dry_run` (build and hash,
skip release and PR). The plan job resolves the matrix from deps.lock rows
carrying a `repo` field; build jobs run on macos-15 (arm64); the PR job
opens one deps.lock PR on `bundle-ci/<run_id>`. Nothing pushes to main.

Two declarations drive it, each owned by the party that knows it:

- `repo` on the deps.lock row (`"m4ttstack/<repo>"`) marks the app
  buildable. Rows without it (fzf, node, cloudflared...) are third-party
  pins the pipeline never touches.
- `bundle: { build, artifact }` in the app repo's `mattstack.deck.json` is
  the compile recipe, run verbatim at the repo root. A dispatched app whose
  manifest lacks it fails that leg loudly with the remediation; that
  failure IS the pairing enforcement between the two declarations.

Version and tag rules: the tag is `v<version>` from the app repo's root
`package.json` (a missing version fails the leg, never a `vundefined`
release). The guard checks the git tag ref, so a bare pre-existing tag
refuses just like a full release... published artifacts are immutable; bump
the version instead. One leg failing never blocks the others
(`fail-fast: false`); the PR carries only the apps that succeeded.

Skills ride the artifacts: each tarball's root is the `<name>` binary plus
the repo's `skills/` copied verbatim (omitted when absent).
`fetch-deps.sh` materializes `deps/arm64/<name>-skills/` beside the binary
under its own sha stamp (a deleted skills dir re-materializes on the next
run), and `build.sh` lands it signed at `Contents/Helpers/skills/<name>/`.
Skill directory names must be dot-free (codesign reads a dotted dir as a
nested bundle); `check-bundle.sh` asserts each skill dir carries a
`SKILL.md`. rt's own skills are the first-party analogue: `build.sh`
copies the checkout's `skills/` whole to `Contents/Helpers/skills/rt/`,
including `skills/.skillsignore`, the file `rt skills link` reads to keep
maintainer-only skills off user machines.

Manual precondition, once: a fine-grained org PAT with contents read+write
on the m4ttstack app repos and contents write plus PR create on repo-tools,
stored as the `MATTSTACK_RELEASE_TOKEN` Actions secret on repo-tools.

Recovery: a release that published but whose PR step failed is durable and
safe... re-run the pr job, or hand-edit deps.lock from the url and sha in
the run summary. Re-dispatching the same app fails on the tag guard by
design.

Workflow lint: the checks workflow runs actionlint over `bundle-apps.yml`,
`checks.yml`, `e2e.yml`, and `purity.yml`. `release.yml` is grandfathered
(pre-existing findings) until it is next edited.

## Still unproven (as of 2026-08-24)

- A real tag cut end to end (publish + Sparkle update leg + marketplace
  push with MARKETPLACE_TOKEN).
- The walkthrough's full-green 10/10 report (gitless persona asserting the
  graceful refusal, then rt driving the headless CLT install and
  continuing) — parked follow-up; each layer is proven individually.
- An invite redeemed by a second machine.
