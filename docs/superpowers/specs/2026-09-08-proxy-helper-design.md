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
inside the seal like every helper. Swift, not a Bun compile: the ESCALATED
INSTALLER binary should not need `allow-jit` (the bundled node the daemon
runs keeps its `jit` entitlement from deps.lock — do not strip it), and
Swift shares the repo's toolchain.

Why in-repo rather than a bundle-apps release row: the helper's argv/ops
contract is consumed by `PrivilegedInstaller.swift` in the same repo, so
they must ship in lockstep; a release-artifact row would make the app's own
release circular (the release builds the app that bundles the helper); and
a ~100KB root binary does not deserve its own tag lifecycle. Consequence:
the pending deps.lock row is REMOVED (a bundled row requires a url by
schema), and `check-bundle.sh` gets an explicit first-party assertion — the
same allowance rt-ui has, plus the runs-from-the-seal smoke the deps.lock
loop gives fetched helpers.

Ops (argv; the only flag is an unprivileged `--version`, for
check-bundle's runs-from-the-seal smoke; no paths from argv — every path is
compiled in):

- `install` — idempotent, runs as root:
  1. Copy `Contents/Helpers/portless-dist` and the bundled `node` binary
     from the invoking bundle to `/Library/Application Support/mattstack/
     proxy/` (root-owned, 755 dirs / 644 files, binaries 755). The
     LaunchDaemon never execs from `/Applications`: a user-writable bundle
     path executed as root is an escalation. The copy source is the
     helper's own bundle root (derived from its executable path), and
     before anything is staged the helper verifies the SOURCE CONTENT, not
     just layout: the portless-dist tree and node binary must match
     sha256s compiled into the helper at build time from deps.lock — a
     swapped tree in the user-writable bundle must fail the op, or root
     runs attacker code forever under KeepAlive. The target chain is
     guarded too: `/Library/Application Support` is admin-group writable,
     so the helper refuses a pre-existing `mattstack/` path segment that
     is non-root-owned or a symlink before creating/using it. Then stage +
     rename (staging sibling to the target, same filesystem), never
     in-place.
  2. Write `/Library/LaunchDaemons/sh.portless.proxy.plist`: label
     `sh.portless.proxy`, program the root-copied node + portless
     entrypoint, port 443, `KeepAlive`, `RunAtLoad`, state under the
     invoking user's `~/.portless` (`UserName` stays root for 443; the
     state dir is passed via `PORTLESS_STATE_DIR` in the plist
     environment — verified supported by portless's cli — pointing at the
     invoking user's `~/.portless` per the deck-lane contract; the trust
     run gets the same variable).
  3. Trust the portless CA (NON-FATAL): run
     `security add-trusted-cert -d -r trustRoot -k
     /Library/Keychains/System.keychain <ca.pem>` as root. macOS gates
     this write behind `com.apple.trust-settings.admin`, whose rule is
     `entitled OR authenticate-admin` with `timeout 0`: no Developer ID
     process, root included, can write CA trust without an interactive
     prompt, and the admin credential from the escalation prompt is never
     reused for it. So the install raises TWO dialogs, the admin prompt and
     then macOS's "Certificate Trust Settings" prompt, and the copy says so
     (`NeedModels.swift` promises "once" today; it must say two). A
     cancelled or failed trust write does not stop the op: the helper
     records `trust: declined|failed <detail>` on stdout and continues to
     steps 4 and 5, so the proxy installs and runs untrusted. The trust
     outcome travels in the stdout report (a `MATTSTACK_TRUST=<ok|declined|
     failed>` line before the exit trailer); step 5's bootstrap remains the
     op's success criterion.
  4. Write `/etc/sudoers.d/mattstack-portless` granting exactly the
     invoking user (the console user who ran Install, resolved as the
     GUI session's user via `SCDynamicStoreCopyConsoleUser`, never
     `%admin`) NOPASSWD for
     the one command `launchctl kickstart -k system/sh.portless.proxy`;
     `visudo -c`-validated via a sibling temp file on the same filesystem;
     a failed validation removes the candidate and fails the op.
  5. `launchctl bootstrap system` the plist (bootout first when present —
     re-install is the update path).
  Output contract (dictated by the escalator, PrivilegedInstaller.swift
  93-106): `AuthorizationExecuteWithPrivileges` pipes ONLY the child's
  stdout and recovers no real exit code — the helper must end every run
  with a `MATTSTACK_EXIT=<n>` trailer on stdout, and a missing trailer
  parses as success. So: one line per sub-step to stdout, failure detail to
  stdout (there is no stderr channel), and the trailer is written on every
  path the helper can catch. The app relays that stdout into `NeedResult`.
- `remove` — bootout + delete the plist, the sudoers file, the CA trust,
  and the root copy. Wired into `rt uninstall` (installer ruling 14) and
  the app's existing `proxyRemove()`.
- `trust` — re-runs only the CA trust write (install step 3) against the
  root copy's `ca.pem`, same `MATTSTACK_TRUST` line and exit trailer, no
  other side effects. It is the Retry behind the untrusted-certificate row
  and raises macOS's trust prompt (one dialog, plus the escalation prompt
  that reaches the helper at all).

### 3. Wiring

- `proxy.install` runs the need instead of skipping. The skip gate at
  lib/setup/steps/services.ts:57 resolves today through `bundledToolPath`,
  which reads the bundle's deps.lock and returns null without a
  `status: "bundled"` row — with the row removed it would skip forever. The
  gate is re-pointed at a direct first-party existence check of
  `Contents/Helpers/mattstack-proxy-install` under the resolved bundle
  (rt-ui-style resolution), and the skip-with-reason path remains for
  bundles where that file genuinely is absent (old installs).
- The `proxy.install` validator compares the root copy's portless version
  (`/Library/Application Support/mattstack/proxy/VERSION`, written by the
  helper at install) against the bundle's pinned version: match = ready,
  drift = needs-you with an "Update proxy" action that re-runs the helper
  (one prompt). Root never auto-follows a bundle update.
- The same validator checks CA trust: the root copy's `ca.pem` must be
  present in the System keychain with trustRoot settings (`security
  verify-cert -c <ca.pem> -p ssl` under the admin trust domain, or the
  equivalent `security dump-trust-settings -d` match). Version-match but
  untrusted = needs-you ("Browsers will warn until the proxy certificate is
  trusted") with a "Trust certificate" action that runs the helper's `trust`
  verb through the tray's escalator (`POST /privileged/proxy-trust`, the
  sibling of the existing proxy-install route). The proxy keeps serving in
  that state; only browser trust is missing.
- deck: no changes — it already talks to portless and holds the kickstart
  path; the sudoers rule is what makes its reload work on a fresh machine.

## Error handling

- The CA trust step is the one non-fatal sub-step: declined or failed, it
  is reported on the `MATTSTACK_TRUST` line and the op proceeds; the
  validator turns that into the untrusted-certificate needs-you row with
  its Retry. Every OTHER helper sub-step failure is fatal for the op: detail goes to stdout
  (the only channel) followed by a non-zero `MATTSTACK_EXIT` trailer, and
  the previous state stays in place (stage+rename for the copy; plist and
  sudoers writes are single-file renames; bootstrap failure rolls back the
  plist it just wrote).
- The app parses the trailer and synthesizes `NeedResult` / `TrayLog`
  detail from that stdout (PrivilegedInstaller.swift maps a failed run's
  output into its stderr field); `proxy.install` then reports failed with
  that detail, never skipped.
- A machine where the user declines the admin prompt: the escalator
  returns failure; the step reports needs-you ("administrator approval
  declined") and Install continues, completing degraded exactly as today.

## Testing

- Unit (Swift): the helper's plist/sudoers/copy logic behind a filesystem
  seam; golden plist and sudoers fixtures; content verification refuses a
  swapped portless-dist even when its layout is valid (tree hash mismatch
  against the compiled-in sha256s).
- Unit (TS): validator version-compare truth table (match/drift/missing);
  need wiring unchanged contract.
- `check-bundle.sh`: asserts the helper exists in the seal, is signed, and
  `--version` runs from inside the bundle (first-party allowance).
- VM (the release gate, per the ticket): `walkthrough.sh --scenario create
  --no-graphics` shows `proxy.install: done`;
  `/Library/LaunchDaemons/sh.portless.proxy.plist` present in the guest;
  and a `.mattstack` hostname read back from `~/.portless/routes.json`
  answers through the proxy over TLS (`deck.mattstack` itself exists only
  after `deck setup`, which rt never runs; the deck lane owns that). Both
  dialogs are answered by the SecurityAgent driver, which resolves each
  window by its wording, never by index. A second guest run declines the
  trust prompt and asserts the proxy still serves and `tool.proxy` shows the
  untrusted-certificate needs-you row; a `trust` verb run then clears it.
- Unit (Swift): the trust step's declined and failed outcomes leave the op
  running and emit `MATTSTACK_TRUST`; the `trust` verb touches nothing but
  trust settings.

## Out of scope

- Funnel/public URLs (`portless --funnel`), multi-user machines (the
  second-user smoke covers the daemon surviving a different console user,
  MAT-397), and any deck routing changes.
- MAT-400 (every bundled app resolves on its domain) is the follow-on
  verification pass once this ships.
