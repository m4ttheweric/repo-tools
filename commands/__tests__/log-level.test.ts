import { test, expect } from "bun:test";
import { formatLogLevelResult } from "../daemon.ts";

test("formats a set result", () => {
  expect(formatLogLevelResult({ ok: true, level: "debug" }, true)).toContain("debug");
});
test("formats a show result", () => {
  expect(formatLogLevelResult({ ok: true, level: "info" }, false)).toContain("info");
});
