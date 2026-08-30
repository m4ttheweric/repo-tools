# Structure that stops the rot (Phase 5 / RT-82)

Design record for Phase 5 of the rt daemon stability roadmap, the
architectural phase. It restructures the daemon around a lifecycle seam,
puts every out-of-process command behind a typed contract, gives each
concept one owner, sheds the CLI picker from the daemon bundle, bounds
state growth, adds the seam tests those refactors make possible, and
decomposes the worktree reconciler last. Basis: the daemon stability
audit's "Roadmap > Phase 5" plus a re-verification of every named
finding against this branch (waves 1 and 2 merged), because several
were already retired by that work and 5.7's file is being rewritten by
the in-flight Phase 4.

This job produces the spec and the plan only. Execution is deferred by
the dispatcher: Phase 5 restructures every subsystem, including the
reconciler Phase 4 is editing right now, so the roadmap runs it alone on
top of everything else.

## What waves 1, 2 and delivery-v2 already retired

Re-verification found these Phase 5 findings already closed on this
branch. They are out of scope here and are listed so the plan does not
re-open them:

- **R010, R033, R034** (chat/agent input validation): `chat:post`/`chat:dm`
  now validate room, handle, body, mentions and room-existence;
  `chat:join` `wakeOn` and `agent:start`/`agent:resume` `surface` are
  enum-checked; `chat:read`/`chat:messages` clamp `limit` to [1, 500].
- **S085** (REST query coercion): `coerceQueryParams` at the api-server
  seam converts `?maxAgeMs`/`?refresh=true` to number/boolean for every
  GET route before dispatch.
- **S102** (chat pulse hot-path scan): the `chat:pulse` /
  `unreadWakingCount` mechanism was deleted in delivery-v2; delivery is
  socket-push, and the `armed_at` column is vestigial.
- **R026, R018** (lifecycle and crash-path tests): eviction, cleanup file
  ownership, signal exit codes, boot-failure, crash handler,
  logger-init-failure and alive-not-serving all have tests now.
- **R023** (`clearAllArmed` invariant): obsolete; the armed-doorbell model
  is gone.
- **S065** (reconciler kick dropped mid-pass): landed with a regression
  test; a kick during an in-flight pass or hold is now queued and fired
  in `finally`. 5.7 must preserve this behavior and its test.

Everything below is a finding re-verified as still open (fully or
partially) against the current tree.

## 5.1 A lifecycle seam

Today `lib/daemon.ts` arms roughly twenty live side effects at module
import, before `startDaemon()` runs: timers, `events.db` open, a git
spawn, a login-shell PATH scrape, and the construction-and-arm of cron,
the reconciler, home-snapshot, the agent-status poller, and (added by
Phase 2, following the same pattern) the health sampler and loop monitor.
`startDaemon()` is a thin wrapper over `runDaemon()`, which then wires the
serving half (state.db, handlers, servers, pollers, freshness,
discussions). Cleanup is hand-listed in two places (`cleanup()` plus
`shutdown.ts` `cleanupCore`); some subsystems have no `stop()` at all
(`startPollers` returns `void`, so its intervals are never cleared at
shutdown); `state.db` is never closed; and the ordering rules survive
only as MUST/BEFORE/AFTER comments. This is R006, R009, R019, R020, R031,
R022. Phase 2's Phase-0 work already fixed the state.db-at-module-scope
half of R006 and the `eventsBus.close()` half of R022.

### The unit interface (decision)

**Option A (recommended): one ordered unit list built inside
`startDaemon()`.** A `DaemonUnit` is `{ name: string; start(): Promise<void>
| void; stop(): Promise<void> | void }`. `startDaemon(opts)` constructs a
`BootContext` and an ordered `DaemonUnit[]`, starts them in order, and on
shutdown stops them in reverse; nothing arms at import (only the
`import.meta.main` call to `startDaemon()` stays at module scope). A unit
that produces a handle later units consume (the logger, the events bus,
the state db, the servers) writes it onto the `BootContext` as it starts,
so a later unit reads it by name rather than a module singleton. This is
the audit's R009 fix verbatim, it is the only shape that retires R006's
root (arming-at-import), and it matches the `createX(deps)` factories
several subsystems already expose (events-bus, pollers, health-sampler,
loop-monitor, reconciler, cache-refresh are already this shape).

**Option B: a disposal registry only.** Keep construction where it is,
add a central `register({name, stop})` so `cleanup()` derives from
registrations. Smaller diff, retires R009's cleanup half and R022, but
leaves R006 (arming at import) and R031 (module singletons) standing, and
Phase 2 shows the module-scope pattern actively growing. Rejected as a
half-measure for the phase whose entire point is the seam.

The three sweep timers (R019) become units through one
`scheduleSweep(name, fn, { bootDelayMs, intervalMs })` helper that extends
the existing `lib/daemon/safe-timers.ts` and returns a stop handle;
`events`, `pruneRuns` and `pruneLogs` each become a one-line
registration, and the later retention sweeps (5.5) hang off the same
helper.

`emit()`'s per-event business logic and the duplicated frame
construction (R020) move behind the bus: the events bus owns one
`emitEvent(topic, payload)` that builds the frame and fans out, plus an
`onBroadcast(type, fn)` registration so endpoint-release and cron
subscribe themselves instead of living as `if (type === ...)` branches in
`emit()` and a second copied `emitEvent` in `command-router.ts`.

R031's module-scope singletons (`freshness`, `discussions-poller`,
`notifier`, worktree `locks`, `registry`) convert to `createX(env)`
factories owned by the unit list; module-level wrappers stay only for the
CLI paths that still call them directly.

### Boot order (decision)

The unit list is the single source of truth for boot order, encoding the
invariants today's comments carry. Order, each entry a unit whose
`start()` both constructs and arms:

1. **stderr redirect + logger + crash handlers** ... first, so any later
   throw is captured; depends on nothing but paths.
2. **flavor/park gate** ... MUST precede every subsystem that arms
   (today's module-scope invariant), so it is unit 2, before anything
   opens a db or a timer.
3. **PATH resolution** ... before any unit that spawns git or herdr.
   Phase 6 makes `resolveUserPath` async; this unit `await`s it.
4. **events.db** (createEventsBus, with the quarantine guard).
5. **state.db** (open + migrate) ... before serving, per the state.db
   spec's contention rule.
6. **background subsystems** ... hooks guard, cron, reconciler,
   home-snapshot, agent-status poller, health sampler, loop monitor,
   and the sweep units.
7. **handlers** (buildRoutedHandlers over the started subsystems).
8. **API server** ... a failed bind exits fatally, and binding it before
   the socket means that exit never strands a socket-bound zombie.
9. **socket server**.
10. **rt.pid** ... written only after both servers are bound.
11. **pollers, freshness, discussions poller**.
12. **signal handlers**, then the **ready** breadcrumb.

`stop()` runs in reverse; `closeStateDb()` becomes the state.db unit's
`stop()`, retiring R022. Phase 2's health sampler and loop monitor, and
Phase 6's async `resolveUserPath`, both land at module scope in their own
phases; 5.1 relocates their construction into units 3 and 6. This makes
5.1 a re-base on Phase 2 and Phase 6 (see Dependencies).

## 5.2 Contracts all the way

Wave 2 built a `TypedHandlers` catalog in `@mattstack/rt-client`
(`commands.ts`) and typed 39 of the 81 daemon commands. Forty-two remain
`payload: any`, including every command the Swift tray calls
(`tray:status`, `system-processes`, `notifications`, `ports`, `repos`,
`repos:locate`, `worktree:*`, `endpoint:*`, `mr:action`, and the
`discussions:*` writes), and `cache:read` is called by rt-client but is
in no catalog at all (R013, R016). The re-verified count of 42 untyped
commands supersedes the roadmap's 48: wave 2 typed 39 of the 81 commands,
and `cache:read` is one of the 42 (not a separate item). Handler error
shapes still diverge:
`handleCommand` rethrows on a throw (a stack-stringed 500 to the client),
`sdm:*` and `cache:*` spread fields at the top level instead of under
`data`, and no structured `{code, message}` error object exists anywhere
(R035).

### Typed catalog (decision)

Extend wave 2's rt-client `Commands` catalog to every command with an
out-of-process consumer (the 42, tray-facing and `cache:read` included),
and add them to `COMMAND_NAMES` so the existing exhaustiveness guard
covers them. The one-directional drift guard gains its missing half: a test that
walks rt-client's own call sites (`client.ts`) and asserts each string it
passes to `rtCommand` is a cataloged name, closing the `cache:read` gap.
Any verb that is genuinely daemon-internal (no external caller) goes in a
small daemon-internal typed map rather than the shipped catalog, so the
rt-client surface stays exactly the consumer contract. `Handler`'s
`payload: any` drops to `unknown`, forcing every handler to narrow.

### Validation seam (decision)

**Option A (recommended): `unknown` payload plus a co-located decoder per
handler.** Dropping `any` to `unknown` makes the compiler demand
narrowing; each handler decodes its payload at the top through small
shared validators (the codebase already has `isValidChatName`,
`clampLimit`, and now a `SerializedIdentity` decoder from 5.3), returning
the standard typed error on a bad shape. This is the audit's own R013
prescription, it matches the inline-validation style waves already
adopted in `chat.ts`, and it introduces no framework the repo does not
have.

**Option B: a central declarative schema map at the router.** One
validator per command applied before dispatch. Uniform, but a new
abstraction with no precedent here, and it duplicates the type the
catalog already carries. Rejected for altitude; the seam's job is a size
cap (`request-limits.ts` already caps body size) plus type narrowing,
not a schema engine.

### Error envelope (decision)

**Option A (recommended): additive convergence.** `handleCommand` catches
a throw and returns an `ok: false` envelope instead of rethrowing a 500.
The existing `error` field stays a plain **string**, because every
rt-client wrapper, mr-board and console display it verbatim today; the
structured object lands under a new additive key `failure: { code,
message }`, and the throw-to-envelope path fills **both** (`error` set to
the message, `failure` to `{ code, message }`, alongside the `reqId`
Phase 2 already adds). New consumers read `failure.code`; no current
consumer adapts. Existing `ok: true` top-level fields (`sdm` resources,
`cache` source) are kept for back-compat, and rt-client types the added
`failure` key additively.
Consistent with Phase 2's discipline: rt-client source plus a `dist`
rebuild, no version bump, no publish (publishing is release-class, from
`main`); the estate reads the tightened shape on the next release.

**Option B: full convergence.** Force every reply to
`{ ok: true, data }` / `{ ok: false, error: { code, message } }`, moving
`sdm`/`cache` fields under `data`. Cleaner long-term, but it breaks the
tray, mr-board and console until a coordinated rt-client bump and an
estate rollout, which the "publish from main only" rule makes a
multi-step release, not a Phase 5 change. Recommend A now; leave B as a
follow-up ticket if the estate later wants one error handler.

## 5.3 One owner per concept

Mechanical de-duplication and one rename, all re-verified as still open
(several worse than the audit found):

- **RepoIndex (R037):** down from three declarations to two, but the
  handlers/types.ts declaration still documents `repos.json` as the
  source and `freshness.ts` still throws an error naming `rt repo add`, a
  command that does not exist (the real one is `rt repos register`). One
  `RepoIndex` in `lib/repo-index.ts` keyed by a branded identity; delete
  the re-export; fix the doc and the error message.
- **repoName-is-identity (R039):** fourteen `parseIdentity(repoName) ===
  null` guards across five handler files, each with an apology comment,
  because the field name contradicts its contents. Introduce a branded
  `SerializedIdentity` (`parseIdentity` returns it), rename the field and
  parameter to `repo: SerializedIdentity`, and collapse the guards into
  the payload decoder (this is the concrete decoder 5.2's seam uses). This
  overlaps the RT-62 repo-identity re-key work and must be coordinated
  with it (see Dependencies).
- **Duplicated helpers (R029):** `canon` now has five definitions (a new
  one in `runs/prune.ts` recurses up parents, a genuine semantic drift);
  `patchTree` two; `numericUserId` two that still disagree on
  `gitlab:user:12a` (regex tail `null` vs `parseInt` `12`) and on return
  type; `TERMINAL` three. Consolidate to one module each
  (`lib/fs-canon.ts`, `lib/worktree/patch.ts`, one identity helper,
  `MR_TERMINAL_STATES` in `enrich.ts`); for `canon` and `numericUserId`
  the plan picks and documents the single correct semantics rather than
  blessing whichever copy is nearest.
- **`db` test seam (R028):** three handler factories still return a `db`
  key the router strips by destructuring. Remove `db` from the factory
  return types (tests already pass the db in) and make
  `buildRoutedHandlers`' return type reject non-function values.
- **HandlerContext (R038):** now fifteen fields, every factory receiving
  all of it. Give each factory only the deps it names (`Pick<>` or a small
  interface); `startDaemon` composes per-factory dep objects from the
  unit instances 5.1 owns, so this fix rides the lifecycle seam.

## 5.4 The daemon graph sheds the CLI

A leaf `lib/repo-label.ts` now exists and `repo-arg.ts` re-exports it, but
three daemon-graph sites (`notifier.ts`, `handlers/agent.ts`,
`handlers/system-processes.ts`) still import `repoLabel` through
`repo-arg.ts`, which pulls `repo.ts` and `git.ts` (process.exit paths, ink
and fzf references) into the daemon bundle (R050). Point the three sites
at `repo-label.ts`, and extend `lib/__tests__/no-eager-tui.test.ts` with a
guard that scans `lib/daemon/**` (transitively) for a static import of
`repo-arg.ts`, `repo.ts`, `fzf.ts`, `rt-render` or `ink`, so the daemon
graph is asserted TUI-free and cannot regress.

## 5.5 State growth and scan bounds

`SCHEMA_VERSION` is 9 and its migration concatenates `V1 + V2 + V3 + V4 +
V6 + V7` plus three guarded `ALTER` helpers, all run only when
`user_version < 9` (R015, R056). `chat_messages` and `agents` grow
unbounded with no prune (R053, R054); the events journal reads with no
SQL `LIMIT` and glob-filters in JS, and waiters register at a stale
cursor so every matching emit rescans the journal (S047, R030); and
`state.db` has no integrity check, backup or restore, only
quarantine-and-cold-start (R055).

### Schema convergence, so no version bump is needed (decision)

Adopt the audit's R015 + R056 fix: turn the concat into `const SCHEMAS =
[V1, ... ]` joined, and run `SCHEMAS.join("")` plus the guarded column
helpers **unconditionally on every open** inside the IMMEDIATE
transaction (every statement is already `IF NOT EXISTS` or a
`table_info`-guarded `ALTER`, so re-running is idempotent, cost one schema
parse). `user_version` stays only as the legacy JSON-import gate
(`=== 0`). This self-heals the cross-lane collision R015 describes (a db
stamped at 9 by a lane whose build lacked a column now converges on the
next open) and makes a forgotten constant impossible (R056). Replace the
hand-maintained golden-table list with a dynamic test that greps this
module for every `CREATE TABLE IF NOT EXISTS` and asserts each lands in
`sqlite_master` after a fresh open.

**Consequence for the SCHEMA_VERSION constraint:** because idempotent DDL
now applies on every open, the retention indexes below (and any future
table) land without a `SCHEMA_VERSION` bump, and the prune jobs are plain
deletes. Phase 5 therefore needs **no** `SCHEMA_VERSION` bump; the
"prefer prune jobs over schema" instruction is satisfied by construction.

### Retention (prune jobs, decision)

A daily retention sweep, registered through 5.1's `scheduleSweep` beside
the events sweep:

- **chat_messages:** delete messages older than a floor age with a
  per-room keep-floor (never empty a live room), exposed as `rt chat
  prune`; add the `(room, posted_at)` index through the always-applied
  DDL if the summary scan needs it (today's index is `(room, id)`).
- **agents:** delete rows whose `finished_at` is older than the floor; add
  a `created_at` index for the unfiltered list, through the same DDL.

Retention ages are **named constants**, not settings keys (matching the
branch-cache GC's "30 days is a constant" precedent and avoiding a
registry row per knob). If a knob is later wanted, it rides a settings
row then; the spec does not add one now.

### Events journal bounds (decision)

`events.db` stays a separate store (append-only journal, its own sweep).
Push `LIMIT ?` into the waiter/list statement, give `events:list` a
default hard cap when the client omits `limit` (500), and register waiters
with `afterId = head` (the catch-up already covered everything up to head)
so a stale cursor stops forcing a full-journal rescan on every emit
(S047, R030).

### Backup and integrity (decision)

Add `rt state backup` (`VACUUM INTO` a stamped copy) and `rt state
restore`; run `PRAGMA quick_check` at daemon boot and warn (do not block)
on a bad result; take a daily rotating copy from the retention sweep unit
(R055). This is a new command module `commands/state.ts` (no `state`
command exists today), so the plan must register its thunk in
`lib/module-registry.ts` (`() => import("../commands/state.ts")`) or the
compiled binary cannot bundle it. `rt state restore`'s required positional
(which stamped copy to restore) declares `omitBehavior` on its node in
`command-tree-def.ts` (a `"picker"` over the existing stamped copies), and
its leaf picker gates `process.stdin.isTTY && !json &&
!process.env.RT_BATCH`, leaving the non-TTY and `--json` paths exactly as
they were; `rt state backup` takes no required positional. No schema
change.

## 5.6 Seam tests

The refactors above make the previously-untestable seams testable, so the
tests land with them:

- **Transport integration (R024):** start `startApiServer` on
  `RT_API_PORT=0` and `startSocketServer` on a temp socket with a fake
  `handleCommand`; assert routing dispatch, the token gate per
  `REST_ROUTES`, CORS headers, WS upgrade rejection for a foreign Origin,
  the 404/405/500 envelope, and client-disconnect signal abort. Feasible
  because 5.1 makes the graph startable in-process.
- **Untested modules (R027, narrowed):** re-verification leaves three with
  genuinely zero coverage: `bounce.ts`, `pollers.ts`, `socket-server.ts`.
  Add tests for each.
- **Pollers wiring (R047):** a pollers test with injected scanners
  asserting the in-flight guards, demand gating, and that a never-settling
  scan does not block later ticks. (`runCapture`'s timeout is already
  tested.)

R026, R018 and R023 are already covered or obsolete (see the retired
list) and get no new work here.

## 5.7 Reconciler decomposition (last)

`worktree-reconciler.ts` is 1262 lines (grown since the audit), five
duties in one serial `runOnce` pass under one `inFlight` promise, with
eleven internals exported for tests (R014). Written against the reconciler's
**intent**, not its current lines, because Phase 4 is rewriting the
reconcile/dispose/reap paths concurrently:

- Split the five duties (reconcile, reactor, freshen, replenish, shrink)
  into units behind the 5.1 seam: `reconciler/reconcile.ts` (registry),
  `reactor.ts` (merge detection and the fired-ledger), `freshen.ts`, and
  `replenish.ts`. Shrink co-locates with replenish in `replenish.ts` (they
  share `replenishAndShrink` today); that is a file-layout choice, not a
  sixth duty. Worktree-trash reaping (`reapRepoTrash`) is not one of the
  five: it belongs to Phase 4's retention work and is re-based here, not
  designed in this spec. Each unit exports a per-repo step with its own
  test file; the eleven `__test__` exports move to their home modules.
- Schedule per-repo steps as independent promises with a concurrency cap
  instead of one serial loop, so one repo's multi-minute install no longer
  delays every other repo's merge reactor, and a long pass no longer
  blocks `repos:locate` for its whole duration (S094's remaining half).
  `createBackoff` moves into the reconciler instance.
- Run `worktree:adopt` and `worktree:freshen` inside `withReconcilerHeld`
  (they are reconciler-shaped passes) and delete the `#adopt` synthetic
  lock, which today excludes nothing but other adopts (R041).
- GC the reactor `fired` keys: drop keys whose MR is no longer in the
  repo's branch-cache entries (the branch-cache GC already bounds that
  set), so the ledger stops growing forever (R049).
- Preserve S065's landed kick-queue behavior and its regression test
  through the split.

## Dependencies and lane ordering

Phase 5 executes alone on top of the merged roadmap, but its own items
have an internal order and two external re-base points:

- **5.1 re-bases on Phase 2 and Phase 6.** Phase 2 adds the health sampler
  and loop monitor at module scope; Phase 6 makes `resolveUserPath` async
  and edits the one module-scope call in `daemon.ts`. 5.1 relocates all of
  these into the unit list, so 5.1 lands after both and the plan's 5.1
  tasks start from their merged result.
- **5.7 re-bases on Phase 4.** Phase 4 (p4-destructive-engine) is
  rewriting the reconciler's reconcile/dispose/reap paths. 5.7 is written
  against the five-duty intent; the plan orders it last and its tasks
  explicitly re-base on Phase 4's merged reconciler before execution.
- **5.3's R039** overlaps the RT-62 repo-identity re-key; the branded
  `SerializedIdentity` introduction must be coordinated with that work so
  the two do not double-introduce the type.

Suggested lanes (the plan sequences the tasks): **5.1 first** (it unblocks
5.6's in-process tests and 5.3's per-factory dep composition); then
**5.2 + 5.3 + 5.4** (types, ownership, bundle) and **5.5** (state) in
parallel; **5.6** follows 5.1; **5.7** last, after the Phase 4 re-base.

## Constraints and invariants

- **No `SCHEMA_VERSION` bump.** The schema-convergence decision (5.5) makes
  every retention change apply through idempotent DDL; retention itself is
  prune jobs. Nothing in this phase bumps the version.
- **No new persisted config keys.** Retention ages are named constants.
  Backup/restore are commands; the integrity check is a boot step.
- **rt-client is source + `dist` rebuild only.** The catalog and
  error-envelope edits (5.2) ship as source plus `bun run build` so the
  dist-freshness test stays green; no version bump, no publish (release
  is from `main`); the estate rollout rides the next release.
- **No `rt-tray/` edits.** The tray reads the tightened `tray:status`
  contract; any tray-side change is a documented follow-up.
- **Never start a daemon or run `dist/rt` except under `env -i
  HOME=<temp dir>`.** Tests use the isolated HOME from the bunfig preload;
  never touch the real `~/.mattstack`.
- **Do not edit Phase 4, Phase 6, or Phase 2-owned files ahead of their
  merge.** 5.1 and 5.7 re-base on their results rather than racing them.

## Non-goals

- Not a rewrite of the settings resolver, the events-bus wire protocol, or
  the chat schema; contracts and retention only.
- Not full error-envelope convergence (Option B) or a schema-driven
  validation engine (Option B); both are deferrable follow-ups.
- Not the R012 watcher-close leak remediation (Phase 2 scoped it out; it
  rides the later watcher-lifecycle work), and not any finding outside the
  Phase 5 list.
- No estate adoption of the tightened rt-client contract here; that rides
  the next release from `main`.

## Testing summary

- **Lifecycle:** an in-process boot test starts the unit list under a temp
  HOME and asserts start order, pid/socket ownership, `busy_timeout`, and
  a clean reverse-order stop that closes state.db; `scheduleSweep` returns
  a working stop handle; `onBroadcast` subscribers fire and unsubscribe.
- **Contracts:** the catalog exhaustiveness test plus the new call-site
  guard (`cache:read` and the 42 covered); a `handleCommand` test that a
  thrown handler yields the `{ code, message }` envelope, not a rethrow.
- **Ownership:** the consolidated `canon`/`patchTree`/`numericUserId`/
  terminal-states each have one test; a compile check that factories
  return only functions.
- **Bundle:** the extended `no-eager-tui` guard fails on a `lib/daemon/**`
  import of the CLI picker chain.
- **State:** the dynamic schema-presence test; retention sweep deletes
  past the floor and never empties a live room; events `list`/`wait` read
  at most `limit + 1` rows and a stale-cursor waiter does not rescan;
  `quick_check` warns on a damaged db; `backup`/`restore` round-trip.
- **Seams:** the api-server and socket-server integration tests, and the
  pollers wiring test, above.
- **Reconciler:** each extracted duty has its own test file; the
  concurrency-capped scheduler runs independent repos without serializing;
  the kick-queue regression test still passes; adopt/freshen run under the
  hold; the fired-ledger GC drops evicted keys.
