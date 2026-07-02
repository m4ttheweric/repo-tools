import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadSdmState, recordRecent, MAX_RECENTS } from "../state.ts";

const dir = mkdtempSync(join(tmpdir(), "rt-sdm-state-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const entry = (key: string) => ({ key, label: key, sdmResource: `example-${key}` });

describe("loadSdmState", () => {
  test("missing file yields empty state", () => {
    expect(loadSdmState(join(dir, "missing.json"))).toEqual({ version: 1, recents: [] });
  });

  test("corrupt file yields empty state", () => {
    const p = join(dir, "corrupt.json");
    writeFileSync(p, "{nope");
    expect(loadSdmState(p)).toEqual({ version: 1, recents: [] });
  });
});

describe("recordRecent", () => {
  test("prepends, dedupes by key, and caps", () => {
    const p = join(dir, "state.json");
    const now = () => new Date("2026-07-01T12:00:00Z");
    for (let i = 0; i < MAX_RECENTS + 3; i++) recordRecent(entry(`c${i}`), { path: p, now });
    let state = loadSdmState(p);
    expect(state.recents).toHaveLength(MAX_RECENTS);
    expect(state.recents[0]!.key).toBe(`c${MAX_RECENTS + 2}`);

    state = recordRecent(entry("c5"), { path: p, now });
    expect(state.recents[0]!.key).toBe("c5");
    expect(state.recents.filter(r => r.key === "c5")).toHaveLength(1);
    expect(state.recents[0]!.lastConnectedAt).toBe("2026-07-01T12:00:00.000Z");
  });
});
