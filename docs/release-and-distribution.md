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
skip release and PR). Four jobs: plan resolves the matrix from deps.lock rows
carrying a `repo` field; build runs on macos-15 (arm64), one leg per app;
release publishes the packaged tarballs; the PR job opens one deps.lock PR on
`bundle-ci/<run_id>`. Nothing pushes to main.

Release is a separate job on purpose. The build job runs each app repo's own
recipe verbatim, and a recipe can write `GITHUB_ENV` and `GITHUB_PATH`, so no
step holding the release token may follow it in the same job... a poisoned
PATH would otherwise hand that token to an attacker-controlled `gh`. The
build job's own token use (clone, tag guard) all happens before the recipe
runs.

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

### Adding a managed app to the bundle (the checklist that built console and chat)

1. **The app must answer `--version` with a bare semver and exit 0.** The
   build leg's smoke step and `check-bundle.sh` both probe it; a server
   that just starts listening hangs both. Apps on `@mattstack/app-server`
   get this from `serveMattstackApp` (≥0.1.2) — pass `version` from
   package.json, never a hardcoded string, or the tag and the binary
   disagree.
2. **A compiled Bun server needs embedded assets.** The console pattern:
   `build:binary` runs `vite build && mattstack-embed-assets && bun build
   --compile`; the server passes `embedded: () => import('./embedded/manifest'
   as string)`; tsconfig excludes the generated manifest; `.gitignore`
   carries `dist-bin` and the manifest path.
3. **Declare the pair**: `bundle: { build, artifact }` in the app's
   `mattstack.deck.json`, and the `repo` field on its deps.lock row.
4. **Dry-run dispatch first** (`dry_run: true`), then the real one. The
   real run publishes an immutable release and opens a deps.lock PR; two
   real runs back-to-back conflict on the PR — merge the first, then apply
   the second's row by hand from its PR diff (verify the sha yourself from
   the release asset) and close it.
5. **Private app repos work, with one wire**: their release assets refuse
   bare curl, so `fetch-deps.sh` falls back to `gh release download` for
   github release URLs. CI's fetch step passes
   `GH_TOKEN: MATTSTACK_RELEASE_TOKEN` for that; local builds ride the
   developer's own gh auth. The sha gate judges the bytes either way.

An app's skills and plugins do NOT automatically ride its binary — see
"Two channels ship skills" below.

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

Manual preconditions, once, both Actions secrets on repo-tools:

- `MATTSTACK_RELEASE_TOKEN` ... a fine-grained org PAT with contents
  read+write on the m4ttstack app repos and contents write plus
  pull-requests write on repo-tools.
- `NPM_READ_TOKEN` ... an npm token with READ access to the private
  `@mattstack` org packages (deck and board depend on `@mattstack/tui-kit`,
  published private). Read-only on purpose: the build job writes it to
  `~/.npmrc` and then runs the app's own build recipe, which can read that
  file. Without it those apps fail with a bare `404` on the package, which
  reads like a missing package rather than a missing credential.

Recovery: a release that published but whose PR step failed is durable and
safe... re-run the pr job, or hand-edit deps.lock from the url and sha in
the run summary. Re-dispatching the same app fails on the tag guard by
design.

Workflow lint: the checks workflow runs actionlint over `bundle-apps.yml`,
`checks.yml`, `e2e.yml`, `purity.yml`, and `renovate.yml`. `release.yml`
is grandfathered (pre-existing SC2086/SC2129 style findings only).

### Two channels ship skills — pick deliberately

- **The app tarball → `rt skills link --from`**: the repo's `skills/` dir
  rides the bundle to `Contents/Helpers/skills/<name>/`, reconciled into
  `~/.claude/skills` by frontmatter name. `skills/.skillsignore` (rt's
  own skills) keeps maintainer-only skills off user machines; a plain
  `rt skills link` in a checkout ignores it, because that is the author.
  Right for skills addressed by their bare name (`rt:chat` rides rt's
  own surface this way).
- **A marketplace plugin**: `marketplace/marketplace.json` in this repo is
  the generator source; `scripts/release/marketplace.sh` REPLACES the
  published m4ttstack/mattstack-marketplace tree wholesale, so anything
  living only in the published repo (or only in the local dev marketplace
  working copy, which has no git remote) dies on the next publish. Plugins
  with no repo of their own ship inline under `marketplace/plugins/`
  (string source `"./plugins/<name>"`); everything else is a url-pinned
  git source. Required when the `<plugin>:` namespace is a wire contract
  (`rt chat invite` types `/chat:join`) or the plugin carries hooks —
  `linkBundledSkills` handles skills dirs only, never hooks.
- A baseline plugin reaches users only if it is BOTH published in the
  marketplace AND listed in `BASE_PLUGINS` (`lib/setup/steps/plugins.ts`).
  The chat plugin needed both wires; check both when adding one.

## Still unproven (as of 2026-08-24)

- A real tag cut end to end (publish + Sparkle update leg + marketplace
  push with MARKETPLACE_TOKEN).
- The walkthrough's full-green 10/10 report (gitless persona asserting the
  graceful refusal, then rt driving the headless CLT install and
  continuing) — parked follow-up; each layer is proven individually.
- An invite redeemed by a second machine.
