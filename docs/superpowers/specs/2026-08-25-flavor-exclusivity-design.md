# Flavor exclusivity — one intended mode, enforced everywhere

**Status**: ratified 2026-08-25 (Matt, via forms) · **Scope**: full set — TS
self-heal + Swift tray enforcement in one push.

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
   setting, written only by the dev-mode toggle. Unset ⇒ derived at read
   from the wrapper state, with provenance; never silently written.
3. **Both surfaces now** — TS (daemon/CLI, hot-deployable via the dev
   shim) and Swift (tray, requires a bundle rebuild + blessing round).

## Components

### 1. `mattstack.mode` (settings)

- Machine scope, registered per docs/settings-architecture.md (registry
  entry + checklist; call-time HOME rules apply).
- Readers get `{ value, provenance }`; when unset, resolution derives from
  the dev wrapper's presence and reports `derived-from-wrapper`.
- The ONLY writer is the dev-mode toggle, after a successful handoff.

### 2. Daemon: flavor resolution + park-based stand-down

- At boot, before any socket work, the daemon resolves its own flavor:
  running-from-source (shim) ⇒ dev; compiled ⇒ prod.
- Mismatch with intended mode ⇒ **park**: one `info` log naming flavor,
  intended mode, and remedy; then re-read the setting every 30s. On match,
  continue boot. No exit, so no launchd respawn churn; flipping the toggle
  converts a parked daemon into the serving one within ~30s.
- Socket-bind failure while matched ⇒ **standoff handling**: query the
  holder's identity over the socket (component 3), log
  `standoff: rt.sock held by <flavor> pid <n>` (a holder that predates the
  identity payload logs as `unknown flavor`), retry on the same 30s
  cadence. With stand-down live, the wrong holder drains and the retry
  wins.

### 3. Identity in the daemon's hello

- The daemon's status/info payload gains
  `{ flavor, version, sourceRev, startedAt }` (`sourceRev` = checkout HEAD
  at boot for dev; release version for prod).
- `rt daemon status` prints the identity line and cross-checks the tuple
  (intended mode, CLI flavor, serving daemon flavor); any disagreement is
  a yellow warning naming the exact remedy.
- `stop/start/restart/install` print which flavor they are addressing,
  and say plainly when the socket's owner is not that flavor instead of
  reporting a false "✓".

### 4. Verify: `flavor coherence` row

- One critical row asserting the tuple agrees; detail names each leg
  (setting, wrapper, daemon). Subsumes the misleading scatter of
  false-negatives a half-state produces today. (Dev-aware bundle lookup
  for `tool.app` stays in RT-64 — c3's lane.)

### 5. Toggle: repair, not just switch

- Guard compares the full tuple; "already in dev mode" only when all legs
  agree. Any mismatch runs the complete handoff and writes
  `mattstack.mode`.
- Bare `rt settings dev-mode` without a TTY prints the tuple read-only
  (today it refuses with "requires an interactive terminal") — the
  inspection path a half-state diagnosis needs.

### 6. Swift tray: enforcement at the root

All four behaviors key off the same `mattstack.mode` read (via the
bundled rt binary, `rt settings get mattstack.mode --json`, at launch and
on a foreground re-check):

- **Self-unregister**: at LOGIN launch with a flavor mismatch, the wrong
  tray unregisters its own daemon agent and login item
  (`SMAppService.unregister` is self-only — no other process can), posts
  a user notification ("mattstack (prod) stood down — this Mac is in dev
  mode"), and quits. Dual registration stops being representable.
- **Manual-launch alert**: when a human double-clicks the wrong flavor,
  show the choice instead: "This Mac is in dev mode" · **Switch to prod
  here** (runs the real handoff, writes the setting) / **Quit**. Never
  the silent path on a deliberate launch.
- **`tray.sock` deference**: a mismatched tray never binds `tray.sock`
  (covers the alert window), so `rt daemon` verbs always reach the
  intended flavor's tray.
- **Badge**: the dev tray's menu-bar icon carries a persistent DEV badge.

### 7. Deployment of the Swift work

- Build into scratch (never touch the blessed bundles in place). Matt
  swaps the new dev bundle in and redoes the TCC/Login Items grants — the
  accepted blessing round. Prod ships with the next release tag.
- Validation: unit-level via the TS suite for everything in 1–5; the
  Swift behaviors are exercised on the real machine during the blessing
  round, and the VM walkthrough revalidates the prod install path when
  the next tag's DMG carries the tray changes.

## Error handling and edges

- Setting unreadable/corrupt ⇒ treat as unset (derive from wrapper),
  warn with provenance. Never park both flavors on a bad read: derivation
  always yields a mode.
- Fresh machine, no wrapper, no setting ⇒ prod (the install default).
- The park loop's setting read is bounded and exception-safe; a read
  error keeps the previous decision and logs at `warn` (catch policy).
- Migration: first boot after merge finds the setting unset — daemons
  derive and proceed; the first toggle run writes it. No migration step.

## Testing

- Unit: mode resolution (set/unset/corrupt), daemon park loop with
  injected setting reads (mismatch→match transition binds), standoff
  logging, status tuple rendering + warning, toggle guard tuple matrix,
  non-TTY read output, verify row states.
- The daemon park/standoff seams are injected (no real launchd in tests),
  matching the existing probes/seams patterns.
- Swift: XCTest for the mode-read + decision function; the four behaviors
  smoke-tested on hardware at the blessing round (checklist in the PR).

## Out of scope

- Any change to the flavor-pair architecture itself (two bundles, two
  labels) — this spec enforces it, not redesigns it.
- RT-64 (dev-aware `tool.app` bundle lookup) — c3's lane.
- Auto-updating the dev bundle; Sparkle remains prod-only.
