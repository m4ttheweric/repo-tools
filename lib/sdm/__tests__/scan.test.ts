import { describe, test, expect } from "bun:test";
import { parseCatalogResources } from "../scan.ts";

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
