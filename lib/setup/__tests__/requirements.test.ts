import { describe, test, expect } from "bun:test";
import { fakeProbes } from "./fakes.ts";
import { parseRequirements, readPackRequirements } from "../requirements.ts";

describe("parseRequirements", () => {
  test("parses tools, keeps known integrations, and reports an unknown one", () => {
    const result = parseRequirements(
      "acme",
      '{ "tools":[{"name":"doppler","floor":"3.0.0","why":"secrets","install":{"brew":"dopplerhq/cli/doppler"},"connect":{"integration":"doppler"}}], "integrations":["gitlab","linear","bogus"] }',
    );

    expect(result.pack).toBe("acme");
    expect(result.tools).toEqual([
      { name: "doppler", floor: "3.0.0", why: "secrets", install: { brew: "dopplerhq/cli/doppler" }, connect: { integration: "doppler" } },
    ]);
    expect(result.integrations).toEqual(["gitlab", "linear"]);
    expect(result.error).toContain("bogus");
  });

  test("invalid JSON yields an empty, error-carrying result", () => {
    const result = parseRequirements("broken", "{ not json");
    expect(result).toEqual({ pack: "broken", tools: [], integrations: [], error: expect.stringContaining("invalid JSON") });
  });

  test("strips // and /* */ comments and trailing commas before parsing", () => {
    const result = parseRequirements(
      "acme",
      `{
        // a pack-side note
        "tools": [],
        "integrations": ["github",], /* trailing comma + block comment */
      }`,
    );
    expect(result.integrations).toEqual(["github"]);
    expect(result.error).toBeUndefined();
  });
});

describe("readPackRequirements", () => {
  test("discovers requirements.jsonc under teams/<slug>/**", () => {
    const root = "/fake-home/.mattstack/teams/acme";
    const p = fakeProbes({
      home: "/fake-home",
      dirs: {
        [root]: ["mattstack"],
        [`${root}/mattstack`]: ["packs"],
        [`${root}/mattstack/packs`]: ["acme"],
        [`${root}/mattstack/packs/acme`]: ["requirements.jsonc"],
      },
      files: {
        [`${root}/mattstack/packs/acme/requirements.jsonc`]: '{ "tools":[], "integrations":["github"] }',
      },
    });

    const result = readPackRequirements(p, "acme");
    expect(result).toHaveLength(1);
    expect(result[0]!.pack).toBe("acme");
    expect(result[0]!.integrations).toEqual(["github"]);
  });

  test("returns [] when the team has no packs", () => {
    const p = fakeProbes({ home: "/fake-home" });
    expect(readPackRequirements(p, "acme")).toEqual([]);
  });
});
