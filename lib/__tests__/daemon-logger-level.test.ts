import { test, expect } from "bun:test";
import { resolveDaemonLogLevel, isPanicLine } from "../daemon-logger.ts";

test("RT_LOG_LEVEL env wins over the setting", () => {
  expect(resolveDaemonLogLevel("debug", () => "warn")).toBe("debug");
});
test("setting is used when env is unset", () => {
  expect(resolveDaemonLogLevel(undefined, () => "warn")).toBe("warn");
});
test("falls back to info when neither is set", () => {
  expect(resolveDaemonLogLevel(undefined, () => undefined)).toBe("info");
});
test("a thrown setting read falls back to info instead of propagating", () => {
  expect(
    resolveDaemonLogLevel(undefined, () => {
      throw new Error("unknown key: rt.logLevel");
    }),
  ).toBe("info");
});
test("an unknown level falls back to info instead of reaching pino", () => {
  expect(resolveDaemonLogLevel("verbose", () => undefined)).toBe("info");
});
test("a valid level still passes through", () => {
  expect(resolveDaemonLogLevel("debug", () => undefined)).toBe("debug");
});
test("a panic-looking stderr line is escalated; ordinary noise is not", () => {
  expect(isPanicLine("panic: runtime error")).toBe(true);
  expect(isPanicLine("Uncaught Error: boom")).toBe(true);
  expect(isPanicLine("rt: ignoring \"x\" from the team scope")).toBe(false);
});
