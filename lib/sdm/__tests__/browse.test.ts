import { describe, test, expect } from "bun:test";
import { buildBrowseConnections } from "../browse.ts";
import type { CatalogResult, DiscoveredConnection, UnresolvedGap } from "../connectors.ts";

const primary: DiscoveredConnection = {
  id: "alpha-qa",
  label: "progressive-qa",
  sdmResource: "assured-pgr-qa",
  tier: "qa",
  production: false,
  key: "assured:alpha-qa",
  connector: "assured",
  resolution: { source: "exact", candidates: ["assured-pgr-qa", "assured-pgr-qa-read-only"] },
};

const gap: UnresolvedGap = {
  id: "acg-qa",
  label: "ACG QA",
  slug: "acg",
  env: "qa",
  source: "ambiguous",
  candidates: ["assured-acg-qa-read-only"],
  key: "assured:acg-qa",
  connector: "assured",
};

function catalog(overrides: Partial<CatalogResult> = {}): CatalogResult {
  return { connections: [], errors: [], unresolved: [], fromCache: false, ...overrides };
}

describe("buildBrowseConnections", () => {
  test("a primary connection is kept verbatim", () => {
    const result = buildBrowseConnections(catalog({ connections: [primary] }));
    const found = result.find(c => c.sdmResource === "assured-pgr-qa");
    expect(found).toEqual(primary);
  });

  test("a connection's extra resolution.candidates become deduped variant rows with the '${label} (suffix)' label", () => {
    const result = buildBrowseConnections(catalog({ connections: [primary] }));
    expect(result.length).toBe(2);
    const variant = result.find(c => c.sdmResource === "assured-pgr-qa-read-only");
    expect(variant).toBeDefined();
    expect(variant!.label).toBe("progressive-qa (read-only)");
    expect(variant!.key).toBe("assured:assured-pgr-qa-read-only");
    expect(variant!.id).toBe("assured-pgr-qa-read-only");
    expect(variant!.tier).toBe("qa");
    expect(variant!.production).toBe(false);
    expect(variant!.reasonSuggestion).toBe("investigating progressive-qa (read-only) data");
    expect(variant!.db).toEqual({ database: "postgres", schema: "assured", user: "postgres" });
  });

  test("a gap's candidates become variant rows labeled from the raw name", () => {
    const result = buildBrowseConnections(catalog({ unresolved: [gap] }));
    expect(result.length).toBe(1);
    const variant = result[0]!;
    expect(variant.sdmResource).toBe("assured-acg-qa-read-only");
    expect(variant.label).toBe("acg-qa-read-only");
    expect(variant.production).toBe(false);
  });

  test("a resource that is both a primary and someone's candidate appears once (primary wins)", () => {
    const dupPrimary: DiscoveredConnection = {
      ...primary,
      id: "read-only-primary",
      label: "progressive-qa read replica",
      sdmResource: "assured-pgr-qa-read-only",
      key: "assured:read-only-primary",
      resolution: { source: "exact" },
    };
    const result = buildBrowseConnections(catalog({ connections: [primary, dupPrimary] }));
    const matches = result.filter(c => c.sdmResource === "assured-pgr-qa-read-only");
    expect(matches.length).toBe(1);
    expect(matches[0]).toEqual(dupPrimary);
  });

  test("a gap with empty candidates contributes nothing", () => {
    const emptyGap: UnresolvedGap = { ...gap, id: "empty-gap", key: "assured:empty-gap", candidates: [] };
    const result = buildBrowseConnections(catalog({ unresolved: [emptyGap] }));
    expect(result.length).toBe(0);
  });

  test("gap candidate production derives from env === 'prod'", () => {
    const prodGap: UnresolvedGap = { ...gap, id: "prod-gap", key: "assured:prod-gap", env: "prod", candidates: ["assured-prod-thing"] };
    const result = buildBrowseConnections(catalog({ unresolved: [prodGap] }));
    expect(result[0]!.production).toBe(true);
  });

  test("an orphan name present only in catalog.allResources appears as a browse row", () => {
    const result = buildBrowseConnections(
      catalog({ allResources: [{ name: "assured-staging-read-write", connector: "assured" }] }),
    );
    expect(result.length).toBe(1);
    const orphan = result[0]!;
    expect(orphan.label).toBe("staging-read-write");
    expect(orphan.tier).toBe("staging");
    expect(orphan.sdmResource).toBe("assured-staging-read-write");
    expect(orphan.key).toBe("assured:assured-staging-read-write");
    expect(orphan.connector).toBe("assured");
  });

  test("a name already present as a primary or candidate is not duplicated by the allResources pass", () => {
    const result = buildBrowseConnections(
      catalog({
        connections: [primary],
        allResources: [
          { name: "assured-pgr-qa", connector: "assured" },
          { name: "assured-pgr-qa-read-only", connector: "assured" },
        ],
      }),
    );
    // primary + its resolution.candidates variant only; no extra orphan rows.
    expect(result.length).toBe(2);
    expect(result.find(c => c.sdmResource === "assured-pgr-qa")).toEqual(primary);
  });
});
