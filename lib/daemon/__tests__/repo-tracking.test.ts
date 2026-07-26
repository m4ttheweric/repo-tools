import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  loadRepoTracking, grants, saveRepoTracking, parseCachesArg, CACHE_KINDS,
} from "../../repo-tracking.ts";

function tmpFile(contents?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "rt-tracking-"));
  const p = join(dir, "repo-tracking.json");
  if (contents !== undefined) writeFileSync(p, contents);
  return p;
}

describe("loadRepoTracking", () => {
  test("missing file → empty", () => {
    expect(loadRepoTracking(tmpFile())).toEqual({});
  });

  test("corrupt file → empty", () => {
    expect(loadRepoTracking(tmpFile("{nope"))).toEqual({});
  });

  test("v2 envelope parses; unknown cache names dropped; empty caches drops entry", () => {
    const p = tmpFile(JSON.stringify({
      version: 2,
      repos: {
        a: { mode: "live", caches: ["branches", "project-mrs"] },
        b: { mode: "poll", caches: ["branches", "bogus"] },
        c: { mode: "live", caches: [] },
        d: { mode: "sideways", caches: ["branches"] },
      },
    }));
    const t = loadRepoTracking(p);
    expect(t.a).toEqual({ mode: "live", caches: ["branches", "project-mrs"] });
    expect(t.b).toEqual({ mode: "poll", caches: ["branches"] });
    expect(t.c).toBeUndefined();
    expect(t.d).toBeUndefined();
  });

  test("legacy flat strings migrate to {mode, caches:[branches]}; off/unknown dropped", () => {
    const p = tmpFile(JSON.stringify({ a: "live", b: "poll", c: "off", d: "bogus" }));
    const t = loadRepoTracking(p);
    expect(t.a).toEqual({ mode: "live", caches: ["branches"] });
    expect(t.b).toEqual({ mode: "poll", caches: ["branches"] });
    expect(t.c).toBeUndefined();
    expect(t.d).toBeUndefined();
  });

  test('a repo literally named "version" survives in both shapes', () => {
    const legacy = tmpFile(JSON.stringify({ version: "live", other: "poll" }));
    expect(loadRepoTracking(legacy).version).toEqual({ mode: "live", caches: ["branches"] });
    const v2 = tmpFile(JSON.stringify({
      version: 2,
      repos: { version: { mode: "poll", caches: ["branches"] }!, other: { mode: "live", caches: ["branches"] }! },
    }));
    expect(loadRepoTracking(v2).version).toEqual({ mode: "poll", caches: ["branches"] });
    expect(loadRepoTracking(v2).other).toBeDefined();
  });
});

describe("grants", () => {
  test("unlisted repo → off with empty set", () => {
    const g = grants({}, "nope");
    expect(g.mode).toBe("off");
    expect(g.caches.size).toBe(0);
  });

  test("listed repo → mode + caches as a Set", () => {
    const g = grants({ a: { mode: "live", caches: ["branches", "discussions"] } }, "a");
    expect(g.mode).toBe("live");
    expect(g.caches.has("branches")).toBe(true);
    expect(g.caches.has("discussions")).toBe(true);
    expect(g.caches.has("project-mrs")).toBe(false);
  });
});

describe("saveRepoTracking", () => {
  test("writes v2 envelope, sorted repos; round-trips through loadRepoTracking", () => {
    const p = tmpFile();
    saveRepoTracking({
      zed: { mode: "poll", caches: ["branches"] },
      abc: { mode: "live", caches: ["branches", "project-mrs"] },
    }, p);
    const raw = JSON.parse(require("fs").readFileSync(p, "utf8"));
    expect(raw.version).toBe(2);
    expect(Object.keys(raw.repos)).toEqual(["abc", "zed"]);
    expect(loadRepoTracking(p).abc!.caches).toEqual(["branches", "project-mrs"]);
  });
});

describe("parseCachesArg", () => {
  test("valid lists parse (whitespace tolerated)", () => {
    expect(parseCachesArg("branches")).toEqual(["branches"]);
    expect(parseCachesArg("branches, project-mrs ,discussions")).toEqual(["branches", "project-mrs", "discussions"]);
  });
  test("unknown name or empty → null", () => {
    expect(parseCachesArg("branches,bogus")).toBeNull();
    expect(parseCachesArg("")).toBeNull();
    expect(parseCachesArg(",")).toBeNull();
  });
  test("duplicates collapse", () => {
    expect(parseCachesArg("branches,branches")).toEqual(["branches"]);
  });
});

describe("single parser", () => {
  test("commands/daemon.ts has no local tracking parser", async () => {
    const src = await Bun.file(join(import.meta.dir, "../../../commands/daemon.ts")).text();
    expect(src).not.toContain("function readRepoTracking");
  });
  test("freshness.ts has no local tracking parser", async () => {
    const src = await Bun.file(join(import.meta.dir, "../freshness.ts")).text();
    expect(src).not.toContain("export function loadRepoTracking");
  });
});
