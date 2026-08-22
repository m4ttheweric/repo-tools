import { describe, test, expect } from "bun:test";
import { fakeProbes } from "./fakes.ts";
import { readSetupState, updateSetupState } from "../state.ts";

describe("readSetupState", () => {
  test("defaults to empty arrays when the state file is absent", () => {
    const p = fakeProbes();
    expect(readSetupState(p)).toEqual({ v: 1, marketplaces: [], plugins: [], links: [], extensionEditors: [] });
  });

  test("defaults to empty arrays when the state file is unparseable", () => {
    const p = fakeProbes({ files: { "/fake-home/.mattstack/rt/setup-state.json": "not json" } });
    expect(readSetupState(p)).toEqual({ v: 1, marketplaces: [], plugins: [], links: [], extensionEditors: [] });
  });
});

describe("updateSetupState", () => {
  test("round-trips a patched state through the probe", () => {
    const p = fakeProbes();
    const result = updateSetupState(p, (s) => ({ ...s, marketplaces: ["core"] }));
    expect(result.marketplaces).toEqual(["core"]);
    expect(readSetupState(p).marketplaces).toEqual(["core"]);
  });

  test("sets lastApplyAt when the patch adds it", () => {
    const p = fakeProbes();
    const result = updateSetupState(p, (s) => ({ ...s, lastApplyAt: "2026-08-21T00:00:00.000Z" }));
    expect(result.lastApplyAt).toBe("2026-08-21T00:00:00.000Z");
  });

  test("dedupes arrays via [...new Set]", () => {
    const p = fakeProbes();
    updateSetupState(p, (s) => ({ ...s, plugins: ["a", "b"] }));
    const result = updateSetupState(p, (s) => ({ ...s, plugins: [...s.plugins, "b", "c"] }));
    expect(result.plugins).toEqual(["a", "b", "c"]);
  });
});
