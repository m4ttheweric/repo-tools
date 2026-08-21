import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { machineSettingsPath, teamSettingsPath } from "../../rt-paths.ts";
import { getSetting } from "../../settings/resolve.ts";
import { setSetting } from "../../settings/write.ts";
import { runCapture } from "../../subprocess.ts";
import { clearIdentityMemo } from "../../settings/identity.ts";
import {
  loadRepoTracking, grants, saveRepoTracking, parseCachesArg, CACHE_KINDS,
  primeTeamTrackingIdentityMap,
} from "../../repo-tracking.ts";

function writeStore(file: string, obj: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(obj, null, 2));
}

/** setSetting("mattstack.tracking", ..., "team") refuses without a local team store. */
function seedTeam(): void {
  const path = teamSettingsPath("acme");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "// team store\n{}\n");
}

describe("loadRepoTracking through the settings resolver", () => {
  const origHome = process.env.HOME;
  let home: string;

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "rt-tracking-")));
    process.env.HOME = home;
  });

  afterEach(() => {
    process.env.HOME = origHome;
    rmSync(home, { recursive: true, force: true });
  });

  test("empty store → empty (nothing tracked)", () => {
    expect(loadRepoTracking()).toEqual({});
  });

  test("a malformed stored value degrades to empty", () => {
    writeStore(machineSettingsPath(), { "rt.repoTracking": ["not", "an", "object"] });
    expect(loadRepoTracking()).toEqual({});
  });

  test("a store-seeded v2-shaped entry resolves; unknown cache names dropped; empty caches drops entry", () => {
    setSetting("rt.repoTracking", {
      a: { mode: "live", caches: ["branches", "project-mrs"] },
      b: { mode: "poll", caches: ["branches", "bogus"] },
      c: { mode: "live", caches: [] },
      d: { mode: "sideways", caches: ["branches"] },
    }, "machine");

    const t = loadRepoTracking();
    expect(t.a).toEqual({ mode: "live", caches: ["branches", "project-mrs"] });
    expect(t.b).toEqual({ mode: "poll", caches: ["branches"] });
    expect(t.c).toBeUndefined();
    expect(t.d).toBeUndefined();
  });

  test("legacy flat strings migrate to {mode, caches:[branches]}; off/unknown dropped", () => {
    writeStore(machineSettingsPath(), { "rt.repoTracking": { a: "live", b: "poll", c: "off", d: "bogus" } });

    const t = loadRepoTracking();
    expect(t.a).toEqual({ mode: "live", caches: ["branches"] });
    expect(t.b).toEqual({ mode: "poll", caches: ["branches"] });
    expect(t.c).toBeUndefined();
    expect(t.d).toBeUndefined();
  });

  test("invalid projectMrsWindowDays values are dropped, entry survives", () => {
    setSetting("rt.repoTracking", {
      a: { mode: "live", caches: ["branches"], projectMrsWindowDays: -5 },
      b: { mode: "live", caches: ["branches"], projectMrsWindowDays: "soon" },
    }, "machine");

    const t = loadRepoTracking();
    expect(t.a).toBeDefined(); expect(t.a?.projectMrsWindowDays).toBeUndefined();
    expect(t.b).toBeDefined(); expect(t.b?.projectMrsWindowDays).toBeUndefined();
  });

  test("an unexpandable ${repoRoot} in a stored value degrades to empty instead of throwing", () => {
    setSetting("rt.repoTracking", { a: { mode: "${repoRoot}", caches: ["branches"] } }, "machine");

    expect(() => loadRepoTracking()).not.toThrow();
    expect(loadRepoTracking()).toEqual({});
  });

  test("a versioned {version, repos} envelope warns loudly and auto-unwraps to the inner repos map", () => {
    writeStore(machineSettingsPath(), {
      "rt.repoTracking": { version: 2, repos: { a: { mode: "live", caches: ["branches"] } } },
    });

    const warnings: string[] = [];
    const orig = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
    let t: ReturnType<typeof loadRepoTracking>;
    try {
      t = loadRepoTracking();
    } finally {
      console.warn = orig;
    }

    expect(t.a).toEqual({ mode: "live", caches: ["branches"] });
    expect(warnings.some((w) => w.includes("store the repos map, not the versioned envelope"))).toBe(true);
  });
});

describe("loadRepoTracking merges mattstack.tracking team intent", () => {
  const origHome = process.env.HOME;
  let home: string;

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "rt-tracking-team-")));
    process.env.HOME = home;
    seedTeam();
  });

  afterEach(() => {
    process.env.HOME = origHome;
    rmSync(home, { recursive: true, force: true });
  });

  test("team intent for a cloned repo folds in as {mode: live, caches}", () => {
    setSetting("mattstack.tracking", {
      repos: { "gitlab.com/acme/foo": { caches: ["branches", "project-mrs"] } },
    }, "team", { team: "acme" });

    const t = loadRepoTracking({ identityMap: { "gitlab.com/acme/foo": "foo" } });
    expect(t.foo).toEqual({ mode: "live", caches: ["branches", "project-mrs"] });
  });

  test("a machine grant for the same repo name wins the whole entry, team ignored", () => {
    setSetting("rt.repoTracking", { foo: { mode: "poll", caches: ["branches"] } }, "machine");
    setSetting("mattstack.tracking", {
      repos: { "gitlab.com/acme/foo": { caches: ["discussions"] } },
    }, "team", { team: "acme" });

    const t = loadRepoTracking({ identityMap: { "gitlab.com/acme/foo": "foo" } });
    expect(t.foo).toEqual({ mode: "poll", caches: ["branches"] });
  });

  test("an identity with no local resolution is silently dropped", () => {
    setSetting("mattstack.tracking", {
      repos: { "gitlab.com/acme/not-cloned": { caches: ["branches"] } },
    }, "team", { team: "acme" });

    const t = loadRepoTracking({ identityMap: { "gitlab.com/acme/foo": "foo" } });
    expect(t).toEqual({});
  });

  test("no mattstack.tracking value authored → unchanged from machine-only behavior", () => {
    setSetting("rt.repoTracking", { foo: { mode: "live", caches: ["branches"] } }, "machine");

    const withoutMap = loadRepoTracking();
    const withMap = loadRepoTracking({ identityMap: { "gitlab.com/acme/foo": "foo" } });
    expect(withoutMap).toEqual({ foo: { mode: "live", caches: ["branches"] } });
    expect(withMap).toEqual(withoutMap);
  });

  test("an unresolvable mattstack.tracking value degrades to machine-only, warning once", () => {
    setSetting("rt.repoTracking", { foo: { mode: "live", caches: ["branches"] } }, "machine");
    setSetting("mattstack.tracking", {
      repos: { "gitlab.com/acme/bar": { caches: ["${repoRoot}"] } },
    }, "team", { team: "acme" });

    const warnings: string[] = [];
    const orig = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };
    let t: ReturnType<typeof loadRepoTracking>;
    try {
      t = loadRepoTracking({ identityMap: { "gitlab.com/acme/bar": "bar" } });
    } finally {
      console.warn = orig;
    }

    expect(t).toEqual({ foo: { mode: "live", caches: ["branches"] } });
    expect(warnings.some((w) => w.includes("mattstack.tracking could not be resolved"))).toBe(true);
  });

  test("unknown cache names are dropped from team intent; an empty result drops the entry", () => {
    setSetting("mattstack.tracking", {
      repos: {
        "gitlab.com/acme/foo": { caches: ["branches", "bogus"] },
        "gitlab.com/acme/baz": { caches: ["bogus"] },
      },
    }, "team", { team: "acme" });

    const t = loadRepoTracking({
      identityMap: { "gitlab.com/acme/foo": "foo", "gitlab.com/acme/baz": "baz" },
    });
    expect(t.foo).toEqual({ mode: "live", caches: ["branches"] });
    expect(t.baz).toBeUndefined();
  });
});

describe("primeTeamTrackingIdentityMap", () => {
  const origHome = process.env.HOME;
  let home: string;
  let repoDir: string;

  beforeEach(async () => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "rt-tracking-prime-")));
    process.env.HOME = home;
    seedTeam();
    clearIdentityMemo();

    repoDir = mkdtempSync(join(tmpdir(), "rt-tracking-prime-repo-"));
    await runCapture(["git", "init", "-q"], { cwd: repoDir });
    await runCapture(["git", "remote", "add", "origin", "https://gitlab.com/acme/foo.git"], { cwd: repoDir });
  });

  afterEach(async () => {
    process.env.HOME = origHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(repoDir, { recursive: true, force: true });
    clearIdentityMemo();
    // Reset the module-level primed map so later tests in this file that rely
    // on the default (unprimed) seam are not affected by this real prime.
    await primeTeamTrackingIdentityMap({});
  });

  test("primes the identity map from a repo index, and the default seam picks it up", async () => {
    setSetting("mattstack.tracking", {
      repos: { "gitlab.com/acme/foo": { caches: ["branches"] } },
    }, "team", { team: "acme" });

    await primeTeamTrackingIdentityMap({ foo: repoDir });

    expect(loadRepoTracking().foo).toEqual({ mode: "live", caches: ["branches"] });
  });

  test("a repo whose identity fails to derive is left out of the primed map", async () => {
    const noRemoteDir = mkdtempSync(join(tmpdir(), "rt-tracking-prime-noremote-"));
    await runCapture(["git", "init", "-q"], { cwd: noRemoteDir });
    try {
      await primeTeamTrackingIdentityMap({ nope: noRemoteDir });
      expect(loadRepoTracking()).toEqual({});
    } finally {
      rmSync(noRemoteDir, { recursive: true, force: true });
    }
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

  test("grants resolves window default 30 and explicit value", () => {
    expect(grants({ r: { mode: "live", caches: ["project-mrs"] } }, "r").projectMrsWindowDays).toBe(30);
    expect(grants({ r: { mode: "live", caches: ["project-mrs"], projectMrsWindowDays: 90 } }, "r").projectMrsWindowDays).toBe(90);
    expect(grants({}, "missing").projectMrsWindowDays).toBe(30);
  });
});

describe("saveRepoTracking through the settings resolver", () => {
  const origHome = process.env.HOME;
  let home: string;

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "rt-tracking-save-")));
    process.env.HOME = home;
  });

  afterEach(() => {
    process.env.HOME = origHome;
    rmSync(home, { recursive: true, force: true });
  });

  test("writes to the machine store, repos sorted; round-trips through loadRepoTracking", () => {
    saveRepoTracking({
      zed: { mode: "poll", caches: ["branches"] },
      abc: { mode: "live", caches: ["branches", "project-mrs"] },
    });

    const stored = getSetting<Record<string, unknown>>("rt.repoTracking").value;
    expect(Object.keys(stored)).toEqual(["abc", "zed"]);
    expect(loadRepoTracking().abc!.caches).toEqual(["branches", "project-mrs"]);

    const raw = JSON.parse(readFileSync(machineSettingsPath(), "utf8").replace(/^\/\/.*\n/, ""));
    expect(Object.keys(raw["rt.repoTracking"])).toEqual(["abc", "zed"]);
  });

  test("projectMrsWindowDays round-trips through save/load", () => {
    saveRepoTracking({ repo: { mode: "live", caches: ["project-mrs"], projectMrsWindowDays: 60 } });
    expect(loadRepoTracking().repo?.projectMrsWindowDays).toBe(60);
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
