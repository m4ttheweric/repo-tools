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
import { mkdirSync, openSync, closeSync } from "fs";
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

let cached: DaemonLoggerHandle | undefined;

/**
 * Lazily initialize the production logger bound to ~/.mattstack/rt/logs.
 * Multiple callers share the same handle.
 */
export async function getDaemonLogger(): Promise<DaemonLoggerHandle> {
  if (!cached) {
    cached = await createDaemonLogger({
      logDir: logsDir(),
      level: (process.env.RT_LOG_LEVEL as pino.LevelWithSilent | undefined) ?? "info",
    });
  }
  return cached;
}

/**
 * A `childLogger(module)` result usable synchronously from module load
 * (no top-level await, which would make every importer async-initializing
 * and block `bun build --compile`). Calls made before getDaemonLogger()
 * resolves are queued and replayed in order once it does, so no line is
 * lost or reordered relative to today's `await`-at-module-scope behavior —
 * only its write to disk shifts later by the same startup delay
 * getDaemonLogger() always had.
 */
export function lazyChildLogger(module: string): Logger {
  let real: Logger | undefined;
  const pending: Array<() => void> = [];
  getDaemonLogger().then((handle) => {
    real = handle.childLogger(module);
    for (const call of pending) call();
    pending.length = 0;
  });

  return new Proxy({} as Logger, {
    get(_target, prop, _receiver) {
      if (real) return (real as any)[prop];
      // Pino's logging methods (info/warn/error/debug/…) are the only
      // members these seven call sites use — queue the invocation.
      return (...args: unknown[]) => {
        pending.push(() => { (real as any)[prop](...args); });
      };
    },
  });
}

// ─── Native stderr capture ───────────────────────────────────────────────────

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
    const fd = openSync(join(dir, "daemon-stderr.log"), "a");
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
 * - unhandledRejection: log as error, do NOT exit (let the daemon recover)
 * - process.stderr.write: intercept so console.error / anything writing to
 *   stderr lands in the JSON log instead of vanishing.
 */
export function installCrashHandlers(handle: DaemonLoggerHandle): void {
  const { logger } = handle;

  // Because the pino-roll stream is opened with sync:true, logger.fatal()
  // flushes immediately to the fd — no need for pino.final() here.
  process.on("uncaughtException", (err) => {
    logger.fatal({ err }, "uncaughtException");
    process.exit(1);
  });

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
    // write(chunk, encoding?, cb?) — invoke the completion callback so callers
    // (and piped streams) waiting on it don't hang forever.
    const cb = rest[rest.length - 1];
    if (typeof cb === "function") cb();
    return true;
  }) as typeof process.stderr.write;
}
