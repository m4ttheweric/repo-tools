# Flavor exclusivity — one intended mode, enforced everywhere

**Status**: ratified 2026-08-25 (Matt, via forms); amended same day after
adversarial code review. · **Scope**: full set — TS self-heal + Swift tray
enforcement in one push.

## Why (the 2026-08-25 incident, compressed)

mattstack runs as two complete flavor pairs: prod
(`/Applications/mattstack.app` → agent `com.mattstack.daemon`, compiled
rt-daemon) and dev (`rt-tray/mattstack-dev.app` →
`com.mattstack.daemon.dev`, a source shim running bun against the
checkout). Exclusivity — one registered pair at a time — existed only as a
protocol (the `rt settings dev-mode` handoff: retire → quit → open).
Nothing enforced it. Both pairs sat registered for days; when the dev
daemon exited overnight, prod's keepalive respawned a four-day-stale
compiled daemon which bound `rt.sock`. Every repair surface then failed:
`rt daemon stop` reported success while acting on the wrong flavor (verbs
route via whichever tray owns `tray.sock`), `rt daemon install`
resurrected the prod registration, the dev-mode toggle's early guard read
only the CLI side ("already in dev mode"), and the dev agent's socket
guard exited 1 indistinguishably from a crash. Recovery required a raw
`launchctl bootout`.

## Ratified decisions

1. **Self-heal to recorded intent** — a daemon or tray whose flavor does
   not match the machine's declared mode stands down; the matching flavor
   serves. No hard-stop, no first-to-bind race.
2. **Intent lives in `mattstack.mode`** — a `"dev" | "prod"` machine-store
   setting, normally written by the dev-mode toggle. Unset ⇒ derived at
   read from the wrapper state, with provenance.
3. **Both surfaces now** — TS (daemon/CLI, hot-deployable via the dev
   shim) and Swift (tray, requires a bundle rebuild + blessing round).

## Components

### 1. `mattstack.mode` and the single derivation seam

- Machine scope, registered per docs/settings-architecture.md
  (`mattstack.appPath` at registry-defs.ts:225 is the template row).
  Registry ripple applies: rt-client dist rebuild + `bun install` in the
  `file:` consumers + deck rebundle (checklist steps 2–3).
- **One resolver, used by every consumer**: `resolveIntendedMode()` in
  `lib/dev-mode.ts` — `getSetting("mattstack.mode")`, falling back to
  `currentMode()` (the wrapper check) when unset, returning
  `{ mode, provenance: "setting" | "derived-from-wrapper" }`. The park
  loop, toggle, verify row, daemon verbs, and (via the CLI, component 6)
  the tray all call this seam. The suite-generic `rt settings get` is NOT
  the read path — it reports store values only and drops an unset value
  entirely.
- The toggle writes the setting after a successful handoff. A manual
  `rt settings set mattstack.mode <m> --scope machine` is a **blessed
  escape hatch**, not a violation: the park loop makes the machine
  converge on whatever the setting says (this is the write path a repair
  under a dead tray uses).

### 2. Daemon: park-based stand-down, placed where parking is inert

- `lib/daemon.ts` arms live subsystems at module scope (cron :216, the
  home-snapshot auto-committer :254, events sweeps :159, prune intervals
  :165–213), and `startDaemon()` runs `evictStaleDaemon` — which SIGTERMs
  the pid in the shared `rt.pid` — before binding. **The park check
  therefore runs at the very top of `lib/daemon.ts` module scope**
  (immediately after the logger's existing top-level await, so no new
  bytecode constraint; both entry paths — `rt --daemon` via cli.ts and
  the shim's `bun run lib/daemon.ts` — converge there). A parked daemon
  arms NOTHING: no `evictStaleDaemon`, no `rt.pid` write, no module-scope
  subsystem.
- Flavor self-detection: `typeof RT_VERSION !== "undefined"` ⇒ prod
  (build-wide `--define`, same pattern as lib/plugin-api.ts:18); absent ⇒
  dev. (`import.meta.main` is wrong — false for a dev-wrapper
  `rt --daemon`.) Test invariant: the e2e harness builds a compiled
  binary under an isolated HOME with no wrapper ⇒ prod/prod ⇒ never parks.
- Mismatch with `resolveIntendedMode()` ⇒ **park**: one `info` log naming
  flavor, intended mode, provenance, and remedy; re-resolve every 30s
  (the resolver re-reads stores per call — no caching to defeat). On
  match, continue into the normal boot. launchd math holds: KeepAlive is
  `{SuccessfulExit:false}` for both flavors and the tray's 10s health
  poll only colors the dot — nothing kills a parked daemon.
- **Socket takeover replaces "bind failure" handling** —
  `startSocketServer` today unconditionally unlinks `rt.sock` and binds
  (silent theft; EADDRINUSE cannot happen). Amended contract: before
  binding, probe-connect. Live holder ⇒ query its identity (component 3;
  a pre-identity holder logs as `unknown flavor`), log
  `standoff: rt.sock held by <flavor> pid <n>`, retry on the 30s cadence
  — and skip `evictStaleDaemon`'s SIGTERM of that pid while standing off.
  Dead socket ⇒ unlink + bind.

### 3. Identity in the daemon's hello

- `ping`/`status` payloads gain `{ flavor, version, sourceRev,
  startedAt }` (`ctx.startedAt` exists; `RT_VERSION` for prod, checkout
  HEAD at boot for dev). Today they carry pid/uptime/counters only.
- `rt daemon status` prints the identity line and cross-checks the tuple
  (intended mode, CLI flavor, serving daemon flavor); any disagreement is
  a yellow warning naming the exact remedy.
- `stop/start/restart/install` print which flavor they are addressing,
  verify the socket owner's flavor before claiming "✓", and say plainly
  when the owner is not that flavor. The "open it" hints become
  flavor-aware (`trayAppHintPath()` is prod-only today; `devTrayAppPath`
  exists).

### 4. Verify: `flavor coherence` row

- One critical row asserting the tuple agrees. **Mismatch-only-fails**: a
  mismatch requires a LIVE daemon of the wrong flavor. Daemon down or
  unreachable ⇒ that leg reads "n/a" and the row passes (CI and the
  clean-room gate run `rt verify --ci` with no daemon running — the row
  must not fail there; its `--ci` classification is stated in the
  implementation).
- Dev-aware `tool.app` bundle lookup stays in RT-64 (c3's lane).

### 5. Toggle: repair, not just switch

- Guard compares the full tuple (CLI mode, serving daemon flavor via
  socket identity, `mattstack.mode`); "already in dev mode" only when all
  legs agree. Any mismatch runs the complete handoff and writes the
  setting.
- **Dead-tray repair**: when the wrong flavor's tray is not running, its
  `/flavor/retire` is unreachable and `SMAppService.unregister` is
  self-only — so the toggle's repair path directly boots out the wrong
  daemon label (`launchctl bootout gui/$UID/<label>`) before launching
  the incoming flavor.
- Bare `rt settings dev-mode` without a TTY prints the tuple read-only
  with `--json` support (this is also the tray's mode-read verb). Two
  seams change together: the tree's `requiresTTY` predicate
  (lib/command-tree-def.ts:841) AND the handler's own non-TTY guard
  (commands/settings.ts:689) — fixing only one leaves the other exit.

### 6. Swift tray: enforcement at the root

- **Mode read**: exec the CLI's read-only verb (component 5) via
  `RtBinaryLocator` — with the locator amended so the DEV flavor never
  falls back to its bundled `Contents/MacOS/rt`, which is the daemon
  shim: invoking it as a CLI starts a rogue daemon. No `~/.local/bin/rt`
  and no usable CLI ⇒ the read FAILS, and **failure means serve**: treat
  as match, log, re-check on next foreground activation. Never
  unregister or defer the socket on a failed or ambiguous read.
- **Login-launch self-unregister**: launched as a login item (detected
  via the launch event's `keyAELaunchedAsLogInItem`; when detection is
  uncertain, fall through to the alert — never silently unregister on
  uncertainty) with a flavor mismatch ⇒ unregister own daemon agent +
  login item, post a user notification ("mattstack (prod) stood down —
  this Mac is in dev mode"), quit.
- **Manual-launch alert**: deliberate launch of the wrong flavor shows
  the choice: "This Mac is in dev mode" · **Switch to prod here** (runs
  the real toggle with an explicit target, as GeneralPane already does) /
  **Quit**. After a switch in the incoming tray's favor, the already-
  running unbound tray must transition itself to serving (bind tray.sock,
  registerAll, login item) or relaunch — `open` alone only activates it.
- **`tray.sock` deference, both directions**: a mismatched tray never
  binds. AND the matched tray no longer blind-exits when another tray
  holds the socket (`exitIfAnotherTrayOwnsSocket` today exits ANY later
  tray): tray `/health` gains a `flavor` field; on finding a live
  wrong-flavor holder, the matched tray asks it to retire/stand down,
  then takes the socket.
- **DEV badge**: already ships (AppDelegate.swift:357 renders the orange
  " dev" mark, MAT-383) — keep, don't rebuild.

### 7. Deployment and migration

- Swift builds into scratch (never touch blessed bundles in place); Matt
  swaps the new dev bundle in and redoes the TCC/Login Items grants.
  Prod ships with the next release tag; the VM walkthrough revalidates
  the prod install path at that tag.
- **Old code cannot self-heal**: a wrong-flavor daemon actually serving
  is by definition running pre-amendment code and never drains on its
  own; the wrong flavor's agent stays registered until that flavor's NEW
  tray next launches. So dual registration becomes unrepresentable
  *eventually* (next login of new-code trays), and the migration includes
  a **one-time cleanup**: run the toggle once (its repair path now covers
  the dead-tray case), or manually `launchctl bootout` the wrong label.
- First boot after merge: setting unset ⇒ daemons derive from the
  wrapper and proceed; the first toggle run writes it. No data migration.

## Error handling and edges

- Setting unreadable/corrupt ⇒ treat as unset (derive from wrapper), warn
  with provenance. Derivation always yields a mode — both flavors can
  never park simultaneously.
- Fresh machine, no wrapper, no setting ⇒ prod (the install default; the
  clean-room and e2e flows depend on this).
- The park loop's resolver call is bounded and exception-safe; a read
  error keeps the previous decision and logs at `warn` (catch policy).

## Testing

- Unit: `resolveIntendedMode` (set/unset/corrupt/provenance), park
  decision with injected resolver reads (mismatch→match transition
  proceeds to boot), socket probe-takeover states (live-match /
  live-mismatch / dead), status tuple rendering + warning, toggle guard
  tuple matrix incl. dead-tray bootout path, non-TTY read output (both
  seams), verify row states incl. daemon-down ⇒ pass.
- Daemon park/standoff seams are injected (no real launchd in tests),
  matching the existing probes/seams patterns. E2e invariant: compiled
  binary + no wrapper ⇒ prod/prod ⇒ boots normally.
- Swift: XCTest for the mode-read + decision function (failure ⇒ serve);
  the four behaviors smoke-tested on hardware at the blessing round
  (checklist in the PR).

## Out of scope

- Any change to the flavor-pair architecture itself (two bundles, two
  labels) — this spec enforces it, not redesigns it.
- RT-64 (dev-aware `tool.app` bundle lookup) — c3's lane.
- Auto-updating the dev bundle; Sparkle remains prod-only.
