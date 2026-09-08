# Privileged proxy helper (mattstack-proxy-install) — design

RT-106. Ships the helper the app already knows how to run, so `proxy.install`
stops skipping and fresh installs serve the bundled apps on `.mattstack`
domains instead of raw ports. Rulings ratified with Matt 2026-09-07/08:
portless is vendored and pinned through deps.lock (root never runs unpinned
registry code); the steady state is a root LaunchDaemon running portless on
443 per the deck-lane contract (`sh.portless.proxy` / 443 / `~/.portless`);
the helper is first-party Swift built inside rt-tray's own build; every root
change is an explicit admin prompt, never an auto-follow.

## What exists already (verified in source)

- `PrivilegedInstaller.swift` dispatches `install` / `remove` to
  `ProxyHelper.relativePath` = `Contents/Helpers/mattstack-proxy-install`
  through `AuthorizationExecuteWithPrivileges` with the one prompt
  (`ProxyHelper.promptText`, `Sources-core/Needs/NeedModels.swift:19-21`).
  The app side needs no changes to invoke the helper.
- `proxy.install` is an Install need that currently answers "proxy-install
  helper is not bundled" and the step skips with reason (3c90cc6f).
- `rt-tray/deps.lock` carries the row as `status: "pending"` with empty
  url/sha.
- deck consumes portless as an external service and documents the manual
  setup this helper replaces (`npm i -g portless; portless trust; portless
  service install`, deck README). portless is a third-party npm package
  (maintainers ctate + a Vercel release bot; 0.15.6 at spec time).
- The deck-lane contract (2026-08-21, binding): label `sh.portless.proxy`,
  port 443, `~/.portless` state, routes.json watched BY INODE (writers write
  in place), sudoers NOPASSWD kickstart rule for deck reload must survive.

## Components

### 1. Vendored portless (deps.lock)

Two new third-party rows, pinned url+sha256 like every other vendor pin:

- `portless` — the npm registry tarball
  (`https://registry.npmjs.org/portless/-/portless-<ver>.tgz`), extracted
  into the bundle under `Contents/Helpers/portless-dist/` (kind `helper`,
  `exposeByDefault: false`, entitlements `none`). It is JS, not Mach-O; the
  seal signs its files as resources, same as fast-browser's tree.
- The runtime is the already-bundled `node` row; no new runtime ships.

Upgrades ride deps.lock bumps: a new portless version is a PR changing
url+sha, and reaches root only through the helper's explicit re-run (see
Update story).

### 2. The helper (first-party Swift, in-repo)

`rt-tray/proxy-helper/` — a SwiftPM executable target built by
`rt-tray/build.sh` into `Contents/Helpers/mattstack-proxy-install`, signed
inside the seal like every helper. Swift, not a Bun compile: a root binary
must not carry `allow-jit`, and Swift shares the repo's toolchain.

Why in-repo rather than a bundle-apps release row: the helper's argv/ops
contract is consumed by `PrivilegedInstaller.swift` in the same repo, so
they must ship in lockstep; a release-artifact row would make the app's own
release circular (the release builds the app that bundles the helper); and
a ~100KB root binary does not deserve its own tag lifecycle. Consequence:
the pending deps.lock row is REMOVED (a bundled row requires a url by
schema), and `check-bundle.sh` gets an explicit first-party assertion — the
same allowance rt-ui has, plus the runs-from-the-seal smoke the deps.lock
loop gives fetched helpers.

Ops (argv, no flags, no paths from argv — every path is compiled in):

- `install` — idempotent, runs as root:
  1. Copy `Contents/Helpers/portless-dist` and the bundled `node` binary
     from the invoking bundle to `/Library/Application Support/mattstack/
     proxy/` (root-owned, 755 dirs / 644 files, binaries 755). The
     LaunchDaemon never execs from `/Applications`: a user-writable bundle
     path executed as root is an escalation. The copy source is the
     helper's own bundle root (derived from its executable path), and the
     copy VERIFIES the expected layout before replacing the previous root
     copy (stage + rename, never in-place).
  2. Write `/Library/LaunchDaemons/sh.portless.proxy.plist`: label
     `sh.portless.proxy`, program the root-copied node + portless
     entrypoint, port 443, `KeepAlive`, `RunAtLoad`, state under the
     invoking user's `~/.portless` (`UserName` stays root for 443;
     portless's state dir is passed explicitly — the contract keeps
     `~/.portless` as the state home).
  3. Trust the portless CA: run the root-copied portless's own trust
     routine (`portless trust`), which installs the local CA into the
     system keychain so `https://<app>.mattstack` is green.
  4. Write `/etc/sudoers.d/mattstack-portless` with the NOPASSWD rule for
     the deck-reload kickstart (`launchctl kickstart -k
     system/sh.portless.proxy`), `visudo -c`-validated before install;
     a failed validation removes the candidate file and fails the op.
  5. `launchctl bootstrap system` the plist (bootout first when present —
     re-install is the update path).
  Output: one line per sub-step to stdout; non-zero exit + stderr detail on
  the first failure. The app relays stdout/stderr into `NeedResult` today.
- `remove` — bootout + delete the plist, the sudoers file, the CA trust,
  and the root copy. Wired into `rt uninstall` (installer ruling 14) and
  the app's existing `proxyRemove()`.

### 3. Wiring

- `proxy.install` runs the need instead of skipping; the skip-with-reason
  path stays for the genuinely-not-bundled case (old bundles).
- The `proxy.install` validator compares the root copy's portless version
  (`/Library/Application Support/mattstack/proxy/VERSION`, written by the
  helper at install) against the bundle's pinned version: match = ready,
  drift = needs-you with an "Update proxy" action that re-runs the helper
  (one prompt). Root never auto-follows a bundle update.
- deck: no changes — it already talks to portless and holds the kickstart
  path; the sudoers rule is what makes its reload work on a fresh machine.

## Error handling

- Every helper sub-step failure is fatal for the op, reported on stderr,
  and leaves the previous state in place (stage+rename for the copy; plist
  and sudoers writes are single-file renames; bootstrap failure rolls back
  the plist it just wrote).
- The app already logs helper stdout/stderr through `TrayLog` and returns
  `NeedResult(ok:false)` upward; `proxy.install` then reports failed with
  the stderr detail, never skipped.
- A machine where the user declines the admin prompt: the escalator
  returns failure; the step reports needs-you ("administrator approval
  declined") and Install continues — the checklist row rule (a row only
  Install can satisfy must not gate Install) does not apply here since
  proxy.install IS an Install step; it completes degraded exactly as today.

## Testing

- Unit (Swift): the helper's plist/sudoers/copy logic behind a filesystem
  seam; golden plist and sudoers fixtures; layout-verification refuses a
  malformed portless-dist.
- Unit (TS): validator version-compare truth table (match/drift/missing);
  need wiring unchanged contract.
- `check-bundle.sh`: asserts the helper exists in the seal, is signed, and
  `--version` runs from inside the bundle (first-party allowance).
- VM (the release gate, per the ticket): `walkthrough.sh --scenario create
  --no-graphics` shows `proxy.install: done`;
  `/Library/LaunchDaemons/sh.portless.proxy.plist` present in the guest;
  and `curl -fsS https://deck.mattstack` (or the guest's configured app
  domain) answers through the proxy. The admin prompt is answered by the
  existing SecurityAgent driver from the update leg.

## Out of scope

- Funnel/public URLs (`portless --funnel`), multi-user machines (the
  second-user smoke covers the daemon surviving a different console user,
  MAT-397), and any deck routing changes.
- MAT-400 (every bundled app resolves on its domain) is the follow-on
  verification pass once this ships.
