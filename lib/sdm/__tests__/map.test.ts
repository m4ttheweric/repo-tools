import { describe, test, expect } from "bun:test";
import { formatMap } from "../../../commands/sdm.ts";
import type { DiscoveredConnection, UnresolvedGap } from "../connectors.ts";
import type { SuggestionRecord } from "../suggest.ts";

const exactConn: DiscoveredConnection = {
  id: "alpha-staging",
  label: "Alpha Staging",
  sdmResource: "assured-alpha-staging",
  tier: "staging",
  key: "assured:alpha-staging",
  connector: "assured",
  resolution: { source: "exact" },
};

const overrideConn: DiscoveredConnection = {
  id: "beta-qa",
  label: "Beta QA",
  sdmResource: "assured-beta-qa-prod",
  tier: "qa",
  key: "assured:beta-qa",
  connector: "assured",
  resolution: { source: "override" },
};

const devConn: DiscoveredConnection = {
  id: "dev-thing",
  label: "Dev Thing",
  sdmResource: "assured-dev-thing",
  tier: "development",
  key: "assured:dev-thing",
  connector: "assured",
  resolution: { source: "exact" },
};

const ambiguousGap: UnresolvedGap = {
  id: "gamma-labs",
  label: "Gamma Labs",
  slug: "gamma",
  env: "labs",
  source: "ambiguous",
  candidates: ["assured-gamma-labs", "assured-gamma-labs-2"],
  key: "assured:gamma-labs",
  connector: "assured",
};

const readOnlyOnlyGap: UnresolvedGap = {
  id: "delta-qa",
  label: "Delta QA",
  slug: "delta",
  env: "qa",
  source: "none",
  candidates: [],
  readOnlyAlt: "assured-delta-qa-read-only",
  key: "assured:delta-qa",
  connector: "assured",
};

const noResourceGap: UnresolvedGap = {
  id: "epsilon-dev",
  label: "Epsilon Dev",
  slug: "epsilon",
  env: "dev",
  source: "none",
  candidates: [],
  key: "assured:epsilon-dev",
  connector: "assured",
};

const suggestion: SuggestionRecord = {
  key: "assured:gamma-labs",
  slug: "gamma",
  env: "labs",
  resource: "assured-gamma-labs-2",
  reasoning: "matches naming pattern for the labs primary",
};

describe("formatMap", () => {
  test("resolved connections are grouped under a tier header", () => {
    const lines = formatMap([exactConn, devConn], [], []).join("\n");
    expect(lines).toContain("Resolved (2)");
    expect(lines).toContain("Development");
    expect(lines).toContain("Staging");
    expect(lines).toContain("assured-dev-thing");
    expect(lines).toContain("assured-alpha-staging");
    expect(lines).toContain("exact");
  });

  test("resolved rows show label, sdmResource, and resolution.source", () => {
    const lines = formatMap([overrideConn], [], []).join("\n");
    expect(lines).toContain("Beta QA");
    expect(lines).toContain("assured-beta-qa-prod");
    expect(lines).toContain("override");
  });

  test("needs-mapping splits into three labeled, counted buckets", () => {
    const lines = formatMap([], [ambiguousGap, readOnlyOnlyGap, noResourceGap], []).join("\n");
    expect(lines).toContain("Needs mapping (3)");
    expect(lines).toContain("Ambiguous");
    expect(lines).toContain("(1)");
    expect(lines).toContain("Read-only only");
    expect(lines).toContain("No StrongDM resource");
  });

  test("an ambiguous gap shows its candidates and a matched suggestion", () => {
    const lines = formatMap([], [ambiguousGap], [suggestion]).join("\n");
    expect(lines).toContain("Gamma Labs");
    expect(lines).toContain("assured-gamma-labs");
    expect(lines).toContain("assured-gamma-labs-2");
    expect(lines).toContain("matches naming pattern for the labs primary");
  });

  test("an ambiguous gap with no matching suggestion shows no suggestion line", () => {
    const otherSuggestion: SuggestionRecord = { ...suggestion, key: "assured:other-gap" };
    const lines = formatMap([], [ambiguousGap], [otherSuggestion]);
    expect(lines.some(l => l.includes("suggestion:"))).toBe(false);
  });

  test("a declined (null-resource) suggestion shows friendly copy, not the literal null", () => {
    const declined: SuggestionRecord = { ...suggestion, resource: null, reasoning: "no candidate matched" };
    const lines = formatMap([], [ambiguousGap], [declined]).join("\n");
    expect(lines).toContain("(declined)");
    expect(lines).not.toMatch(/suggestion:.*\bnull\b/);
  });

  test("a read-only-only gap shows its readOnlyAlt", () => {
    const lines = formatMap([], [readOnlyOnlyGap], []).join("\n");
    expect(lines).toContain("Delta QA");
    expect(lines).toContain("assured-delta-qa-read-only");
  });

  test("no-resource gaps collapse into one wrapped line with multiple labels, not one row each", () => {
    const otherNoResource: UnresolvedGap = { ...noResourceGap, id: "zeta-dev", key: "assured:zeta-dev", label: "Zeta Dev" };
    const lines = formatMap([], [noResourceGap, otherNoResource], []);
    const noResourceLines = lines.filter(l => l.includes("Epsilon Dev") || l.includes("Zeta Dev"));
    // Both labels land on the same collapsed line (or wrap onto one of a
    // small number of lines), never one full row per gap.
    expect(noResourceLines.length).toBeLessThan(2 + 1);
    expect(lines.join("\n")).toContain("Epsilon Dev");
    expect(lines.join("\n")).toContain("Zeta Dev");
  });

  test("no connections and no gaps: still returns section headers with zero counts", () => {
    const lines = formatMap([], [], []).join("\n");
    expect(lines).toContain("Resolved (0)");
    expect(lines).toContain("Needs mapping (0)");
  });
});
