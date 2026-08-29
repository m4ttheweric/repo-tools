import { describe, test, expect, mock } from "bun:test";
import pino from "pino";
import { safeInterval, safeTimeout } from "../safe-timers.ts";

const silentLog = pino({ level: "silent" });

describe("safeInterval / safeTimeout", () => {
  test("safeInterval swallows a throwing tick and logs warn", async () => {
    const warn = mock(() => {});
    const log = { ...silentLog, warn } as unknown as typeof silentLog;
    let ticks = 0;
    const handle = safeInterval(
      () => {
        ticks++;
        throw new Error("SQLITE_FULL");
      },
      10,
      "test-sweep",
      log,
    );
    await new Promise<void>((r) => setTimeout(r, 45));
    clearInterval(handle);
    expect(ticks).toBeGreaterThan(0);
    expect(warn).toHaveBeenCalled();
  });

  test("safeTimeout swallows a throwing tick and logs warn", async () => {
    const warn = mock(() => {});
    const log = { ...silentLog, warn } as unknown as typeof silentLog;
    let ran = false;
    safeTimeout(
      () => {
        ran = true;
        throw new Error("SQLITE_FULL");
      },
      10,
      "test-timeout",
      log,
    );
    await new Promise<void>((r) => setTimeout(r, 45));
    expect(ran).toBe(true);
    expect(warn).toHaveBeenCalled();
  });

  test("safeInterval does not swallow a non-throwing tick's normal operation", async () => {
    const warn = mock(() => {});
    const log = { ...silentLog, warn } as unknown as typeof silentLog;
    let ticks = 0;
    const handle = safeInterval(() => { ticks++; }, 10, "test-sweep-ok", log);
    await new Promise<void>((r) => setTimeout(r, 45));
    clearInterval(handle);
    expect(ticks).toBeGreaterThan(0);
    expect(warn).not.toHaveBeenCalled();
  });
});
