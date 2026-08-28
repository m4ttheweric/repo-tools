/**
 * Daemon logger — pino root + child loggers, daily rotation, 14-day retention.
 *
 * Conventional structured logging. Replaces the previous handrolled
 * appendFileSync-based log() in lib/daemon.ts.
 *
 * Two exports:
 *   - createDaemonLogger(opts): async factory (testable, takes a logDir)
 *   - getDaemonLogger():        lazy singleton bound to ~/.mattstack/rt/logs (production use)
 *
 * Crash safety: the pino-roll stream uses sync:true so fatal lines flush
 * synchronously before exit when uncaught exceptions propagate.
 */

import pino, { type Logger } from "pino";
// pino-roll ships no .d.ts; typed below with a minimal declare.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — no types shipped; the JS API is well-tested.
import roll from "pino-roll";
import { dlopen, suffix, FFIType } from "bun:ffi";
import { mkdirSync, openSync, closeSync, existsSync, statSync, renameSync } from "fs";
import { join } from "path";
import { logsDir } from "./rt-paths.ts";

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
 * pino-roll's default export is async (it stats the dir + sets up the writer).
 */
export async function createDaemonLogger(opts: CreateOptions): Promise<DaemonLoggerHandle> {
  // pino-roll naming: <file>.<dateFormat>.<index><extension>
  // With file=daemon, extension=.log, dateFormat=yyyy-MM-dd, we get
  // "daemon.2026-05-22.1.log" — clean and globbable as "daemon.*.log".
  // sync:true makes each write() hit the fd immediately so crash logs land
  // even when process.exit follows directly.
  const stream = await roll({
    file: `${opts.logDir}/daemon`,
    extension: ".log",
    frequency: "daily",
    dateFormat: "yyyy-MM-dd",
    mkdir: true,
    limit: { count: 14 },
    sync: true,
  });

  const logger = pino(
    {
      level: opts.level ?? "info",
      // pino's default ISO timestamp + level + pid + hostname
      timestamp: pino.stdTimeFunctions.isoTime,
      // Emit string levels ("info"/"warn"/"error"/"fatal") instead of numeric
      // (30/40/50/60). Numeric is pino's default but most viewers (hl, lnav,
      // logdy column-detection) recognize string levels automatically; numeric
      // requires per-tool config. The cost is ~3 bytes per line.
      formatters: { level: (label) => ({ level: label }) },
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

// Caches the in-flight PROMISE, not the resolved value: `if (!cached) cached
// = await …` leaves a window where every caller that arrives before the
// first resolves runs its own createDaemonLogger(), each opening a
// pino-roll stream against the same file (rt's daemon boot has ~8
// near-simultaneous callers). Caching the promise makes them share one init.
let cachedPromise: Promise<DaemonLoggerHandle> | undefined;

/**
 * Lazily initialize the production logger bound to ~/.mattstack/rt/logs.
 * Multiple callers share the same handle.
 */
export async function getDaemonLogger(): Promise<DaemonLoggerHandle> {
  if (!cachedPromise) {
    cachedPromise = createDaemonLogger({
      logDir: logsDir(),
      level: (process.env.RT_LOG_LEVEL as pino.LevelWithSilent | undefined) ?? "info",
    }).catch((err) => {
      // Clear the cache on failure — a transient cause (log dir momentarily
      // unwritable) may not recur, so a later call should retry rather than
      // stay permanently poisoned.
      cachedPromise = undefined;
      throw err;
    });
  }
  return cachedPromise;
}

const PINO_LEVEL_METHODS = new Set(["trace", "debug", "info", "warn", "error", "fatal"]);

// Lets tests read a lazyChildLogger's queue depth without adding an escape
// hatch to the Proxy's property guard below.
const pendingQueueLengths = new WeakMap<object, () => number>();

/**
 * A `childLogger(module)` result usable synchronously from module load
 * (no top-level await, which would make every importer async-initializing
 * and block `bun build --compile`). Calls made before getDaemonLogger()
 * resolves are queued and replayed in order once it does, so no line is
 * lost or reordered relative to today's `await`-at-module-scope behavior —
 * only its write to disk shifts later by the same startup delay
 * getDaemonLogger() always had.
 *
 * `deps.getLogger` defaults to the production singleton; tests substitute a
 * controlled promise to exercise the failure path without touching it.
 */
export function lazyChildLogger(
  module: string,
  deps: { getLogger?: () => Promise<DaemonLoggerHandle> } = {},
): Logger {
  const getLogger = deps.getLogger ?? getDaemonLogger;
  let real: Logger | undefined;
  let failed = false;
  const pending: Array<() => void> = [];

  getLogger()
    .then((handle) => {
      real = handle.childLogger(module);
      for (const call of pending) call();
      pending.length = 0;
    })
    .catch((err: unknown) => {
      // `real` will never resolve after this — stop queuing permanently so
      // a long-lived daemon doesn't grow this array forever, and surface
      // the failure since it would otherwise be invisible (no logger to
      // log it through).
      failed = true;
      pending.length = 0;
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`daemon-logger: init failed for module "${module}": ${message}\n`);
    });

  const proxy = new Proxy({} as Logger, {
    get(_target, prop, _receiver) {
      if (real) return (real as any)[prop];
      // Only pino's level methods are safe to queue pre-warm: a queued call
      // is a `real[prop](...args)` closure replayed later, which only makes
      // sense for methods. Anything else (e.g. `.child()`, `.level`) fails
      // loud instead of returning a function where a Logger/string is
      // expected.
      if (typeof prop !== "string" || !PINO_LEVEL_METHODS.has(prop)) {
        throw new Error(
          `lazyChildLogger("${module}"): "${String(prop)}" is not usable before the logger ` +
          `initializes — only ${[...PINO_LEVEL_METHODS].join("/")} queue pre-warm`,
        );
      }
      return (...args: unknown[]) => {
        if (failed) return;
        pending.push(() => { (real as any)[prop](...args); });
      };
    },
  });

  pendingQueueLengths.set(proxy, () => pending.length);
  return proxy;
}

export const __test__ = {
  resetDaemonLoggerCache(): void {
    cachedPromise = undefined;
  },
  pendingQueueLength(logger: Logger): number {
    const get = pendingQueueLengths.get(logger as unknown as object);
    return get ? get() : -1;
  },
};

// ─── Native stderr capture ───────────────────────────────────────────────────

/** Local `yyyy-MM-dd`, matching the janitor's dated-file convention (lib/cli-logger.ts's `today()`). */
function todayDate(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * Picks the rotation target for `daemon-stderr.log`: `daemon-stderr.<date>.log`,
 * or `.<N>.log` if that name is already taken (e.g. two boots same day); both
 * shapes match log-janitor's LOG_FILE_PATTERN, so pruneLogs sweeps them for free.
 */
function nextRotatedStderrPath(dir: string, date: string): string {
  const base = join(dir, `daemon-stderr.${date}.log`);
  if (!existsSync(base)) return base;
  for (let n = 1; ; n++) {
    const candidate = join(dir, `daemon-stderr.${date}.${n}.log`);
    if (!existsSync(candidate)) return candidate;
  }
}

/**
 * Point fd 2 at ~/.mattstack/rt/logs/daemon-stderr.log so native output that bypasses
 * JS entirely (bun panics, segfault reports, runtime asserts) is captured no
 * matter how the daemon was launched. The launchd plist cannot do this
 * (macOS 26 broke $(HOME) expansion in SMAppService plists) and the dev shim
 * only covers source mode — self-redirection makes capture a property of the
 * daemon process itself. JS-side stderr never reaches fd 2 anyway: the
 * installCrashHandlers interceptor routes it into the JSON log first.
 */
export function redirectNativeStderr(): void {
  if (process.platform !== "darwin") return;
  try {
    const dir = logsDir();
    mkdirSync(dir, { recursive: true });
    const stderrPath = join(dir, "daemon-stderr.log");
    // Rotate any leftover content from a previous crash before reopening,
    // otherwise `rt daemon logs` keeps showing yesterday's panic as "most
    // recent". A rename here can never lose data (unlike truncation).
    if (existsSync(stderrPath) && statSync(stderrPath).size > 0) {
      renameSync(stderrPath, nextRotatedStderrPath(dir, todayDate()));
    }
    const fd = openSync(stderrPath, "a");
    const libc = dlopen(`libSystem.${suffix}`, {
      dup2: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    });
    libc.symbols.dup2(fd, 2);
    closeSync(fd); // fd 2 now holds the file description
    libc.close();
  } catch {
    // Non-fatal: stderr stays wherever the launcher pointed it.
  }
}

// ─── Crash handler installer ─────────────────────────────────────────────────

/**
 * Install process-level handlers that route uncaught failures through the
 * logger before exit. Call ONCE during daemon startup, AFTER logger init.
 *
 * - uncaughtException: log as fatal (sync), exit 1
 * - unhandledRejection: fatal + exit 1 while `opts.booting()` is true (no
 *   socket/API bound yet, nothing worth staying up for); log as error and
 *   stay alive once booted, so a stray steady-state rejection doesn't kill a
 *   daemon that's already serving. No `booting` given preserves the old
 *   always-log, never-exit behavior.
 * - process.stderr.write: intercept so console.error / anything writing to
 *   stderr lands in the JSON log instead of vanishing.
 */
export function installCrashHandlers(
  handle: DaemonLoggerHandle,
  opts: { booting?: () => boolean } = {},
): void {
  const { logger } = handle;

  // Because the pino-roll stream is opened with sync:true, logger.fatal()
  // flushes immediately to the fd — no need for pino.final() here.
  process.on("uncaughtException", (err) => {
    logger.fatal({ err }, "uncaughtException");
    process.exit(1);
  });

  process.on("unhandledRejection", (reason) => {
    if (opts.booting?.()) {
      logger.fatal({ err: reason }, "unhandledRejection during boot");
      process.exit(1);
      return;
    }
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
    // write(chunk, encoding?, cb?) — invoke the completion callback so callers
    // (and piped streams) waiting on it don't hang forever.
    const cb = rest[rest.length - 1];
    if (typeof cb === "function") cb();
    return true;
  }) as typeof process.stderr.write;
}
