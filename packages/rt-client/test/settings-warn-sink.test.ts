import { test, expect } from "bun:test";
import { setSettingsWarnSink } from "../src/index.ts";
import { emitSettingsWarning } from "../src/settings/resolve.ts";

test("a bound sink receives warnings and dedupes on identical messages", () => {
  const seen: string[] = [];
  setSettingsWarnSink((m) => seen.push(m));
  emitSettingsWarning("rt: sample warning");
  emitSettingsWarning("rt: sample warning");
  expect(seen).toEqual(["rt: sample warning"]); // deduped
  setSettingsWarnSink(null); // restore default
});
