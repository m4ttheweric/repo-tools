import { describe, test, expect } from "bun:test";
import { buildBrowseConnections } from "../browse.ts";
import type { CatalogResult, DiscoveredConnection, UnresolvedGap } from "../connectors.ts";

const primary: DiscoveredConnection = {
  id: "alpha-qa",
  label: "acme-db-qa",
  sdmResource: "acme-db-qa",
  tier: "qa",
  production: false,
  key: "acme:alpha-qa",
  connector: "acme",
  resolution: { source: "exact", candidates: ["acme-db-qa", "acme-db-qa-read-only"] },
};

const gap: UnresolvedGap = {
  id: "acg-qa",
  label: "ACG QA",
  slug: "acg",
  env: "qa",
  source: "ambiguous",
  candidates: ["acme-acg-qa-read-only"],
  key: "acme:acg-qa",
  connector: "acme",
};

function catalog(overrides: Partial<CatalogResult> = {}): CatalogResult {
  return { connections: [], errors: [], unresolved: [], fromCache: false, ...overrides };
}

describe("buildBrowseConnections", () => {
  test("a primary connection is kept verbatim", () => {
    const result = buildBrowseConnections(catalog({ connections: [primary] }));
    const found = result.find(c => c.sdmResource === "acme-db-qa");
    expect(found).toEqual(primary);
  });

  test("a connection's extra resolution.candidates become deduped variant rows with the '${label} (suffix)' label", () => {
    const result = buildBrowseConnections(catalog({ connections: [primary] }));
    expect(result.length).toBe(2);
    const variant = result.find(c => c.sdmResource === "acme-db-qa-read-only");
    expect(variant).toBeDefined();
    expect(variant!.label).toBe("acme-db-qa (read-only)");
    expect(variant!.key).toBe("acme:acme-db-qa-read-only");
    expect(variant!.id).toBe("acme-db-qa-read-only");
    expect(variant!.tier).toBe("qa");
    expect(variant!.production).toBe(false);
    expect(variant!.reasonSuggestion).toBe("investigating acme-db-qa (read-only) data");
    expect(variant!.db).toEqual({ database: "postgres", schema: "acme", user: "postgres" });
  });

  test("a gap's candidates become variant rows labeled from the raw name", () => {
    const result = buildBrowseConnections(catalog({ unresolved: [gap] }));
    expect(result.length).toBe(1);
    const variant = result[0]!;
    expect(variant.sdmResource).toBe("acme-acg-qa-read-only");
    expect(variant.label).toBe("acg-qa-read-only");
    expect(variant.production).toBe(false);
  });

  test("a resource that is both a primary and someone's candidate appears once (primary wins)", () => {
    const dupPrimary: DiscoveredConnection = {
      ...primary,
      id: "read-only-primary",
      label: "acme-db-qa read replica",
      sdmResource: "acme-db-qa-read-only",
      key: "acme:read-only-primary",
      resolution: { source: "exact" },
    };
    const result = buildBrowseConnections(catalog({ connections: [primary, dupPrimary] }));
    const matches = result.filter(c => c.sdmResource === "acme-db-qa-read-only");
    expect(matches.length).toBe(1);
    expect(matches[0]).toEqual(dupPrimary);
  });

  test("a gap with empty candidates contributes nothing", () => {
    const emptyGap: UnresolvedGap = { ...gap, id: "empty-gap", key: "acme:empty-gap", candidates: [] };
    const result = buildBrowseConnections(catalog({ unresolved: [emptyGap] }));
    expect(result.length).toBe(0);
  });

  test("gap candidate production derives from env === 'prod'", () => {
    const prodGap: UnresolvedGap = { ...gap, id: "prod-gap", key: "acme:prod-gap", env: "prod", candidates: ["acme-prod-thing"] };
    const result = buildBrowseConnections(catalog({ unresolved: [prodGap] }));
    expect(result[0]!.production).toBe(true);
  });
});
