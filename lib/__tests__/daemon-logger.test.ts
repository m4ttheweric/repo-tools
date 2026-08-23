import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// We import the factory (not the singleton) so each test gets isolation.
import { createDaemonLogger, lazyChildLogger } from "../daemon-logger.ts";
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
