import { describe, test, expect, spyOn } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { tmpdir } from "os";
import { openStateDb } from "../../state/db.ts";
import { closeStateDb } from "../../state/index.ts";
import { loadSdmState, recordRecent, saveSdmState, sdmStatePath, MAX_RECENTS } from "../state.ts";

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "rt-sdm-state-"));
  return { db: openStateDb(join(dir, "state.db"), "cli"), dir };
}

const entry = (key: string) => ({ key, label: key, sdmResource: `example-${key}` });

describe("loadSdmState", () => {
  test("no prior write yields empty state", () => {
    const { db, dir } = freshDb();
    expect(loadSdmState(db)).toEqual({ version: 1, recents: [] });
    rmSync(dir, { recursive: true, force: true });
  });

  test("a malformed stored row yields empty state", () => {
    const { db, dir } = freshDb();
    db.query("INSERT INTO kv (ns, k, v, updated_at) VALUES ('sdm-state', 'state', '{not json', 0);").run();
    expect(loadSdmState(db)).toEqual({ version: 1, recents: [] });
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("recordRecent", () => {
  test("prepends, dedupes by resource, and caps", () => {
    const { db, dir } = freshDb();
    const now = () => new Date("2026-07-01T12:00:00Z");
    for (let i = 0; i < MAX_RECENTS + 3; i++) recordRecent(entry(`c${i}`), { db, now });
    let state = loadSdmState(db);
    expect(state.recents).toHaveLength(MAX_RECENTS);
    expect(state.recents[0]!.key).toBe(`c${MAX_RECENTS + 2}`);

    state = recordRecent(entry("c5"), { db, now });
    expect(state.recents[0]!.key).toBe("c5");
    expect(state.recents.filter(r => r.key === "c5")).toHaveLength(1);
    expect(state.recents[0]!.lastConnectedAt).toBe("2026-07-01T12:00:00.000Z");
    rmSync(dir, { recursive: true, force: true });
  });

  test("a new-key connect replaces the old-key recent for the same resource (no dup)", () => {
    const { db, dir } = freshDb();
    const now = () => new Date("2026-07-01T12:00:00Z");
    // Old connector-model recent, then reconnect via the new scan model:
    // different key, same underlying resource.
    recordRecent({ key: "acme:progressive-qa", label: "progressive-qa", sdmResource: "acme-db-qa" }, { db, now });
    const state = recordRecent({ key: "sdm:acme-db-qa", label: "acme qa", sdmResource: "acme-db-qa" }, { db, now });
    const forResource = state.recents.filter(r => r.sdmResource === "acme-db-qa");
    expect(forResource).toHaveLength(1);
    expect(forResource[0]!.key).toBe("sdm:acme-db-qa");
    expect(forResource[0]!.label).toBe("acme qa");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("loadSdmState — legacy import, real (HOME-faked) singleton", () => {
  const origHome = process.env.HOME;
  let home: string;

  test("a pre-existing sdm/state.json is imported on first read, and renamed to .migrated", () => {
    home = mkdtempSync(join(tmpdir(), "rt-sdm-state-home-"));
    process.env.HOME = home;
    closeStateDb();
    try {
      const legacyPath = sdmStatePath();
      mkdirSync(dirname(legacyPath), { recursive: true });
      writeFileSync(legacyPath, JSON.stringify({ version: 1, recents: [entry("stale")] }));
      expect(existsSync(legacyPath)).toBe(true);

      expect(loadSdmState().recents.map(r => r.key)).toEqual(["stale"]);
      expect(existsSync(legacyPath)).toBe(false);
      expect(existsSync(`${legacyPath}.migrated`)).toBe(true);

      // A later save still overwrites the imported value, and renames (not
      // unlinks) anything left at the legacy path.
      saveSdmState({ version: 1, recents: [{ ...entry("fresh"), lastConnectedAt: "2026-07-01T12:00:00.000Z" }] });
      expect(loadSdmState().recents.map(r => r.key)).toEqual(["fresh"]);
    } finally {
      process.env.HOME = origHome;
      closeStateDb();
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("a corrupt sdm/state.json warns and is left in place; loadSdmState reads as empty", () => {
    home = mkdtempSync(join(tmpdir(), "rt-sdm-state-corrupt-home-"));
    process.env.HOME = home;
    closeStateDb();
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const legacyPath = sdmStatePath();
      mkdirSync(dirname(legacyPath), { recursive: true });
      writeFileSync(legacyPath, "{ not valid json");

      expect(loadSdmState()).toEqual({ version: 1, recents: [] });
      expect(existsSync(legacyPath)).toBe(true);
      expect(existsSync(`${legacyPath}.migrated`)).toBe(false);
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
      process.env.HOME = origHome;
      closeStateDb();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
