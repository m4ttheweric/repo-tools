# Release & distribution — the mac app and everything it ships

The maintenance reference for mattstack.app's release pipeline and bundle.
CLAUDE.md carries the always-on rules (isolated HOME, never re-sign blessed
bundles, module registry, bytecode); this file is the map of how a release
actually works and the traps that were found by running it for real.
MAT-386 (Linear, mattstack workspace) is the historical record of how each
piece was proven; `docs/architecture.md` links the governing design docs.

## What a release ships

One tag (`v*`) produces, via `.github/workflows/release.yml` on macos-15:

- `mattstack-<ver>.dmg` and `.zip` — the app, signed + notarized + stapled
  (`scripts/release/make-dmg.sh`, `make-zip.sh`); the compiled rt CLI ships
  inside the bundle, there is no separate `rt-darwin-*.tar.gz` asset
- `SHA256SUMS` over the dmg/zip (the workflow's Checksums step). Sparkle
  `.delta` files are attempted but never materialize, by accepted decision
  (MAT-395): `build.sh` signs every plain file under `Contents/Helpers`
  individually, codesign stores those signatures as extended attributes, and
  Sparkle's `BinaryDelta` refuses to diff xattr'd trees. `appcast.sh`
  tolerates the delta failure and every update ships as the full ~260 MB
  zip; the update leg is proven on that path. Revisit only if the user base
  or update cadence makes delta bandwidth matter, or if the Helpers tree is
  restructured for another reason.
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

## Privileged proxy helper (mattstack-proxy-install)

The bundle ships a first-party Swift helper, `rt-tray/proxy-helper/`, built
by `build.sh` into `Contents/Helpers/mattstack-proxy-install` and signed like
every other helper. It is what lets `proxy.install` (`rt setup apply`)
install portless as a root LaunchDaemon on 443 instead of skipping. portless
itself is vendored and pinned through `rt-tray/deps.lock` like any other
third-party tool (`bundlePath: Contents/Helpers/portless-dist`); the already
bundled `node` row runs it, so no extra runtime ships. The helper's argv
contract (`install`, `remove`, `trust`, `--version`) is consumed by
`PrivilegedInstaller.swift` in this same repo, which is why it is a checked-in
SwiftPM target rather than a deps.lock-pinned release artifact.

Pin model: root must never run a payload it cannot verify, so `install`
refuses a `portless-dist`/`node` tree whose sha256 does not match the values
compiled into the helper at build time. Those pins come from
`rt-tray/proxy-helper/scripts/gen-pins.sh <app-version> <portless-dist-dir>
<node-binary>` (three required path arguments, no default for any of them).
`build.sh` runs it AFTER the Helpers signing loop, not before: codesign
rewrites a Mach-O in place, so a pin taken from the fetched (pre-sign) dep
would describe bytes that never ship, and the helper would refuse its own
payload at install time. `check-bundle.sh` re-asserts the shipped
`--version` line, the codesign identifier
(`com.mattstack.helper.mattstack-proxy-install`), and that `portless-dist`
ships, so a build that skips or reorders `gen-pins.sh` fails there instead of
at install time on someone's machine.

Install raises two admin dialogs, not one: the escalation prompt
(`AuthorizationExecuteWithPrivileges`) that reaches the helper at all, and
then macOS's own Certificate Trust Settings prompt for `security
add-trusted-cert`. The two cannot collapse into one: `com.apple.trust-settings.admin`
requires its own interactive `authenticate-admin` every time, root and
Developer ID signing included, and the credential the first prompt collected
is never reused for the second. `NeedModels.swift`'s prompt text says so up
front ("macOS will ask twice").

CA trust is the one non-fatal step in the install, and it runs LAST, after
`launchctl bootstrap`: portless does not mint its CA until the daemon it just
started actually runs, so there is nothing to trust until the LaunchDaemon is
up (the helper polls for `ca.pem` for up to 20s). A declined or failed trust
write does not fail the install: the proxy installs and serves untrusted,
and the outcome travels back on its own stdout line
(`MATTSTACK_TRUST=ok|declined|failed`) ahead of the `MATTSTACK_EXIT` trailer.
The `tool.proxy` validator row (`lib/setup/validators/tools.ts`) turns an
untrusted-but-current-version install into a `needs-you` row ("Browsers will
warn until the proxy certificate is trusted") with a "Trust certificate"
action; a version-drifted install gets the same treatment with "Update
proxy". Both actions, and a plain "Install proxy", resolve to the same
`setup apply --only proxy.install` verb (`--only` runs that step alone, where
`--from` would carry the rest of the install behind it): the step itself reads
plist presence, deployed-vs-pinned version, and CA trust state, and decides
whether to install, update, adopt a portless install that predates mattstack
(a plist with no VERSION beside it), or only re-run the trust write (the
helper's `trust` op, reached through its own tray route
`POST /privileged/proxy-trust` beside
`/privileged/proxy-install`), so no remedy can point at a route that disagrees
with what the row reported.

A version-drifted proxy (the deployed `/Library/Application
Support/mattstack/proxy/VERSION` disagreeing with the bundle's pinned
portless) re-runs that same install step rather than a separate update path:
the helper boots the running daemon out before bootstrapping the
replacement, so an update costs one admin prompt, same as a fresh install,
and root never follows a bundle update on its own.

Remove ties into `rt uninstall`'s existing `proxy.remove` action: bootout,
delete the plist and the sudoers rule, delete the CA from the System
keychain (its common name is read back from the installed `ca.pem`, since
deletion has to name the certificate), and delete the root copy. Every step
is idempotent: absence at any point is success, not something to report as
a failure.

Full security model and rulings: `docs/superpowers/specs/2026-09-08-proxy-helper-design.md`.

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
The update path is proven in the VM harness (MAT-394, rt#195): silent
in-place install and relaunch, daemon restart, `rt --version`, 2.8.0 to a
real 2.8.1 build. The prod-Mac leg (Create Release → appcast → an installed
app on real hardware) still awaits the first real tag; treat that first run
as a verification exercise, not a routine.

## App-bundle CI (bundle-apps.yml)

`.github/workflows/bundle-apps.yml` builds the managed mattstack apps from
source and pins them into `rt-tray/deps.lock`. Manual dispatch only: inputs
are `apps` (comma-separated names, or `all`) and `dry_run` (build and hash,
skip release and PR). Four jobs: plan resolves the matrix from deps.lock rows
carrying a `repo` field; build runs on macos-15 (arm64), one leg per app;
release publishes the packaged tarballs; the PR job opens one deps.lock PR on
`bundle-ci/<run_id>`. Nothing pushes to main.

Since the apps fold-in (m4ttstack/apps, 2026-09-06): chat, console, board and
deck are monorepo rows whose deps.lock entry carries `subdir` (e.g.
`apps/chat`) alongside `repo`. A subdir leg installs the workspace and builds
tui-kit's dist before the app's own recipe (recipe and version read from the
subdir), and its releases land on m4ttstack/apps under app-prefixed tags
(`chat-v0.1.1`) because two apps can share a bare version. Rows without
`subdir` (gitq) keep plain `v` tags and single-repo behavior. There is no npm
auth step: platform packages resolve in-workspace and every remaining
registry dep is public. The old app repos were DELETED 2026-09-07 on
Matt's loud-failure ruling: branches live as archive/<app>/* refs and every
release is ported byte-identical to m4ttstack/apps under prefixed tags, but
pre-cutover mattstack.app tags (v2.8.0 included) rebuild only after
hand-pointing their deps.lock at the ported assets (the cutover
brief lives at docs/bundle-cutover-brief.md in m4ttstack/apps).

Release is a separate job on purpose. The build job runs each app repo's own
recipe verbatim, and a recipe can write `GITHUB_ENV` and `GITHUB_PATH`, so no
step holding the release token may follow it in the same job... a poisoned
PATH would otherwise hand that token to an attacker-controlled `gh`. The
build job's own token use (clone, tag guard) all happens before the recipe
runs.

Two declarations drive it, each owned by the party that knows it:

- `repo` on the deps.lock row (`"m4ttstack/<repo>"`) marks the app
  buildable. Rows without it (jq, node, cloudflared...) are third-party
  pins the pipeline never touches.
- `bundle: { build, artifact }` in the app's `mattstack.deck.json` is the
  compile recipe, run verbatim at the app's root: the repo root for
  single-repo rows, `subdir` for monorepo rows. A dispatched app whose
  manifest lacks it fails that leg loudly with the remediation; that
  failure IS the pairing enforcement between the two declarations.

Version and tag rules: the version comes from the app root's
`package.json` (a missing version fails the leg, never a `vundefined`
release); the tag is `v<version>` for single-repo rows and
`<name>-v<version>` for monorepo rows. The guard checks the git tag ref,
so a bare pre-existing tag refuses just like a full release... published
artifacts are immutable; bump the version instead. One leg failing never
blocks the others
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
- `NPM_READ_TOKEN` ... no longer used: tui-kit and the other platform
  packages resolve in-workspace since the apps fold-in, and the registry
  deps the legs still reach are public. The secret can stay configured
  harmlessly; reintroduce its npmrc step only if a leg ever resolves a
  restricted registry package again.

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
