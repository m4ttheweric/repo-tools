import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "pino";

// We import the factory (not the singleton) so each test gets isolation.
import {
  createDaemonLogger,
  lazyChildLogger,
  getDaemonLogger,
  installCrashHandlers,
  __test__,
  type DaemonLoggerHandle,
} from "../daemon-logger.ts";
import { logsDir } from "../rt-paths.ts";

let logDir: string;

beforeEach(() => {
  logDir = mkdtempSync(join(tmpdir(), "rt-daemon-logger-test-"));
});

afterEach(() => {
  try { rmSync(logDir, { recursive: true, force: true }); } catch { /* */ }
});

function readTodayLog(): string {
  // pino-roll names files: <base>.<YYYY-MM-DD> (using its default frequency:'daily')
  // pino-roll names files: daemon.<YYYY-MM-DD>.<N>.log (config in daemon-logger.ts)
  const files = readdirSync(logDir).filter(f => /^daemon\..+\.log$/.test(f));
  if (files.length === 0) return "";
  // Newest by name (date sort works for YYYY-MM-DD)
  files.sort().reverse();
  return readFileSync(join(logDir, files[0]!), "utf8");
}

async function flush(logger: { flush?: () => void }): Promise<void> {
  // pino streams are sync via pino-roll's stream, but give the runtime
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
    expect(content).toContain('"level":"info"');
    expect(content).toContain('"msg":"hello world"');
  });

  it("childLogger stamps module field on every line", async () => {
    const { childLogger } = await createDaemonLogger({ logDir, level: "info" });
    const log = childLogger("parking-lot");
    log.info("something happened");
    await flush(log);
    const content = readTodayLog();
    expect(content).toContain('"module":"parking-lot"');
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

describe("lazyChildLogger", () => {
  // lazyChildLogger binds to the production getDaemonLogger() singleton, so
  // these read the singleton's real (HOME-isolated by test-setup.ts) log dir
  // rather than a per-test tmpdir like the suite above.
  function readSingletonLog(): string {
    const dir = logsDir();
    if (!existsSync(dir)) return "";
    const files = readdirSync(dir).filter((f) => /^daemon\..+\.log$/.test(f));
    if (files.length === 0) return "";
    files.sort().reverse();
    return readFileSync(join(dir, files[0]!), "utf8");
  }

  it("queues calls made before the singleton resolves and replays them in order, tagged with the module name", async () => {
    const log = lazyChildLogger("lazy-order-test");
    // Fires synchronously, before getDaemonLogger()'s internal await settles.
    log.info("lazy-first");
    log.warn("lazy-second");

    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));

    const content = readSingletonLog();
    expect(content).toContain('"module":"lazy-order-test"');
    expect(content).toContain('"msg":"lazy-first"');
    expect(content).toContain('"msg":"lazy-second"');
    expect(content.indexOf("lazy-first")).toBeLessThan(content.indexOf("lazy-second"));
  });

  it("passes calls straight through once the singleton is already warm", async () => {
    // The singleton is warm from the previous test in this file.
    const log = lazyChildLogger("lazy-warm-test");
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    log.info("lazy-warm-line");
    await new Promise((r) => setImmediate(r));
    const content = readSingletonLog();
    expect(content).toContain('"module":"lazy-warm-test"');
    expect(content).toContain('"msg":"lazy-warm-line"');
  });
});

describe("getDaemonLogger — concurrency", () => {
  it("shares one in-flight initialization across concurrent callers", async () => {
    __test__.resetDaemonLoggerCache();
    const results = await Promise.all(Array.from({ length: 8 }, () => getDaemonLogger()));
    for (const handle of results) expect(handle).toBe(results[0]!);
  });
});

describe("lazyChildLogger — init failure", () => {
  it("diagnoses to stderr, drops the queue permanently, and never produces an unhandled rejection", async () => {
    const stderrChunks: string[] = [];
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: any, ...rest: any[]) => {
      stderrChunks.push(typeof chunk === "string" ? chunk : String(chunk));
      const cb = rest[rest.length - 1];
      if (typeof cb === "function") cb();
      return true;
    }) as typeof process.stderr.write;

    let sawUnhandledRejection = false;
    const onUnhandled = () => { sawUnhandledRejection = true; };
    process.on("unhandledRejection", onUnhandled);

    try {
      const log = lazyChildLogger("init-fail-test", {
        getLogger: () => Promise.reject(new Error("disk unwritable")),
      });

      log.info("queued-before-failure-1");
      log.info("queued-before-failure-2");

      for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));

      expect(stderrChunks.join("")).toContain("disk unwritable");
      expect(stderrChunks.join("")).toContain("init-fail-test");
      expect(__test__.pendingQueueLength(log)).toBe(0);

      for (let i = 0; i < 500; i++) log.warn(`post-failure-${i}`);
      expect(__test__.pendingQueueLength(log)).toBe(0);

      expect(sawUnhandledRejection).toBe(false);
    } finally {
      process.stderr.write = origWrite;
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

describe("lazyChildLogger — Proxy guard", () => {
  it("queues the known pino level methods pre-warm without throwing", () => {
    const log = lazyChildLogger("guard-ok-test", { getLogger: () => new Promise(() => {}) });
    expect(() => log.trace("t")).not.toThrow();
    expect(() => log.debug("d")).not.toThrow();
    expect(() => log.info("i")).not.toThrow();
    expect(() => log.warn("w")).not.toThrow();
    expect(() => log.error("e")).not.toThrow();
    expect(() => log.fatal("f")).not.toThrow();
  });

  it("throws a clear error for a non-level property accessed pre-warm", () => {
    const log = lazyChildLogger("guard-throw-test", { getLogger: () => new Promise(() => {}) });
    expect(() => (log as any).child({})).toThrow(/guard-throw-test/);
    expect(() => (log as any).level).toThrow();
  });
});

describe("installCrashHandlers — boot-phase gating", () => {
  it("unhandledRejection exits(1) while booting, only logs once ready", () => {
    const exits: number[] = [];
    const origExit = process.exit;
    const origStderrWrite = process.stderr.write.bind(process.stderr);
    // @ts-expect-error test stub — captures the exit code instead of terminating
    process.exit = (code?: number) => { exits.push(code ?? 0); };
    const fatal = mock(() => {});
    const error = mock(() => {});
    const logger = { fatal, error } as unknown as Logger;
    let booting = true;
    try {
      installCrashHandlers({ logger } as DaemonLoggerHandle, { booting: () => booting });
      process.emit("unhandledRejection", new Error("boot boom"), Promise.resolve());
      expect(fatal).toHaveBeenCalledTimes(1);
      expect(exits).toEqual([1]);

      booting = false;
      process.emit("unhandledRejection", new Error("steady boom"), Promise.resolve());
      expect(error).toHaveBeenCalledTimes(1);
      expect(exits).toEqual([1]); // no second exit
    } finally {
      process.exit = origExit;
      process.stderr.write = origStderrWrite;
      process.removeAllListeners("unhandledRejection");
      process.removeAllListeners("uncaughtException");
    }
  });
});
