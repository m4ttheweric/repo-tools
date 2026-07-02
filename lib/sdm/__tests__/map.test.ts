import { describe, test, expect } from "bun:test";
import { formatMap } from "../../../commands/sdm.ts";
import type { DiscoveredConnection, UnresolvedGap } from "../connectors.ts";
import type { SuggestionRecord } from "../suggest.ts";

const exactConn: DiscoveredConnection = {
  id: "alpha-staging",
  label: "Alpha Staging",
  sdmResource: "acme-alpha-staging",
  tier: "staging",
  key: "acme:alpha-staging",
  connector: "acme",
  resolution: { source: "exact" },
};

const overrideConn: DiscoveredConnection = {
  id: "beta-qa",
  label: "Beta QA",
  sdmResource: "acme-beta-qa-prod",
  tier: "qa",
  key: "acme:beta-qa",
  connector: "acme",
  resolution: { source: "override" },
};

const gap: UnresolvedGap = {
  id: "gamma-labs",
  label: "Gamma Labs",
  slug: "gamma",
  env: "labs",
  source: "ambiguous",
  candidates: ["acme-gamma-labs", "acme-gamma-labs-2"],
  key: "acme:gamma-labs",
  connector: "acme",
};

const suggestion: SuggestionRecord = {
  key: "acme:gamma-labs",
  slug: "gamma",
  env: "labs",
  resource: "acme-gamma-labs-2",
  reasoning: "matches naming pattern for the labs primary",
};

describe("formatMap", () => {
  test("resolved connections show sdmResource and resolution.source provenance", () => {
    const lines = formatMap([exactConn, overrideConn], [], []).join("\n");
    expect(lines).toContain("acme-alpha-staging");
    expect(lines).toContain("exact");
    expect(lines).toContain("acme-beta-qa-prod");
    expect(lines).toContain("override");
  });

  test("unresolved gaps appear under a 'Needs mapping' block with candidates", () => {
    const lines = formatMap([], [gap], []).join("\n");
    expect(lines).toContain("Needs mapping");
    expect(lines).toContain("Gamma Labs");
    expect(lines).toContain("acme-gamma-labs");
    expect(lines).toContain("acme-gamma-labs-2");
  });

  test("a gap with a matching suggestion (by key) shows the suggested resource and reasoning", () => {
    const lines = formatMap([], [gap], [suggestion]).join("\n");
    expect(lines).toContain("acme-gamma-labs-2");
    expect(lines).toContain("matches naming pattern for the labs primary");
  });

  test("a gap with no matching suggestion shows no suggestion line", () => {
    const otherSuggestion: SuggestionRecord = { ...suggestion, key: "acme:other-gap" };
    const lines = formatMap([], [gap], [otherSuggestion]);
    expect(lines.some(l => l.includes("suggestion:"))).toBe(false);
  });

  test("no connections and no gaps: still returns Resolved and Needs mapping section headers", () => {
    const lines = formatMap([], [], []).join("\n");
    expect(lines).toContain("Resolved");
    expect(lines).toContain("Needs mapping");
  });
});
