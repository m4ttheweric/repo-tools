import { describe, test, expect } from "bun:test";
import { fakeProbes } from "./fakes.ts";
import { parseRequirements, readPackRequirements } from "../requirements.ts";

describe("parseRequirements", () => {
  test("parses tools, keeps known integrations, and reports an unknown one", () => {
    const result = parseRequirements(
      "claimview",
      '{ "tools":[{"name":"doppler","floor":"3.0.0","why":"secrets","install":{"brew":"dopplerhq/cli/doppler"},"connect":{"integration":"doppler"}}], "integrations":["gitlab","linear","bogus"] }',
    );

    expect(result.pack).toBe("claimview");
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
      "claimview",
      `{
        // a pack-side note
        "tools": [],
        "integrations": ["github",], /* trailing comma + block comment */
      }`,
    );
    expect(result.integrations).toEqual(["github"]);
    expect(result.error).toBeUndefined();
  });

  test("a tool declaring an unknown connect.integration is kept but the drop is reported, naming the tool", () => {
    const result = parseRequirements("claimview", '{ "tools":[{"name":"widget","why":"builds things","connect":{"integration":"bogus"}}], "integrations":[] }');

    expect(result.tools).toEqual([{ name: "widget", why: "builds things" }]);
    expect(result.error).toContain("widget");
    expect(result.error).toContain("bogus");
  });

  test("a malformed tool entry is skipped and the error names the pack and the tool's index", () => {
    const result = parseRequirements("claimview", '{ "tools":[{"name":"ok","why":"fine"}, {"name":"missing-why"}], "integrations":[] }');

    expect(result.tools).toEqual([{ name: "ok", why: "fine" }]);
    expect(result.error).toContain("claimview");
    expect(result.error).toContain("tools[1]");
  });

  test("connect.verb rejects non-string elements rather than passing them through", () => {
    const result = parseRequirements("claimview", '{ "tools":[{"name":"widget","why":"x","connect":{"verb":[1,2],"label":"Run it"}}], "integrations":[] }');
    expect(result.tools).toEqual([{ name: "widget", why: "x" }]);
  });

  test("connect.verb with all-string elements is kept", () => {
    const result = parseRequirements("claimview", '{ "tools":[{"name":"widget","why":"x","connect":{"verb":["run","it"],"label":"Run it"}}], "integrations":[] }');
    expect(result.tools).toEqual([{ name: "widget", why: "x", connect: { verb: ["run", "it"], label: "Run it" } }]);
  });
});

describe("readPackRequirements", () => {
  test("discovers requirements.jsonc under teams/<slug>/**", () => {
    const root = "/fake-home/.mattstack/teams/claimview";
    const p = fakeProbes({
      home: "/fake-home",
      dirs: {
        [root]: ["mattstack"],
        [`${root}/mattstack`]: ["packs"],
        [`${root}/mattstack/packs`]: ["claimview"],
        [`${root}/mattstack/packs/claimview`]: ["requirements.jsonc"],
      },
      files: {
        [`${root}/mattstack/packs/claimview/requirements.jsonc`]: '{ "tools":[], "integrations":["github"] }',
      },
    });

    const result = readPackRequirements(p, "claimview");
    expect(result).toHaveLength(1);
    expect(result[0]!.pack).toBe("claimview");
    expect(result[0]!.integrations).toEqual(["github"]);
  });

  test("returns [] when the team has no packs", () => {
    const p = fakeProbes({ home: "/fake-home" });
    expect(readPackRequirements(p, "claimview")).toEqual([]);
  });

  test("an unreadable file yields one error entry naming the file, not a silent skip", () => {
    const root = "/fake-home/.mattstack/teams/claimview";
    const p = fakeProbes({
      home: "/fake-home",
      dirs: {
        [root]: ["mattstack"],
        [`${root}/mattstack`]: ["packs"],
        [`${root}/mattstack/packs`]: ["claimview"],
        [`${root}/mattstack/packs/claimview`]: ["requirements.jsonc"],
      },
      // No matching entry in `files` — readFile(path) returns null, simulating a permission error or a broken symlink.
    });

    const result = readPackRequirements(p, "claimview");
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ pack: "claimview", tools: [], integrations: [], error: expect.stringContaining("requirements.jsonc") });
  });

  test("skips .git and node_modules rather than descending into them", () => {
    const root = "/fake-home/.mattstack/teams/claimview";
    const p = fakeProbes({
      home: "/fake-home",
      dirs: {
        [root]: ["mattstack", ".git", "node_modules"],
        [`${root}/mattstack`]: ["packs"],
        [`${root}/mattstack/packs`]: ["claimview"],
        [`${root}/mattstack/packs/claimview`]: ["requirements.jsonc"],
      },
      files: {
        [`${root}/mattstack/packs/claimview/requirements.jsonc`]: '{ "tools":[], "integrations":[] }',
        [`${root}/.git/config`]: "[core]",
        [`${root}/node_modules/pkg/requirements.jsonc`]: '{ "tools":[], "integrations":["github"] }',
      },
    });

    const result = readPackRequirements(p, "claimview");
    expect(result).toHaveLength(1);
    expect(result[0]!.pack).toBe("claimview");
  });

  test("sorts and dedupes discovered packs by name", () => {
    const root = "/fake-home/.mattstack/teams/claimview";
    const p = fakeProbes({
      home: "/fake-home",
      dirs: {
        [root]: ["mattstack"],
        [`${root}/mattstack`]: ["packs", "packs2"],
        [`${root}/mattstack/packs`]: ["zeta", "alpha"],
        [`${root}/mattstack/packs/zeta`]: ["requirements.jsonc"],
        [`${root}/mattstack/packs/alpha`]: ["requirements.jsonc"],
        [`${root}/mattstack/packs2`]: ["alpha"],
        [`${root}/mattstack/packs2/alpha`]: ["requirements.jsonc"],
      },
      files: {
        [`${root}/mattstack/packs/zeta/requirements.jsonc`]: '{ "tools":[], "integrations":[] }',
        [`${root}/mattstack/packs/alpha/requirements.jsonc`]: '{ "tools":[], "integrations":["github"] }',
        [`${root}/mattstack/packs2/alpha/requirements.jsonc`]: '{ "tools":[], "integrations":["gitlab"] }',
      },
    });

    const result = readPackRequirements(p, "claimview");
    expect(result.map((r) => r.pack)).toEqual(["alpha", "zeta"]);
    // First discovery wins on a name collision — packs/alpha, not packs2/alpha.
    expect(result[0]!.integrations).toEqual(["github"]);
  });
});
