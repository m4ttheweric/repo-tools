# Daemon & Runner Code-Health Audit

Reference analysis for the `rt` daemon ([lib/daemon.ts](../lib/daemon.ts) and [lib/daemon/](../lib/daemon/)) and the runner TUI ([commands/runner.tsx](../commands/runner.tsx)).

Both subsystems are central — the daemon owns all process lifecycle and long-lived state; the runner is our flagship feature and the primary surface that touches that state. Defects here leak processes, corrupt UI state, or silently drop features without any obvious error. This document exists to catalog known issues so they can be fixed deliberately rather than re-discovered.

## Legend

- **P0** — Active correctness bug or resource leak with user-visible impact.
- **P1** — Reliability issue, silent feature drop, or unbounded growth under realistic use.
- **P2** — Edge case or latent bug that will bite under specific conditions.
- **P3** — Code quality / testability — not a bug, but the surrounding code will rot without it.

Each item is scoped by file:line-link so a fix PR can jump straight to the site.

---

## 1. Orphaned processes

### ~~P0 — Child process groups are not reaped on kill~~ ✅ FIXED
[lib/daemon/process-manager.ts:34-54](../lib/daemon/process-manager.ts#L34-L54), [lib/daemon/process-manager.ts:140-147](../lib/daemon/process-manager.ts#L140-L147), [lib/daemon/process-manager.ts:182-190](../lib/daemon/process-manager.ts#L182-L190)

`Bun.spawn` now passes `detached: true` so the child is a session/pgroup leader (pgid == pid). A new `killGroup(pid, signal)` helper sends signals to `-pid` with guards against pid ≤ 1 and ESRCH. Both the kill() path and the existing-process eviction path now use it. New regression test [`process-manager.test.ts`](../lib/daemon/__tests__/process-manager.test.ts) `"kill reaps grandchildren (detached pgroup)"` verifies the fix by spawning backgrounded sleepers, killing the parent, and asserting every grandchild pid is gone.

### ~~P0 — `process:respawn` drops the remedy subscription~~ ✅ FIXED
[lib/daemon.ts:720-726](../lib/daemon.ts#L720-L726)

Added `remedyEngine.onSpawn(id)` after `processManager.respawn(id)`. Re-uses stored `processMeta` (cwd/cmd unchanged across respawn).

### ~~P1 — Warm (SIGSTOP) processes survive daemon death as stopped zombies~~ ✅ FIXED
[lib/daemon/state-store.ts:28-104](../lib/daemon/state-store.ts#L28-L104), [lib/daemon.ts:1398-1411](../lib/daemon.ts#L1398-L1411), [lib/daemon/process-manager.ts:168-174](../lib/daemon/process-manager.ts#L168-L174)

`StateStore` now persists `{state, pid}` per id. `ProcessManager.spawn` records pid on spawn; terminal transitions (`stopped`/`crashed`) clear it. `reconcileAfterRestart()` returns orphans (non-stopped with a pid), which the daemon reaps via `killGroup(pid, SIGCONT)` followed by `killGroup(pid, SIGKILL)`. Legacy `{id: state}` persistence format is still accepted on load. Regression coverage in [state-store.test.ts](../lib/daemon/__tests__/state-store.test.ts#L200-L230).

### ~~P1 — `subscribeToOutput` unsubscribers leave empty Sets behind~~ ✅ FIXED
[lib/daemon/process-manager.ts:100-109](../lib/daemon/process-manager.ts#L100-L109)

Unsubscribe now deletes the Set from `outputHooks` once its size reaches zero.

---

## 2. Memory leaks

### ~~P0 — `:wt` git watcher is torn down every reconcile tick~~ ✅ FIXED
[commands/runner.tsx:1580-1584](../commands/runner.tsx#L1580-L1584)

Reconcile loop now strips a trailing `:wt` from the key before checking `activeLaneIds`, so the companion watcher lives and dies with its parent lane instead of being torn down every tick.

### ~~P1 — Global-remedy `fs.watch` has no handle and no cleanup~~ ✅ FIXED
[lib/daemon.ts:132-163](../lib/daemon.ts#L132-L163), [lib/daemon.ts:1320](../lib/daemon.ts#L1320)

Handle retained in `globalRemedyWatcher` and closed in `cleanup()`.

### ~~P1 — `ProcessManager.spawnConfigs` and `outputHooks` grow unbounded~~ ✅ FIXED
[lib/daemon.ts:770-779](../lib/daemon.ts#L770-L779), [commands/runner.tsx](../commands/runner.tsx)

Added `process:remove` IPC handler that tears down all five daemon-side maps (remedy state, attach socket, log buffer, process config, state-store entry). The runner now calls it from every entry-deletion path (remove-entry, remove-lane, reset). Entries with fresh ids no longer leak daemon-side state.

### ~~P2 — `RemedyEngine` can create orphan state for globals-only matches~~ ✅ FIXED
[lib/daemon.ts:773](../lib/daemon.ts#L773)

`process:remove` handler (added in Session B) calls `remedyEngine.unregister(id)` before tearing down the other maps, so globals-only state is cleaned up when the runner deletes an entry.

### ~~P2 — `refreshCache` has no in-flight guard~~ ✅ FIXED
[lib/daemon.ts:390-407](../lib/daemon.ts#L390-L407)

Split into a coalescing `refreshCache()` wrapper and the original logic as `refreshCacheImpl()`. Concurrent callers await the same promise.

### ~~P2 — outputHooks Map retains empty Sets~~ ✅ FIXED
Covered by the subscribeToOutput unsubscribe cleanup above.

---

## 3. Bugs

### ~~P1 — Invalid JSON during save wipes all globals~~ ✅ FIXED
[lib/runner-store.ts:154-168](../lib/runner-store.ts#L154-L168), [lib/daemon.ts:137-158](../lib/daemon.ts#L137-L158)

`loadGlobalRemedies` now throws on parse failure / non-array shape; missing file still returns `[]`. Daemon watcher callback catches and logs without calling `reloadGlobals`, so live rules persist through transient invalid states.

### ~~P1 — Global-remedy watcher is not debounced~~ ✅ FIXED
[lib/daemon.ts:147-161](../lib/daemon.ts#L147-L161)

100ms settle timer collapses the rename+change burst into a single reload.

### ~~P1 — Concurrent `cache:refresh` via REST API~~ ✅ FIXED
Resolved by the `refreshCache` in-flight guard above.

### ~~P2 — `entry.id` basename collision~~ ✅ FIXED
[lib/runner-store.ts:410-420](../lib/runner-store.ts#L410-L420)

`normalizeLane` now detects within-lane entry id duplicates and appends a 6-char sha1 of the worktree path to the loser (`~a1b2c3`). Collisions no longer silently alias two processes' PTY/state.

### ~~P2 — `onSpawn` re-merge uses stale meta for callers that pass neither cwd nor cmd~~ ✅ FIXED
[lib/daemon.ts:753-761](../lib/daemon.ts#L753-L761), [lib/daemon/process-manager.ts:245-247](../lib/daemon/process-manager.ts#L245-L247)

`process:respawn` — the only caller that used to pass no cwd/cmd — now pulls them from `processManager.getSpawnConfig(id)` so globals-only matches survive respawn. Other `onSpawn` callers already pass cwd/cmd from their handler payload.

### ~~P2 — `reloadGlobals` didn't subscribe for processes registered with empty remedies~~ ✅ FIXED
[lib/daemon/remedy-engine.ts:108-127](../lib/daemon/remedy-engine.ts#L108-L127)

If `register()` was called with no per-entry remedies and `onSpawn` early-returned (no subscription because merged was empty), a later `reloadGlobals` that added matching rules updated `s.remedies` but never subscribed to output — so nothing fired. Found while writing the RemedyEngine test suite. Fix: `reloadGlobals` now subscribes on empty→non-empty and unsubscribes on non-empty→empty. Regression test in [remedy-engine.test.ts "reloadGlobals mid-flight re-merges active states"](../lib/daemon/__tests__/remedy-engine.test.ts#L300-L319).

### ~~P3 — Dead constant~~ ✅ FIXED
[lib/daemon.ts:48](../lib/daemon.ts#L48)

`LINEAR_REFRESH_INTERVAL_MS` removed.

### ~~P3 — Compaction ordering is interleaving-sensitive~~ ✅ FIXED
[lib/runner-store.ts:338-348](../lib/runner-store.ts#L338-L348)

Each entry now gets its absolute input index as its position. Groups inherit the position of their first member. Output order follows input order deterministically.

### ~~P3 — State-store permits invalid transitions silently~~ ✅ FIXED
[lib/daemon/state-store.ts:111-119](../lib/daemon/state-store.ts#L111-L119), [lib/daemon.ts:1403-1407](../lib/daemon.ts#L1403-L1407)

Forced transitions remain permitted (needed for kill-of-warm, reconcile, etc.) but `StateStore` now exposes `onInvalidTransition(cb)` and fires it when the move isn't in `VALID_TRANSITIONS`. The daemon wires this to its log so drift surfaces in the daemon log instead of being silently swallowed.

---

## 4. Code organization / testability

### ~~P1 — `lib/daemon.ts` is 1400+ lines with no seams~~ ✅ FIXED
[lib/daemon.ts](../lib/daemon.ts), [lib/daemon/handlers/](../lib/daemon/handlers/)

`handleCommand` split into four domain modules behind a routed-lookup-first-then-switch dispatch:

- [lib/daemon/handlers/process.ts](../lib/daemon/handlers/process.ts) — `process:spawn|kill|respawn|remove|start|stop|restart|list|state|states|logs|attach-info|suspend|resume`
- [lib/daemon/handlers/cache.ts](../lib/daemon/handlers/cache.ts) — `cache:read|refresh` + `branch:enrich`
- [lib/daemon/handlers/remedy.ts](../lib/daemon/handlers/remedy.ts) — `remedy:set|clear|drain`
- [lib/daemon/handlers/proxy.ts](../lib/daemon/handlers/proxy.ts) — `proxy:start|stop|set-upstream|status|list`

Each module is a factory that takes a `HandlerContext` and returns a `HandlerMap`. Daemon.ts constructs the ctx once and merges the maps into `routedHandlers`; `handleCommand` does `routedHandlers[cmd] ?? switch` so non-extracted commands (ping, hooks:*, repos, ports, status, tcc:check, notifications*, tray:status, group:*, workspace:sync:*, port:*, shutdown) remain inline because they read daemon-local state (watchers, repos index, notifications, port allocator, workspace-sync, groups) that wouldn't benefit from being pushed out.

Live cache access goes through `ctx.cache.entries` — `loadCache()` now mutates `cache.entries` in place instead of reassigning, so handlers see disk reloads without plumbing getters.

### ~~P1 — `lib/runner-store.ts` doubled in size with no tests~~ ✅ FIXED
[lib/runner-store/compact.ts](../lib/runner-store/compact.ts), [lib/__tests__/runner-store-compact.test.ts](../lib/__tests__/runner-store-compact.test.ts)

Added 7 round-trip tests and physically extracted `normalizeRemedy`, `normalizeEntry`, `compactEntries` (and their helpers) to `lib/runner-store/compact.ts`. runner-store.ts now re-exports `compactEntries`/`normalizeEntry` and delegates all compact↔expand logic. The extracted module imports only types from `runner-store.ts`, so there's no runtime cycle.

### ~~P1 — `commands/runner.tsx` is 2500+ lines~~ ✅ PARTIALLY FIXED
[lib/runner/git-watchers.ts](../lib/runner/git-watchers.ts)

Git watcher setup, per-lane debounce, and linked-worktree `.git/worktrees/<name>/HEAD` handling extracted into `createGitWatcherPool(onChange) → { sync, dispose }`. `repoGitDir`, `readCurrentBranch`, `readCurrentBranchAsync` now live there too. runner.tsx drops from 2500 → ~2430 lines and no longer imports `fs.watch` or `FSWatcher` at all. Remaining deferrals (keymap-handler split, `reconcileWatchers` module) are cosmetic and not bugs.

### ~~P2 — `ProcessManager.spawn` does too many things~~ ✅ PARTIALLY FIXED
[lib/daemon/process-manager.ts:31-44](../lib/daemon/process-manager.ts#L31-L44)

Port eviction is now an async `evictPort(port)` helper — no more synchronous `Bun.spawnSync(["sh","-c","lsof..."])` stalling the event loop. The broader decomposition of `spawn()` is deferred with the other structural refactors.

### ~~P2 — No unit tests for `RemedyEngine` lifecycle invariants~~ ✅ FIXED
[lib/daemon/__tests__/remedy-engine.test.ts](../lib/daemon/__tests__/remedy-engine.test.ts)

Added 13 tests driving `register`/`onSpawn`/`unregister` against a `FakeProcessManager` stub. Covers all five invariants (hook accumulation, orphan on removal, concurrent triggers, cooldown gating, double-respawn guard) plus pattern handling (array OR, invalid regex tolerance, ANSI stripping) and global remedies (cwdContains match/non-match, reload mid-flight re-merge). Writing the tests uncovered the latent `reloadGlobals`-doesn't-subscribe bug fixed above.

### ~~P3 — Repeated sync git reads on runner startup~~ ✅ FIXED
[commands/runner.tsx:483-498](../commands/runner.tsx#L483-L498), [commands/runner.tsx:2527-2545](../commands/runner.tsx#L2527-L2545)

Added async `readCurrentBranchAsync` (uses `Bun.spawn` + `proc.exited`) and parallelized the startup fan-out with `Promise.all`. Cost is now ~max-spawn-time, not N×spawn-time.

---

## Status summary (audit sweep)

All correctness, leak, and resource-safety items from the audit have been addressed:

- **P0 / P1 bugs & leaks:** all fixed — pgroup reaping, remedy respawn subscription, `:wt` watcher, global-remedy hardening, refreshCache coalescing, warm-process crash recovery, empty-Set cleanup, map growth.
- **P2 correctness:** all fixed — entry.id collision salting, onSpawn meta passthrough, reloadGlobals missed-subscribe, RemedyEngine lifecycle tests, state-store invalid-transition observability.
- **P3:** all fixed — dead constant removed, compaction ordering deterministic, async parallel git reads on startup.

**Structural refactors completed:**
- `handleCommand` split into `lib/daemon/handlers/{process,cache,remedy,proxy}.ts` — routed-lookup dispatch in daemon.ts, 14 `process:*` + 3 `cache:*`/`branch:*` + 3 `remedy:*` + 5 `proxy:*` commands all flow through factory-injected `HandlerContext`.
- compact/expand physically extracted to `lib/runner-store/compact.ts`; runner-store.ts re-exports for back-compat.
- Git watcher pool extracted to `lib/runner/git-watchers.ts` — `createGitWatcherPool(onChange) → { sync, dispose }` with built-in 150ms per-lane debounce.

**Remaining cosmetic deferrals:**
- `commands/runner.tsx` keymap handlers could be split into sibling files for testability, but that's pure reorg — no correctness signal behind it.

## Not covered here

- `SuspendManager`, `ExclusiveGroup`, `AttachServer`, `WorkspaceSync`, `PortAllocator` — not re-read this pass. Worth a follow-up audit on the same four axes.
- Test coverage itself — there is very little for the daemon. Any of the extraction work above should ship with the matching test file.
- Observability — `diag()` is sprinkled throughout but there's no sampling, no correlation id, no structured reader. A shared `makeChildLogger(component, id)` helper would clean up call sites and produce greppable logs.
