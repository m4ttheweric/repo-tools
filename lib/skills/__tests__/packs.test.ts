import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { pathToFileURL } from "url";
import { detectLayout, discoverPacks } from "../packs.ts";

function writeFile(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function tmp(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

/** A directory marketplace serving two plugins: a flat team pack and a grouped one. */
function makeMarketplaceFixture() {
  const market = tmp("rt-packs-market-");
  const teamPack = join(market, "plugins", "acme");
  const groupedPack = join(market, "plugins", "mattstack");
  const noSurface = join(market, "plugins", "current-time");

  writeFile(join(teamPack, "pack", "surface.jsonc"), `// flat pack\n{ "public": ["work"] }\n`);
  writeFile(join(teamPack, "skills", "work", "SKILL.md"), "---\nname: work\n---\nbody\n");
  writeFile(join(teamPack, "attachments", "qa-gates", "SKILL.md"), "---\nname: qa-gates\n---\nbody\n");

  writeFile(join(groupedPack, "surface.jsonc"), `{ "public": ["subagent-review-loop"] }\n`);
  writeFile(join(groupedPack, "skills", "review", "subagent-review-loop", "SKILL.md"), "---\nname: subagent-review-loop\n---\nbody\n");
  writeFile(join(groupedPack, "attachments", "pipeline", "work", "SKILL.md"), "---\nname: work\n---\nbody\n");

  writeFile(join(noSurface, "skills", "getting-current-time", "SKILL.md"), "---\nname: getting-current-time\n---\nbody\n");

  writeFile(
    join(market, ".claude-plugin", "marketplace.json"),
    JSON.stringify({
      plugins: [
        { name: "acme", source: "./plugins/acme" },
        { name: "mattstack", source: "./plugins/mattstack" },
        { name: "current-time", source: "./plugins/current-time" },
      ],
    }),
  );

  const settingsDir = tmp("rt-packs-settings-");
  const settingsPath = join(settingsDir, "settings.json");
  writeFile(
    settingsPath,
    JSON.stringify({
      extraKnownMarketplaces: {
        local: { source: { source: "directory", path: market } },
        remote: { source: { source: "github", repo: "someone/marketplace" } },
      },
    }),
  );

  return { market, settingsPath, teamPack, groupedPack };
}

describe("discoverPacks", () => {
  test("finds directory-marketplace plugins that carry a surface.jsonc, with layout and surface path", () => {
    const { settingsPath, teamPack, groupedPack } = makeMarketplaceFixture();
    const packs = discoverPacks({ settingsPath });
    expect(packs.map((p) => p.name)).toEqual(["acme", "mattstack"]);

    const acme = packs.find((p) => p.name === "acme")!;
    expect(acme.dir).toBe(teamPack);
    expect(acme.layout).toBe("flat");
    expect(acme.surfacePath).toBe(join(teamPack, "pack", "surface.jsonc"));

    const mattstack = packs.find((p) => p.name === "mattstack")!;
    expect(mattstack.dir).toBe(groupedPack);
    expect(mattstack.layout).toBe("grouped");
    expect(mattstack.surfacePath).toBe(join(groupedPack, "surface.jsonc"));
  });

  test("a plugin without surface.jsonc is not a pack; non-directory marketplaces are ignored", () => {
    const { settingsPath } = makeMarketplaceFixture();
    const names = discoverPacks({ settingsPath }).map((p) => p.name);
    expect(names).not.toContain("current-time");
  });

  test("missing settings file yields no packs rather than throwing; extraPackDirs still count", () => {
    const extra = tmp("rt-packs-extra-");
    writeFile(join(extra, "pack", "surface.jsonc"), `{ "public": [] }\n`);
    const packs = discoverPacks({ settingsPath: join(extra, "nope.json"), extraPackDirs: [{ name: "solo", dir: extra }] });
    expect(packs.map((p) => p.name)).toEqual(["solo"]);
  });
  test("a url source whose url is file:// resolves to that local checkout; other url sources are ignored", () => {
    const checkout = tmp("rt-packs-checkout-");
    writeFile(join(checkout, "surface.jsonc"), `{ "public": ["shepherdr"] }\n`);
    writeFile(join(checkout, "skills", "shepherdr", "SKILL.md"), "---\nname: shepherdr\n---\nbody\n");
    const market = tmp("rt-packs-url-market-");
    writeFile(
      join(market, ".claude-plugin", "marketplace.json"),
      JSON.stringify({
        plugins: [
          { name: "local-clone", source: { source: "url", url: pathToFileURL(checkout).href, ref: "main" } },
          { name: "remote-clone", source: { source: "url", url: "https://github.com/someone/pack.git", ref: "main" } },
        ],
      }),
    );
    const settingsPath = join(tmp("rt-packs-url-settings-"), "settings.json");
    writeFile(settingsPath, JSON.stringify({ extraKnownMarketplaces: { local: { source: { source: "directory", path: market } } } }));

    const packs = discoverPacks({ settingsPath });
    expect(packs.map((p) => p.name)).toEqual(["local-clone"]);
    expect(packs[0]!.dir).toBe(checkout);
  });

  test("a malformed url entry is skipped without hiding the packs listed after it", () => {
    const checkout = tmp("rt-packs-after-bad-");
    writeFile(join(checkout, "surface.jsonc"), `{ "public": [] }\n`);
    const market = tmp("rt-packs-bad-market-");
    writeFile(
      join(market, ".claude-plugin", "marketplace.json"),
      JSON.stringify({
        plugins: [
          { name: "host-url", source: { source: "url", url: "file://somehost/pack" } },
          { name: "non-string-url", source: { source: "url", url: 42 } },
          { name: "good", source: { source: "url", url: pathToFileURL(checkout).href } },
        ],
      }),
    );
    const settingsPath = join(tmp("rt-packs-bad-settings-"), "settings.json");
    writeFile(settingsPath, JSON.stringify({ extraKnownMarketplaces: { local: { source: { source: "directory", path: market } } } }));

    expect(discoverPacks({ settingsPath }).map((p) => p.name)).toEqual(["good"]);
  });
});

describe("detectLayout", () => {
  test("flat when every skill dir carries SKILL.md at depth one", () => {
    const dir = tmp("rt-packs-flat-");
    writeFile(join(dir, "skills", "a", "SKILL.md"), "x");
    writeFile(join(dir, "attachments", "b", "SKILL.md"), "x");
    expect(detectLayout(dir)).toBe("flat");
  });

  test("grouped when a depth-one dir holds SKILL.md-bearing children", () => {
    const dir = tmp("rt-packs-grouped-");
    writeFile(join(dir, "attachments", "forge", "checkout", "SKILL.md"), "x");
    expect(detectLayout(dir)).toBe("grouped");
  });
});
