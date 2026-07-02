import { describe, test, expect, beforeEach, afterEach, afterAll } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { LlmUnavailableError } from "../../llm.ts";
import { suggestForGaps, writeSuggestions, suggestionsPath, type SuggestionRecord } from "../suggest.ts";
import type { UnresolvedGap } from "../connectors.ts";

// Every test gets an isolated HOME so suggestionsPath() (~/.rt/sdm/suggestions.json)
// never touches the real developer machine.
const origHome = process.env.HOME;
let testHome: string;
beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), "rt-sdm-suggest-home-"));
  process.env.HOME = testHome;
});
afterEach(() => {
  process.env.HOME = origHome;
  rmSync(testHome, { recursive: true, force: true });
});
afterAll(() => { process.env.HOME = origHome; });

const acgGap: UnresolvedGap = {
  id: "acg-qa",
  key: "assured:acg-qa",
  connector: "assured",
  label: "ACG QA",
  slug: "acg",
  env: "qa",
  source: "ambiguous",
  candidates: ["assured-acg-qa-prod", "assured-acg-qa-prod-2"],
  url: "https://gitlab.example.com/acg/-/environments/qa",
};

const noCandidatesGap: UnresolvedGap = {
  id: "mystery-dev",
  key: "assured:mystery-dev",
  connector: "assured",
  label: "Mystery Dev",
  slug: "mystery",
  env: "dev",
  source: "none",
  candidates: [],
};

describe("suggestForGaps", () => {
  test("llm returns a real candidate: record carries that resource", async () => {
    const llm = async () => JSON.stringify({ resource: "assured-acg-qa-prod", reasoning: "qa-prod is the RW db" });
    const records = await suggestForGaps([acgGap], { llm });
    expect(records).toEqual([
      { key: "assured:acg-qa", slug: "acg", env: "qa", resource: "assured-acg-qa-prod", reasoning: "qa-prod is the RW db" },
    ]);
  });

  test("llm returns a resource not in candidates: coerced to null (honesty guard)", async () => {
    const llm = async () => JSON.stringify({ resource: "assured-invented-resource", reasoning: "made this up" });
    const records = await suggestForGaps([acgGap], { llm });
    expect(records).toHaveLength(1);
    expect(records[0]!.resource).toBeNull();
    expect(records[0]!.reasoning).toBe("made this up");
  });

  test("llm throws LlmUnavailableError: that gap is skipped, no throw", async () => {
    const llm = async () => { throw new LlmUnavailableError("no model configured"); };
    const records = await suggestForGaps([acgGap], { llm });
    expect(records).toEqual([]);
  });

  test("llm unavailable for every gap: returns []", async () => {
    const llm = async () => { throw new LlmUnavailableError("no model configured"); };
    const records = await suggestForGaps([acgGap, { ...acgGap, id: "acg-staging", key: "assured:acg-staging", env: "staging" }], { llm });
    expect(records).toEqual([]);
  });

  test("gap with no candidates: no llm call, resource null with 'no candidates' reasoning", async () => {
    let called = false;
    const llm = async () => { called = true; return JSON.stringify({ resource: null, reasoning: "n/a" }); };
    const records = await suggestForGaps([noCandidatesGap], { llm });
    expect(called).toBe(false);
    expect(records).toEqual([
      { key: "assured:mystery-dev", slug: "mystery", env: "dev", resource: null, reasoning: "no candidates" },
    ]);
  });

  test("llm reply is malformed JSON: that gap is skipped", async () => {
    const llm = async () => "not json at all";
    const records = await suggestForGaps([acgGap], { llm });
    expect(records).toEqual([]);
  });

  test("llm reply legitimately picks null: record keeps resource null with the model's reasoning", async () => {
    const llm = async () => JSON.stringify({ resource: null, reasoning: "ambiguous, can't tell which is primary" });
    const records = await suggestForGaps([acgGap], { llm });
    expect(records).toEqual([
      { key: "assured:acg-qa", slug: "acg", env: "qa", resource: null, reasoning: "ambiguous, can't tell which is primary" },
    ]);
  });

  test("mixed gaps: one succeeds, one has no candidates, one is skipped on throw", async () => {
    const throwingGap: UnresolvedGap = { ...acgGap, id: "other", key: "assured:other", env: "staging" };
    const llm = async (_system: string, user: string) => {
      if (user.includes("staging")) throw new LlmUnavailableError("down");
      return JSON.stringify({ resource: "assured-acg-qa-prod", reasoning: "primary" });
    };
    const records = await suggestForGaps([acgGap, noCandidatesGap, throwingGap], { llm });
    expect(records).toEqual([
      { key: "assured:acg-qa", slug: "acg", env: "qa", resource: "assured-acg-qa-prod", reasoning: "primary" },
      { key: "assured:mystery-dev", slug: "mystery", env: "dev", resource: null, reasoning: "no candidates" },
    ]);
  });
});

describe("suggestionsPath / writeSuggestions", () => {
  test("suggestionsPath resolves under ~/.rt/sdm/suggestions.json at call-time HOME", () => {
    expect(suggestionsPath()).toBe(join(testHome, ".rt", "sdm", "suggestions.json"));
  });

  test("writeSuggestions writes the records as JSON to suggestionsPath() by default", () => {
    const records: SuggestionRecord[] = [
      { key: "assured:acg-qa", slug: "acg", env: "qa", resource: "assured-acg-qa-prod", reasoning: "primary" },
    ];
    writeSuggestions(records);
    const written = JSON.parse(readFileSync(suggestionsPath(), "utf8"));
    expect(written).toEqual(records);
  });

  test("writeSuggestions honors an explicit path override", () => {
    const p = join(testHome, "custom-suggestions.json");
    const records: SuggestionRecord[] = [];
    writeSuggestions(records, p);
    expect(JSON.parse(readFileSync(p, "utf8"))).toEqual([]);
  });
});
