# Phase 0 · Honest Supervision Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make rt daemon crashes visible and recoverable: every boot failure exits non-zero (or parks visibly) instead of becoming a silent zombie, crash/restart history is persisted and surfaced by `rt daemon status`, and start/stop/eviction stop deleting a live daemon's runtime files.

**Architecture:** Retire the P0/P1 crash-and-hide class in `lib/daemon.ts` and its immediate collaborators. Boot failures become fatal (log + `process.exit(1)`) on the prod path, gated by a boot-phase flag so steady-state stray rejections still recover; crash handlers and stderr redirection move above every module-scope side effect; restart counters and last-exit reasons live in the existing `kv` table (no schema change); `rt daemon status` and `/api/status` gain `alive-not-serving` / `parked` / `boot-failed` / `crash-looping` verdicts; start/stop/eviction become ownership-aware. Two one-line correctness fixes (state.db flavor on the snapshot path, extended busy-code matching + `BEGIN IMMEDIATE`) make the contention policy real.

**Tech Stack:** Bun, `bun:sqlite`, pino, TypeScript. Tests are `bun test` (unit) and `bun test --preload ./e2e/setup.ts` (e2e, isolated-HOME daemon spawns).

**Spec:** `/Users/matt/Documents/GitHub/repo-tools/.claude/worktrees/daemon-stability-audit/docs/daemon-stability-audit-2026-08.md` ... "Roadmap › Phase 0" plus Appendix A/B entries S001, S003, S004, S009, S011, S012, S026, S027, S028, S029, S030, S035, S036, S037, S043, S044, S060, S072, S073, S074, R001, R002, R007, R017. Each carries a failure scenario, prescribed fix, and fixer notes; read the relevant entry before implementing its task.

## Global Constraints

- **No `SCHEMA_VERSION` bump and no new/edited `V*_SCHEMA` block.** Persist all supervision state (restart counters, last-exit reason, boot-failed markers) in the existing `kv` table under namespace `daemon-supervision`, via `setKvValue`/`getKvValue` from `lib/state/kv-blob.ts`. If any task appears to need a schema change, STOP and ask the user (per the job brief's question format) ... do not proceed.
- **Never start a daemon or run `rt` against the real machine.** Every daemon or `dist/rt` invocation in a test or check runs under `env -i HOME=<temp dir>` only (repo CLAUDE.md, "Operating on this machine"). e2e daemon spawns already do this via `e2e/setup.ts`; new e2e tests must follow the same isolation.
- **Write fence ... do NOT modify these sibling-owned files** (ask the user if a task seems to need one): `lib/daemon/api-server.ts`, `lib/daemon/api-auth.ts`, `lib/daemon/socket-server.ts`, `lib/daemon/handlers/secrets.ts`, `lib/subprocess.ts`, `lib/daemon/cache-refresh.ts`, `lib/git-worktrees.ts`, `lib/daemon/freshness.ts`, `lib/daemon/pollers.ts`, `lib/daemon/worktree-process-kill.ts`, `lib/daemon/system-process-scanner.ts`, `lib/runs/store.ts`, `lib/notifier.ts`, `lib/daemon/handlers/discussions.ts`, `lib/daemon/handlers/chat.ts`, `lib/daemon/handlers/agent.ts`, `lib/daemon/handlers/pane.ts`, `lib/daemon/handlers/project-mrs.ts`, `lib/daemon/handlers/worktree.ts`, `lib/herdr/client.ts`, `lib/port-scanner.ts`, `lib/deps/links.ts`, `lib/worktree/trash.ts`, `lib/agent-herdr.ts`, `lib/daemon/cron.ts`, `lib/daemon/hooks-guard.ts`, `lib/home/age-key.ts`, `lib/daemon/discussions-store.ts`, `lib/state/presence-store.ts`.
- **Every subagent dispatched during execution carries an explicit `model`** (`sonnet` for mechanical tasks, `haiku` for lookups).
- **`packages/rt-client` is touched** (Task 5 edits `registry-defs.ts`). After that task and before the final whole-branch review, run `bun run build` inside `packages/rt-client` (keeps `dist/` and `dist-freshness.test.ts` green).
- **Verification (must pass before the work is done):**
  - `bun test lib commands packages scripts` green (from the worktree root)
  - `bunx tsc --noEmit` reports zero errors
  - `bun run test:e2e` green, or at minimum `bun test --preload ./e2e/setup.ts --timeout 60000 e2e/tests/daemon.test.ts` (say which was run)

## Deferred / out-of-fence items (documented, not implemented here)

- **S073 · `presence-store.ts:signIn` → `.immediate()`** ... `lib/state/presence-store.ts` is fenced. Task 7 converts the chat-store and notifier-store read-then-write transactions; the `signIn` caller is a follow-up for the presence-store owner. Not required for verification.
- **0.3 · `rt.apiPort` bind-time consumption** ... `lib/daemon/api-server.ts` (the binder) is fenced. Task 5 registers the `rt.apiPort` setting and exposes `resolveApiPort()`; the bind-time read is the api-server sibling's hop. The escape hatch is therefore wired daemon-side but consumed sibling-side; do not claim it functions end-to-end until the sibling reads it.
- **Swift tray edits (S026 dot mapping, S028 `DaemonLifecycle` kickstart fallback, S029 `tray-crash.log` rotation, S060 `AppDelegate` comment)** ... grouped as optional Task 16. They cannot be verified by the bun/tsc/e2e gate and the operating rules forbid rebuilding the blessed bundle. Scope confirmation is raised at the plan-review checkpoint. The verifiable CLI-side halves (S028 start→kickstart fallback, S060 exit-code policy) live in Tasks 14 and 12 and are done regardless.

---

## Task 1: Status-verdict + exit-code design sketch

The half-page design that Tasks 9-14 depend on. No production code; the deliverable is a committed design doc. (Retires nothing directly; anchors R001, R002, S036, S060, S026, S028.)

**Files:**
- Create: `docs/daemon-supervision-design.md`

**Interfaces:**
- Produces: the verdict names (`serving`, `alive-not-serving`, `parked`, `boot-failed`, `crash-looping`, `installed-not-running`, `not-installed`), the boot-phase names (`booting` → `ready`), the kv keys under ns `daemon-supervision`, the boot-breadcrumb shape, and the exit-code policy table. Tasks 9/10/12 consume these names verbatim.

- [ ] **Step 1: Write the design doc** with exactly this content:

```markdown
# Daemon supervision: status verdicts and exit-code semantics

Phase 0 design anchor for the rt daemon stability roadmap (audit
2026-08). Tasks 9-14 of the Phase 0 plan implement this.

## launchd contract

The prod plist sets `KeepAlive = { SuccessfulExit: false }`: launchd
respawns the daemon ONLY on a non-zero exit. A zero exit means "stay
down". Every exit-code decision below follows from that single fact.

## Exit-code policy

| Path                                    | Exit | Why |
|-----------------------------------------|------|-----|
| `startDaemon()` boot throw (prod path)  | 1    | Visible + launchd relaunches. Paired with crash-loop detection so it cannot loop silently forever. |
| `shutdown` IPC/REST verb                | 0    | Intentional stop; launchd must not respawn. Records `last-exit.kind = "shutdown"`. |
| Bare OS signal SIGTERM/SIGINT/SIGHUP    | 1    | External kill (pkill, script, memory pressure); launchd SHOULD respawn. The sanctioned stop path goes through SMAppService.unregister, where the exit code is irrelevant, so exiting non-zero here does not break intended stops. |
| Crash-loop guard trips (N in M minutes) | 0 (park) | Stop the flapping; surface `crash-looping` so a human intervenes instead of launchd hammering every ~10s. |

Mechanism: a module-scope `shuttingDownViaVerb` flag is set true by the
`shutdown` verb before it calls cleanup; `gracefulExit(signal)` reads it
... set → exit(0), unset (bare signal) → exit(1).

Boot-phase gate: a module-scope `bootPhase: "booting" | "ready"` flips
to `"ready"` immediately before the `daemon ready` log. The
`unhandledRejection` handler exits(1) while `bootPhase === "booting"`
and only logs (recovers) once ready ... so a boot-time stray rejection is
fatal but a steady-state one is not.

## Status verdicts

`rt daemon status` and `/api/status` classify by first match:

1. `not-installed` ... SMAppService not registered.
2. `serving` ... ping on rt.sock succeeds.
3. `parked` ... ping fails, a live rt pid exists, and the boot breadcrumb
   phase is a flavor standoff (park). Named distinctly so the user is
   told "another flavor owns the socket", not "wedged".
4. `alive-not-serving` ... ping fails but a live rt pid exists
   (`process.kill(pid,0)` on rt.pid, or `pgrep -f 'rt --daemon|lib/daemon.ts'`).
   Sub-detail from the breadcrumb phase: `booting` / `wedged`, or
   `quarantined` when a state.db/events.db boot-failed marker is present.
   Prints "process <pid> is running but not answering rt.sock ... rt daemon logs -t".
5. `crash-looping` ... no live pid AND the kv failure record shows ≥ N
   failures within the last M minutes (N=3, M=5). Prints the last reason.
6. `boot-failed` ... no live pid AND the most recent kv exit record is a
   boot throw (fewer than N failures). Prints the last reason + phase.
7. `installed-not-running` ... registered, no live pid, clean/again-absent
   exit record.

## Persisted state (kv, ns `daemon-supervision`, no schema change)

- `boot-attempts` (number) ... incremented at the top of `runDaemon()`.
- `last-ready-at` (number, epoch ms) ... stamped just before `daemon ready`.
- `recent-failures` (array of `{ at, phase, reason }`, capped to 10) ...
  appended by the boot fatal path and by state.db/events.db boot-failed
  markers. Crash-loop = ≥ N entries newer than now − M minutes.
- `last-exit` (`{ at, kind: "shutdown" | "signal" | "boot-failed", code, reason? }`)
  ... written by the shutdown verb, the signal handlers, and the boot
  fatal path. Lets status distinguish "cleanly stopped" from "died".

## Boot breadcrumb

`~/.mattstack/rt/daemon-boot.json` = `{ at, pid, flavor, phase }`,
rewritten at each boot phase: `start` → `crash-handlers` → `events-db`
→ `state-db` → `socket` → `api` → `ready`. Lets `alive-not-serving`
name where a live-but-silent daemon is stuck even when the logs are
unreadable. Removed (or stamped `ready`) on successful boot.
```

- [ ] **Step 2: Commit**

```bash
git add docs/daemon-supervision-design.md
git commit -m "docs: sketch daemon supervision verdicts + exit-code semantics"
```

---

## Task 2: Fatal boot means exit (0.1 ... S001, S037)

Boot failures on the prod path currently become an `unhandledRejection` that only logs, leaving a live-pid zombie with no socket/API. Make a `runDaemon()` throw fatal, gate the rejection handler on a boot-phase flag, and move the rt.pid write to after both binds.

**Files:**
- Modify: `lib/daemon-logger.ts:232-264` (`installCrashHandlers` gains a `booting` predicate)
- Modify: `lib/daemon.ts:385-514` (wrap `runDaemon()` body; boot-phase flag; move rt.pid write), `lib/daemon.ts:392` (pass predicate), `lib/daemon.ts:513` (flip flag)
- Test: `lib/__tests__/daemon-logger.test.ts` (rejection handler), `e2e/tests/daemon.test.ts` (fatal boot)

**Interfaces:**
- Produces: `installCrashHandlers(logger, opts?: { booting?: () => boolean })` ... when `booting()` is true, `unhandledRejection` logs `fatal` and `process.exit(1)`; otherwise it logs `error` only (today's behavior). Default (no `booting`) preserves today's error-only behavior.
- Produces: module-scope `let bootPhase: "booting" | "ready" = "booting"` in `lib/daemon.ts`, flipped to `"ready"` at line 513.

- [ ] **Step 1: Write the failing unit test** in `lib/__tests__/daemon-logger.test.ts`:

```ts
test("unhandledRejection exits(1) while booting, only logs once ready", () => {
  const exits: number[] = [];
  const origExit = process.exit;
  // @ts-expect-error test stub
  process.exit = (code?: number) => { exits.push(code ?? 0); };
  const fatal = mock(() => {});
  const error = mock(() => {});
  const logger = makeFakeLogger({ fatal, error }); // existing test helper
  let booting = true;
  installCrashHandlers(logger, { booting: () => booting });
  process.emit("unhandledRejection", new Error("boot boom"), Promise.resolve());
  expect(fatal).toHaveBeenCalledTimes(1);
  expect(exits).toEqual([1]);
  booting = false;
  process.emit("unhandledRejection", new Error("steady boom"), Promise.resolve());
  expect(error).toHaveBeenCalledTimes(1);
  expect(exits).toEqual([1]); // no second exit
  process.exit = origExit;
});
```

(If `makeFakeLogger` does not exist, build a minimal `{ info, warn, error, fatal }` of `mock(() => {})`. Remove the listeners this test adds in `afterEach` via `process.removeAllListeners("unhandledRejection")` scoped to the test, matching the file's existing cleanup convention.)

- [ ] **Step 2: Run it ... expect FAIL** (`booting` option not supported):

Run: `bun test lib/__tests__/daemon-logger.test.ts -t "unhandledRejection exits"`
Expected: FAIL.

- [ ] **Step 3: Implement in `lib/daemon-logger.ts`.** Change the signature and the `unhandledRejection` branch (currently lines 242-244):

```ts
export function installCrashHandlers(
  logger: Logger,
  opts: { booting?: () => boolean } = {},
): void {
  // ... uncaughtException handler unchanged (still fatal + exit 1) ...
  process.on("unhandledRejection", (reason) => {
    if (opts.booting?.()) {
      logger.fatal({ err: reason }, "unhandledRejection during boot");
      process.exit(1);
      return;
    }
    logger.error({ err: reason }, "unhandledRejection");
  });
  // ... stderr interception unchanged ...
}
```

- [ ] **Step 4: Run the unit test ... expect PASS.**

- [ ] **Step 5: Wire the boot-phase flag + fatal wrap + rt.pid move in `lib/daemon.ts`.**
  - Add near the top of module scope (after imports, before line 78): `let bootPhase: "booting" | "ready" = "booting";`
  - At the `installCrashHandlers(loggerHandle)` call (line 392): `installCrashHandlers(loggerHandle, { booting: () => bootPhase === "booting" });`
  - Wrap the body of `runDaemon()` (385-514) in try/catch:

```ts
async function runDaemon() {
  try {
    // ... existing body 386-513 ...
  } catch (err) {
    loggerHandle.fatal?.({ err }, "daemon boot failed");
    // Task 9 adds recordBootFailure(currentPhase, err) here.
    try { loggerHandle.flush?.(); } catch {}
    process.exit(1);
  }
}
```

  - **Move the rt.pid write** (currently `writeFileSync(DAEMON_PID_PATH, String(process.pid))` at line 416) to AFTER both binds ... i.e. after the API bind at line 469 and the socket bind at line 468 (Task 5 will make API bind first; either way, rt.pid is written only once both `servers.socket` and `servers.api` are assigned). A failed boot then never leaves a live-pid file.
  - Set `bootPhase = "ready";` immediately before `log.info({ pid }, "daemon ready")` at line 513.

- [ ] **Step 6: Write the failing e2e test** in `e2e/tests/daemon.test.ts` (uses the isolated-HOME harness already in `e2e/setup.ts`):

```ts
test("daemon boot with API port already bound exits non-zero and leaves no stale rt.pid", async () => {
  // Bind the API port inside the isolated HOME so the daemon cannot.
  const port = 9411;
  const squatter = Bun.serve({ port, hostname: "127.0.0.1", fetch: () => new Response("busy") });
  try {
    const proc = Bun.spawn({
      cmd: [rtBinary, "--daemon"],
      env: { ...isolatedEnv, RT_API_PORT: String(port) },
      stdout: "pipe", stderr: "pipe",
    });
    const code = await proc.exited;
    expect(code).not.toBe(0);
    expect(existsSync(join(isolatedHome, ".mattstack/rt/rt.pid"))).toBe(false);
  } finally {
    squatter.stop(true);
  }
});
```

(Reuse the harness's existing `rtBinary`, `isolatedEnv`, `isolatedHome` fixtures ... mirror `e2e/tests/daemon.test.ts`'s existing setup. The daemon's own `startApiServer` retries the bind 6× before throwing, so allow up to the 60s timeout.)

- [ ] **Step 7: Run the e2e test ... expect PASS.** Run: `bun test --preload ./e2e/setup.ts --timeout 60000 e2e/tests/daemon.test.ts -t "API port already bound"`

- [ ] **Step 8: Commit**

```bash
git add lib/daemon-logger.ts lib/daemon.ts lib/__tests__/daemon-logger.test.ts e2e/tests/daemon.test.ts
git commit -m "daemon: boot failure is fatal (exit 1), gated by boot-phase flag; rt.pid after binds"
```

---

## Task 3: Crash handlers first (0.2 ... S003, S004, R007)

Move `redirectNativeStderr()` and `installCrashHandlers()` above every module-scope side effect so a pre-`startDaemon` failure lands in the crash log instead of a discarded stderr.

**Files:**
- Modify: `lib/daemon.ts` (hoist two calls to module scope; remove the duplicates inside `runDaemon()` at 391-392)
- Test: `e2e/tests/daemon.test.ts`

**Interfaces:**
- Consumes: `installCrashHandlers(logger, { booting })` from Task 2.

- [ ] **Step 1: Hoist `redirectNativeStderr()`** to the very first executable statement of `lib/daemon.ts` module scope ... before `migrateLegacyRtDir()` at line 78. It depends only on `logsDir()` and has its own internal try/catch, so a subsequent module-scope throw's fd-2 output lands in `daemon-stderr.log`.

- [ ] **Step 2: Hoist `installCrashHandlers(loggerHandle, { booting: () => bootPhase === "booting" })`** to immediately after `getDaemonLogger()` resolves (right after line ~95, before `parkUntilIntended` at 103 and before `createEventsBus` at 191). The logger must exist first (line 85), so this is the earliest correct point.

- [ ] **Step 3: Remove the now-duplicate `redirectNativeStderr()` and `installCrashHandlers()` calls** inside `runDaemon()` (lines 391-392). Keep `mkdirSync(RT_DIR, …)` at 386 (redirect needs the logs dir; `redirectNativeStderr` already mkdirs its own dir, and RT_DIR creation is idempotent ... verify the hoisted `redirectNativeStderr` still finds/creates `logsDir()`).

- [ ] **Step 4: Write the failing e2e test** in `e2e/tests/daemon.test.ts`:

```ts
test("a corrupt events.db does not crash the daemon silently ... error is captured", async () => {
  // Pre-create a corrupt events.db in the isolated HOME.
  const rtDir = join(isolatedHome, ".mattstack/rt");
  mkdirSync(rtDir, { recursive: true });
  writeFileSync(join(rtDir, "events.db"), "not a sqlite file at all");
  const proc = Bun.spawn({ cmd: [rtBinary, "--daemon"], env: isolatedEnv, stdout: "pipe", stderr: "pipe" });
  // Task 4 makes this self-heal; for Task 3 we only require the failure is captured, not /dev/null.
  await Bun.sleep(3000); proc.kill();
  const stderrLog = join(rtDir, "logs", "daemon-stderr.log");
  const quarantined = readdirSync(rtDir).some((f) => f.startsWith("events.db.corrupt-"));
  const captured = existsSync(stderrLog) || quarantined;
  expect(captured).toBe(true);
});
```

- [ ] **Step 5: Run ... expect PASS** (the redirect now runs before events.db construction, so a corruption throw is captured in `daemon-stderr.log`; after Task 4 it is quarantined instead). Run: `bun test --preload ./e2e/setup.ts --timeout 60000 e2e/tests/daemon.test.ts -t "corrupt events.db"`

- [ ] **Step 6: Commit**

```bash
git add lib/daemon.ts e2e/tests/daemon.test.ts
git commit -m "daemon: install stderr redirect + crash handlers before every module-scope side effect"
```

---

## Task 4: events.db joins the discipline (0.4 ... S009, S035)

Give `events.db` the corruption quarantine + busy_timeout/synchronous pragmas state.db has, and guard the two sweep timers so a sync sqlite throw cannot exit the daemon.

**Files:**
- Modify: `lib/daemon/events-bus.ts:64-224` (quarantine + pragmas in `createEventsBus`)
- Modify: `lib/daemon.ts:194,196` (wrap sweep timers; add a `safeInterval`/`safeTimeout` helper)
- Test: `lib/daemon/__tests__/events-bus.test.ts`

**Interfaces:**
- Consumes: `isCorruptionError` and `quarantine` shape from `lib/state/db.ts` (reuse the `SQLITE_CORRUPT`/`SQLITE_NOTADB` detection; `events.db` is a bounded-retention journal, so total loss on quarantine is harmless ... no migration concern).

- [ ] **Step 1: Write the failing test** in `lib/daemon/__tests__/events-bus.test.ts`:

```ts
test("createEventsBus quarantines and recreates a corrupt events.db instead of throwing", () => {
  const dir = mkdtempSync(join(tmpdir(), "events-corrupt-"));
  const dbPath = join(dir, "events.db");
  writeFileSync(dbPath, "garbage not sqlite");
  const bus = createEventsBus({ dbPath, log: silentLog });
  expect(readdirSync(dir).some((f) => f.startsWith("events.db.corrupt-"))).toBe(true);
  // fresh db works:
  bus.emit("test", { hi: 1 });
  expect(bus.list({ limit: 1 }).length).toBe(1);
  bus.close();
});

test("createEventsBus sets busy_timeout and synchronous=NORMAL", () => {
  const dir = mkdtempSync(join(tmpdir(), "events-pragma-"));
  const bus = createEventsBus({ dbPath: join(dir, "events.db"), log: silentLog });
  // @ts-expect-error internal handle access for the test, or expose a debug getter
  const handle = bus.__db ?? getBusDb(bus);
  expect(handle.query("PRAGMA busy_timeout").get()).toEqual({ timeout: 250 });
  expect(handle.query("PRAGMA synchronous").get()).toEqual({ synchronous: 1 }); // NORMAL
  bus.close();
});
```

(If the bus does not expose its handle, add a minimal `__db` back-reference or a `busyTimeout()` debug accessor in `events-bus.ts` for the test; do not expose it beyond the module's test needs.)

- [ ] **Step 2: Run ... expect FAIL.** Run: `bun test lib/daemon/__tests__/events-bus.test.ts -t "quarantine"`

- [ ] **Step 3: Implement in `lib/daemon/events-bus.ts`** ... wrap the open (lines 73-86):

```ts
import { isCorruptionError } from "../state/db"; // export it if not already exported
// ...
mkdirSync(dirname(opts.dbPath), { recursive: true });
let db: Database;
try {
  db = new Database(opts.dbPath, { create: true });
  db.exec("PRAGMA busy_timeout = 250;");     // before journal_mode, matching state/db.ts ordering
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
  db.query("PRAGMA user_version").get();      // touch to force a real read that trips corruption
} catch (err) {
  if (!isCorruptionError(err)) throw err;
  quarantineEventsDb(opts.dbPath, opts.log); // rename to events.db.corrupt-<ISO>, warn
  db = new Database(opts.dbPath, { create: true });
  db.exec("PRAGMA busy_timeout = 250;");
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
}
// then the existing CREATE TABLE / CREATE INDEX (78-86)
```

Write a local `quarantineEventsDb(path, log)` mirroring `state/db.ts`'s `quarantine` (rename the db + `-wal`/`-shm` sidecars to `path.corrupt-<ISO>`, `log.warn`). If `isCorruptionError` is not exported from `state/db.ts`, add the export (it is a pure predicate, safe to export).

- [ ] **Step 4: Run the events-bus tests ... expect PASS.**

- [ ] **Step 5: Write the failing sweep-guard test** in `lib/daemon/__tests__/events-bus.test.ts` OR a small `lib/__tests__/daemon-sweep-guard.test.ts` for the helper:

```ts
test("safeInterval swallows a throwing tick and logs warn", () => {
  const warn = mock(() => {});
  const log = { ...silentLog, warn };
  let ticks = 0;
  const handle = safeInterval(() => { ticks++; throw new Error("SQLITE_FULL"); }, 10, "test-sweep", log);
  return new Promise<void>((r) => setTimeout(() => {
    clearInterval(handle);
    expect(ticks).toBeGreaterThan(0);
    expect(warn).toHaveBeenCalled();
    r();
  }, 45));
});
```

- [ ] **Step 6: Implement `safeInterval`/`safeTimeout`** in `lib/daemon.ts` (or a tiny `lib/daemon/safe-timers.ts` exporting both):

```ts
export function safeInterval(fn: () => void, ms: number, label: string, log: Logger) {
  return setInterval(() => { try { fn(); } catch (err) { log.warn({ err, label }, "timer tick failed"); } }, ms);
}
export function safeTimeout(fn: () => void, ms: number, label: string, log: Logger) {
  return setTimeout(() => { try { fn(); } catch (err) { log.warn({ err, label }, "timer tick failed"); } }, ms);
}
```

Replace the two bare sweep timers at `lib/daemon.ts:194` and `:196` with `safeInterval(() => eventsBus.sweep(), 60*60*1000, "events-sweep", log)` and `safeTimeout(() => eventsBus.sweep(), 30_000, "events-sweep-boot", log)`. (The `pruneRuns`/`pruneLogs` timers at 200-248 already wrap their bodies; leaving them is fine, but converting them to `safeInterval` is a welcome DRY cleanup if trivial.)

- [ ] **Step 7: Run ... expect PASS.** Then `bun test lib/daemon/__tests__/events-bus.test.ts`.

- [ ] **Step 8: Commit**

```bash
git add lib/daemon/events-bus.ts lib/daemon.ts lib/state/db.ts lib/daemon/__tests__/events-bus.test.ts
git commit -m "events.db: corruption quarantine + busy_timeout/synchronous pragmas; guard sweep timers"
```

---

## Task 5: Bind order + rt.apiPort setting (0.3, my side ... S043, S030 seam)

Bind the API server before the unix socket so a failed API bind never strands a socket-bound zombie, and register the `rt.apiPort` escape-hatch setting (the api-server sibling consumes it at bind time).

**Files:**
- Modify: `lib/daemon.ts:468-469` (swap: API bind first, then socket bind; rt.pid still written after both, per Task 2)
- Modify: `lib/daemon-config.ts:72` (add `resolveApiPort()`; keep `API_PORT` const non-breaking)
- Modify: `packages/rt-client/src/settings/registry-defs.ts` (register `rt.apiPort`)
- Test: `lib/__tests__/daemon-config.test.ts`, `packages/rt-client` settings test, `e2e/tests/daemon.test.ts`

**Interfaces:**
- Produces: `resolveApiPort(): number` in `lib/daemon-config.ts` = `Number(process.env.RT_API_PORT) || getSetting<number>("rt.apiPort").value || 9401`, resolved lazily (never at module load). `API_PORT` const stays as-is for `api-server.ts`'s existing import.

- [ ] **Step 1: Register the setting.** Append to `packages/rt-client/src/settings/registry-defs.ts` (shaped like `rt.logRetentionDays` at 190-198):

```ts
{
  key: "rt.apiPort",
  type: "number",
  scopes: ["machine", "user"],
  default: 9401,
  merge: "replace",
  migrated: true,
  description: "TCP port the daemon's local HTTP/WS API binds (escape hatch when 9401 is held).",
},
```

- [ ] **Step 2: Rebuild rt-client** so the daemon and `dist-freshness` see the new key:

Run: `cd packages/rt-client && bun run build && cd -`

- [ ] **Step 3: Write the failing test** in `lib/__tests__/daemon-config.test.ts`:

```ts
test("resolveApiPort: env wins, then setting, then 9401", () => {
  const prev = process.env.RT_API_PORT;
  process.env.RT_API_PORT = "12345";
  expect(resolveApiPort()).toBe(12345);
  delete process.env.RT_API_PORT;
  expect(resolveApiPort()).toBe(9401); // default setting value
  if (prev !== undefined) process.env.RT_API_PORT = prev;
});
```

- [ ] **Step 4: Run ... expect FAIL** (`resolveApiPort` undefined).

- [ ] **Step 5: Implement in `lib/daemon-config.ts`** (leave `API_PORT` at line 72 untouched):

```ts
import { getSetting } from "./settings/resolve";
export function resolveApiPort(): number {
  const env = Number(process.env.RT_API_PORT);
  if (env) return env;
  try { return getSetting<number>("rt.apiPort").value || 9401; } catch { return 9401; }
}
```

- [ ] **Step 6: Run ... expect PASS.**

- [ ] **Step 7: Swap the bind order in `lib/daemon.ts`.** Reorder so the API binds before the socket:

```ts
servers.api = await startApiServer({ handleCommand, log });   // was line 469 ... now first
servers.socket = startSocketServer({ handleCommand, log });   // was line 468 ... now second
// rt.pid write (moved by Task 2) stays after BOTH assignments
```

- [ ] **Step 8: Write the failing e2e test** in `e2e/tests/daemon.test.ts` (extends the Task 2 squatter test):

```ts
test("API-bind failure leaves neither rt.sock nor rt.pid", async () => {
  const port = 9412;
  const squatter = Bun.serve({ port, hostname: "127.0.0.1", fetch: () => new Response("busy") });
  try {
    const proc = Bun.spawn({ cmd: [rtBinary, "--daemon"], env: { ...isolatedEnv, RT_API_PORT: String(port) }, stdout: "pipe", stderr: "pipe" });
    await proc.exited;
    expect(existsSync(join(isolatedHome, ".mattstack/rt/rt.sock"))).toBe(false);
    expect(existsSync(join(isolatedHome, ".mattstack/rt/rt.pid"))).toBe(false);
  } finally { squatter.stop(true); }
});
```

- [ ] **Step 9: Run ... expect PASS.** Run: `bun test --preload ./e2e/setup.ts --timeout 60000 e2e/tests/daemon.test.ts -t "API-bind failure"`

- [ ] **Step 10: Commit**

```bash
git add lib/daemon.ts lib/daemon-config.ts packages/rt-client/src/settings/registry-defs.ts packages/rt-client/dist lib/__tests__/daemon-config.test.ts e2e/tests/daemon.test.ts
git commit -m "daemon: bind API before socket; register rt.apiPort setting + resolveApiPort()"
```

---

## Task 6: home-snapshot opens state.db daemon-flavored (0.7 ... S011)

`startHomeSnapshot` opens the state.db singleton at module scope with the default `cli` flavor (5000ms busy_timeout), so the daemon runs with the wrong contention policy forever. Make its db lazy and daemon-flavored, and harden `getStateDb` against a silent flavor mismatch.

**Files:**
- Modify: `lib/daemon/home-snapshot.ts:272,299` (lazy daemon-flavored db resolver)
- Modify: `lib/state/db.ts:522-530` (`getStateDb` mismatch hardening)
- Test: `lib/state/__tests__/db.test.ts`

**Interfaces:**
- Consumes: `getStateDb("daemon")` ... 250ms busy_timeout.

- [ ] **Step 1: Write the failing test** in `lib/state/__tests__/db.test.ts` (`describe("pragma values per flavor")`):

```ts
test("getStateDb('daemon') reports busy_timeout 250 even after a default open", () => {
  const cli = getStateDb();              // opens singleton, cli flavor
  expect(cli.query("PRAGMA busy_timeout").get()).toEqual({ timeout: 5000 });
  const daemon = getStateDb("daemon");   // same singleton ... must not stay at 5000
  expect(daemon.query("PRAGMA busy_timeout").get()).toEqual({ timeout: 250 });
});
```

(Use the file's existing isolated-HOME / `closeStateDb` setup so this does not leak into other tests.)

- [ ] **Step 2: Run ... expect FAIL** (singleton keeps the cli 5000 timeout).

- [ ] **Step 3: Harden `getStateDb` in `lib/state/db.ts:522-530`** ... when the singleton is already open and a caller requests a stronger (shorter) flavor timeout, re-apply the pragma:

```ts
export function getStateDb(flavor: DbFlavor = "cli"): Database {
  const path = stateDbPath();
  if (singleton && singletonPath === path) {
    const want = BUSY_TIMEOUT_MS[flavor];
    const have = Number((singleton.query("PRAGMA busy_timeout").get() as any)?.timeout ?? 0);
    if (want < have) singleton.exec(`PRAGMA busy_timeout = ${want};`);
    return singleton;
  }
  // ... existing (re)open path ...
}
```

- [ ] **Step 4: Run ... expect PASS.**

- [ ] **Step 5: Make home-snapshot's db lazy + daemon-flavored** in `lib/daemon/home-snapshot.ts`. Replace the eager `db: rawDeps.db ?? getStateDb()` (line 272) with a thunk defaulting to `() => getStateDb("daemon")`, and resolve it on first use inside `loadState`/`runNow`/`status` rather than at construction (line 299). Concretely: store `const resolveDb = rawDeps.db ? () => rawDeps.db! : () => getStateDb("daemon");` and call `resolveDb()` where `deps.db` was read, so no db opens until `startDaemon` has already opened it daemon-flavored via `openBranchCacheStore`.

- [ ] **Step 6: Add a boot-order regression test** in `lib/state/__tests__/db.test.ts` (or `home-snapshot.test.ts`) asserting that constructing `startHomeSnapshot` does NOT open the state.db singleton (call it, then assert `getStateDb` was not yet invoked ... spy on the module or assert no `state.db` file exists until first use in an isolated HOME).

- [ ] **Step 7: Run the db tests ... expect PASS.** Run: `bun test lib/state/__tests__/db.test.ts`

- [ ] **Step 8: Commit**

```bash
git add lib/daemon/home-snapshot.ts lib/state/db.ts lib/state/__tests__/db.test.ts
git commit -m "home-snapshot: lazy daemon-flavored state.db; getStateDb re-applies a stronger flavor timeout"
```

---

## Task 7: Extended busy codes + IMMEDIATE transactions (0.7 ... S072, S073)

`isBusyError` misses `SQLITE_BUSY_SNAPSHOT`/`_RECOVERY`, and read-then-write daemon transactions use a deferred `BEGIN` that produces snapshot conflicts busy_timeout cannot absorb. Widen the match and take the write lock up front.

**Files:**
- Modify: `lib/state/busy.ts:39-41` (`isBusyError`)
- Modify: `lib/state/chat-store.ts` (`readUnread`, `joinRoom`, `archiveRoom`, `dmRoomFor` → `.immediate()`)
- Modify: `lib/state/notifier-store.ts` (`drainNotificationQueue` → `.immediate()`)
- Test: `lib/state/__tests__/busy.test.ts`
- **Deferred (fenced):** `lib/state/presence-store.ts:signIn` ... documented follow-up, not done here.

**Interfaces:**
- Produces: `isBusyError` returns true for any `code` starting `SQLITE_BUSY`.

- [ ] **Step 1: Write the failing test** in `lib/state/__tests__/busy.test.ts` ... a real two-connection snapshot conflict:

```ts
test("isBusyError matches SQLITE_BUSY_SNAPSHOT from a real conflict", () => {
  const dir = mkdtempSync(join(tmpdir(), "busy-snap-"));
  const path = join(dir, "t.db");
  const a = new Database(path); a.exec("PRAGMA journal_mode=WAL; CREATE TABLE t(id INTEGER PRIMARY KEY, v INTEGER);");
  a.exec("INSERT INTO t(id,v) VALUES(1,0);");
  const b = new Database(path);
  a.exec("BEGIN;"); a.query("SELECT v FROM t WHERE id=1").get(); // pin snapshot on A
  b.exec("UPDATE t SET v=1 WHERE id=1;");                        // B commits (autocommit)
  let caught: unknown;
  try { a.exec("UPDATE t SET v=2 WHERE id=1;"); } catch (e) { caught = e; }
  expect(caught).toBeDefined();
  expect((caught as any).code?.startsWith("SQLITE_BUSY")).toBe(true);
  expect(isBusyError(caught)).toBe(true);
  try { a.exec("ROLLBACK;"); } catch {}
  a.close(); b.close();
});
```

- [ ] **Step 2: Run ... expect FAIL** (`isBusyError` returns false for `SQLITE_BUSY_SNAPSHOT`).

- [ ] **Step 3: Widen `isBusyError`** in `lib/state/busy.ts:39-41`:

```ts
export function isBusyError(err: unknown): boolean {
  const code = (err as { code?: string })?.code;
  return code === "SQLITE_BUSY" || (typeof code === "string" && code.startsWith("SQLITE_BUSY_"));
}
```

- [ ] **Step 4: Run ... expect PASS.**

- [ ] **Step 5: Convert read-then-write transactions to `.immediate()`.** In `lib/state/chat-store.ts`, change the four cited transaction builders (`readUnread` ~483, `joinRoom`, `archiveRoom`, `dmRoomFor`) from `db.transaction(fn)(...)` to `db.transaction(fn).immediate(...)` so the write lock is taken at `BEGIN IMMEDIATE`. Do the same for `drainNotificationQueue` in `lib/state/notifier-store.ts:111`. Leave a one-line comment at the first site: `// BEGIN IMMEDIATE: read-then-write must lock up front or SQLITE_BUSY_SNAPSHOT bypasses busy_timeout.`

- [ ] **Step 6: Verify no regression** ... run the chat/notifier/state suites: `bun test lib/state` and any `chat` command tests. Expect PASS (behavior identical under no contention; the change only affects lock acquisition timing).

- [ ] **Step 7: Commit**

```bash
git add lib/state/busy.ts lib/state/chat-store.ts lib/state/notifier-store.ts lib/state/__tests__/busy.test.ts
git commit -m "state: isBusyError matches SQLITE_BUSY_*; read-then-write daemon txns use BEGIN IMMEDIATE"
```

---

## Task 8: state.db importer isolation (0.3 ... S074)

A throwing legacy importer inside the v0 migration rolls back the whole migration, so `user_version` stays 0 and every subsequent open repeats the failure. Wrap each importer in a SAVEPOINT; on throw, roll back that one importer, warn, and still rename the file.

**Files:**
- Modify: `lib/state/db.ts:400-417` (`importLegacyStores` ... SAVEPOINT per importer)
- Test: `lib/state/__tests__/db.test.ts`

**Interfaces:**
- Consumes: `LEGACY_IMPORTS` array (line 71), `runMigrations`'s `consumed` list (renames to `.migrated`).

- [ ] **Step 1: Write the failing test** in `lib/state/__tests__/db.test.ts`:

```ts
test("a throwing legacy importer is isolated: db reaches SCHEMA_VERSION, other stores import, file renamed", () => {
  // Arrange an isolated HOME with a project-mrs.json whose keys "5" and "05" normalize to the same iid,
  // plus one benign legacy file another importer consumes.
  writeFileSync(join(rtDir, "project-mrs.json"), JSON.stringify({ "host/repo": { mrs: { "5": {...}, "05": {...} } } }));
  writeFileSync(join(rtDir, "<benign-legacy>.json"), JSON.stringify(benignFixture));
  const db = openStateDb(join(rtDir, "state.db"), "daemon");
  expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: SCHEMA_VERSION });
  // benign store's rows landed:
  expect(db.query("SELECT COUNT(*) c FROM <benign_table>").get()).toMatchObject({ c: benignCount });
  // offending file still renamed:
  expect(existsSync(join(rtDir, "project-mrs.json"))).toBe(false);
  expect(existsSync(join(rtDir, "project-mrs.json.migrated"))).toBe(true);
});
```

(Fill `<benign-legacy>`/`<benign_table>`/fixtures from an existing importer in `LEGACY_IMPORTS`; the db.test.ts legacy-import cases already build such fixtures ... reuse one.)

- [ ] **Step 2: Run ... expect FAIL** (the throw rolls back the whole migration; `user_version` stays 0 / benign rows absent).

- [ ] **Step 3: Implement SAVEPOINT-per-importer** in `importLegacyStores` (`lib/state/db.ts:400-417`). For each `LEGACY_IMPORTS` entry, wrap its `run(db)` in a savepoint scoped to that importer only (do NOT loosen the surrounding schema-DDL migration, which must stay loud):

```ts
for (const imp of LEGACY_IMPORTS) {
  if (!existsSync(imp.path())) continue;
  db.exec("SAVEPOINT legacy_import;");
  try {
    imp.run(db);
    db.exec("RELEASE legacy_import;");
    consumed.push(imp.path());
  } catch (err) {
    db.exec("ROLLBACK TO legacy_import; RELEASE legacy_import;");
    log?.warn?.({ err, file: imp.path() }, "legacy import failed; skipping (file will still be renamed)");
    consumed.push(imp.path()); // spec: corrupt = warn + skip, but still rename
  }
}
```

(Match the exact `LegacyImport` shape at db.ts:64-69 ... `path()`/`run(db)` names may differ; adapt to the real fields.)

- [ ] **Step 4: Run ... expect PASS.**

- [ ] **Step 5: Commit**

```bash
git add lib/state/db.ts lib/state/__tests__/db.test.ts
git commit -m "state.db: isolate each legacy importer in a SAVEPOINT so one bad file cannot wedge migration"
```

---

## Task 9: Restart counter + last-exit reason in kv (0.5 ... R002, S037)

Persist boot attempts, last-ready stamp, recent failures, and last-exit reason in the `kv` table (ns `daemon-supervision`), plus a boot breadcrumb file. Wire the record calls into the boot path, the shutdown verb, the signal handlers, and the boot fatal path. No schema change.

**Files:**
- Create: `lib/daemon/supervision-state.ts`
- Create: `lib/daemon/__tests__/supervision-state.test.ts`
- Modify: `lib/daemon.ts` (record boot-attempt at `runDaemon` top; breadcrumb per phase; ready stamp; `recordBootFailure` in Task 2's catch; `recordCleanExit("shutdown")` in the shutdown verb), `lib/daemon/shutdown.ts` (record exit in `gracefulExit`)

**Interfaces:**
- Produces:
  - `recordBootAttempt(): void` ... increments `boot-attempts`, appends nothing.
  - `recordDaemonReady(): void` ... sets `last-ready-at = Date.now()`.
  - `recordBootFailure(phase: BootPhase, reason: string): void` ... appends `{ at, phase, reason }` to `recent-failures` (cap 10), sets `last-exit = { at, kind: "boot-failed", code: 1, reason }`.
  - `recordCleanExit(kind: "shutdown" | "signal", code: number): void` ... sets `last-exit = { at, kind, code }`.
  - `readSupervisionState(): { bootAttempts, lastReadyAt, recentFailures, lastExit }`.
  - `isCrashLooping(state, now, n = 3, windowMs = 5*60_000): boolean` ... ≥ n failures newer than `now - windowMs`.
  - `writeBreadcrumb(phase: BootPhase): void` / `clearBreadcrumb(): void` ... `~/.mattstack/rt/daemon-boot.json`.
  - `type BootPhase = "start" | "crash-handlers" | "events-db" | "state-db" | "socket" | "api" | "ready"`.
- Consumes: `getKvValue`/`setKvValue` from `lib/state/kv-blob.ts`; `getStateDb("daemon")`.

- [ ] **Step 1: Write the failing test** in `lib/daemon/__tests__/supervision-state.test.ts`:

```ts
test("boot attempts, ready stamp, failures and last-exit round-trip through kv", () => {
  recordBootAttempt(); recordBootAttempt();
  recordDaemonReady();
  recordBootFailure("api", "EADDRINUSE");
  const s = readSupervisionState();
  expect(s.bootAttempts).toBe(2);
  expect(s.lastReadyAt).toBeGreaterThan(0);
  expect(s.recentFailures.at(-1)).toMatchObject({ phase: "api", reason: "EADDRINUSE" });
  expect(s.lastExit).toMatchObject({ kind: "boot-failed", code: 1 });
});

test("isCrashLooping true at >=3 failures within the window", () => {
  const now = 1_000_000;
  const fails = [now-10, now-20, now-30].map((at) => ({ at, phase: "api" as const, reason: "x" }));
  expect(isCrashLooping({ bootAttempts: 3, lastReadyAt: 0, recentFailures: fails, lastExit: null }, now)).toBe(true);
  const old = [{ at: now-10*60_000, phase: "api" as const, reason: "x" }];
  expect(isCrashLooping({ bootAttempts: 1, lastReadyAt: 0, recentFailures: old, lastExit: null }, now)).toBe(false);
});
```

(Use the file's isolated-HOME convention ... `bunfig` preload already repoints HOME for `bun test`; `recordBootAttempt` writes to the test state.db.)

- [ ] **Step 2: Run ... expect FAIL** (module does not exist).

- [ ] **Step 3: Implement `lib/daemon/supervision-state.ts`** with the interfaces above. All reads/writes go through `getKvValue("daemon-supervision", key, fallback, getStateDb("daemon"))` / `setKvValue("daemon-supervision", key, value, getStateDb("daemon"))`. Cap `recent-failures` at 10 on append. Breadcrumb via `writeFileSync(join(RT_DIR, "daemon-boot.json"), JSON.stringify({ at, pid: process.pid, flavor: currentMode(), phase }))` inside a try/catch (never fatal).

- [ ] **Step 4: Run ... expect PASS.**

- [ ] **Step 5: Wire into the boot path** (`lib/daemon.ts`):
  - `recordBootAttempt(); writeBreadcrumb("start");` at the top of `runDaemon()` (after Task 3's crash handlers are already at module scope; call these first thing inside `runDaemon`).
  - `writeBreadcrumb("events-db" | "state-db" | "socket" | "api")` at each corresponding phase (events.db is module-scope ... write that breadcrumb right after `createEventsBus`; state-db right after `openBranchCacheStore`; socket/api at the binds).
  - In Task 2's catch: `recordBootFailure(currentPhase, String(err));` (track `currentPhase` in a module var updated alongside each `writeBreadcrumb`).
  - `recordDaemonReady(); writeBreadcrumb("ready");` right where `bootPhase = "ready"` is set (line 513).
  - Shutdown verb (349-364): before `process.exit(0)`, `recordCleanExit("shutdown", 0);` and set the Task 12 `shuttingDownViaVerb = true` flag (Task 12 adds the flag; here just add the record call).

- [ ] **Step 6: Wire into signal exit** (`lib/daemon/shutdown.ts` `gracefulExit`): before exit, `recordCleanExit("signal", code)` (Task 12 sets `code` to 1 for bare signals; for now record with the code it exits with).

- [ ] **Step 7: Add an e2e assertion** in `e2e/tests/daemon.test.ts`: after the Task 5 API-bind-failure spawn, assert `daemon-boot.json` exists with `phase: "api"` and the kv `recent-failures` has an entry (read the state.db in the isolated HOME, or assert via `rt daemon status --json` once Task 10 lands ... for Task 9, assert the breadcrumb file only).

- [ ] **Step 8: Run the unit + e2e tests ... expect PASS.**

- [ ] **Step 9: Commit**

```bash
git add lib/daemon/supervision-state.ts lib/daemon/__tests__/supervision-state.test.ts lib/daemon.ts lib/daemon/shutdown.ts e2e/tests/daemon.test.ts
git commit -m "daemon: persist boot attempts, failures, last-exit in kv + boot breadcrumb"
```

---

## Task 10: Status verdicts (0.5 ... R001, S026 daemon-side)

Extend `DaemonStatusVerdict` and `classifyDaemonStatus` with `alive-not-serving`, `parked`, `boot-failed`, `crash-looping`, read from the liveness probe + supervision state + breadcrumb. Expose the fields in `ping`/`/api/status`, and print them in `rt daemon status`.

**Files:**
- Modify: `lib/daemon-status.ts:14-19` (verdict type), `31-…` (`classifyDaemonStatus`)
- Modify: `lib/daemon/handlers/status.ts:23` (`ping` includes supervision summary; NOT fenced)
- Modify: `commands/daemon.ts:379-…` (`statusLines` prints new verdicts)
- Test: `lib/__tests__/daemon-status.test.ts`

**Interfaces:**
- Consumes: `readSupervisionState`, `isCrashLooping`, breadcrumb reader from Task 9.
- Produces: `DaemonStatusVerdict` extended with `{ state: "alive-not-serving"; pid: number; detail: "booting" | "wedged" | "quarantined" }`, `{ state: "parked"; pid: number; holderFlavor?: string }`, `{ state: "boot-failed"; reason: string; phase: string }`, `{ state: "crash-looping"; failures: number; reason: string }`.

- [ ] **Step 1: Write the failing tests** in `lib/__tests__/daemon-status.test.ts`:

```ts
test("alive pid + failed ping -> alive-not-serving with breadcrumb detail", () => {
  const v = classifyDaemonStatus({ installed: true, pingOk: false, pidAlive: true, pid: 42,
    breadcrumb: { phase: "socket" }, supervision: emptySupervision() });
  expect(v).toMatchObject({ state: "alive-not-serving", pid: 42, detail: "booting" });
});
test("no pid + >=3 recent failures -> crash-looping", () => {
  const v = classifyDaemonStatus({ installed: true, pingOk: false, pidAlive: false, pid: null,
    supervision: { recentFailures: threeRecentFailures(), lastExit: { kind: "boot-failed", reason: "EADDRINUSE" } } });
  expect(v).toMatchObject({ state: "crash-looping" });
});
test("no pid + single boot-failed -> boot-failed with reason", () => {
  const v = classifyDaemonStatus({ installed: true, pingOk: false, pidAlive: false, pid: null,
    supervision: { recentFailures: [oneFailure("api","EADDRINUSE")], lastExit: { kind: "boot-failed", reason: "EADDRINUSE", phase: "api" } } });
  expect(v).toMatchObject({ state: "boot-failed", reason: "EADDRINUSE", phase: "api" });
});
```

- [ ] **Step 2: Run ... expect FAIL.**

- [ ] **Step 3: Extend the verdict type and `classifyDaemonStatus`** in `lib/daemon-status.ts` following the resolution order from the design doc (Task 1): not-installed → serving → parked → alive-not-serving → crash-looping → boot-failed → installed-not-running. `classifyDaemonStatus` takes the already-gathered inputs (`pingOk`, `pidAlive`, `pid`, `breadcrumb`, `supervision`); keep it a pure function (the liveness probe and kv/breadcrumb reads happen in `commands/daemon.ts`/the caller, matching the existing `needsLivenessProbe` split). `parked` when breadcrumb phase indicates a flavor standoff; `alive-not-serving` detail = `booting` (phase < ready), `wedged` (phase == ready), `quarantined` (a `*.boot-failed` marker present).

- [ ] **Step 4: Run ... expect PASS.**

- [ ] **Step 5: Surface the data.** In `lib/daemon/handlers/status.ts` `ping`, add a `supervision: { bootAttempts, lastReadyAt, recentFailures: recentFailures.slice(-3), lastExit }` field (read via Task 9). In `commands/daemon.ts` `showStatus`/liveness probe, gather `pidAlive` (`process.kill(pid,0)` on rt.pid, fallback `pgrep -f 'rt --daemon|lib/daemon.ts'` via `runCapture`) and read the breadcrumb + supervision state (when ping fails), then pass to `classifyDaemonStatus`. In `statusLines`, print a line per new verdict (see the design doc's status strings).

- [ ] **Step 6: Add a `--json` assertion e2e** in `e2e/tests/daemon.test.ts`: after an API-bind-failure spawn, `rt daemon status --json` under the same isolated HOME reports `boot-failed` or `crash-looping` (whichever the failure count yields). Run under `env -i HOME=<temp>`.

- [ ] **Step 7: Run the unit + e2e tests ... expect PASS.** `bun test lib/__tests__/daemon-status.test.ts`

- [ ] **Step 8: Commit**

```bash
git add lib/daemon-status.ts lib/daemon/handlers/status.ts commands/daemon.ts lib/__tests__/daemon-status.test.ts e2e/tests/daemon.test.ts
git commit -m "daemon status: alive-not-serving / parked / boot-failed / crash-looping verdicts"
```

---

## Task 11: stderr log rotation + stale-crash stamp (0.5 ... S029)

`daemon-stderr.log` is never rotated and its stale contents are shown as "most recent crash". Rotate on open and gate the crash block on mtime.

**Files:**
- Modify: `lib/daemon-logger.ts:204-219` (`redirectNativeStderr` rotate-on-open)
- Modify: `commands/daemon.ts:716-765` (`showLogs` mtime gate + label)
- Test: `lib/__tests__/daemon-logger.test.ts`, `commands/__tests__/daemon.test.ts` (or wherever `showLogs` is tested)

**Interfaces:**
- Produces: rotated filename `daemon-stderr.<YYYY-MM-DD>.log` (matches the janitor's `LOG_FILE_PATTERN`, so it prunes for free).

- [ ] **Step 1: Write the failing test** in `lib/__tests__/daemon-logger.test.ts`:

```ts
test("redirectNativeStderr rotates a non-empty daemon-stderr.log before reopening", () => {
  // isolated logs dir with a pre-existing non-empty daemon-stderr.log
  writeFileSync(join(logsDir(), "daemon-stderr.log"), "old panic\n");
  redirectNativeStderr();
  const rotated = readdirSync(logsDir()).filter((f) => /^daemon-stderr\.\d{4}-\d{2}-\d{2}\.log$/.test(f));
  expect(rotated.length).toBe(1);
  expect(statSync(join(logsDir(), "daemon-stderr.log")).size).toBe(0);
});
```

- [ ] **Step 2: Run ... expect FAIL.**

- [ ] **Step 3: Implement rotate-on-open** in `redirectNativeStderr` (`lib/daemon-logger.ts:204-219`): before `openSync(path, "a")`, if the file exists and is non-empty, `renameSync` it to `daemon-stderr.<yyyy-MM-dd>.log` (dedupe with a `.N` suffix if that name already exists, matching the janitor's dated-file convention). Keep the existing swallow-on-failure behavior.

- [ ] **Step 4: Run ... expect PASS.**

- [ ] **Step 5: Write the failing `showLogs` test** ... the native-stderr block is hidden when the file mtime predates the current daemon's start:

```ts
test("showLogs hides the native-stderr block when the file is older than the daemon start", () => {
  // stub daemon startedAt newer than the file mtime; assert the red block is not printed
});
```

- [ ] **Step 6: Implement in `showLogs`** (`commands/daemon.ts:724-737`): only print the native-stderr block when the file's `mtime` is newer than the current daemon's `startedAt` (from `ping`); include the mtime in the header (`native stderr (captured <mtime>)`). When older, skip it silently (or print a one-line "no crash since this daemon started").

- [ ] **Step 7: Run ... expect PASS.**

- [ ] **Step 8: Commit**

```bash
git add lib/daemon-logger.ts commands/daemon.ts lib/__tests__/daemon-logger.test.ts
git commit -m "logs: rotate daemon-stderr.log on open; hide stale crash block by mtime"
```

---

## Task 12: Exit-code semantics (0.6 ... S036, S060)

The `shutdown` verb correctly exits 0, but bare OS signals also exit 0, so an externally-killed daemon stays down. Reserve exit 0 for the verb; exit non-zero on bare signals.

**Files:**
- Modify: `lib/daemon.ts:349-364` (shutdown verb sets `shuttingDownViaVerb = true`)
- Modify: `lib/daemon/shutdown.ts:57-71` (`gracefulExit` reads the flag)
- Test: `lib/daemon/__tests__/shutdown.test.ts` (new)

**Interfaces:**
- Produces: a shared boolean the shutdown verb sets before cleanup; `installSignalHandlers` gains a `wasVerbShutdown: () => boolean` option (avoids a cross-module global). `gracefulExit` exits 0 when `wasVerbShutdown()` is true, else `process.exit(1)`.
- Consumes: `recordCleanExit` (Task 9).

- [ ] **Step 1: Write the failing test** in `lib/daemon/__tests__/shutdown.test.ts`:

```ts
test("gracefulExit exits 0 after the shutdown verb, 1 on a bare signal", () => {
  const exits: number[] = [];
  const exit = (c?: number) => { exits.push(c ?? 0); };
  let viaVerb = false;
  const handlers = makeGracefulExit({ cleanup: () => {}, flushLogs: () => {}, log: silentLog,
    wasVerbShutdown: () => viaVerb, exit, recordCleanExit: () => {} });
  handlers("SIGTERM");
  expect(exits).toEqual([1]);
  viaVerb = true;
  handlers("SIGTERM");
  expect(exits).toEqual([1, 0]);
});
```

(Refactor `gracefulExit` into a testable `makeGracefulExit(deps)` that returns the handler, injecting `exit`/`recordCleanExit` so no real `process.exit` fires in the test.)

- [ ] **Step 2: Run ... expect FAIL.**

- [ ] **Step 3: Implement.** In `lib/daemon/shutdown.ts`, refactor `installSignalHandlers`/`gracefulExit` to `makeGracefulExit(deps)` reading `deps.wasVerbShutdown()`: true → `recordCleanExit("shutdown", 0)` + `exit(0)`; false → `recordCleanExit("signal", 1)` + `exit(1)`. In `lib/daemon.ts`, add module-scope `let shuttingDownViaVerb = false;`, set it `true` in the shutdown verb before `cleanup()`, and pass `wasVerbShutdown: () => shuttingDownViaVerb` into `installSignalHandlers` at line 511. The shutdown verb keeps `process.exit(0)`.

- [ ] **Step 4: Run ... expect PASS.**

- [ ] **Step 5: Commit**

```bash
git add lib/daemon.ts lib/daemon/shutdown.ts lib/daemon/__tests__/shutdown.test.ts
git commit -m "daemon: bare-signal exit is non-zero (launchd respawns); shutdown verb stays exit 0"
```

---

## Task 13: Ownership-aware cleanup + eviction death-confirmation (0.6 ... S012, S044)

`cleanup()` unlinks rt.sock/rt.pid unconditionally, and eviction sleeps a blind 300ms. Make cleanup compare-and-delete, and make eviction wait for the old pid to actually die.

**Files:**
- Modify: `lib/daemon/shutdown.ts:44-46` (ownership-aware unlink)
- Modify: `lib/daemon/boot-reconcile.ts:16-26` (poll-to-death, escalate to SIGKILL)
- Test: `lib/daemon/__tests__/shutdown.test.ts`, `lib/daemon/__tests__/boot-reconcile.test.ts` (new)

**Interfaces:**
- Produces: `cleanup()` unlinks rt.pid only when its content `=== String(process.pid)`, and gates the rt.sock unlink on that same check. `evictStaleDaemon` polls `process.kill(pid, 0)` up to a bound (e.g. 3s / 30×100ms), escalates to SIGKILL, and only returns once the pid is gone.

- [ ] **Step 1: Write the failing cleanup test** in `lib/daemon/__tests__/shutdown.test.ts`:

```ts
test("cleanup does not unlink rt.pid/rt.sock when the pid file belongs to another process", () => {
  writeFileSync(DAEMON_PID_PATH, "999999");     // not our pid
  writeFileSync(DAEMON_SOCK_PATH, "");
  createCleanup({ ...deps, pid: process.pid })();
  expect(existsSync(DAEMON_PID_PATH)).toBe(true);
  expect(existsSync(DAEMON_SOCK_PATH)).toBe(true);
});
test("cleanup unlinks when the pid file is ours", () => {
  writeFileSync(DAEMON_PID_PATH, String(process.pid));
  writeFileSync(DAEMON_SOCK_PATH, "");
  createCleanup({ ...deps, pid: process.pid })();
  expect(existsSync(DAEMON_PID_PATH)).toBe(false);
  expect(existsSync(DAEMON_SOCK_PATH)).toBe(false);
});
```

(Inject `pid` into `createCleanup` deps for testability; default to `process.pid`.)

- [ ] **Step 2: Run ... expect FAIL.**

- [ ] **Step 3: Implement ownership-aware unlink** in `createCleanup` (`lib/daemon/shutdown.ts:44-46`):

```ts
try {
  if (existsSync(DAEMON_PID_PATH) && readFileSync(DAEMON_PID_PATH, "utf8").trim() === String(deps.pid)) {
    unlinkSync(DAEMON_PID_PATH);
    if (existsSync(DAEMON_SOCK_PATH)) unlinkSync(DAEMON_SOCK_PATH);
  }
} catch (err) { deps.log.warn({ err }, "cleanup unlink skipped"); }
```

- [ ] **Step 4: Run ... expect PASS.**

- [ ] **Step 5: Write the failing eviction test** in `lib/daemon/__tests__/boot-reconcile.test.ts`:

```ts
test("evictStaleDaemon waits for the old pid to die, escalating to SIGKILL", async () => {
  // Spawn a child that ignores SIGTERM; write its pid to rt.pid; assert evict SIGKILLs it and returns only once gone.
  const child = Bun.spawn({ cmd: ["bash", "-c", "trap '' TERM; sleep 30"] });
  writeFileSync(DAEMON_PID_PATH, String(child.pid));
  const start = Date.now();
  await evictStaleDaemon(silentLog);       // now async
  expect(isAlive(child.pid)).toBe(false);
  expect(Date.now() - start).toBeLessThan(5000);
});
```

- [ ] **Step 6: Implement in `evictStaleDaemon`** (`lib/daemon/boot-reconcile.ts`): replace `Bun.sleepSync(300)` with an async poll ... after SIGTERM, loop `process.kill(pid, 0)` every 100ms up to ~2.5s; if still alive, `process.kill(pid, "SIGKILL")` and poll another ~0.5s; return once `process.kill(pid,0)` throws (pid gone). Make the function `async` and `await` it at the call site (`lib/daemon.ts:396`). Keep the `previousPid === process.pid` self-guard.

- [ ] **Step 7: Run ... expect PASS.** Then `bun test lib/daemon/__tests__/boot-reconcile.test.ts lib/daemon/__tests__/shutdown.test.ts`

- [ ] **Step 8: Commit**

```bash
git add lib/daemon/shutdown.ts lib/daemon/boot-reconcile.ts lib/daemon.ts lib/daemon/__tests__/shutdown.test.ts lib/daemon/__tests__/boot-reconcile.test.ts
git commit -m "daemon: ownership-aware socket/pid unlink; eviction waits for pid death then SIGKILL"
```

---

## Task 14: uninstall + start guards (0.6 ... S027, S030, S028 CLI-side)

`rt daemon uninstall` deletes rt.sock/rt.pid from under a live daemon, and `rt daemon start` cannot revive a registered-but-exited-0 daemon. Guard uninstall on liveness; make start escalate to a kickstart route.

**Files:**
- Modify: `commands/daemon.ts:210-231` (`uninstall` guard), `commands/daemon.ts:235-269` (`start` escalation)
- Modify: `lib/daemon-client.ts:171-185` (`attemptRestart` re-probes liveness)
- Test: `commands/__tests__/daemon.test.ts` (or the existing commands/daemon test location)

**Interfaces:**
- Consumes: `isDaemonProcessRunning()` (daemon-config.ts:152), `probeSocketHolder()` (park.ts), `activeLaunchdLabel()` (daemon-config.ts:61), `isDaemonRunning()`.

- [ ] **Step 1: Write the failing uninstall test**:

```ts
test("uninstall leaves rt.sock/rt.pid and daemon.json when the daemon is still running", async () => {
  // stub trayQuery('/daemon/stop') to fail, isDaemonProcessRunning -> true
  await uninstall();
  expect(cleanupDaemonFilesSpy).not.toHaveBeenCalled();
  expect(printedRemedy).toContain("launchctl bootout");
});
```

- [ ] **Step 2: Run ... expect FAIL.**

- [ ] **Step 3: Implement the uninstall guard** (`commands/daemon.ts:210-231`): after a failed/absent `trayQuery("/daemon/stop")`, call `isDaemonProcessRunning()` (and `probeSocketHolder()` as a second signal). Only run `markDaemonUninstalled()` + `cleanupDaemonFiles()` when no live holder; otherwise print the remedy `launchctl bootout gui/$UID/${activeLaunchdLabel()}` and leave the files. Audit other callers of `cleanupDaemonFiles`/`markDaemonUninstalled` (e.g. the dev-mode toggle in `commands/settings.ts`) for the same missing guard and note any in the commit body.

- [ ] **Step 4: Run ... expect PASS.**

- [ ] **Step 5: Write the failing start-escalation test**:

```ts
test("start escalates to the restart/kickstart route when the tray acks but the socket stays absent", async () => {
  // trayQuery('/daemon/start') returns ok, isDaemonRunning stays false through the poll
  await start();
  expect(restartRouteSpy).toHaveBeenCalled();
});
```

- [ ] **Step 6: Implement start escalation** (`commands/daemon.ts:235-269`): when the tray acked `/daemon/start` but `isDaemonRunning()` stays false through the 12×250ms poll, fall back to the `/daemon/restart` route (kickstart). In `lib/daemon-client.ts:171-185`, make `attemptRestart` re-probe `isDaemonRunning()` after `trayQuery("/daemon/start")` and return `true` only when the daemon actually answers ... so the `daemonQuery` nag stops misdirecting. Do NOT change signal-handler exit codes here (that is Task 12).

- [ ] **Step 7: Run ... expect PASS.**

- [ ] **Step 8: Commit**

```bash
git add commands/daemon.ts lib/daemon-client.ts commands/__tests__/daemon.test.ts
git commit -m "daemon CLI: uninstall guards on liveness; start escalates to kickstart; attemptRestart re-probes"
```

---

## Task 15: Retire the stale audit doc (0.8 ... R017)

Replace `docs/daemon-runner-health.md` (which audits deleted subsystems) with a pointer to the current audit and the new supervision design doc.

**Files:**
- Modify: `docs/daemon-runner-health.md`

- [ ] **Step 1: Replace the file's contents** with a short pointer:

```markdown
# Daemon runner health ... superseded

This document audited subsystems (process-manager, remedy-engine,
runner.tsx, workspace-sync) that no longer exist. It is retained only as
a redirect.

- Current stability audit + roadmap: `docs/daemon-stability-audit-2026-08.md`
  (in the daemon-stability-audit worktree).
- Supervision verdicts + exit-code semantics: `docs/daemon-supervision-design.md`.
```

(If R058's comment sweep is trivially co-located, remove the one stale comment it names; otherwise leave it.)

- [ ] **Step 2: Commit**

```bash
git add docs/daemon-runner-health.md
git commit -m "docs: retire stale daemon-runner-health.md, point at the current audit + supervision design"
```

---

## Task 16 (OPTIONAL ... pending plan-review scope confirmation): Swift tray consumption

**Do not start without the reviewer's go-ahead** (raised in the plan-milestone report). These edits cannot be verified by the bun/tsc/e2e gate, and the operating rules forbid rebuilding the blessed bundle, so they ship as source-only, unverified changes following the fixer notes:

- **S026** ... `rt-tray/Sources/AppDelegate.swift`: give `.starting` an expiry (record `startingSince`; in `refreshStatus` treat `.starting` as expired after ~30s / 3 failed polls and fall through to `setHealth(.down)`), so the health dot stops sticking yellow; map the new daemon verdicts (Task 10) to dot colors.
- **S028** ... `rt-tray/Sources/DaemonLifecycle.swift`: when `register()` returns already-registered but the socket stays unreachable, fall back to `launchctl kickstart` (Kickstart.arguments already exists).
- **S029** ... `rt-tray/Sources/TrayLog.swift`: rotate `tray-crash.log` on open (rename-if-nonempty), matching Task 11's `daemon-stderr.log` treatment.
- **S060** ... `rt-tray/Sources/AppDelegate.swift:625-627`: fix the stale comment to say `KeepAlive: SuccessfulExit=false` (not `KeepAlive=true`).

If confirmed, do the comment fix (S060) first (trivial), then S026/S028/S029, one commit each, each commit body noting "source-only, unverified: blessed bundle not rebuilt".

---

## Final verification (before the whole-branch review)

- [ ] `cd packages/rt-client && bun run build && cd -` (rt-client was touched in Task 5)
- [ ] `bunx tsc --noEmit` ... zero errors
- [ ] `bun test lib commands packages scripts` ... green
- [ ] `bun run test:e2e` (or `bun test --preload ./e2e/setup.ts --timeout 60000 e2e/tests/daemon.test.ts` ... record which)
- [ ] Request the whole-branch code review (superpowers:requesting-code-review); address findings; re-run the gate.
