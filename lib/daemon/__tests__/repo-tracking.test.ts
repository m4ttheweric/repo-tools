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
  loadRepoTracking, loadMachineRepoTracking, grants, saveRepoTracking, parseCachesArg, CACHE_KINDS,
  primeTeamTrackingIdentityMap, teamNamesIdentity,
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

  test("a typo'd machine entry (rejected by normalizeEntry) still blocks team intent for that name", () => {
    setSetting("rt.repoTracking", { foo: { mode: "sideways", caches: ["branches"] } }, "machine");
    setSetting("mattstack.tracking", {
      repos: { "gitlab.com/acme/foo": { caches: ["branches"] } },
    }, "team", { team: "acme" });

    const t = loadRepoTracking({ identityMap: { "gitlab.com/acme/foo": "foo" } });
    expect(t.foo).toBeUndefined();
  });

  test("an explicit {mode:\"off\"} machine entry opts a team-tracked repo out", () => {
    setSetting("rt.repoTracking", { foo: { mode: "off" } }, "machine");
    setSetting("mattstack.tracking", {
      repos: { "gitlab.com/acme/foo": { caches: ["branches"] } },
    }, "team", { team: "acme" });

    const t = loadRepoTracking({ identityMap: { "gitlab.com/acme/foo": "foo" } });
    expect(t.foo).toBeUndefined();
  });
});

describe("teamNamesIdentity", () => {
  const origHome = process.env.HOME;
  let home: string;

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "rt-tracking-teamnames-")));
    process.env.HOME = home;
    seedTeam();
  });

  afterEach(() => {
    process.env.HOME = origHome;
    rmSync(home, { recursive: true, force: true });
  });

  test("true when mattstack.tracking.repos names the identity, regardless of the value's shape", () => {
    setSetting("mattstack.tracking", {
      repos: { "gitlab.com/acme/foo": { caches: ["branches"] } },
    }, "team", { team: "acme" });

    expect(teamNamesIdentity("gitlab.com/acme/foo")).toBe(true);
  });

  test("false when no mattstack.tracking value is authored at all", () => {
    expect(teamNamesIdentity("gitlab.com/acme/foo")).toBe(false);
  });

  test("false for an identity the team layer never named", () => {
    setSetting("mattstack.tracking", {
      repos: { "gitlab.com/acme/foo": { caches: ["branches"] } },
    }, "team", { team: "acme" });

    expect(teamNamesIdentity("gitlab.com/acme/bar")).toBe(false);
  });
});

describe("loadMachineRepoTracking — the machine-only read (no team merge)", () => {
  const origHome = process.env.HOME;
  let home: string;

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "rt-tracking-machine-only-")));
    process.env.HOME = home;
    seedTeam();
  });

  afterEach(() => {
    process.env.HOME = origHome;
    rmSync(home, { recursive: true, force: true });
  });

  test("never contains team-declared entries, even with a primed map and team intent present", () => {
    setSetting("mattstack.tracking", {
      repos: { "gitlab.com/acme/foo": { caches: ["branches"] } },
    }, "team", { team: "acme" });

    // Sanity: the merged view WOULD show foo if this test used loadRepoTracking.
    const merged = loadRepoTracking({ identityMap: { "gitlab.com/acme/foo": "foo" } });
    expect(merged.foo).toBeDefined();

    expect(loadMachineRepoTracking()).toEqual({});
  });

  test("a read-modify-write through loadMachineRepoTracking + saveRepoTracking never bakes team intent into the machine store", () => {
    setSetting("rt.repoTracking", { existing: { mode: "poll", caches: ["branches"] } }, "machine");
    setSetting("mattstack.tracking", {
      repos: { "gitlab.com/acme/foo": { caches: ["branches", "project-mrs"] } },
    }, "team", { team: "acme" });
    const identityMap = { "gitlab.com/acme/foo": "foo" };

    // Prove the merged view sees "foo" (the state a track/untrack call must NOT capture).
    expect(loadRepoTracking({ identityMap }).foo).toBeDefined();

    // track <existing> live — a read-modify-write exactly like commands/daemon.ts's manageTracking.
    const tracking = loadMachineRepoTracking();
    tracking.existing = { mode: "live", caches: ["branches"] };
    saveRepoTracking(tracking);

    const saved = getSetting<Record<string, unknown>>("rt.repoTracking").value;
    expect(Object.keys(saved)).toEqual(["existing"]);
    expect(saved.foo).toBeUndefined();

    // untrack <existing> off — same primitive, same guarantee.
    const tracking2 = loadMachineRepoTracking();
    delete tracking2.existing;
    saveRepoTracking(tracking2);

    const savedAfterOff = getSetting<Record<string, unknown>>("rt.repoTracking").value;
    expect(savedAfterOff).toEqual({});
  });

  test("the rider: turning a team-tracked repo off writes an explicit {mode:\"off\"} marker, not a delete — and the merge stays off", () => {
    setSetting("rt.repoTracking", { foo: { mode: "live", caches: ["branches"] } }, "machine");
    setSetting("mattstack.tracking", {
      repos: { "gitlab.com/acme/foo": { caches: ["branches"] } },
    }, "team", { team: "acme" });
    const identityMap = { "gitlab.com/acme/foo": "foo" };

    // Sanity: team still declares intent for foo.
    expect(teamNamesIdentity("gitlab.com/acme/foo")).toBe(true);

    // untrack foo off, team-named — the fix: pass it as an offMarker instead
    // of deleting outright.
    const tracking = loadMachineRepoTracking();
    delete tracking.foo;
    saveRepoTracking(tracking, ["foo"]);

    const saved = getSetting<Record<string, unknown>>("rt.repoTracking").value;
    expect(saved.foo).toEqual({ mode: "off" });

    // The merge must NOT resurrect team intent for foo now that the raw
    // machine map names it — this is the bug the rider fixes.
    const merged = loadRepoTracking({ identityMap });
    expect(merged.foo).toBeUndefined();
    expect(grants(merged, "foo").mode).toBe("off");
  });

  test("turning a NON-team-tracked repo off still deletes outright (no marker planted)", () => {
    setSetting("rt.repoTracking", { existing: { mode: "poll", caches: ["branches"] } }, "machine");
    // No mattstack.tracking value at all — teamNamesIdentity is false for any identity.
    expect(teamNamesIdentity("gitlab.com/acme/existing")).toBe(false);

    const tracking = loadMachineRepoTracking();
    delete tracking.existing;
    saveRepoTracking(tracking, []); // no offMarkers — the untracked-by-team path

    const saved = getSetting<Record<string, unknown>>("rt.repoTracking").value;
    expect(saved).toEqual({});
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

  // A no-op prime (one that never populates the map) would make "nope" absent
  // for the right reason but ALSO leave "foo" absent — this only passes if
  // priming a mixed index actually resolves the repo that CAN derive, not
  // just skips the one that can't.
  test("a mixed index: the repo that fails to derive is left out, the one that succeeds is folded in", async () => {
    setSetting("mattstack.tracking", {
      repos: { "gitlab.com/acme/foo": { caches: ["branches"] } },
    }, "team", { team: "acme" });

    const noRemoteDir = mkdtempSync(join(tmpdir(), "rt-tracking-prime-noremote-"));
    await runCapture(["git", "init", "-q"], { cwd: noRemoteDir });
    try {
      await primeTeamTrackingIdentityMap({ nope: noRemoteDir, foo: repoDir });
      expect(Object.keys(loadRepoTracking())).toEqual(["foo"]);
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
