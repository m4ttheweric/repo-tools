import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isBusyError, persistOrWarn, runCriticalWrite, setBusyLogSink } from "../busy.ts";

test("returns the value when fn succeeds", () => {
  expect(runCriticalWrite("t", () => 42, {})).toBe(42);
});

test("retries a busy error and returns the eventual value", () => {
  let calls = 0;
  const value = runCriticalWrite("t", () => {
    calls++;
    if (calls < 2) { const e = new Error("database is locked"); (e as { code?: string }).code = "SQLITE_BUSY"; throw e; }
    return "ok";
  }, {});
  expect(value).toBe("ok");
  expect(calls).toBe(2);
});

test("returns undefined after exhausting attempts on a busy error", () => {
  const value = runCriticalWrite("t", () => {
    const e = new Error("database is locked"); (e as { code?: string }).code = "SQLITE_BUSY"; throw e;
  }, {});
  expect(value).toBeUndefined();
});

test("rethrows a non-busy error rather than retrying", () => {
  expect(() => runCriticalWrite("t", () => { throw new Error("syntax error"); }, {})).toThrow("syntax error");
});

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

// R052: busy.ts's warn/error lines used to always go through
// getDaemonLogger(), so a CLI process hitting a busy write appended a line
// under the daemon pid to the daemon's own log surface. An injected sink
// lets whichever process this code runs in (daemon or CLI) route these
// lines to its own surface instead, without busy.ts importing either
// logger module itself.
afterEach(() => {
  setBusyLogSink(null);
});

test("R052: an injected sink receives persistOrWarn's warning synchronously, not the daemon-logger default", () => {
  const calls: Array<{ level: string; module: string; message: string }> = [];
  setBusyLogSink({
    warn: (module, _context, message) => calls.push({ level: "warn", module, message }),
    error: (module, _context, message) => calls.push({ level: "error", module, message }),
  });

  persistOrWarn("mymodule", () => {
    const e = new Error("database is locked");
    (e as { code?: string }).code = "SQLITE_BUSY";
    throw e;
  }, { foo: 1 });

  expect(calls).toEqual([{ level: "warn", module: "mymodule", message: expect.stringContaining("db busy") as unknown as string }]);
});

test("R052: an injected sink receives runCriticalWrite's error after exhausting attempts", () => {
  const calls: Array<{ level: string; module: string }> = [];
  setBusyLogSink({
    warn: (module) => calls.push({ level: "warn", module }),
    error: (module) => calls.push({ level: "error", module }),
  });

  runCriticalWrite("myop", () => {
    const e = new Error("database is locked");
    (e as { code?: string }).code = "SQLITE_BUSY";
    throw e;
  }, {});

  expect(calls).toEqual([{ level: "error", module: "myop" }]);
});
