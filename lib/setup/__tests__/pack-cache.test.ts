import { describe, test, expect } from "bun:test";
import { join } from "path";
import { fakeProbes } from "./fakes.ts";
import { parsePluginList, readServedPacks } from "../pack-cache.ts";

const home = "/fake-home";
const clone = join(home, ".mattstack", "teams", "acme");
const marketplacePath = join(clone, ".claude-plugin", "marketplace.json");

describe("parsePluginList", () => {
  test("keeps id, version and enabled", () => {
    const out = JSON.stringify([{ id: "a@m", version: "1.2.0", enabled: true }]);
    expect(parsePluginList(out)).toEqual([{ id: "a@m", version: "1.2.0", enabled: true }]);
  });

  test("a missing string id rejects the WHOLE payload, not just that element", () => {
    const out = JSON.stringify([{ id: "a@m", enabled: true }, { enabled: false }]);
    expect(parsePluginList(out)).toBeNull();
  });

  test("a missing enabled normalizes to false; a missing version to null", () => {
    expect(parsePluginList(JSON.stringify([{ id: "a@m" }]))).toEqual([{ id: "a@m", version: null, enabled: false }]);
  });

  test("unparsable or non-array output is null", () => {
    expect(parsePluginList("not json")).toBeNull();
    expect(parsePluginList(JSON.stringify({ id: "a@m" }))).toBeNull();
  });
});

describe("readServedPacks", () => {
  test("an absent marketplace.json is not an error", () => {
    const p = fakeProbes({ home });
    expect(readServedPacks(p, "acme")).toEqual({ packs: [], error: null });
  });

  test("an unparsable marketplace.json reports an error rather than vanishing", () => {
    const p = fakeProbes({ home, files: { [marketplacePath]: "{ broken" } });
    const result = readServedPacks(p, "acme");
    expect(result.packs).toEqual([]);
    expect(result.error).toContain(marketplacePath);
  });

  test("a string source resolves the served version from the pack's plugin.json", () => {
    const p = fakeProbes({
      home,
      files: {
        [marketplacePath]: JSON.stringify({ name: "acme-market", plugins: [{ name: "acme-skills", source: "./packs/acme-skills" }] }),
        [join(clone, "packs", "acme-skills", ".claude-plugin", "plugin.json")]: JSON.stringify({ version: "0.5.28" }),
      },
    });
    expect(readServedPacks(p, "acme")).toEqual({
      packs: [{ id: "acme-skills@acme-market", name: "acme-skills", servedVersion: "0.5.28" }],
      error: null,
    });
  });

  test("an object-form source is listed with a null served version", () => {
    const p = fakeProbes({
      home,
      files: { [marketplacePath]: JSON.stringify({ name: "acme-market", plugins: [{ name: "remote", source: { source: "github", repo: "o/r" } }] }) },
    });
    expect(readServedPacks(p, "acme")).toEqual({
      packs: [{ id: "remote@acme-market", name: "remote", servedVersion: null }],
      error: null,
    });
  });

  test("a missing or unparsable plugin.json yields a null served version, not a dropped pack", () => {
    const p = fakeProbes({
      home,
      files: { [marketplacePath]: JSON.stringify({ name: "acme-market", plugins: [{ name: "acme-skills", source: "./packs/acme-skills" }] }) },
    });
    expect(readServedPacks(p, "acme").packs).toEqual([{ id: "acme-skills@acme-market", name: "acme-skills", servedVersion: null }]);
  });

  test("the marketplace name falls back to the slug when the file omits it", () => {
    const p = fakeProbes({
      home,
      files: { [marketplacePath]: JSON.stringify({ plugins: [{ name: "p", source: { source: "url" } }] }) },
    });
    expect(readServedPacks(p, "acme").packs[0]!.id).toBe("p@acme");
  });
});
