import { describe, test, expect } from "bun:test";
import { parseCatalogResources } from "../scan.ts";

const CATALOG = [
  "ID                     NAME                     PUBLIC   TYPE              AUTH                 ACCESS       TAGS",
  "rs-3683bf6c68ffb3d7    acme-db-staging    true     postgres          Leased Credentials   available    postgres-db=,staging=",
  "rs-275c2cfc66b6a84e    acme-acg-qa-prod      true     postgres          Leased Credentials   available    production=",
  "rs-cccc2222dddd3333    acme-dev-read-only    true     aurora-postgres   Leased Credentials   granted      postgres-db=",
  "rs-aaaa0000bbbb1111    some-website             true     website           HTTP                 available    web=",
  "rs-eeee4444ffff5555    some-aws-account         true     account           AWS                  available    aws=",
  "not-a-row",
].join("\n");
const STATUS_NAMES = ["acme-dev", "acme-db-staging"]; // datasource-section names from getSdmSnapshot()

describe("parseCatalogResources", () => {
  test("keeps postgres-family datasources (postgres + aurora-postgres), drops the rest", () => {
    const byName = Object.fromEntries(parseCatalogResources(CATALOG, []).map(x => [x.name, x]));
    expect(byName["acme-db-staging"]).toEqual({ name: "acme-db-staging", type: "postgres", tags: ["postgres-db=", "staging="], standingAccess: false });
    expect(byName["acme-acg-qa-prod"]!.type).toBe("postgres");
    expect(byName["acme-dev-read-only"]!.type).toBe("aurora-postgres"); // aurora-postgres kept (was dropped by exact match)
    expect(byName["some-website"]).toBeUndefined();     // non-postgres filtered out
    expect(byName["some-aws-account"]).toBeUndefined(); // non-postgres filtered out
  });
  test("standing access: 'available' rows need a request; granted rows do not", () => {
    const byName = Object.fromEntries(parseCatalogResources(CATALOG, []).map(x => [x.name, x]));
    expect(byName["acme-db-staging"]!.standingAccess).toBe(false); // row has "available"
    expect(byName["acme-dev-read-only"]!.standingAccess).toBe(true);  // "granted"
  });
  test("adds status names not already in the catalog (standing), deduped", () => {
    const rows = parseCatalogResources(CATALOG, STATUS_NAMES);
    const names = rows.map(x => x.name);
    expect(names).toContain("acme-dev");                 // status-only standing access
    expect(rows.find(r => r.name === "acme-dev")!.standingAccess).toBe(true);
    expect(names.filter(n => n === "acme-db-staging")).toHaveLength(1); // deduped
  });
});
