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

const gap: UnresolvedGap = {
  id: "gamma-labs",
  label: "Gamma Labs",
  slug: "gamma",
  env: "labs",
  source: "ambiguous",
  candidates: ["assured-gamma-labs", "assured-gamma-labs-2"],
  key: "assured:gamma-labs",
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
  test("resolved connections show sdmResource and resolution.source provenance", () => {
    const lines = formatMap([exactConn, overrideConn], [], []).join("\n");
    expect(lines).toContain("assured-alpha-staging");
    expect(lines).toContain("exact");
    expect(lines).toContain("assured-beta-qa-prod");
    expect(lines).toContain("override");
  });

  test("unresolved gaps appear under a 'Needs mapping' block with candidates", () => {
    const lines = formatMap([], [gap], []).join("\n");
    expect(lines).toContain("Needs mapping");
    expect(lines).toContain("Gamma Labs");
    expect(lines).toContain("assured-gamma-labs");
    expect(lines).toContain("assured-gamma-labs-2");
  });

  test("a gap with a matching suggestion (by key) shows the suggested resource and reasoning", () => {
    const lines = formatMap([], [gap], [suggestion]).join("\n");
    expect(lines).toContain("assured-gamma-labs-2");
    expect(lines).toContain("matches naming pattern for the labs primary");
  });

  test("a gap with no matching suggestion shows no suggestion line", () => {
    const otherSuggestion: SuggestionRecord = { ...suggestion, key: "assured:other-gap" };
    const lines = formatMap([], [gap], [otherSuggestion]);
    expect(lines.some(l => l.includes("suggestion:"))).toBe(false);
  });

  test("no connections and no gaps: still returns Resolved and Needs mapping section headers", () => {
    const lines = formatMap([], [], []).join("\n");
    expect(lines).toContain("Resolved");
    expect(lines).toContain("Needs mapping");
  });
});
