import { describe, test, expect } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { tmpdir } from "os";
import { openStateDb } from "../../state/db.ts";
import { closeStateDb } from "../../state/index.ts";
import { CATALOG_CACHE_MS, parseCatalogResources, readScanCache, scanCachePath, writeScanCache, type SdmResource } from "../scan.ts";

const CATALOG = [
  "ID                     NAME                     PUBLIC   TYPE              AUTH                 ACCESS       TAGS",
  "rs-3683bf6c68ffb3d7    assured-amfam-staging    true     postgres          Leased Credentials   available    postgres-db=,staging=",
  "rs-275c2cfc66b6a84e    assured-acg-qa-prod      true     postgres          Leased Credentials   available    production=",
  "rs-cccc2222dddd3333    assured-dev-read-only    true     aurora-postgres   Leased Credentials   granted      postgres-db=",
  "rs-aaaa0000bbbb1111    some-website             true     website           HTTP                 available    web=",
  "rs-eeee4444ffff5555    some-aws-account         true     account           AWS                  available    aws=",
  "not-a-row",
].join("\n");
const STATUS_NAMES = ["assured-dev", "assured-amfam-staging"]; // datasource-section names from getSdmSnapshot()

describe("parseCatalogResources", () => {
  test("keeps postgres-family datasources (postgres + aurora-postgres), drops the rest", () => {
    const byName = Object.fromEntries(parseCatalogResources(CATALOG, []).map(x => [x.name, x]));
    expect(byName["assured-amfam-staging"]).toEqual({ name: "assured-amfam-staging", type: "postgres", tags: ["postgres-db=", "staging="], standingAccess: false });
    expect(byName["assured-acg-qa-prod"]!.type).toBe("postgres");
    expect(byName["assured-dev-read-only"]!.type).toBe("aurora-postgres"); // aurora-postgres kept (was dropped by exact match)
    expect(byName["some-website"]).toBeUndefined();     // non-postgres filtered out
    expect(byName["some-aws-account"]).toBeUndefined(); // non-postgres filtered out
  });
  test("standing access: 'available' rows need a request; granted rows do not", () => {
    const byName = Object.fromEntries(parseCatalogResources(CATALOG, []).map(x => [x.name, x]));
    expect(byName["assured-amfam-staging"]!.standingAccess).toBe(false); // row has "available"
    expect(byName["assured-dev-read-only"]!.standingAccess).toBe(true);  // "granted"
  });
  test("adds status names not already in the catalog (standing), deduped", () => {
    const rows = parseCatalogResources(CATALOG, STATUS_NAMES);
    const names = rows.map(x => x.name);
    expect(names).toContain("assured-dev");                 // status-only standing access
    expect(rows.find(r => r.name === "assured-dev")!.standingAccess).toBe(true);
    expect(names.filter(n => n === "assured-amfam-staging")).toHaveLength(1); // deduped
  });
});

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), "rt-sdm-scan-"));
  return { db: openStateDb(join(dir, "state.db"), "cli"), dir };
}

const RESOURCES: SdmResource[] = [{ name: "assured-dev", type: "postgres", tags: [], standingAccess: true }];

describe("readScanCache / writeScanCache", () => {
  test("round-trips through the store within CATALOG_CACHE_MS", () => {
    const { db, dir } = freshDb();
    expect(readScanCache(db)).toBeNull();
    writeScanCache(RESOURCES, db);
    expect(readScanCache(db)).toEqual(RESOURCES);
    rmSync(dir, { recursive: true, force: true });
  });

  test("an empty result never clobbers a good cache", () => {
    const { db, dir } = freshDb();
    writeScanCache(RESOURCES, db);
    writeScanCache([], db);
    expect(readScanCache(db)).toEqual(RESOURCES);
    rmSync(dir, { recursive: true, force: true });
  });

  test("a cache older than CATALOG_CACHE_MS reads as null (stale)", () => {
    const { db, dir } = freshDb();
    db.query("INSERT INTO kv (ns, k, v, updated_at) VALUES ('sdm-scan-cache', 'state', ?, 0);")
      .run(JSON.stringify({ builtAt: Date.now() - CATALOG_CACHE_MS - 1, resources: RESOURCES }));
    expect(readScanCache(db)).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  test("a stale on-disk sdm/scan-cache.json is ignored once the store owns the value, and gets unlinked on write", () => {
    const home = mkdtempSync(join(tmpdir(), "rt-sdm-scan-home-"));
    const origHome = process.env.HOME;
    process.env.HOME = home;
    closeStateDb();
    try {
      const legacyPath = scanCachePath();
      mkdirSync(dirname(legacyPath), { recursive: true });
      writeFileSync(legacyPath, JSON.stringify({ builtAt: Date.now(), resources: [{ name: "stale-only", type: "postgres", tags: [], standingAccess: true }] }));
      expect(existsSync(legacyPath)).toBe(true);

      // The store, not the stale file, is authoritative — a fresh store has nothing yet.
      expect(readScanCache()).toBeNull();

      writeScanCache(RESOURCES);
      expect(readScanCache()).toEqual(RESOURCES);
      expect(existsSync(legacyPath)).toBe(false);
    } finally {
      process.env.HOME = origHome;
      closeStateDb();
      rmSync(home, { recursive: true, force: true });
    }
  });
});
