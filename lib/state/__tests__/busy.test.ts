import { expect, test } from "bun:test";
import { runCriticalWrite } from "../busy.ts";

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
