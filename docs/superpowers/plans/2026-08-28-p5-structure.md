# Structure That Stops The Rot (Phase 5 / RT-82) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the rt daemon a lifecycle seam, typed command contracts, one owner per concept, a CLI-free daemon bundle, bounded state growth, the seam tests those refactors make possible, and a decomposed worktree reconciler, so the next ten changes land safely instead of accreting rot.

**Architecture:** `startDaemon()` builds an ordered list of `{name, start, stop}` units and nothing arms at import; cleanup derives from reverse-order stop. Every out-of-process command joins the rt-client typed catalog with `unknown` payloads narrowed at the handler, and thrown handlers converge on an additive `failure` envelope. Duplicated concepts collapse to one owner each. The state schema converges on every open so retention (prune jobs plus idempotent indexes) needs no version bump. The reconciler's five duties split into units behind the lifecycle seam, re-based on Phase 4.

**Tech Stack:** Bun, TypeScript, `bun:sqlite`, pino, `@mattstack/rt-client` (typed command catalog + settings registry).

**Spec:** `docs/superpowers/specs/2026-08-28-p5-structure-design.md` (read it alongside this plan; the plan argues from it, executors read both).

## Global Constraints

- **No `SCHEMA_VERSION` bump.** The schema-convergence task (C1) makes idempotent DDL apply on every open; retention is prune jobs plus `IF NOT EXISTS` indexes. Nothing here bumps `SCHEMA_VERSION` (currently 9).
- **No new persisted config keys.** Retention ages are named constants. Backup/restore are commands; the integrity check is a boot step.
- **rt-client is source plus `dist` rebuild only.** After editing `packages/rt-client`, run `cd packages/rt-client && bun run build` so the dist-freshness test stays green. **Do not bump the rt-client version and do not publish** (release is from `main`); the estate rollout rides the next release.
- **No `rt-tray/` edits.** The tray reads the tightened `tray:status` contract; any tray-side change is a documented follow-up.
- **Never start a daemon or run `dist/rt` except under `env -i HOME=<temp dir>`.** Tests use the isolated HOME from the bunfig preload; never touch the real `~/.mattstack`.
- **Module registry:** any new command module referenced by `cli.ts` MUST get a thunk entry in `lib/module-registry.ts` (`() => import("../commands/x.ts")`), or the compiled binary cannot bundle it.
- **Picker conformance:** every visible leaf with a required positional declares `omitBehavior` on its node in `lib/command-tree-def.ts`, and its leaf picker gates `process.stdin.isTTY && !json && !process.env.RT_BATCH`, leaving the non-TTY and `--json` paths unchanged. `bun run picker:check` gates this.
- **Commit after every task.** Run `bunx tsc --noEmit` (0 errors) before each commit that touches TS.
- **No em dashes or en dashes** in any file (use ellipses, parens, or rephrase). `scripts/repo-purity.sh` must stay green.

## Re-base gates (external dependencies)

Three tasks below re-base on sibling phases that touch the same files. The executor reads the merged sibling result first and starts the task from it, rather than from this plan's snapshot:

- **Lane A (5.1)** re-bases on **Phase 2** (health sampler + loop monitor, added at module scope) and **Phase 6** (`resolveUserPath` made async, one module-scope call in `daemon.ts`). Do Lane A after both are merged.
- **Lane E (5.7 reconciler)** re-bases on **Phase 4** (p4-destructive-engine, rewriting reconcile/dispose/reap). Task E0 is a hard gate: do not start E1+ until Phase 4 is merged, then re-read `lib/daemon/worktree-reconciler.ts` and re-base the extraction against its duties, not this plan's line numbers.
- **Task B6** (branded `SerializedIdentity`) coordinates with **RT-62** repo-identity re-key; if RT-62 introduces the brand first, B6 consumes it instead of re-declaring.

## Lane order

Lane A first (it unblocks the in-process seam tests in Lane D and the per-factory dep composition in B11). Then Lanes B and C in parallel. Lane D (seam tests) follows Lane A. Lane E (reconciler) is last, after the Phase 4 re-base.

---

## File Structure

**New files:**
- `lib/daemon/lifecycle.ts` ... `DaemonUnit` interface, `BootContext`, `runUnits`/`stopUnits`.
- `lib/fs-canon.ts` ... single `canon(path)`.
- `lib/worktree/patch.ts` ... single `patchTree`.
- `commands/state.ts` ... `rt state backup` / `rt state restore`.
- `lib/daemon/reconciler/{reconcile,reactor,freshen,replenish}.ts` ... the split duties (Lane E).
- Tests colocated under `lib/daemon/__tests__/`, `lib/__tests__/`, `commands/__tests__/`, `lib/state/__tests__/`.

**Modified files (by lane):**
- A: `lib/daemon.ts`, `lib/daemon/shutdown.ts`, `lib/daemon/safe-timers.ts`, `lib/daemon/events-bus.ts`, `lib/daemon/command-router.ts`, `lib/daemon/freshness.ts`, `lib/daemon/discussions-poller.ts`, `lib/notifier.ts`, `lib/worktree/locks.ts`, `lib/worktree/registry.ts`.
- B: `lib/daemon/handlers/types.ts`, `lib/daemon/handlers/*.ts`, `lib/daemon.ts` (handleCommand envelope), `packages/rt-client/src/commands.ts`, `packages/rt-client/src/client.ts`, `lib/repo-index.ts`, `lib/daemon/discussions-store.ts`, `lib/enrich.ts`, `lib/port-scanner.ts`, `lib/repo-locate.ts`, `lib/runs/prune.ts`, `lib/notifier.ts`, `lib/daemon/handlers/agent.ts`, `lib/daemon/handlers/system-processes.ts`, `lib/__tests__/no-eager-tui.test.ts`.
- C: `lib/state/db.ts`, `lib/state/chat-store.ts`, `lib/state/agents-store.ts`, `lib/daemon/events-bus.ts`, `lib/daemon/handlers/events.ts`, `lib/command-tree-def.ts`, `lib/module-registry.ts`.
- D: `lib/daemon/api-server.ts` (test seams only), `lib/daemon/pollers.ts` (test seams only).
- E: `lib/daemon/worktree-reconciler.ts`, `lib/daemon/handlers/worktree.ts`.

---

# Lane A ... 5.1 Lifecycle seam

## Task A1: `DaemonUnit` interface and the boot context

**Files:**
- Create: `lib/daemon/lifecycle.ts`
- Test: `lib/daemon/__tests__/lifecycle.test.ts`

**Interfaces:**
- Produces: `interface DaemonUnit { name: string; start(): Promise<void> | void; stop(): Promise<void> | void }`; `runUnits(units: DaemonUnit[], log): Promise<void>` (starts in order, throws on first failure after stopping already-started units in reverse); `stopUnits(units: DaemonUnit[], log): Promise<void>` (stops in reverse, each in its own try/catch, warns on a stop throw, never rethrows).

- [ ] **Step 1: Write the failing test**

```ts
// lib/daemon/__tests__/lifecycle.test.ts
import { test, expect } from "bun:test";
import { runUnits, stopUnits, type DaemonUnit } from "../lifecycle.ts";

const noopLog = { warn() {}, info() {}, error() {} } as any;

test("runUnits starts in order; stopUnits stops in reverse", async () => {
  const order: string[] = [];
  const mk = (n: string): DaemonUnit => ({
    name: n,
    start: () => { order.push(`start:${n}`); },
    stop: () => { order.push(`stop:${n}`); },
  });
  const units = [mk("a"), mk("b"), mk("c")];
  await runUnits(units, noopLog);
  await stopUnits(units, noopLog);
  expect(order).toEqual(["start:a","start:b","start:c","stop:c","stop:b","stop:a"]);
});

test("a start failure stops already-started units in reverse and rethrows", async () => {
  const order: string[] = [];
  const units: DaemonUnit[] = [
    { name: "a", start: () => { order.push("start:a"); }, stop: () => { order.push("stop:a"); } },
    { name: "b", start: () => { throw new Error("boom"); }, stop: () => { order.push("stop:b"); } },
  ];
  await expect(runUnits(units, noopLog)).rejects.toThrow("boom");
  expect(order).toEqual(["start:a","stop:a"]); // b never fully started, a rolled back
});

test("stopUnits swallows a stop throw and continues", async () => {
  const order: string[] = [];
  const units: DaemonUnit[] = [
    { name: "a", start: () => {}, stop: () => { order.push("stop:a"); } },
    { name: "b", start: () => {}, stop: () => { throw new Error("x"); } },
  ];
  await stopUnits(units, noopLog); // must not reject
  expect(order).toEqual(["stop:a"]);
});
```

- [ ] **Step 2: Run to verify it fails** ... `bun test lib/daemon/__tests__/lifecycle.test.ts` ... Expected: FAIL (module not found).
- [ ] **Step 3: Implement `lib/daemon/lifecycle.ts`**

```ts
import type { Logger } from "pino";

export interface DaemonUnit {
  name: string;
  start(): Promise<void> | void;
  stop(): Promise<void> | void;
}

export async function runUnits(units: DaemonUnit[], log: Logger): Promise<void> {
  const started: DaemonUnit[] = [];
  for (const u of units) {
    try {
      await u.start();
      started.push(u);
    } catch (err) {
      await stopUnits(started, log);
      throw err;
    }
  }
}

export async function stopUnits(units: DaemonUnit[], log: Logger): Promise<void> {
  for (const u of [...units].reverse()) {
    try {
      await u.stop();
    } catch (err) {
      log.warn({ err, unit: u.name }, "daemon unit stop failed");
    }
  }
}
```

- [ ] **Step 4: Run to verify it passes** ... `bun test lib/daemon/__tests__/lifecycle.test.ts`.
- [ ] **Step 5: Commit** ... `git commit -m "add lib/daemon/lifecycle.ts DaemonUnit + runUnits/stopUnits"`.

## Task A2: `scheduleSweep` helper, retire the duplicated sweep timers (R019)

**Files:**
- Modify: `lib/daemon/safe-timers.ts`
- Modify: `lib/daemon.ts` (the `pruneRuns`/`pruneLogs`/events sweep blocks)
- Test: `lib/daemon/__tests__/safe-timers.test.ts`

**Interfaces:**
- Produces: `scheduleSweep(name: string, fn: () => void | Promise<void>, opts: { bootDelayMs: number; intervalMs: number }, log): { stop(): void }` ... schedules one boot-delay timer and one interval, both `unref()`'d, each tick wrapped in try/catch that warns with `{ err }`; `stop()` clears both.

- [ ] **Step 1: Write the failing test** (injected clock or fake timers) asserting: one boot fire after `bootDelayMs`, repeated fires every `intervalMs`, a throwing `fn` is caught and warned (not unhandled), and `stop()` halts further fires.

```ts
import { test, expect } from "bun:test";
import { scheduleSweep } from "../safe-timers.ts";

test("scheduleSweep fires boot + interval, catches throws, stops", async () => {
  let fires = 0; const warns: unknown[] = [];
  const log = { warn: (o: unknown) => warns.push(o) } as any;
  const h = scheduleSweep("t", () => { fires++; if (fires === 1) throw new Error("x"); },
    { bootDelayMs: 5, intervalMs: 10 }, log);
  await Bun.sleep(8);   expect(fires).toBe(1); expect(warns.length).toBe(1); // boot fire threw, warned
  await Bun.sleep(12);  expect(fires).toBeGreaterThanOrEqual(2);
  h.stop(); const n = fires; await Bun.sleep(15); expect(fires).toBe(n);
});
```

- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement `scheduleSweep`** in `safe-timers.ts` on top of the existing `safeInterval`/`safeTimeout`, returning a combined stop handle.
- [ ] **Step 4: Replace the three sweep blocks in `daemon.ts`** (`events` sweep, `pruneRuns`, `pruneLogs`) with three `scheduleSweep(...)` calls; delete the four duplicated raw `setInterval`/`setTimeout` bodies. (These calls move into units in A5; for now they return handles captured in a local array.)
- [ ] **Step 5: Run** ... `bun test lib/daemon/__tests__/safe-timers.test.ts` and `bunx tsc --noEmit`.
- [ ] **Step 6: Commit** ... `git commit -m "safe-timers: scheduleSweep helper; collapse 3 duplicated sweep blocks (R019)"`.

## Task A3: bus `emitEvent` + `onBroadcast` subscription, retire emit() business logic (R020)

**Files:**
- Modify: `lib/daemon/events-bus.ts` (add `onBroadcast`)
- Modify: `lib/daemon.ts` (`emit`), `lib/daemon/command-router.ts` (duplicated `emitEvent`)
- Test: `lib/daemon/__tests__/events-bus-subscribe.test.ts`

**Interfaces:**
- Produces: `EventsBus.onBroadcast(fn: (type: string, data: unknown) => void): () => void` (returns an unsubscribe); a single `emitEvent(topic, payload)` owned by the bus that builds the frame (`{id, topic, payload, emittedAt}`), persists via `emitAt`, and fans out to `onBroadcast` subscribers.
- Consumes: nothing new.

- [ ] **Step 1: Write the failing test:** registering two `onBroadcast` subscribers; asserting one `emitEvent` fans out to both with the frame, and unsubscribe removes one. Assert the endpoint-release reaction (formerly `if (type === "worktree:disposed")`) fires only through a registered subscriber.
- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement** `onBroadcast` and the single `emitEvent` on the bus. In `daemon.ts`, replace `emit`'s inline `if (type === "worktree:disposed") ...` and the `cron.onBroadcast` call with two `bus.onBroadcast(...)` registrations (endpoint release; cron). Delete the duplicated `emitEvent` in `command-router.ts` and route it through `bus.emitEvent`.
- [ ] **Step 4: Run** the new test plus `lib/daemon/__tests__/events-bus*.test.ts` and `bunx tsc --noEmit`.
- [ ] **Step 5: Commit** ... `git commit -m "events-bus: single emitEvent + onBroadcast; move emit() reactions to subscribers (R020)"`.

## Task A4: convert module-scope singletons to factories (R031)

**Files:**
- Modify: `lib/daemon/freshness.ts`, `lib/daemon/discussions-poller.ts`, `lib/notifier.ts`, `lib/worktree/locks.ts`, `lib/worktree/registry.ts`
- Test: `lib/daemon/__tests__/freshness-factory.test.ts` (representative)

**Interfaces:**
- Produces: `createFreshness(env): FreshnessUnit` (exposing `reconcile`, `dispose`, `getSnapshot`, `stop`); `createDiscussionsPoller(deps): { start(); stop() }`; `createNotifier(deps)`, `createLocks()`, `createRegistry(env)`. Module-level wrappers stay only for CLI callers that construct nothing.

- [ ] **Step 1: Write the failing test** proving two instances coexist in one process without shared state (construct `createFreshness(envA)` and `createFreshness(envB)`, assert their watch maps are independent).
- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement** each factory wrapping the existing module state in a closure; keep the current free-function exports as thin wrappers over a lazily-created default instance for CLI paths (so non-daemon callers are unchanged).
- [ ] **Step 4: Run** the affected suites (`freshness*.test.ts`, `discussions*.test.ts`, `notifier*.test.ts`) and `bunx tsc --noEmit`.
- [ ] **Step 5: Commit** ... `git commit -m "freshness/discussions-poller/notifier/locks/registry: factory constructors (R031)"`.

## Task A5: assemble the ordered unit list in `startDaemon()` (R006, R009, R022)

> **Re-base gate:** start from the merged Phase 2 + Phase 6 `daemon.ts`. Phase 2's health sampler and loop monitor, and Phase 6's async `resolveUserPath`, currently arm at module scope; this task relocates their construction into units 3 and 6 of the ordered list.

**Files:**
- Modify: `lib/daemon.ts` (module scope collapses to `startDaemon()` + `import.meta.main`), `lib/daemon/shutdown.ts` (cleanup derives from `stopUnits`)
- Test: `lib/daemon/__tests__/boot-order.test.ts`

**Interfaces:**
- Consumes: `DaemonUnit`, `runUnits`, `stopUnits` (A1); `scheduleSweep` (A2); `bus.onBroadcast` (A3); the factories (A4).
- Produces: `buildUnits(ctx: BootContext): DaemonUnit[]` and a `startDaemon(opts?)` that constructs the ctx, calls `runUnits`, and installs signal handlers that call `stopUnits`.

- [ ] **Step 1: Write the failing boot-order test** under an isolated temp HOME: call `startDaemon` with test seams (fake servers), assert (a) start order matches the spec's list, (b) `rt.pid` is written only after both server units started, (c) `state.db` `busy_timeout` is set, (d) a clean stop runs in reverse and `closeStateDb()` was called. Use a spy list threaded through the ctx.

```ts
// lib/daemon/__tests__/boot-order.test.ts  (shape)
import { test, expect } from "bun:test";
import { buildUnits } from "../../daemon.ts";
// build ctx with fake logger/servers/db seams under a temp HOME (bunfig preload)
test("units start in spec order and stop in reverse, state.db closed on stop", async () => {
  // assert the ordered names, pid-after-servers, closeStateDb-on-stop
});
```

- [ ] **Step 2: Run to verify it fails.**
- [ ] **Step 3: Implement `buildUnits`**: one `DaemonUnit` per spec boot-order entry (stderr+logger+crash; park/flavor gate; PATH; events.db; state.db with `stop = closeStateDb`; background subsystems incl. the A2 sweep units and the Phase 2 health units; handlers; api server; socket server; pid; pollers/freshness/discussions; signal handlers; ready breadcrumb). Move every current module-scope construction into the matching unit's `start()`. `cleanup()` becomes `stopUnits(units)`; delete the hand-listed disposal in `daemon.ts` and `cleanupCore`.
- [ ] **Step 4: Run** `bun test lib/daemon/__tests__/boot-order.test.ts`, the full daemon suite, and `bunx tsc --noEmit`.
- [ ] **Step 5: Commit** ... `git commit -m "daemon: ordered unit list in startDaemon; nothing arms at import; state.db closed on stop (R006/R009/R022)"`.

---

# Lane B ... 5.2 contracts, 5.3 ownership, 5.4 bundle

## Task B1: drop `Handler`'s `any` to `unknown` (R013 groundwork)

**Files:**
- Modify: `lib/daemon/handlers/types.ts` (`Handler` type), and every handler that fails to compile once payloads are `unknown`.
- Test: relies on `bunx tsc --noEmit` (a type-level change).

**Interfaces:**
- Produces: `type Handler = (payload: unknown, signal?: AbortSignal) => Promise<unknown>;`

- [ ] **Step 1:** Change `Handler`'s `payload: any` to `unknown` in `handlers/types.ts`.
- [ ] **Step 2:** Run `bunx tsc --noEmit`; it lists every handler reading fields off `payload` without narrowing.
- [ ] **Step 3:** For each, add a top-of-handler decode: reuse `isValidChatName`/`clampLimit`/(from B6) the `SerializedIdentity` decoder; return the standard typed error (B4's shape) on a bad shape. Keep changes mechanical, one handler at a time.
- [ ] **Step 4:** `bunx tsc --noEmit` clean; run the handler suites.
- [ ] **Step 5: Commit** ... `git commit -m "handlers: Handler payload any->unknown; narrow at each handler (R013)"`.

## Task B2: extend the rt-client typed catalog to the remaining 42 + `cache:read` (R013, R016)

**Files:**
- Modify: `packages/rt-client/src/commands.ts` (`Commands`, `COMMAND_NAMES`)
- Modify: `lib/daemon/handlers/types.ts` (a daemon-internal typed map for any verb with no external consumer)
- Test: `lib/daemon/__tests__/rt-client-commands.test.ts` (existing exhaustiveness) plus B3.

**Interfaces:**
- Produces: `Commands["cache:read"]` = `{ payload: { branches?: string[]; maxAgeMs?: number }; data: Record<string, BranchEnrichment> }`, and payload/data types for each of the 42 (tray-facing included). `TypedHandlers` now compile-checks all of them.

- [ ] **Step 1:** Write the failing test: assert `COMMAND_NAMES` includes `cache:read` and each of the 42 (enumerate them in the test).
- [ ] **Step 2:** Run to verify it fails.
- [ ] **Step 3:** Add the catalog entries. For each command, copy the wire shape from its handler's current return and payload reads. Put genuinely internal verbs in the daemon-internal typed map instead of the shipped catalog.
- [ ] **Step 4:** `cd packages/rt-client && bun run build` (dist freshness). Run `lib/daemon/__tests__/rt-client-commands.test.ts` and `bunx tsc --noEmit`.
- [ ] **Step 5: Commit** ... `git commit -m "rt-client: catalog the remaining 42 commands + cache:read (R013/R016); rebuild dist"`.

## Task B3: bidirectional drift guard (R016)

**Files:**
- Test: `packages/rt-client/test/command-call-sites.test.ts`

**Interfaces:**
- Consumes: `COMMAND_NAMES`.

- [ ] **Step 1:** Write the failing test: scan `packages/rt-client/src/**` for `rtCommand` call sites and assert each command-name literal is in `COMMAND_NAMES`. Use a **multi-line-aware** match, because several call sites (`cache:read` included) put the command literal on the line after `rtCommand(` / `rtCommand<...>(`): read each file whole and match across newlines, e.g. `/rtCommand\s*(?:<[^>]*>)?\s*\(\s*["']([^"']+)["']/g`. Seed it so `cache:read` would have failed before B2.
- [ ] **Step 2:** Run to verify it passes now (B2 cataloged `cache:read`); temporarily remove `cache:read` from the catalog to confirm the test catches it, then restore.
- [ ] **Step 3: Commit** ... `git commit -m "rt-client: guard that every call-site command name is cataloged (R016)"`.

## Task B4: additive `failure` error envelope (R035)

**Files:**
- Modify: `lib/daemon.ts` (`handleCommand`)
- Modify: `packages/rt-client/src/transport.ts` (type the added key)
- Test: `lib/daemon/__tests__/handle-command-envelope.test.ts`

**Interfaces:**
- Produces: on a handler throw, `handleCommand` returns `{ ok: false, error: string, failure: { code: string; message: string }, reqId }` (never rethrows to the transport). `error` stays the human string consumers display today; `failure` is the new additive structured key; both are filled from the same throw (`error = message`, `failure = { code, message }`).

- [ ] **Step 1: Write the failing test:**

```ts
import { test, expect } from "bun:test";
// build a handleCommand over a handler map with one throwing handler
test("a thrown handler yields an additive failure envelope, not a rethrow", async () => {
  const res = await handleCommand("boom:verb", {}, /*seams*/);
  expect(res.ok).toBe(false);
  expect(typeof res.error).toBe("string");           // consumers still display this
  expect(res.failure).toEqual({ code: expect.any(String), message: res.error });
  expect(res.reqId).toBeString();
});
```

- [ ] **Step 2:** Run to verify it fails (today it rethrows).
- [ ] **Step 3:** Wrap the handler call in `handleCommand` in try/catch; on catch, log (as today) and return the additive envelope instead of rethrowing. Choose `code` from the error (`err.code ?? "handler-threw"`). Leave existing `ok: true` top-level fields untouched.
- [ ] **Step 4:** `cd packages/rt-client && bun run build`. Run the new test, the api-server 500 test, and `bunx tsc --noEmit`.
- [ ] **Step 5: Commit** ... `git commit -m "handleCommand: additive {failure:{code,message}} envelope on throw; keep error string (R035)"`.

## Task B5: single `RepoIndex`, fix stale doc and error (R037)

**Files:**
- Modify: `lib/repo-index.ts`, `lib/daemon/handlers/types.ts` (delete the re-declaration, keep a type-only import), `lib/daemon/freshness.ts` (error message)
- Test: `lib/daemon/__tests__/repo-index-message.test.ts`

- [ ] **Step 1:** Write the failing test asserting the freshness "repo not in index" error names `rt repos register` (not `rt repo add`) and does not mention `repos.json`.
- [ ] **Step 2:** Run to verify it fails.
- [ ] **Step 3:** In `lib/repo-index.ts`, add `export` to the `RepoIndex` interface (line ~54 is module-private today). Delete the `RepoIndex` re-declaration in `handlers/types.ts` and import the type from `lib/repo-index.ts`; fix the doc comment (source is state.db kv, not `repos.json`); fix the freshness error text.
- [ ] **Step 4:** `bunx tsc --noEmit`; run the test.
- [ ] **Step 5: Commit** ... `git commit -m "repo-index: one RepoIndex declaration; fix stale repos.json doc + rt repos register message (R037)"`.

## Task B6: branded `SerializedIdentity`, collapse the guards (R039)

> Coordinate with RT-62: if it introduces the brand first, import it here instead of re-declaring.

**Files:**
- Modify: `lib/repo-index.ts` (or wherever `parseIdentity` lives), `lib/daemon/handlers/*.ts` (the 14 guard sites), the payload decoder used by B1
- Test: `lib/daemon/__tests__/identity-decoder.test.ts`

**Interfaces:**
- Produces: `type SerializedIdentity = string & { readonly __brand: "SerializedIdentity" }`; `parseIdentity(s: string): SerializedIdentity | null`; a `decodeRepo(payload): SerializedIdentity` helper that returns the typed error on a null parse.

- [ ] **Step 1:** Write the failing test: `decodeRepo({ repoName: "bad" })` returns an `ok:false` error; `decodeRepo({ repo: "<valid serialized>" })` returns the branded value.
- [ ] **Step 2:** Run to verify it fails.
- [ ] **Step 3:** Add the brand and `decodeRepo`; rename the `repoName` field/param to `repo: SerializedIdentity` in handlers; replace the 14 `parseIdentity(...) === null` guards with one `decodeRepo` call at each handler top.
- [ ] **Step 4:** `bunx tsc --noEmit`; run the handler suites.
- [ ] **Step 5: Commit** ... `git commit -m "handlers: brand SerializedIdentity; collapse 14 parseIdentity guards into decodeRepo (R039)"`.

## Task B7: consolidate `canon` (R029, part 1)

**Files:**
- Create: `lib/fs-canon.ts`
- Modify: `lib/port-scanner.ts`, `lib/repo-locate.ts`, `lib/daemon/worktree-reconciler.ts`, `lib/daemon/handlers/worktree.ts`, `lib/runs/prune.ts`
- Test: `lib/__tests__/fs-canon.test.ts`

**Note:** the `worktree-reconciler.ts` call sites are grep-discovered against the merged Phase 4 file; the copy counts here are indicative (Phase 4 may move or add sites).

**Interfaces:**
- Produces: `canon(path: string): string`. **Chosen semantics:** realpath when it resolves, else the input path unchanged (the four non-recursive copies' behavior). The recursive `runs/prune.ts` variant is dropped; the test documents why (a parent-walking canon changes prune's match set).

- [ ] **Step 1:** Write the failing test covering: an existing path canonicalizes; a missing path returns unchanged (not a parent walk).
- [ ] **Step 2:** Run to verify it fails.
- [ ] **Step 3:** Implement `lib/fs-canon.ts`; replace all five call sites with an import. For `runs/prune.ts`, confirm the prune match set is unchanged by the semantics choice (add an assertion in the prune test if one is affected).
- [ ] **Step 4:** `bunx tsc --noEmit`; run the affected suites.
- [ ] **Step 5: Commit** ... `git commit -m "fs-canon: one canon() over 5 copies; document dropped recursive variant (R029)"`.

## Task B8: consolidate `patchTree` (R029, part 2)

**Files:**
- Create: `lib/worktree/patch.ts`
- Modify: `lib/daemon/worktree-reconciler.ts`, `lib/daemon/handlers/worktree.ts`
- Test: `lib/worktree/__tests__/patch.test.ts`

**Note:** the `worktree-reconciler.ts` call sites are grep-discovered against the merged Phase 4 file; the copy counts here are indicative (Phase 4 may move or add sites).

- [ ] **Step 1:** Write the failing test for the single `patchTree(load, mutate, save)` (load-mutate-save) covering the epoch check both copies should share.
- [ ] **Step 2:** Run to verify it fails.
- [ ] **Step 3:** Extract to `lib/worktree/patch.ts`; replace both call sites.
- [ ] **Step 4:** `bunx tsc --noEmit`; run the reconciler + worktree-handler suites.
- [ ] **Step 5: Commit** ... `git commit -m "worktree/patch: one patchTree over 2 copies (R029)"`.

## Task B9: consolidate `numericUserId` and terminal states (R029, part 3)

**Files:**
- Modify: `lib/notifier.ts`, `lib/daemon/discussions-store.ts`, `lib/daemon/discussions-poller.ts`, `lib/daemon/worktree-reconciler.ts`, `lib/enrich.ts`
- Test: `lib/__tests__/numeric-user-id.test.ts`

**Note:** the `worktree-reconciler.ts` and other call sites are grep-discovered against the merged Phase 4 file; the copy counts here are indicative (Phase 4 may move or add sites).

**Interfaces:**
- Produces: one `numericUserId(id: string | null | undefined): number | null`. **Chosen semantics:** split on `:`, `parseInt` the tail, `Number.isFinite` gate (the discussions-store form), so `gitlab:user:12a` yields `12` consistently; the notifier's self-author null-means-suppress rule is applied at its own call site, not inside the helper. `MR_TERMINAL_STATES` exported from `enrich.ts`.

- [ ] **Step 1:** Write the failing test: `numericUserId("gitlab:user:12a") === 12`; `numericUserId(null) === null`; and that `MR_TERMINAL_STATES` is the single source for the three former copies.
- [ ] **Step 2:** Run to verify it fails.
- [ ] **Step 3:** Implement the one helper and the constant; replace the two `numericUserId` copies and the three `TERMINAL` copies; preserve the notifier's suppression rule at its call site.
- [ ] **Step 4:** `bunx tsc --noEmit`; run the notifier + discussions + reconciler suites.
- [ ] **Step 5: Commit** ... `git commit -m "one numericUserId + MR_TERMINAL_STATES; retire drifting copies (R029)"`.

## Task B10: remove the `db` factory seam (R028)

**Files:**
- Modify: `lib/daemon/command-router.ts` (the three strip sites), `lib/daemon/handlers/{chat,pane,agent}.ts` (factory return types)
- Test: `lib/daemon/__tests__/router-no-db-key.test.ts`

- [ ] **Step 1:** Write the failing test asserting `buildRoutedHandlers(...)` produces a map whose every value is a function (no `db` key), given the three factories.
- [ ] **Step 2:** Run to verify it fails.
- [ ] **Step 3:** Remove `db` from the three factory return types (tests already pass the db in); delete the three `const { db: _x, ...handlers }` strips; type `buildRoutedHandlers`' return as `Record<string, Handler>` so a non-function value is a compile error.
- [ ] **Step 4:** `bunx tsc --noEmit`; run the router + chat/pane/agent suites.
- [ ] **Step 5: Commit** ... `git commit -m "command-router: drop the db factory seam; reject non-function handler values (R028)"`.

## Task B11: per-factory HandlerContext deps (R038)

> Depends on A5 (units own the instances `startDaemon` composes from).

**Files:**
- Modify: `lib/daemon/handlers/types.ts`, each handler factory signature, `lib/daemon.ts` (compose per-factory dep objects)
- Test: `bunx tsc --noEmit` plus existing handler stubs simplify.

- [ ] **Step 1:** For each factory, change its parameter from `ctx: HandlerContext` to a `Pick<HandlerContext, ...>` (or a named small interface) listing only the fields it reads.
- [ ] **Step 2:** In `startDaemon`, compose each factory's dep object from the unit instances.
- [ ] **Step 3:** `bunx tsc --noEmit`; update the test stubs that previously cast `as unknown as HandlerContext` to pass only the narrowed deps.
- [ ] **Step 4:** Run the handler suites.
- [ ] **Step 5: Commit** ... `git commit -m "handlers: per-factory Pick<> deps; drop the 15-field grab-bag at each factory (R038)"`.

## Task B12: point the daemon graph at the leaf label; extend the guard (R050)

**Files:**
- Modify: `lib/notifier.ts:28`, `lib/daemon/handlers/agent.ts:20`, `lib/daemon/handlers/system-processes.ts:3` (import `repoLabel` from `../../repo-label.ts`)
- Modify: `lib/__tests__/no-eager-tui.test.ts`
- Test: same file.

- [ ] **Step 1: Write the failing test:** `no-eager-tui.test.ts` today is a filesystem walk over `commands/` that parses direct imports only, so it does not cover the daemon graph and never reaches `lib/notifier.ts` (which lives outside `lib/daemon/**`). Add a new test that builds a **transitive resolver walk** from the daemon entry set (`lib/daemon.ts`): follow each relative `import` / `export ... from` to its resolved file, recurse, and assert no reachable module statically imports `repo-arg.ts`, `repo.ts`, `fzf.ts`, `rt-render`, or `ink`. If a full resolver walk is too much, the fallback is an explicit scanned set: `lib/daemon.ts`, every `lib/daemon/**` file, and the daemon-imported top-level modules (`lib/notifier.ts`, `lib/enrich.ts`, and any other non-`lib/daemon/` module the daemon reaches). It fails today because `notifier.ts`, `handlers/agent.ts`, and `handlers/system-processes.ts` reach `repo-arg.ts`.
- [ ] **Step 2:** Run to verify it fails.
- [ ] **Step 3:** Change the three imports to `repo-label.ts`.
- [ ] **Step 4:** Run `bun test lib/__tests__/no-eager-tui.test.ts` and `bunx tsc --noEmit`.
- [ ] **Step 5: Commit** ... `git commit -m "daemon: import repoLabel from leaf repo-label.ts; guard lib/daemon/** against the CLI picker chain (R050)"`.

---

# Lane C ... 5.5 state growth and scan bounds

## Task C1: schema convergence on every open (R015, R056)

**Files:**
- Modify: `lib/state/db.ts` (`runMigrations`, the `V*_SCHEMA` concat)
- Test: `lib/state/__tests__/db-schema-convergence.test.ts`

**Interfaces:**
- Produces: `const SCHEMAS = [V1_SCHEMA, V2_SCHEMA, V3_SCHEMA, V4_SCHEMA, V6_SCHEMA, V7_SCHEMA]`; `runMigrations` execs `SCHEMAS.join("")` plus the three guarded column helpers **unconditionally** inside the IMMEDIATE transaction; `user_version === 0` gates only the legacy JSON import; `user_version` is still stamped to `SCHEMA_VERSION` for compatibility but no longer gates DDL.

- [ ] **Step 1: Write the failing tests:** (a) a db pre-stamped at `SCHEMA_VERSION` but missing a column self-heals on the next `openStateDb` (the R015 regression); (b) a dynamic presence test that greps `db.ts` source for every `CREATE TABLE IF NOT EXISTS <name>` and asserts each `<name>` is in `sqlite_master` after a fresh open (replacing the hand-maintained golden list) ... this fails if a constant is left out of `SCHEMAS`.

```ts
// (a) self-heal shape
test("a db stamped at SCHEMA_VERSION but missing a column self-heals on open", () => {
  // open temp db, manually PRAGMA user_version = SCHEMA_VERSION, DROP a column,
  // reopen via openStateDb, assert the column is back
});
// (b) dynamic presence
test("every CREATE TABLE in db.ts source exists in sqlite_master", () => {
  const src = readFileSync(new URL("../db.ts", import.meta.url), "utf8");
  const names = [...src.matchAll(/CREATE TABLE IF NOT EXISTS (\w+)/g)].map(m => m[1]);
  const db = openStateDb(tmp());
  const present = new Set(tableNames(db));
  for (const n of names) expect(present.has(n)).toBe(true);
});
```

- [ ] **Step 2:** Run to verify they fail.
- [ ] **Step 3:** Refactor `runMigrations`: array-ify to `SCHEMAS`, run `SCHEMAS.join("")` + the three `addXColumnIfMissing` helpers unconditionally; keep `user_version === 0` as the legacy-import gate only. Delete the hand-maintained golden-list test (replaced by the dynamic one).
- [ ] **Step 4:** Run `lib/state/__tests__/db*.test.ts` and `bunx tsc --noEmit`.
- [ ] **Step 5: Commit** ... `git commit -m "state/db: converge schema on every open; dynamic table-presence test (R015/R056)"`.

## Task C2: chat_messages retention + index + `rt chat prune` (R053)

**Files:**
- Modify: `lib/state/db.ts` (an `(room, posted_at)` index via the always-applied DDL if the summary scan needs it), `lib/state/chat-store.ts` (a `pruneMessages(olderThanMs, perRoomFloor)`), `lib/command-tree-def.ts` + `commands/chat.ts` (`rt chat prune`), the retention sweep unit (registered via A2's `scheduleSweep`)
- Test: `lib/state/__tests__/chat-prune.test.ts`

**Interfaces:**
- Produces: `pruneMessages(db, { olderThanMs: CHAT_RETENTION_MS, perRoomFloor: CHAT_ROOM_FLOOR }): { removed: number }`; named constants `CHAT_RETENTION_MS` (e.g. 90 days) and `CHAT_ROOM_FLOOR` (e.g. keep last 200 per room).

- [ ] **Step 1: Write the failing test:** seed a room with old + recent messages; assert prune deletes past the age floor but never below `perRoomFloor`, and leaves a room with only recent messages untouched.
- [ ] **Step 2:** Run to verify it fails.
- [ ] **Step 3:** Implement `pruneMessages` (a `DELETE` keyed on `(room, posted_at)` with a per-room `id`-ranked floor); add the index in the DDL; wire `rt chat prune` (a leaf with no required positional, so no `omitBehavior` needed) into `command-tree-def.ts` and `module-registry.ts` if a new module is added (reuse `commands/chat.ts`, which already has a registry thunk); register the daily sweep as a unit.
- [ ] **Step 4:** Run the new test, `picker:check`, and `bunx tsc --noEmit`.
- [ ] **Step 5: Commit** ... `git commit -m "chat: message retention sweep + (room,posted_at) index + rt chat prune (R053)"`.

## Task C3: agents retention + index (R054)

**Files:**
- Modify: `lib/state/db.ts` (a `created_at` index via the always-applied DDL), `lib/state/agents-store.ts` (a `pruneAgents(olderThanMs)`), the retention sweep unit
- Test: `lib/state/__tests__/agents-prune.test.ts`

**Interfaces:**
- Produces: `pruneAgents(db, { finishedBeforeMs: AGENTS_RETENTION_MS }): { removed: number }`; named constant `AGENTS_RETENTION_MS` (e.g. 30 days).

- [ ] **Step 1: Write the failing test:** seed finished + running agents; assert prune deletes finished rows older than the floor and never a running (`finished_at IS NULL`) row.
- [ ] **Step 2:** Run to verify it fails.
- [ ] **Step 3:** Implement `pruneAgents`; add the `created_at` index; add the daily prune to the retention sweep unit alongside chat prune.
- [ ] **Step 4:** Run the new test and `bunx tsc --noEmit`.
- [ ] **Step 5: Commit** ... `git commit -m "agents: finished-age retention sweep + created_at index (R054)"`.

## Task C4: bound the events journal reads (S047, R030)

**Files:**
- Modify: `lib/daemon/events-bus.ts` (`afterStmt`, `eventsAfter`, `wait`, `insertAndWake`), `lib/daemon/handlers/events.ts` (default cap on `events:list`)
- Test: `lib/daemon/__tests__/events-bus-bounds.test.ts`

**Interfaces:**
- Produces: `eventsAfter(pattern, after, limit)` pushes `LIMIT ?` into SQL (fetch `limit + 1` to detect truncation, glob-filter the page); `events:list` defaults to a hard cap (500) when the client omits `limit`; `wait` registers waiters with `afterId = head`.

- [ ] **Step 1: Write the failing tests:** (a) `list({ pattern, limit: N })` reads at most `N + 1` rows (spy on `afterStmt.all`); (b) a waiter registered with a stale `after` does not rescan the whole journal on the next non-matching emit (assert the waiter's `afterId` is `head`).
- [ ] **Step 2:** Run to verify they fail.
- [ ] **Step 3:** Add `LIMIT ?` to `afterStmt`, page in id order, apply the default cap, and register waiters at `head`.
- [ ] **Step 4:** Run `lib/daemon/__tests__/events-bus*.test.ts` and `bunx tsc --noEmit`.
- [ ] **Step 5: Commit** ... `git commit -m "events-bus: LIMIT in SQL + default list cap + waiter afterId=head (S047/R030)"`.

## Task C5: `rt state backup`/`restore` + boot integrity check (R055)

**Files:**
- Create: `commands/state.ts`
- Modify: `lib/module-registry.ts` (add `() => import("../commands/state.ts")`), `lib/command-tree-def.ts` (the `state` node with `backup`/`restore` leaves), `lib/state/db.ts` (a `backupTo(path)` using `VACUUM INTO`, a `quickCheck()` wrapper), the daemon boot unit (run `quickCheck` and warn), the retention sweep unit (daily rotating copy)
- Test: `commands/__tests__/state-backup.test.ts`, `lib/state/__tests__/db-integrity.test.ts`

**Interfaces:**
- Produces: `backupTo(db, path): void` (`VACUUM INTO`); `quickCheck(db): string[]` (empty on ok); `rt state backup` (no required positional), `rt state restore <copy>` (required positional `copy`).

- [ ] **Step 1: Write the failing tests:** (a) `backupTo` writes a valid db that reopens with the same tables/rows; (b) `quickCheck` returns `[]` on a healthy db and a nonempty list on a deliberately corrupted one; (c) `rt state restore` with no positional under a TTY shows a picker over stamped copies, and under `--json`/non-TTY errors with the existing usage/exit code (the picker-conformance gate).
- [ ] **Step 2:** Run to verify they fail.
- [ ] **Step 3:** Implement `commands/state.ts` (`backup`, `restore`); register the module-registry thunk; add the `state` node in `command-tree-def.ts` with `restore`'s required positional declaring `omitBehavior: "picker"` (a picker over existing stamped copies) and its leaf picker gating `process.stdin.isTTY && !json && !process.env.RT_BATCH`; add `backupTo`/`quickCheck` to `db.ts`; run `quickCheck` in the boot unit (warn, do not block); add the daily rotating copy to the retention sweep.
- [ ] **Step 4:** Run the new tests, `bun run picker:check`, and `bunx tsc --noEmit`.
- [ ] **Step 5: Commit** ... `git commit -m "state: rt state backup/restore + boot quick_check + daily copy (R055)"`.

---

# Lane D ... 5.6 seam tests (after Lane A)

## Task D1: api-server integration test (R024)

**Files:**
- Modify: `lib/daemon/api-server.ts` (only if a test seam is needed to inject `handleCommand` and the port)
- Test: `lib/daemon/__tests__/api-server.test.ts`

- [ ] **Step 1: Write the test:** start `startApiServer` on `RT_API_PORT=0` with a fake `handleCommand`; drive `fetch` and assert: routing dispatch to the fake; the token gate per `REST_ROUTES` (401 without a token on a gated route, 200 with); CORS headers (no `ACAO:*` for a foreign Origin); a WS upgrade with a foreign Origin is rejected; the 404/405/500 envelope shape (500 carries the additive `failure`); a client disconnect aborts the handler `signal`.
- [ ] **Step 2:** Run; add the minimal injection seam to `api-server.ts` if needed to pass a fake `handleCommand` and read the chosen port.
- [ ] **Step 3:** Run under a temp HOME; `bunx tsc --noEmit`.
- [ ] **Step 4: Commit** ... `git commit -m "test: api-server integration (routing, token, CORS, WS origin, 500 envelope, abort) (R024)"`.

## Task D2: socket-server integration test (R024)

**Files:**
- Test: `lib/daemon/__tests__/socket-server.test.ts`

- [ ] **Step 1: Write the test:** bind `startSocketServer` on a temp socket with a fake `handleCommand`; send framed requests; assert dispatch, the additive `failure` envelope on a thrown handler, and the request-body size cap (`MAX_REQUEST_BODY_SIZE`) rejects an oversized frame.
- [ ] **Step 2:** Run under a temp HOME; `bunx tsc --noEmit`.
- [ ] **Step 3: Commit** ... `git commit -m "test: socket-server integration (dispatch, envelope, body cap) (R024/R027)"`.

## Task D3: pollers wiring test + bounce coverage (R047, R027)

**Files:**
- Modify: `lib/daemon/pollers.ts` (inject scanners if needed)
- Test: `lib/daemon/__tests__/pollers.test.ts`, `lib/daemon/__tests__/bounce.test.ts`

- [ ] **Step 1: Write the pollers test:** with injected port/process scanners, assert the in-flight guards hold (a second tick during an in-flight scan does not double-run), demand gating skips work when nothing is demanded, and a never-settling scan does not block a later tick once a deadline is present.
- [ ] **Step 2: Write a bounce test** covering its one responsibility (the genuinely-untested module).
- [ ] **Step 3:** Add the minimal scanner-injection seam to `pollers.ts` if needed; run under a temp HOME; `bunx tsc --noEmit`.
- [ ] **Step 4: Commit** ... `git commit -m "test: pollers wiring (in-flight, demand gate, deadline) + bounce (R047/R027)"`.

---

# Lane E ... 5.7 reconciler decomposition (last)

## Task E0: re-base gate (Phase 4)

- [ ] **Step 1:** Confirm Phase 4 (p4-destructive-engine) is merged into this branch's base. If not, STOP Lane E until it is.
- [ ] **Step 2:** Re-read `lib/daemon/worktree-reconciler.ts` as merged. Map the five duties (reconcile, reactor, freshen, replenish, shrink) to their current functions; note what Phase 4 changed in reconcile/dispose and where reap now lives (reap is Phase 4's retention concern, re-based not designed here).
- [ ] **Step 3:** Adjust E1..E5 file/line references to the merged reality before implementing. (No commit; this is a read step.)

## Task E1: extract `reconcile.ts` and `reactor.ts` (+ fired-ledger GC, R049)

**Files:**
- Create: `lib/daemon/reconciler/reconcile.ts`, `lib/daemon/reconciler/reactor.ts`
- Modify: `lib/daemon/worktree-reconciler.ts` (import the extracted steps)
- Test: `lib/daemon/reconciler/__tests__/reconcile.test.ts`, `reactor.test.ts`

**Interfaces:**
- Produces: `reconcileRepo(deps): Promise<TreeRecord[]>`; `detectTransitions(deps): Promise<void>` with the `fired`-ledger GC (drop `disposed:<repo>:<iid>:*` keys whose MR is no longer in the repo's branch-cache entries).

- [ ] **Step 1: Write the failing reactor GC test:** seed `fired` with a `disposed:repo:99:*` key whose MR 99 is absent from cacheEntries; run a pass; assert the key is dropped and a returning MR re-notifies.
- [ ] **Step 2:** Run to verify it fails.
- [ ] **Step 3:** Move `reconcileRepoRegistry`/`reconcilePass` to `reconcile.ts` and the reactor (`detectTransitions` + reactor-state IO) to `reactor.ts`; add the fired-ledger GC keyed on the branch-cache set; move the relevant `__test__` exports to the new files.
- [ ] **Step 4:** Run the reconciler suites and `bunx tsc --noEmit`.
- [ ] **Step 5: Commit** ... `git commit -m "reconciler: extract reconcile.ts + reactor.ts with fired-ledger GC (R014/R049)"`.

## Task E2: extract `freshen.ts`

**Files:**
- Create: `lib/daemon/reconciler/freshen.ts`
- Modify: `lib/daemon/worktree-reconciler.ts`, `lib/daemon/handlers/worktree.ts` (import path)
- Test: `lib/daemon/reconciler/__tests__/freshen.test.ts`

- [ ] **Step 1:** Move `freshenCandidate`/`freshenOne`/`freshenRepo` to `freshen.ts` with their `__test__` exports; write/keep a test for the per-repo freshen step.
- [ ] **Step 2:** Run to verify it fails, then passes after the move.
- [ ] **Step 3:** `bunx tsc --noEmit`; run the suites.
- [ ] **Step 4: Commit** ... `git commit -m "reconciler: extract freshen.ts (R014)"`.

## Task E3: extract `replenish.ts` (shrink co-located)

**Files:**
- Create: `lib/daemon/reconciler/replenish.ts`
- Modify: `lib/daemon/worktree-reconciler.ts`
- Test: `lib/daemon/reconciler/__tests__/replenish.test.ts`

- [ ] **Step 1:** Move `withCreateLock`/`replenishAndShrink` to `replenish.ts`. Shrink stays in this file (it shares `replenishAndShrink`); a file comment states this is a layout choice, not a separate duty.
- [ ] **Step 2:** Keep the replenish + pool-shrink tests green through the move.
- [ ] **Step 3:** `bunx tsc --noEmit`; run the suites.
- [ ] **Step 4: Commit** ... `git commit -m "reconciler: extract replenish.ts (shrink co-located) (R014)"`.

## Task E4: per-repo concurrency-capped scheduler (S094, preserve S065)

**Files:**
- Modify: `lib/daemon/worktree-reconciler.ts` (`runOnce`, `createWorktreeReconciler`)
- Test: `lib/daemon/__tests__/reconciler-concurrency.test.ts`, and the existing `worktree-reconciler.test.ts:*` kick-queue cases stay green.

**Interfaces:**
- Produces: a `runOnce` that schedules per-repo steps as independent promises with a concurrency cap (named constant `RECONCILER_CONCURRENCY`), instead of one serial loop; `createBackoff` moves onto the reconciler instance.

- [ ] **Step 1: Write the failing test:** with a multi-repo index where one repo's freshen is slow, assert a second repo's reactor runs without waiting for the slow repo (independent scheduling), and that `withReconcilerHeld` still drains in-flight work before running.
- [ ] **Step 2:** Run to verify it fails.
- [ ] **Step 3:** Rework `runOnce` to schedule per-repo with a concurrency cap; move `createBackoff` into the instance. **Preserve S065's kick-queue behavior and its regression test** (`worktree-reconciler.test.ts:1379`): a mid-pass kick still queues and fires once in `finally`.
- [ ] **Step 4:** Run the concurrency test, the kick-queue test, and `bunx tsc --noEmit`.
- [ ] **Step 5: Commit** ... `git commit -m "reconciler: per-repo concurrency-capped scheduling; preserve kick-queue (R014/S094/S065)"`.

## Task E5: adopt/freshen under the reconciler hold; delete `#adopt` (R041)

**Files:**
- Modify: `lib/daemon/handlers/worktree.ts` (`worktree:adopt`, `worktree:freshen`)
- Test: `lib/daemon/__tests__/reconciler-hold.test.ts` (extend)

- [ ] **Step 1: Write the failing test:** assert `worktree:adopt` and `worktree:freshen` run inside `withReconcilerHeld` (a concurrent reconciler pass cannot interleave with an adopt on the same repo), and the `${repoPath}#adopt` synthetic key is gone.
- [ ] **Step 2:** Run to verify it fails.
- [ ] **Step 3:** Wrap both handlers in `opts.withReconcilerHeld(...)`; delete the `#adopt` `withTreeLock` key and its comment.
- [ ] **Step 4:** Run the hold suite and `bunx tsc --noEmit`.
- [ ] **Step 5: Commit** ... `git commit -m "worktree: run adopt + freshen under withReconcilerHeld; delete #adopt lock (R041)"`.

---

## Self-review (completed by the plan author)

- **Spec coverage:** 5.1 -> A1-A5; 5.2 -> B1-B4; 5.3 -> B5-B11; 5.4 -> B12; 5.5 -> C1-C5; 5.6 -> D1-D3; 5.7 -> E0-E5. The retired findings (R010/R033/R034/S085/S102/R026/R018/R023/S065) have no tasks by design.
- **SCHEMA_VERSION:** C1 makes retention indexes idempotent-on-open; no task bumps the version. Constraint satisfied.
- **Re-base gates:** A5 (Phase 2 + 6), E0 (Phase 4), B6 (RT-62) are called out where they land.
- **Type consistency:** `SerializedIdentity`/`decodeRepo` (B6) are the decoder B1 references; `failure` envelope (B4) is asserted by D1/D2; `scheduleSweep` (A2) is the retention sweep host in C2/C3/C5; `DaemonUnit` (A1) is consumed by A5 and the seam tests.
- **Picker/registry:** C5 declares the module-registry thunk and the `restore` `omitBehavior` + picker gate; C2's `rt chat prune` has no required positional.
