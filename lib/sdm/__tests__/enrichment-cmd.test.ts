import { describe, test, expect } from "bun:test";
import { enrichmentSkeleton } from "../../../commands/sdm.ts";
import { stripJsonc } from "../enrichment.ts";

describe("enrichmentSkeleton", () => {
  test("contains every resource name as a JSON key", () => {
    const names = ["assured-alpha-staging", "assured-beta-qa-prod"];
    const skeleton = enrichmentSkeleton(names);
    for (const name of names) {
      expect(skeleton).toContain(JSON.stringify(name));
    }
  });

  test("parses as valid JSON after stripping JSONC comments", () => {
    const names = ["assured-alpha-staging", "assured-beta-qa-prod"];
    const parsed = JSON.parse(stripJsonc(enrichmentSkeleton(names)));
    expect(Object.keys(parsed)).toEqual(names);
    for (const name of names) {
      expect(parsed[name]).toEqual({ label: "", tier: "" });
    }
  });

  test("empty resource list still produces a valid, parseable object", () => {
    const parsed = JSON.parse(stripJsonc(enrichmentSkeleton([])));
    expect(parsed).toEqual({});
  });
});
