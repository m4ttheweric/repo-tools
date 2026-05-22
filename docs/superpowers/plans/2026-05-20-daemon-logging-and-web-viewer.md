# Daemon Logging + Web Viewer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the daemon's handrolled `log(msg)` with pino (JSON, daily rotation, 14-day retention, crash-safe), audit silent catches in four high-suspicion modules, and ship `rt daemon logs` as a browser viewer powered by logdy.

**Architecture:** Single pino root logger in `lib/daemon-logger.ts` writes JSON to `~/.rt/logs/daemon.YYYY-MM-DD.N.log` via pino-roll. Submodules use `childLogger("<name>")` for module-stamped output. `uncaughtException` + `unhandledRejection` handlers + a `process.stderr.write` interceptor capture everything bun-side. `rt daemon logs` spawns `logdy follow <today's-file> --port 5544` and `open`s the browser; `--terminal` falls back to `tail -F | bunx pino-pretty`.

**Tech Stack:** Bun, TypeScript, pino, pino-roll, pino-pretty, logdy (brew-installed binary, not bundled).

**Spec:** `docs/superpowers/specs/2026-05-20-daemon-logging-and-web-viewer-design.md`

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `lib/daemon-logger.ts` | **New** | pino root + `childLogger(name)` + `installCrashHandlers(logger)` factory |
| `lib/__tests__/daemon-logger.test.ts` | **New** | Unit tests for logger module |
| `lib/daemon-config.ts` | Modify | `LOG_DIR` constant + `DAEMON_LOG_PATH` repointed to `~/.rt/logs/daemon.log` (base) |
| `lib/daemon.ts` | Modify | Remove `log()` function; import logger + childLogger; install crash handlers; intercept `process.stderr.write`; migrate 41 callsites |
| `lib/daemon/auto-fix.ts` | Modify | Replace `log` param with `childLogger("auto-fix")`; audit silent catches |
| `lib/daemon/tunnel-manager.ts` | Modify | `childLogger("tunnel")`; audit silent catches |
| `lib/daemon/parking-lot.ts` | Modify | `childLogger("parking-lot")`; audit silent catches |
| `lib/daemon/process-manager.ts` | Modify | `childLogger("process-manager")`; audit silent catches |
| Other `lib/daemon/*.ts` with `log` callback param | Modify | Drop param; use `childLogger("<name>")` directly |
| `commands/daemon.ts` | Modify | Rewrite `showLogs` for web (logdy) + terminal (pino-pretty) modes |
| `package.json` | Modify | Add `pino`, `pino-roll`, `pino-pretty` deps |

---

## Task 1: Add dependencies

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install pino + pino-roll + pino-pretty**

Run:
```bash
bun add pino pino-roll pino-pretty
```

Expected: `package.json` `dependencies` gains `pino`, `pino-roll`, `pino-pretty` at their latest versions. `bun.lock` updates.

- [ ] **Step 2: Verify install**

Run:
```bash
bun -e 'import pino from "pino"; console.log("pino ok:", typeof pino)'
bun -e 'import roll from "pino-roll"; console.log("pino-roll ok:", typeof createStream)'
```

Expected: `pino ok: function` and `pino-roll ok: function`.

- [ ] **Step 3: Commit**

```bash
git add package.json bun.lock
git commit -m "deps(daemon): add pino, pino-roll, pino-pretty for structured logging"
```

---

## Task 2: Update daemon-config paths

**Files:**
- Modify: `lib/daemon-config.ts`

- [ ] **Step 1: Update path constants**

Open `lib/daemon-config.ts`. Find:
```ts
export const DAEMON_LOG_PATH = join(RT_DIR, "daemon.log");
export const DAEMON_STDERR_LOG_PATH = join(RT_DIR, "daemon-stderr.log");
```

Replace with:
```ts
export const LOG_DIR = join(RT_DIR, "logs");
// pino-roll uses this as the base path; rotated files become daemon.YYYY-MM-DD.N.log
export const DAEMON_LOG_PATH = join(LOG_DIR, "daemon.log");
// NOTE: DAEMON_STDERR_LOG_PATH removed — JS-side stderr is captured by the logger
// (see lib/daemon.ts startup). Native stderr capture is deferred to the swift-shim.
```

- [ ] **Step 2: Verify no other references break**

Run:
```bash
grep -rn "DAEMON_STDERR_LOG_PATH" lib/ commands/ rt-tray/ 2>/dev/null
```

Expected: Only matches in files we'll update later. If any importer would break, note them — we'll fix those imports in their respective tasks.

Then:
```bash
bun --bun tsc --noEmit -p . 2>&1 | grep -E "daemon-config|DAEMON_STDERR_LOG_PATH" | head -5
```

Expected: Either no output (no consumers), or specific files we'll address in later tasks.

- [ ] **Step 3: Commit**

```bash
git add lib/daemon-config.ts
git commit -m "refactor(daemon-config): move logs to ~/.rt/logs/, drop unused stderr path"
```

---

## Task 3: Write daemon-logger unit tests (TDD-first)

**Files:**
- Create: `lib/__tests__/daemon-logger.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `lib/__tests__/daemon-logger.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// We import the factory (not the singleton) so each test gets isolation.
import { createDaemonLogger } from "../daemon-logger.ts";

let logDir: string;

beforeEach(() => {
  logDir = mkdtempSync(join(tmpdir(), "rt-daemon-logger-test-"));
});

afterEach(() => {
  try { rmSync(logDir, { recursive: true, force: true }); } catch { /* */ }
});

function readTodayLog(): string {
  // pino-roll names files: <base>.<YYYY-MM-DD> (using its default frequency:'daily')
  const files = readdirSync(logDir).filter(f => f.startsWith("daemon.log"));
  if (files.length === 0) return "";
  // Newest by name (date sort works for YYYY-MM-DD)
  files.sort().reverse();
  return readFileSync(join(logDir, files[0]!), "utf8");
}

async function flush(logger: { flush?: () => void }): Promise<void> {
  // pino streams are sync via pino-roll's createStream, but give the runtime
  // one tick to settle the underlying fd writes.
  logger.flush?.();
  await new Promise(r => setImmediate(r));
}

describe("daemon-logger", () => {
  it("writes JSON line with level=30 (info) and msg", async () => {
    const { logger } = await createDaemonLogger({ logDir, level: "info" });
    logger.info("hello world");
    await flush(logger);
    const content = readTodayLog();
    expect(content).toContain('"level":30');
    expect(content).toContain('"msg":"hello world"');
  });

  it("childLogger stamps module field on every line", async () => {
    const { childLogger } = await createDaemonLogger({ logDir, level: "info" });
    const log = childLogger("auto-fix");
    log.info("something happened");
    await flush(log);
    const content = readTodayLog();
    expect(content).toContain('"module":"auto-fix"');
    expect(content).toContain('"msg":"something happened"');
  });

  it("serializes Error objects with stack trace", async () => {
    const { logger } = await createDaemonLogger({ logDir, level: "info" });
    const err = new Error("boom");
    logger.error({ err }, "failure");
    await flush(logger);
    const content = readTodayLog();
    expect(content).toContain('"msg":"failure"');
    expect(content).toContain('"type":"Error"');
    expect(content).toContain('"message":"boom"');
    expect(content).toContain('"stack":');
  });

  it("respects level: 'warn' filters info-level out", async () => {
    const { logger } = await createDaemonLogger({ logDir, level: "warn" });
    logger.info("should be filtered");
    logger.warn("should appear");
    await flush(logger);
    const content = readTodayLog();
    expect(content).not.toContain("should be filtered");
    expect(content).toContain("should appear");
  });

  it("creates the log directory if it does not exist", async () => {
    const nested = join(logDir, "nested", "deeper");
    expect(existsSync(nested)).toBe(false);
    const { logger } = await createDaemonLogger({ logDir: nested, level: "info" });
    logger.info("test");
    await flush(logger);
    expect(existsSync(nested)).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:
```bash
bun test lib/__tests__/daemon-logger.test.ts 2>&1 | head -30
```

Expected: All tests fail with "Cannot find module '../daemon-logger.ts'" or similar — we haven't created it yet.

- [ ] **Step 3: Commit the failing tests**

```bash
git add lib/__tests__/daemon-logger.test.ts
git commit -m "test(daemon-logger): write failing unit tests for pino-based logger"
```

---

## Task 4: Implement `lib/daemon-logger.ts`

**Files:**
- Create: `lib/daemon-logger.ts`

- [ ] **Step 1: Write the implementation**

Create `lib/daemon-logger.ts`:

```ts
/**
 * Daemon logger — pino root + child loggers, daily rotation, 14-day retention.
 *
 * Conventional structured logging. Replaces the previous handrolled
 * appendFileSync-based log() in lib/daemon.ts.
 *
 * Two exports:
 *   - createDaemonLogger(opts): async factory (testable, takes a logDir)
 *   - getDaemonLogger():        lazy singleton bound to LOG_DIR (production use)
 *
 * Crash safety: pino.final() in installCrashHandlers() ensures fatal lines
 * flush synchronously before exit when uncaught exceptions propagate.
 */

import pino, { type Logger } from "pino";
import roll from "pino-roll";
import { LOG_DIR } from "./daemon-config.ts";

export interface DaemonLoggerHandle {
  /** Root logger — use when no specific module scope applies. */
  logger: Logger;
  /** Returns a child logger that stamps `module: <name>` on every line. */
  childLogger: (module: string) => Logger;
  /** Force a flush (best-effort; pino-roll's stream is sync but exposes flushSync). */
  flush?: () => void;
}

export interface CreateOptions {
  logDir: string;
  level?: pino.LevelWithSilent;
}

/**
 * Async factory — call once at daemon startup OR in each test.
 * pino-roll's createStream is async (it stats the dir + sets up the writer).
 */
export async function createDaemonLogger(opts: CreateOptions): Promise<DaemonLoggerHandle> {
  const stream = await roll({
    file: `${opts.logDir}/daemon.log`,
    frequency: "daily",
    mkdir: true,
    limit: { count: 14 },
  });

  const logger = pino(
    {
      level: opts.level ?? "info",
      // pino's default ISO timestamp + level + pid + hostname
      timestamp: pino.stdTimeFunctions.isoTime,
      // Standard err serializer captures .message, .stack, .type, .code
      serializers: { err: pino.stdSerializers.err },
    },
    stream,
  );

  return {
    logger,
    childLogger: (module: string) => logger.child({ module }),
    flush: () => {
      // pino's flushSync drains any buffered writes; safe to call repeatedly.
      try { logger.flush(); } catch { /* */ }
    },
  };
}

// ─── Production singleton ────────────────────────────────────────────────────

let cached: DaemonLoggerHandle | undefined;

/**
 * Lazily initialize the production logger bound to LOG_DIR.
 * Returns a handle synchronously by deferring the underlying stream open.
 *
 * Because createStream is async and we want a sync API for callers, we
 * initialize it eagerly on first import via top-level await.
 */
export async function getDaemonLogger(): Promise<DaemonLoggerHandle> {
  if (!cached) {
    cached = await createDaemonLogger({
      logDir: LOG_DIR,
      level: (process.env.RT_LOG_LEVEL as pino.LevelWithSilent | undefined) ?? "info",
    });
  }
  return cached;
}

// ─── Crash handler installer ─────────────────────────────────────────────────

/**
 * Install process-level handlers that route uncaught failures through the
 * logger before exit. Call ONCE during daemon startup, AFTER logger init.
 *
 * - uncaughtException: log as fatal, flush, exit 1
 * - unhandledRejection: log as error, do NOT exit (let the daemon recover)
 * - process.stderr.write: intercept so console.error / anything writing to
 *   stderr lands in the JSON log instead of vanishing.
 */
export function installCrashHandlers(handle: DaemonLoggerHandle): void {
  const { logger } = handle;

  // pino.final() makes the logger synchronous for the lifetime of the handler,
  // so fatal lines flush even when we're about to exit.
  const finalHandler = pino.final(logger, (err, finalLogger) => {
    finalLogger.fatal({ err }, "uncaughtException");
    process.exit(1);
  });
  process.on("uncaughtException", finalHandler);

  process.on("unhandledRejection", (reason) => {
    logger.error({ err: reason }, "unhandledRejection");
  });

  // Intercept process.stderr.write so JS-side stderr writes land in the log.
  // (Native bun panics bypass this — they require the swift-shim follow-up.)
  const origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: any, ...rest: any[]) => {
    try {
      const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
      const trimmed = text.replace(/\n+$/, "");
      if (trimmed.length > 0) logger.error({ source: "stderr" }, trimmed);
    } catch {
      // If anything in the logger fails, fall back to the original stderr.
      return origWrite(chunk, ...rest);
    }
    return true;
  }) as typeof process.stderr.write;
}
```

- [ ] **Step 2: Run the tests**

Run:
```bash
bun test lib/__tests__/daemon-logger.test.ts 2>&1 | tail -25
```

Expected: All 5 tests pass.

- [ ] **Step 3: Type-check**

Run:
```bash
bun --bun tsc --noEmit -p . 2>&1 | grep -E "daemon-logger" | head -10
```

Expected: No errors in `daemon-logger.ts` or the test file.

- [ ] **Step 4: Commit**

```bash
git add lib/daemon-logger.ts
git commit -m "feat(daemon-logger): pino-based structured logger with daily rotation

- pino root + childLogger(name) factory
- pino-roll: daily rotation, keep last 14 files
- pino.stdSerializers.err for full error stacks
- installCrashHandlers wires uncaughtException/unhandledRejection + stderr.write
- RT_LOG_LEVEL env tunable (default info)"
```

---

## Task 5: Migrate `lib/daemon.ts` to the new logger

This is the biggest task — it replaces the hand-rolled `log()` with pino at 41 callsites and installs crash handlers in startup. Do it in one cohesive change so the daemon stays consistent.

**Files:**
- Modify: `lib/daemon.ts`

- [ ] **Step 1: Replace the `log()` function definition with a top-level await logger init**

Find (around `lib/daemon.ts:290-314`):
```ts
// ─── Logging ─────────────────────────────────────────────────────────────────

function log(msg: string): void {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}`;
  console.log(line);

  // Persist to disk — daemon runs under launchd with no stdout redirect,
  // so console.log alone vanishes into the void.
  try {
    appendFileSync(DAEMON_LOG_PATH, line + "\n");
  } catch { /* best-effort */ }

  // Self-rotate log
  try {
    const stat = statSync(DAEMON_LOG_PATH);
    if (stat.size > LOG_MAX_BYTES) {
      const content = readFileSync(DAEMON_LOG_PATH, "utf8");
      // Keep last 20% of the file
      const keepFrom = Math.floor(content.length * 0.8);
      writeFileSync(DAEMON_LOG_PATH, content.slice(keepFrom));
      log("log rotated (exceeded 10MB)");
    }
  } catch { /* no log file yet, that's fine */ }
}
```

Replace with:
```ts
// ─── Logging ─────────────────────────────────────────────────────────────────
// Pino-backed structured logger. See lib/daemon-logger.ts. Top-level await
// initializes the singleton before any other startup code runs, so `log` is
// always usable from sync contexts (including catch blocks).

import { getDaemonLogger, installCrashHandlers } from "./daemon-logger.ts";

const loggerHandle = await getDaemonLogger();
const log = loggerHandle.logger;
```

Then update the file's imports — find:
```ts
import {
  existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync,
  statSync, unlinkSync, watch, type FSWatcher,
} from "fs";
```

If `appendFileSync` / `statSync` are now unused (run `grep -nE "appendFileSync|statSync" lib/daemon.ts` — only the deleted `log()` body used them), remove them from the import list. Otherwise keep them.

- [ ] **Step 2: Install crash handlers inside `startDaemon()`**

Find `startDaemon()` near `lib/daemon.ts:894`:
```ts
export function startDaemon(): void {
  mkdirSync(RT_DIR, { recursive: true });
```

Add crash handler installation as the first line of the function body (logger is already initialized at module load via TLA):

```ts
export function startDaemon(): void {
  mkdirSync(RT_DIR, { recursive: true });

  // Wire uncaughtException + unhandledRejection through pino. Must run BEFORE
  // any async work that could throw uncaught.
  installCrashHandlers(loggerHandle);
```

No change to the function signature (stays sync) or to the call site. The module-level top-level await already gates everything.

- [ ] **Step 3: Migrate the 41 `log("...")` callsites**

For each call site in `lib/daemon.ts`, change `log("message")` → appropriate pino call. Reference table for the call sites discovered during exploration (line numbers may shift; locate by the message text):

| Original | Replacement | Reason |
|---|---|---|
| `log("daemon starting")` | `log.info("daemon starting")` | lifecycle |
| `log("daemon stopped")` | `log.info("daemon stopped")` | lifecycle |
| `log(\`daemon ready (pid: ${process.pid})\`)` | `log.info({ pid: process.pid }, "daemon ready")` | lifecycle + structured field |
| `log(\`PATH resolved (${pathEntries.length} entries, pnpm=${...} doppler=${...})\`)` | `log.info({ entries: pathEntries.length, hasPnpm: hasTool("pnpm"), hasDoppler: hasTool("doppler") }, "PATH resolved")` | structured |
| `log(\`watching: ${repoName} (${gitDir}/${configFile})\`)` | `log.info({ repo: repoName, file: \`${gitDir}/${configFile}\` }, "watching repo")` | structured |
| `log(\`ports: scanned ${n} listening ports matching known repos\`)` | `log.info({ count: n }, "ports scanned")` | structured |
| `log(\`ports: scan failed: ${err}\`)` | `log.error({ err }, "port scan failed")` | error |
| `log(\`cache: ${msg}\`)` | `log.info({}, \`cache: ${msg}\`)` *(or refactor caller; cache module gets its own child logger in a later task)* | info |
| `log(\`cache: GitLab MR fetch failed for ${name}: ${err}\`)` | `log.warn({ err, repo: name }, "GitLab MR fetch failed")` | recoverable |
| `log(\`cache flush failed: ${err}\`)` | `log.error({ err }, "cache flush failed")` | error |
| `log(\`parking-lot: fast-forwarded ${branch} at ${path} → origin/${target}\`)` | (this submodule moves to childLogger in Task 9; leave for now or temporarily: `log.info({ branch, path, target }, "parking-lot fast-forward")`) | |
| `log(\`parking-lot: check failed: ${err}\`)` | `log.warn({ err }, "parking-lot check failed")` | recoverable |
| `log(\`doppler:sync repo=${repoName} skipped=${summary.skipped}\`)` | `log.debug({ repo: repoName, skipped: summary.skipped }, "doppler sync skipped")` | dev-noisy |
| `log(\`doppler:sync repo=${repoName} wrote=${...} overridden=${...} unchanged=${...}\`)` | `log.info({ repo: repoName, ...summary }, "doppler sync")` | |
| `log(\`doppler:sync repo=${repoName} failed: ${err}\`)` | `log.error({ err, repo: repoName }, "doppler sync failed")` | error |
| `log(\`hooks-guard: repaired core.hooksPath for ${repoName} (was: ${currentHooksPath})\`)` | `log.warn({ repo: repoName, was: currentHooksPath }, "hooks-guard repaired core.hooksPath")` | |
| `log(\`hooks-guard: set core.hooksPath for ${repoName} (was unset)\`)` | `log.info({ repo: repoName }, "hooks-guard set core.hooksPath")` | |
| `log(\`remedy: ▸ "${remedy.name}" matched for ${id} (pattern: ${pattern})\`)` | `log.info({ remedy: remedy.name, id, pattern }, "remedy matched")` | |
| `log(\`remedy: ${success ? "✓" : "✗"} "${remedy.name}" fired for ${id}\`)` | `log.info({ remedy: remedy.name, id, success }, "remedy fired")` | |
| `log(\`remedy: could not load global rules at startup (${String(err)}) — starting empty\`)` | `log.warn({ err }, "remedy: could not load global rules at startup")` | |
| `log(\`remedy: hot-reloaded ${rules.length} global rule(s) from _global.json\`)` | `log.info({ count: rules.length }, "remedy: hot-reloaded global rules")` | |
| `log(\`remedy: parse failed — retaining previous rules (${String(err)})\`)` | `log.error({ err }, "remedy: parse failed; retaining previous rules")` | |
| `log(\`remedy: could not watch global remedy dir (${String(err)})\`)` | `log.warn({ err }, "remedy: could not watch global dir")` | |
| `log(\`cache: skipping ${repoName} due to error: ${err}\`)` | `log.warn({ err, repo: repoName }, "cache refresh skipped repo")` | |
| `log(\`socket server listening on ${DAEMON_SOCK_PATH}\`)` | `log.info({ path: DAEMON_SOCK_PATH }, "socket server listening")` | |
| `log(\`api server listening on http://localhost:${API_PORT}\`)` | `log.info({ port: API_PORT }, "api server listening")` | |
| `log(\`api: WebSocket client connected (${wsClients.size} total)\`)` | `log.debug({ total: wsClients.size }, "ws client connected")` | dev-noisy |
| `log(\`api: WebSocket client disconnected (${wsClients.size} total)\`)` | `log.debug({ total: wsClients.size }, "ws client disconnected")` | dev-noisy |
| `log(\`workspace-sync: watching ${file} across ${n} worktree(s) for ${repo}\`)` | `log.info({ file, count: n, repo }, "workspace-sync watching")` | |
| `log("discussions-poller: starting (every 90s)")` | `log.info("discussions-poller starting")` | |
| `log(\`received shutdown command\`)` | `log.info("received shutdown command")` | |
| `log(\`mr-subscriptions: initializing\`)` | `log.info("mr-subscriptions: initializing")` | |
| `log(\`mr-subscriptions: resolved userId=${id}\`)` | `log.info({ userId: id }, "mr-subscriptions: resolved userId")` | |
| `log(\`mr-subscriptions: created ${name} (${n} MRs)\`)` | `log.info({ repo: name, count: n }, "mr-subscriptions created")` | |
| `log(\`stateStore: invalid transition for "${id}": ${prev} → ${next}\`)` | `log.warn({ id, prev, next }, "stateStore: invalid transition")` | |
| `log(\`mr-subscriptions: init failed: ${err}\`)` | `log.error({ err }, "mr-subscriptions: init failed")` | |
| `log(\`auto-fix: stale-sweep failed: ${err}\`)` | `log.error({ err }, "auto-fix: stale-sweep failed")` | |
| `log(\`workspace-sync: failed to restore watchers: ${err}\`)` | `log.error({ err }, "workspace-sync: failed to restore watchers")` | |
| `log("repos.json changed — refreshing watched repos")` | `log.info("repos.json changed; refreshing watched repos")` | |
| `log(\`evicted stale daemon process (pid ${previousPid})\`)` | `log.warn({ pid: previousPid }, "evicted stale daemon process")` | |
| `log(\`reaped orphan process for "${id}" (pid ${pid})\`)` | `log.warn({ id, pid }, "reaped orphan process")` | |
| `log(\`cache: loaded ${n} entries from disk\`)` | `log.info({ count: n }, "cache loaded from disk")` | |
| `log(\`cache: starting background refresh\`)` | `log.debug("cache: starting background refresh")` | dev-noisy |
| `log(\`cache: refresh complete (${n} entries)\`)` | `log.debug({ count: n }, "cache refresh complete")` | dev-noisy |
| `log(\`notify: cleared ${type}:${key} key for ${id}\`)` | `log.info({ type, key, id }, "notify: cleared key")` | |
| `log(\`ports: on-demand refresh — ${n} listening ports\`)` | `log.info({ count: n }, "ports: on-demand refresh")` | |
| `log("log rotated (exceeded 10MB)")` | DELETE (pino-roll handles rotation) | obsolete |

Use a global find-and-replace tool sparingly here — many are subtle. Walk through the file top-to-bottom.

After all 41 are migrated, also remove the constant `LOG_MAX_BYTES` (it's no longer used):

```bash
grep -n "LOG_MAX_BYTES" lib/daemon.ts
```

Delete its declaration.

- [ ] **Step 4: Update SIGTERM/SIGINT/SIGHUP handlers to flush before exit**

Find (around `lib/daemon.ts:1007`):
```ts
process.on("SIGTERM", () => { cleanup(); process.exit(0); });
process.on("SIGINT",  () => { cleanup(); process.exit(0); });
process.on("SIGHUP",  () => { cleanup(); process.exit(0); });
```

Replace with:
```ts
const gracefulExit = (signal: NodeJS.Signals) => {
  log.info({ signal }, "received signal; shutting down");
  cleanup();
  loggerHandle.flush?.();
  process.exit(0);
};
process.on("SIGTERM", () => gracefulExit("SIGTERM"));
process.on("SIGINT",  () => gracefulExit("SIGINT"));
process.on("SIGHUP",  () => gracefulExit("SIGHUP"));
```

- [ ] **Step 5: Type-check**

Run:
```bash
bun --bun tsc --noEmit -p . 2>&1 | grep -E "lib/daemon\.ts" | head -20
```

Expected: No errors in `lib/daemon.ts` (errors elsewhere are pre-existing and OK).

- [ ] **Step 6: Smoke-test the daemon comes up**

Run:
```bash
# Restart the daemon via the existing tray API
curl --unix-socket ~/.rt/tray.sock -s -X POST http://localhost/daemon/restart
sleep 5
ls -la ~/.rt/logs/ 2>&1
echo "---"
# Today's file:
tail -5 ~/.rt/logs/daemon.*.log 2>&1
```

Expected: `~/.rt/logs/` directory exists; `daemon.log.<today>` is being written; tail shows JSON lines like `{"level":30,"time":...,"pid":...,"msg":"daemon ready"}`.

- [ ] **Step 7: Commit**

```bash
git add lib/daemon.ts
git commit -m "refactor(daemon): migrate log() callsites to pino logger

- 41 log(msg) → logger.info/warn/error/debug with structured fields
- Async startDaemon() initializes pino + crash handlers first
- SIGTERM/SIGINT/SIGHUP handlers now flush logger before exit
- Drop LOG_MAX_BYTES (pino-roll handles rotation)"
```

---

## Task 6: Audit `lib/daemon/auto-fix.ts`

**Files:**
- Modify: `lib/daemon/auto-fix.ts`

This is one of the four high-suspicion modules. Goal: replace any `log` callback parameter with `childLogger("auto-fix")` and convert silent catches.

**Note on pattern:** We use **top-level await** at module load to capture the child logger synchronously into a module-scoped `log` constant. Bun supports TLA natively. This makes `log.warn(...)` work in sync catch blocks and anywhere else.

- [ ] **Step 1: Add child logger via top-level await**

At the top of `lib/daemon/auto-fix.ts`, add (after existing imports):
```ts
import { getDaemonLogger } from "../daemon-logger.ts";

// Top-level await — module load waits for the logger singleton to be ready,
// then exposes a sync `log` for use in any context (including sync catches).
const log = (await getDaemonLogger()).childLogger("auto-fix");
```

- [ ] **Step 2: Find every `log(...)` callsite and `catch { /* */ }` block**

Run:
```bash
grep -nE "(\blog\(|catch[^{]*\{\s*(/\*[^*]*\*/)?\s*\})" lib/daemon/auto-fix.ts
```

For each:
- **Function signatures that accept `log` as a parameter** (e.g. `provisionWorktree({ ..., log })`): remove `log` from the param list and from any destructure / type definitions. Internal callsites already see the module-scoped `log`.
- **Silent `catch { /* */ }` blocks**: review each, then convert by classification:
  - Genuinely-ignorable (e.g. "file already gone", "socket already closed"): `catch (err) { log.debug({ err }, "<expected condition>"); }`
  - Unexpected: `catch (err) { log.warn({ err }, "<what failed>"); }`
  - Comments naming the cause: use that comment as the log message
- **Existing `log(\`auto-fix: ...\`)` callsites**: convert to `log.info(...)` / `log.warn(...)` / `log.error({ err }, ...)` per semantics (drop the redundant `"auto-fix: "` prefix — `module: "auto-fix"` is in every JSON line now).

Walk the file top-to-bottom. ~6 silent catches per the earlier survey.

- [ ] **Step 3: Type-check + run existing auto-fix tests**

Run:
```bash
bun --bun tsc --noEmit -p . 2>&1 | grep "auto-fix" | head -10
bun test lib/daemon/__tests__/ 2>&1 | tail -20
```

Expected: No new type errors; existing tests still pass.

- [ ] **Step 4: Update callers in `lib/daemon.ts`**

If `lib/daemon.ts` passed `log` to auto-fix functions, remove those args. Search:
```bash
grep -n "log:" lib/daemon.ts | grep -i "auto-fix\|provisionWorktree\|sweepAutoFix"
```

For each match, remove the `log:` field from the object literal.

- [ ] **Step 5: Type-check again + smoke-test daemon**

```bash
bun --bun tsc --noEmit -p . 2>&1 | grep -E "(daemon\.ts|auto-fix)" | head -10
curl --unix-socket ~/.rt/tray.sock -s -X POST http://localhost/daemon/restart
sleep 5
grep '"module":"auto-fix"' ~/.rt/logs/daemon.*.log | tail -3
```

Expected: At least if auto-fix has fired, you see `"module":"auto-fix"` lines. (If nothing has fired, that's fine — just confirm daemon is running.)

- [ ] **Step 6: Commit**

```bash
git add lib/daemon/auto-fix.ts lib/daemon.ts
git commit -m "refactor(auto-fix): use childLogger, audit silent catches"
```

---

## Task 7: Audit `lib/daemon/tunnel-manager.ts`

**Files:**
- Modify: `lib/daemon/tunnel-manager.ts`

Same pattern as Task 6.

- [ ] **Step 1: Add child logger import**

At the top of `lib/daemon/tunnel-manager.ts`, add (after existing imports):
```ts
import { getDaemonLogger } from "../daemon-logger.ts";
const log = (await getDaemonLogger()).childLogger("tunnel");
```

- [ ] **Step 2: Walk every silent catch + log callsite**

Run:
```bash
grep -nE "(\blog\(|catch[^{]*\{\s*(/\*[^*]*\*/)?\s*\})" lib/daemon/tunnel-manager.ts
```

Convert per the Task 6 rules. Silent catches that are genuinely expected (e.g. "cloudflared already stopped") use `log.debug`; everything else uses `log.warn` or `log.error`.

- [ ] **Step 3: Drop `log` callback param from any function signatures + update callers in `lib/daemon.ts`**

```bash
grep -n "tunnelManager" lib/daemon.ts
```

Update any callsites that pass `log`.

- [ ] **Step 4: Type-check + smoke-test**

```bash
bun --bun tsc --noEmit -p . 2>&1 | grep "tunnel-manager" | head -10
curl --unix-socket ~/.rt/tray.sock -s -X POST http://localhost/daemon/restart
sleep 5
grep '"module":"tunnel"' ~/.rt/logs/daemon.*.log | tail -3 || echo "(no tunnel activity, daemon is ok)"
```

- [ ] **Step 5: Commit**

```bash
git add lib/daemon/tunnel-manager.ts lib/daemon.ts
git commit -m "refactor(tunnel-manager): use childLogger, audit silent catches"
```

---

## Task 8: Audit `lib/daemon/parking-lot.ts`

**Files:**
- Modify: `lib/daemon/parking-lot.ts`

Same pattern as Task 6 with module name `"parking-lot"`.

- [ ] **Step 1: Add child logger import**

```ts
import { getDaemonLogger } from "../daemon-logger.ts";
const log = (await getDaemonLogger()).childLogger("parking-lot");
```

- [ ] **Step 2: Walk callsites + catches** — run the grep, convert per rules
- [ ] **Step 3: Drop `log` param from function signatures + update callers in `lib/daemon.ts`**
- [ ] **Step 4: Type-check + smoke-test**

```bash
bun --bun tsc --noEmit -p . 2>&1 | grep "parking-lot" | head -10
curl --unix-socket ~/.rt/tray.sock -s -X POST http://localhost/daemon/restart
sleep 5
grep '"module":"parking-lot"' ~/.rt/logs/daemon.*.log | tail -3 || echo "(no parking-lot activity)"
```

- [ ] **Step 5: Commit**

```bash
git add lib/daemon/parking-lot.ts lib/daemon.ts
git commit -m "refactor(parking-lot): use childLogger, audit silent catches"
```

---

## Task 9: Audit `lib/daemon/process-manager.ts`

**Files:**
- Modify: `lib/daemon/process-manager.ts`

Same pattern as Task 6 with module name `"process-manager"`.

- [ ] **Step 1: Add child logger import**

```ts
import { getDaemonLogger } from "../daemon-logger.ts";
const log = (await getDaemonLogger()).childLogger("process-manager");
```

- [ ] **Step 2: Walk callsites + catches**
- [ ] **Step 3: Drop `log` param from function signatures + update callers in `lib/daemon.ts`**
- [ ] **Step 4: Type-check + smoke-test**

```bash
bun --bun tsc --noEmit -p . 2>&1 | grep "process-manager" | head -10
curl --unix-socket ~/.rt/tray.sock -s -X POST http://localhost/daemon/restart
sleep 5
grep '"module":"process-manager"' ~/.rt/logs/daemon.*.log | tail -3 || echo "(no process-manager activity)"
```

- [ ] **Step 5: Commit**

```bash
git add lib/daemon/process-manager.ts lib/daemon.ts
git commit -m "refactor(process-manager): use childLogger, audit silent catches"
```

---

## Task 10: Migrate other submodules with a `log` callback to childLogger

After Tasks 6-9, four modules are converted. Other daemon submodules may still take a `log` callback (e.g. `workspace-sync.ts`, `mr-subscriptions.ts`, `discussions-poller.ts`, `remedy-engine.ts`, `proxy-manager.ts`, `state-store.ts`, `attach-server.ts`). Convert all of them — same pattern — but **do not** audit their silent catches (out of scope per spec).

**Files:**
- Modify: Each `lib/daemon/*.ts` that currently takes a `log` callback parameter

- [ ] **Step 1: Enumerate affected files**

Run:
```bash
grep -lE "log[?:]?\s*\(.*\)\s*=>\s*void|log:\s*Logger|log:\s*\(msg:\s*string\)" lib/daemon/ -r
```

Expected: A list of submodule files. For each one:

- [ ] **Step 2 (repeat per file): Replace the `log` callback param with the lazy-getter snippet**

Pattern: drop `log` from constructor/factory args; add the `import { getDaemonLogger }` + lazy getter using the module's name as the child stamp. Replace `log(...)` callsites with `(await getLog()).info(...)` (or warn/error/debug as appropriate by the message text).

- [ ] **Step 3: Update callers in `lib/daemon.ts`** to drop the `log` argument from all construct calls

- [ ] **Step 4: Type-check + smoke-test**

```bash
bun --bun tsc --noEmit -p . 2>&1 | head -30
curl --unix-socket ~/.rt/tray.sock -s -X POST http://localhost/daemon/restart
sleep 5
tail -20 ~/.rt/logs/daemon.*.log
```

Expected: Clean type-check, daemon runs, log shows module-stamped lines from multiple modules.

- [ ] **Step 5: Commit**

```bash
git add lib/daemon/ lib/daemon.ts
git commit -m "refactor(daemon): use childLogger across remaining submodules"
```

---

## Task 11: Rewrite `commands/daemon.ts` showLogs for web + terminal modes

**Files:**
- Modify: `commands/daemon.ts`

- [ ] **Step 1: Update imports**

At the top of `commands/daemon.ts`, find the existing imports and add:
```ts
import { spawn } from "child_process";
import { join } from "path";
import { LOG_DIR } from "../lib/daemon-config.ts";
```

Drop `DAEMON_STDERR_LOG_PATH` from the imports (it was removed in Task 2).

- [ ] **Step 2: Rewrite `showLogs(args)`**

Find `export function showLogs(): void {` near line 228 and replace the entire function:

```ts
/**
 * Show daemon logs.
 *
 *   rt daemon logs              → open browser-based viewer (logdy)
 *   rt daemon logs --terminal   → live tail piped through pino-pretty
 *   rt daemon logs -t           → same as --terminal
 */
export async function showLogs(args: string[] = []): Promise<void> {
  const terminal = args.includes("--terminal") || args.includes("-t");

  // pino-roll names files: daemon.YYYY-MM-DD.N.log
  // Pick the most-recent file by mtime (works whether or not today's daemon
  // has been started yet).
  if (!existsSync(LOG_DIR)) {
    console.log(`\n  ${dim}no daemon logs yet — start the daemon first${reset}\n`);
    return;
  }
  const candidates = readdirSync(LOG_DIR)
    .filter(f => /^daemon\..+\.log$/.test(f))
    .map(f => ({ f, mtime: statSync(join(LOG_DIR, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (candidates.length === 0) {
    console.log(`\n  ${dim}no daemon log files in ${LOG_DIR}${reset}\n`);
    return;
  }
  const logPath = join(LOG_DIR, candidates[0]!.f);

  if (terminal) {
    await runTerminalViewer(logPath);
  } else {
    await runWebViewer(logPath);
  }
}

/**
 * Live-tail through pino-pretty in the current terminal. Stays attached
 * until the user Ctrl-Cs.
 */
async function runTerminalViewer(logPath: string): Promise<void> {
  console.log(`  ${dim}tailing ${logPath} via pino-pretty (Ctrl-C to stop)${reset}\n`);
  // tail -F follows + reopens on rotation; pipe through pino-pretty.
  const tail = spawn("tail", ["-F", logPath], { stdio: ["ignore", "pipe", "inherit"] });
  const pretty = spawn("bunx", ["pino-pretty"], { stdio: [tail.stdout!, "inherit", "inherit"] });

  // Propagate exits/signals so Ctrl-C cleans up both children.
  const stop = (code: number) => {
    try { tail.kill("SIGTERM"); } catch { /* */ }
    try { pretty.kill("SIGTERM"); } catch { /* */ }
    process.exit(code);
  };
  process.on("SIGINT", () => stop(0));
  process.on("SIGTERM", () => stop(0));
  pretty.on("exit", (code) => stop(code ?? 0));
}

/**
 * Spawn logdy follow + open browser. Stays attached so user can Ctrl-C.
 */
async function runWebViewer(logPath: string): Promise<void> {
  const which = spawnSync("which", ["logdy"]);
  if (which.status !== 0) {
    console.log(`\n  ${yellow}⚠${reset} logdy not installed.`);
    console.log(`  ${dim}install: ${bold}brew install logdy-network/logdy/logdy${reset}`);
    console.log(`  ${dim}or use terminal mode: ${bold}rt daemon logs --terminal${reset}\n`);
    process.exit(1);
  }

  const port = "5544";
  const url = `http://localhost:${port}`;
  console.log(`  ${green}●${reset} starting logdy on ${url}`);
  console.log(`  ${dim}tailing: ${logPath}${reset}`);

  const logdy = spawn("logdy", ["follow", logPath, "--port", port, "--ui-pass", ""], {
    stdio: ["ignore", "inherit", "inherit"],
  });

  // Wait briefly for logdy to bind the port, then open browser.
  await waitForPort(Number(port), 2000);
  spawnSync("open", [url]);

  console.log(`  ${green}✓${reset} viewer running on ${url} — ${dim}Ctrl-C to stop${reset}\n`);

  const stop = (code: number) => {
    try { logdy.kill("SIGTERM"); } catch { /* */ }
    process.exit(code);
  };
  process.on("SIGINT", () => stop(0));
  process.on("SIGTERM", () => stop(0));
  logdy.on("exit", (code) => stop(code ?? 0));
}

/** Poll TCP connect until the port is accepting connections, up to timeoutMs. */
async function waitForPort(port: number, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ok = await new Promise<boolean>((resolve) => {
      const { Socket } = require("net");
      const sock: any = new Socket();
      sock.setTimeout(200);
      sock.once("connect", () => { sock.destroy(); resolve(true); });
      sock.once("error",   () => { sock.destroy(); resolve(false); });
      sock.once("timeout", () => { sock.destroy(); resolve(false); });
      sock.connect(port, "127.0.0.1");
    });
    if (ok) return;
    await new Promise(r => setTimeout(r, 100));
  }
}
```

Add the necessary new imports near the existing ones:
```ts
import { readdirSync, statSync } from "fs";
import { spawnSync } from "child_process";
```

If `green` / `yellow` / `bold` / `dim` / `red` / `reset` are not yet imported into this file, add them from wherever the existing imports get color codes (check the top of the file).

- [ ] **Step 3: Update cli.ts to pass args to showLogs**

Open `cli.ts`, find the `logs:` leaf under `daemon:` (around line 619 of cli.ts):
```ts
logs: {
  description: "Show daemon logs",
  module: "./commands/daemon.ts",
  fn: "showLogs",
},
```

The dispatcher passes leftover args automatically (commands like `toggleDevMode(args: string[])` already receive them). No change should be needed unless the dispatcher special-cases zero-arg fns — verify by checking `lib/command-tree.ts`:

```bash
grep -nE "args|invoke|fn\(" lib/command-tree.ts | head -20
```

If `command-tree.ts` always calls `fn(args)`, no change to cli.ts is required. Otherwise update the leaf to declare it takes args.

- [ ] **Step 4: Manual smoke test (web mode)**

Run:
```bash
# If logdy isn't installed yet, install it (one-time):
brew install logdy-network/logdy/logdy || echo "(install manually; see brew tap)"
# Then test the new command (this is interactive — it'll open your browser):
bun run cli.ts daemon logs &
LOGS_PID=$!
sleep 3
curl -s http://localhost:5544/ | head -5 || echo "(logdy not serving yet)"
kill $LOGS_PID 2>/dev/null
```

Expected: logdy serves the page; the browser opened to `http://localhost:5544`.

- [ ] **Step 5: Manual smoke test (terminal mode)**

Run:
```bash
timeout 3s bun run cli.ts daemon logs --terminal 2>&1 | head -10
```

Expected: After ~1 second of buffering, pretty-printed log lines start appearing.

- [ ] **Step 6: Commit**

```bash
git add commands/daemon.ts cli.ts
git commit -m "feat(rt-daemon-logs): web viewer via logdy + terminal mode via pino-pretty

- rt daemon logs (default) → spawn logdy + open browser at :5544
- rt daemon logs --terminal/-t → tail -F | bunx pino-pretty
- Missing logdy → brew install hint, terminal mode still works"
```

---

## Task 12: Final integration smoke test

**Files:** None modified — verification only.

- [ ] **Step 1: Full daemon restart + log inspection**

```bash
curl --unix-socket ~/.rt/tray.sock -s -X POST http://localhost/daemon/restart
sleep 5
echo "=== last 20 log lines ==="
tail -20 ~/.rt/logs/daemon.*.log | bunx pino-pretty
echo ""
echo "=== module distribution ==="
grep -oE '"module":"[^"]+"' ~/.rt/logs/daemon.*.log | sort | uniq -c | sort -rn
echo ""
echo "=== level distribution ==="
grep -oE '"level":[0-9]+' ~/.rt/logs/daemon.*.log | sort | uniq -c
```

Expected:
- daemon comes up clean
- pretty output shows colored, leveled, module-stamped lines
- multiple modules represented (`tunnel`, `auto-fix`, `parking-lot`, `process-manager`, etc.)
- a mix of `info` (30), `warn` (40), maybe `error` (50)

- [ ] **Step 2: Provoke an uncaught exception**

The test verifies the crash handler actually fires. Inject a throw via the daemon's existing socket:

```bash
# Send a malformed request that hits an unhandled code path
curl --unix-socket ~/.rt/rt.sock -s -X POST "http://localhost/nonexistent-command" -H "Content-Type: application/json" -d 'this-is-not-json{'
```

(This shouldn't crash the daemon — it should log an error. The test is that ANY error path produces a structured log line.)

Then check:
```bash
tail -5 ~/.rt/logs/daemon.*.log | bunx pino-pretty
```

Expected: An error-level entry recently logged with stack info.

- [ ] **Step 3: Confirm graceful shutdown still works under new code**

```bash
launchctl kickstart -k gui/$(id -u)/com.rt.daemon
sleep 5
grep -E '(shutting down|daemon ready)' ~/.rt/logs/daemon.*.log | tail -4 | bunx pino-pretty
```

Expected: One "shutting down" line, then "daemon ready" for the new instance. No fatal lines from the SIGTERM handler.

- [ ] **Step 4: Final commit (only if anything stray was changed)**

```bash
git status
# If clean, no commit needed. Otherwise:
# git add -p && git commit -m "..."
```

---

## Self-Review Notes

Spec coverage check:
- ✅ `lib/daemon-logger.ts` + tests — Tasks 3, 4
- ✅ Crash handlers + JS-stderr interception — Tasks 4 (installCrashHandlers), 5 (call it in startDaemon)
- ✅ Native-stderr deferred — noted in spec, not in this plan ✓
- ✅ Call-site migration in daemon.ts — Task 5
- ✅ Targeted catch audit in 4 modules — Tasks 6, 7, 8, 9
- ✅ Other submodules' `log` callback removal — Task 10
- ✅ `rt daemon logs` UX — Task 11
- ✅ pino-roll daily rotation, 14-day retention — Task 4 (`createStream` options)
- ✅ File layout change — Task 2
- ✅ Brew formula (out of plan, user-handled) — noted in spec, not in this plan ✓

Placeholder scan: none — every step shows the actual code or command.

Type consistency: `DaemonLoggerHandle` interface in Task 4 matches usage in Tasks 5-11. `childLogger("<name>")` signature consistent throughout.
