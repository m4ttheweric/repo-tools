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
 * Crash safety: the pino-roll stream uses sync:true so fatal lines flush
 * synchronously before exit when uncaught exceptions propagate.
 */

import pino, { type Logger } from "pino";
// pino-roll ships no .d.ts; typed below with a minimal declare.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — no types shipped; the JS API is well-tested.
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
 * pino-roll's default export is async (it stats the dir + sets up the writer).
 */
export async function createDaemonLogger(opts: CreateOptions): Promise<DaemonLoggerHandle> {
  // Note: pino-roll strips the last file extension from the base name and appends
  // its own counter/date suffixes. Using "daemon.log.log" as the file path causes
  // pino-roll to treat "daemon.log" as the base and ".log" as the extension,
  // producing rotation files named "daemon.log.YYYY-MM-DD.N.log". This naming
  // satisfies the "starts with daemon.log" convention expected by callers/tests.
  const stream = await roll({
    file: `${opts.logDir}/daemon.log.log`,
    frequency: "daily",
    dateFormat: "yyyy-MM-dd",
    mkdir: true,
    limit: { count: 14 },
    // sync mode ensures each pino.write() call flushes immediately to the fd,
    // making log lines available without an explicit async flush step.
    sync: true,
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
 * Multiple callers share the same handle.
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
    return true;
  }) as typeof process.stderr.write;
}
