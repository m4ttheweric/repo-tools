/**
 * lib/repo-index.ts — RT-49: rt.repoRoots settings-seeded repo discovery.
 *
 * Every test re-points HOME to a fresh temp dir (the settings-tests pattern:
 * rt-paths resolves HOME at call time, so tests must never share a tree —
 * repos.json and the settings stores are both process-global state).
 *
 * The 17 tests below correspond 1:1 to the numbered list in
 * docs/superpowers/specs/2026-08-20-rt-reporoots-discovery.md's "Tests"
 * section; each `describe` is headed with that number.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { execSync } from "child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { machineSettingsPath, repoDataDir, rtDir, teamSettingsPath } from "../rt-paths.ts";
import { getSetting } from "../settings/resolve.ts";
import { setSetting } from "../settings/write.ts";
import { closeStateDb, getStateDb, setKvValue } from "../state/index.ts";
import * as stateNs from "../state/index.ts";
import { getKnownRepos, loadRepoIndex, updateRepoIndex, __test__ } from "../repo-index.ts";

const TEAM = "acme";
const REPO_INDEX_NS = "repo-index";

describe("repo-index — rt.repoRoots (RT-49)", () => {
  const origHome = process.env.HOME;
  const origPath = process.env.PATH;
  let home: string;
  let warnSpy: ReturnType<typeof spyOn<Console, "warn">>;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "rt-repoindex-home-"));
    process.env.HOME = home;
    closeStateDb();
    warnSpy = spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    process.env.HOME = origHome;
    process.env.PATH = origPath;
    closeStateDb();
    rmSync(home, { recursive: true, force: true });
  });

  // ─── fixtures ──────────────────────────────────────────────────────────────

  /** A directory with just a `.git` marker — enough for the scanner's
   *  `existsSync(join(path, ".git"))` probe; no real git repo needed. */
  function markerRepo(parent: string, name: string): string {
    const dir = join(parent, name);
    mkdirSync(join(dir, ".git"), { recursive: true });
    return dir;
  }

  /** A marker repo whose `.git/HEAD` names a branch, so the fs-read branch
   *  label (getKnownRepos' single-worktree fast path) resolves without a spawn. */
  function headedMarkerRepo(parent: string, name: string): string {
    const dir = markerRepo(parent, name);
    writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
    return dir;
  }

  /** A real, minimal git repo — used for "already indexed" fixtures so
   *  `git worktree list --porcelain` (the pre-existing, untouched call in
   *  getKnownRepos) resolves cleanly instead of falling into its catch. */
  function realRepo(dir: string): void {
    mkdirSync(dir, { recursive: true });
    execSync("git init -q -b main", { cwd: dir, stdio: "pipe" });
    execSync('git -c user.email=t@t -c user.name=t commit --allow-empty -q -m init', { cwd: dir, stdio: "pipe" });
  }

  /** Registers `repoName` -> `mainPath` directly in the store (bypassing
   *  updateRepoIndex's git-worktree-list spawn, which is off-limits for this
   *  ticket). */
  function indexRepo(repoName: string, mainPath: string): void {
    setKvValue(REPO_INDEX_NS, repoName, mainPath);
  }

  function setRepoRoots(entries: unknown[]): void {
    setSetting("rt.repoRoots", entries, "machine");
  }

  function seedTeam(name: string): void {
    const p = teamSettingsPath(name);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, `// ${name} team store\n{}\n`);
  }

  function writeTeamGlobal(name: string, obj: Record<string, unknown>): void {
    const p = teamSettingsPath(name);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(obj, null, 2));
  }

  function byName(repos: ReturnType<typeof getKnownRepos>, name: string) {
    return repos.find((r) => r.repoName === name);
  }

  /** A fake `git` on PATH that logs every invocation and always answers
   *  "main"/exit 0. Relies on the same explicit `env: process.env` fix
   *  documented on repo-index.ts's `branchOf`. */
  function fakeGit(): { callsLog: string; restore: () => void } {
    const binDir = mkdtempSync(join(tmpdir(), "rt-repoindex-git-bin-"));
    const callsLog = join(binDir, "calls.log");
    writeFileSync(
      join(binDir, "git"),
      `#!/bin/sh\necho "$@" >> "${callsLog}"\necho "main"\nexit 0\n`,
    );
    chmodSync(join(binDir, "git"), 0o755);
    process.env.PATH = `${binDir}:${origPath}`;
    return {
      callsLog,
      restore: () => {
        rmSync(binDir, { recursive: true, force: true });
      },
    };
  }

  function callCount(callsLog: string): number {
    if (!existsSync(callsLog)) return 0;
    return readFileSync(callsLog, "utf8").split("\n").filter((l) => l.trim() !== "").length;
  }

  // ─── 1. Key registry ─────────────────────────────────────────────────────

  describe("1. key registry", () => {
    test("resolves to default [] with no store value", () => {
      const r = getSetting<string[]>("rt.repoRoots");
      expect(r.value).toEqual([]);
      expect(r.provenance).toEqual([{ scope: "default", file: null }]);
    });

    test("a machine-store value resolves with provenance machine", () => {
      setRepoRoots(["/tmp/somewhere"]);
      const r = getSetting<string[]>("rt.repoRoots");
      expect(r.value).toEqual(["/tmp/somewhere"]);
      expect(r.provenance).toEqual([{ scope: "machine", file: machineSettingsPath() }]);
    });

    test("a team-store copy of the key is refused at write time and ignored at read time", () => {
      seedTeam(TEAM);
      expect(() => setSetting("rt.repoRoots", ["/tmp/somewhere"], "team", { team: TEAM })).toThrow();

      // Hand-author it directly (bypassing the write refusal) to prove the
      // READ side independently ignores a team-store value too — the key is
      // machine-only, so a value found in "team" is invalid, not merely
      // unreachable.
      writeTeamGlobal(TEAM, { "rt.repoRoots": ["/tmp/somewhere"] });
      const r = getSetting<string[]>("rt.repoRoots");
      expect(r.value).toEqual([]);
    });
  });

  // ─── 2. Tilde round-trip ─────────────────────────────────────────────────

  describe("2. tilde round-trip", () => {
    test("'~/...' seeded via the real write path is expanded and scanned", () => {
      const parent = join(home, "ghub");
      mkdirSync(parent, { recursive: true });
      const repo = markerRepo(parent, "myrepo");
      setRepoRoots(["~/ghub"]);

      const found = byName(getKnownRepos(), "myrepo");
      expect(found).toBeDefined();
      expect(found?.registered).toBe(false);
      expect(found?.worktrees[0]?.path).toBe(repo);
    });

    test("bare '~' seeded alone is expanded to $HOME itself", () => {
      const repo = markerRepo(home, "homerepo");
      setRepoRoots(["~"]);

      const found = byName(getKnownRepos(), "homerepo");
      expect(found?.worktrees[0]?.path).toBe(repo);
    });

    test("'${home}/...' resolves through the settings resolver's own expansion", () => {
      const parent = join(home, "ghub2");
      mkdirSync(parent, { recursive: true });
      const repo = markerRepo(parent, "myrepo2");
      setRepoRoots(["${home}/ghub2"]);

      const found = byName(getKnownRepos(), "myrepo2");
      expect(found?.worktrees[0]?.path).toBe(repo);
    });
  });

  // ─── 3. Plain candidate one level under a configured root ───────────────

  describe("3. plain candidate", () => {
    test("finds a plain git repo one level under a configured root", () => {
      const root = mkdtempSync(join(tmpdir(), "rt-plain-root-"));
      const repo = markerRepo(root, "plainrepo");
      setRepoRoots([root]);

      const found = byName(getKnownRepos(), "plainrepo");
      expect(found).toBeDefined();
      expect(found?.registered).toBe(false);
      expect(found?.worktrees[0]?.path).toBe(repo);
      rmSync(root, { recursive: true, force: true });
    });
  });

  // ─── 4. Pool grandchildren ────────────────────────────────────────────────

  describe("4. pool grandchildren", () => {
    test("a .git-less parent whose children carry .git yields <pool>/<slot> candidates", () => {
      const root = mkdtempSync(join(tmpdir(), "rt-pool-root-"));
      const poolDir = join(root, "acme-dev");
      mkdirSync(poolDir, { recursive: true });
      const slot1 = markerRepo(poolDir, "on-deck-1");
      const slot2 = markerRepo(poolDir, "on-deck-2");
      setRepoRoots([root]);

      const repos = getKnownRepos();
      const c1 = byName(repos, "acme-dev/on-deck-1");
      const c2 = byName(repos, "acme-dev/on-deck-2");

      expect(c1?.worktrees[0]?.path).toBe(slot1);
      expect(c1?.registered).toBe(false);
      expect(c2?.worktrees[0]?.path).toBe(slot2);
      expect(c2?.registered).toBe(false);
      // The plain pool folder itself must never appear as its own candidate.
      expect(byName(repos, "acme-dev")).toBeUndefined();

      rmSync(root, { recursive: true, force: true });
    });
  });

  // ─── 5. Name collisions across pools ─────────────────────────────────────

  describe("5. name collisions", () => {
    test("two pools with same-named slots yield two distinguishable composite rows", () => {
      const root = mkdtempSync(join(tmpdir(), "rt-pool-collide-root-"));
      const poolA = join(root, "pool-a");
      const poolB = join(root, "pool-b");
      mkdirSync(poolA, { recursive: true });
      mkdirSync(poolB, { recursive: true });
      const slotA = markerRepo(poolA, "on-deck-1");
      const slotB = markerRepo(poolB, "on-deck-1");
      setRepoRoots([root]);

      const repos = getKnownRepos();
      const a = byName(repos, "pool-a/on-deck-1");
      const b = byName(repos, "pool-b/on-deck-1");

      expect(a?.worktrees[0]?.path).toBe(slotA);
      expect(b?.worktrees[0]?.path).toBe(slotB);
      expect(a?.repoName).not.toBe(b?.repoName);

      rmSync(root, { recursive: true, force: true });
    });
  });

  // ─── 6. Root-is-a-repo ────────────────────────────────────────────────────

  describe("6. root-is-a-repo", () => {
    test("a configured root containing .git yields exactly one candidate, none of its children", () => {
      const root = mkdtempSync(join(tmpdir(), "rt-root-is-repo-"));
      mkdirSync(join(root, ".git"));
      mkdirSync(join(root, "submodule-a", ".git"), { recursive: true });
      mkdirSync(join(root, "submodule-b", ".git"), { recursive: true });
      setRepoRoots([root]);

      const repos = getKnownRepos();
      const unregistered = repos.filter((r) => r.registered === false);
      expect(unregistered.length).toBe(1);
      expect(unregistered[0]?.repoName).toBe(root.split("/").pop());
      expect(unregistered[0]?.worktrees[0]?.path).toBe(root);
      expect(byName(repos, "submodule-a")).toBeUndefined();
      expect(byName(repos, "submodule-b")).toBeUndefined();

      rmSync(root, { recursive: true, force: true });
    });

    test("a configured root that IS an already-indexed repo yields nothing", () => {
      // Nested one level under a fresh tmpdir (never a bare mkdtemp result)
      // so `dirname(root)` — the inferred-root computation — stays a small,
      // controlled directory instead of the whole shared system tmpdir.
      const parent = mkdtempSync(join(tmpdir(), "rt-root-is-indexed-"));
      const root = join(parent, "repo");
      realRepo(root);
      indexRepo("already-known", root);
      setRepoRoots([root]);

      const repos = getKnownRepos();
      expect(repos.filter((r) => r.registered === false)).toEqual([]);
      expect(byName(repos, "already-known")).toBeDefined();

      rmSync(parent, { recursive: true, force: true });
    });
  });

  // ─── 7. Duplicate roots ───────────────────────────────────────────────────

  describe("7. duplicate roots", () => {
    test("a configured root equal to an inferred parent, plus a trailing-slash spelling, dedupes to one row", () => {
      const parent = mkdtempSync(join(tmpdir(), "rt-dup-root-"));
      const known = join(parent, "known-repo");
      realRepo(known);
      indexRepo("known-repo", known);

      const sibling = markerRepo(parent, "sibling-repo");
      // configured root == the inferred parent (dirname of known-repo's
      // worktree), authored both bare and with a trailing slash.
      setRepoRoots([parent, `${parent}/`]);

      const repos = getKnownRepos();
      const siblings = repos.filter((r) => r.repoName === "sibling-repo");
      expect(siblings.length).toBe(1);
      expect(siblings[0]?.worktrees[0]?.path).toBe(sibling);

      rmSync(parent, { recursive: true, force: true });
    });
  });

  // ─── 8. Noise immunity ────────────────────────────────────────────────────

  describe("8. noise immunity", () => {
    test("non-git dirs, dotdirs, files, and empty pool-shaped dirs produce nothing", () => {
      const root = mkdtempSync(join(tmpdir(), "rt-noise-root-"));
      mkdirSync(join(root, "plain-dir"));
      mkdirSync(join(root, ".hidden-dir", ".git"), { recursive: true });
      writeFileSync(join(root, "a-file.txt"), "hi");
      mkdirSync(join(root, "empty-pool-shaped", "no-git-here"), { recursive: true });
      setRepoRoots([root]);

      const repos = getKnownRepos();
      const unregistered = repos.filter((r) => r.registered === false);
      expect(unregistered).toEqual([]);

      rmSync(root, { recursive: true, force: true });
    });
  });

  // ─── 9. Dedupe against known repos ───────────────────────────────────────

  describe("9. dedupe", () => {
    test("an indexed repo under a configured root is not duplicated as a candidate", () => {
      const root = mkdtempSync(join(tmpdir(), "rt-dedupe-root-"));
      const known = join(root, "known-repo");
      realRepo(known);
      indexRepo("known-repo", known);
      setRepoRoots([root]);

      const repos = getKnownRepos();
      expect(repos.filter((r) => r.repoName === "known-repo").length).toBe(1);
      expect(byName(repos, "known-repo")?.registered).not.toBe(false);

      rmSync(root, { recursive: true, force: true });
    });

    test("a pool grandchild that is a linked worktree of an indexed repo is not duplicated", () => {
      const root = mkdtempSync(join(tmpdir(), "rt-dedupe-pool-root-"));
      const poolDir = join(root, "acme-dev");
      const mainSlot = join(poolDir, "main");
      realRepo(mainSlot);
      // Simulate a linked worktree: register it as one of the known repo's
      // worktree paths directly (bypassing real `git worktree add`, which
      // this fixture doesn't need — only the dedupe-set membership matters).
      indexRepo("acme-dev", mainSlot);
      const independentSlot = markerRepo(poolDir, "on-deck-1");
      setRepoRoots([root]);

      const repos = getKnownRepos();
      expect(repos.filter((r) => r.repoName === "acme-dev/main").length).toBe(0);
      const indep = byName(repos, "acme-dev/on-deck-1");
      expect(indep?.worktrees[0]?.path).toBe(independentSlot);

      rmSync(root, { recursive: true, force: true });
    });
  });

  // ─── 10. Branch-label cap ─────────────────────────────────────────────────

  describe("10. branch-label cap", () => {
    test("over the cap: no git spawns, every branch blank", () => {
      const { callsLog, restore } = fakeGit();
      try {
        const root = mkdtempSync(join(tmpdir(), "rt-cap-over-root-"));
        for (let i = 0; i < 56; i++) markerRepo(root, `repo-${i}`);
        setRepoRoots([root]);

        const repos = getKnownRepos();
        const unregistered = repos.filter((r) => r.registered === false);
        expect(unregistered.length).toBe(56);
        expect(unregistered.every((r) => r.worktrees[0]?.branch === "")).toBe(true);
        expect(callCount(callsLog)).toBe(0);

        rmSync(root, { recursive: true, force: true });
      } finally {
        restore();
      }
    });

    test("under the cap: branch hints populated from HEAD, no git spawns", () => {
      const { callsLog, restore } = fakeGit();
      try {
        const root = mkdtempSync(join(tmpdir(), "rt-cap-under-root-"));
        for (let i = 0; i < 3; i++) headedMarkerRepo(root, `repo-${i}`);
        setRepoRoots([root]);

        const repos = getKnownRepos();
        const unregistered = repos.filter((r) => r.registered === false);
        expect(unregistered.length).toBe(3);
        expect(unregistered.every((r) => r.worktrees[0]?.branch === "main")).toBe(true);
        // Single-worktree branch labels are read from .git/HEAD, not spawned.
        expect(callCount(callsLog)).toBe(0);

        rmSync(root, { recursive: true, force: true });
      } finally {
        restore();
      }
    });
  });

  // ─── 11. Fail-open ────────────────────────────────────────────────────────

  describe("11. fail-open", () => {
    test("an unexpandable ${repoRoot} entry warns and degrades to inference-only roots, no throw", () => {
      setRepoRoots(["${repoRoot}/whatever"]);
      expect(() => getKnownRepos()).not.toThrow();
      expect(warnSpy).toHaveBeenCalled();
    });

    test("a non-string element and a nonexistent path each warn and are skipped; the rest of the scan is unaffected", () => {
      const root = mkdtempSync(join(tmpdir(), "rt-failopen-root-"));
      const repo = markerRepo(root, "survivor");
      setRepoRoots([42, join(tmpdir(), "rt-does-not-exist-xyz"), root]);

      const repos = getKnownRepos();
      expect(byName(repos, "survivor")?.worktrees[0]?.path).toBe(repo);
      expect(warnSpy.mock.calls.length).toBeGreaterThanOrEqual(2);

      rmSync(root, { recursive: true, force: true });
    });

    test("a realpathSync failure (TOCTOU) on a root falls back to its resolved spelling, no throw", () => {
      const gone = join(tmpdir(), "rt-toctou-gone-xyz");
      // Never created — safeRealpath must not throw for a nonexistent path.
      expect(() => __test__.safeRealpath(gone)).not.toThrow();
      expect(__test__.safeRealpath(gone)).toBe(gone);
    });
  });

  // ─── 12. Determinism ──────────────────────────────────────────────────────

  describe("12. determinism", () => {
    test("a pool folder that is both a configured root's child and an inferred root emits its independent slot exactly once", () => {
      const root = mkdtempSync(join(tmpdir(), "rt-determinism-root-"));
      const poolDir = join(root, "acme-dev");
      const mainSlot = join(poolDir, "main");
      realRepo(mainSlot);
      indexRepo("acme-dev", mainSlot); // pool folder is also an inferred root (dirname of this worktree)
      const independentSlot = markerRepo(poolDir, "on-deck-1");
      setRepoRoots([root]);

      const repos = getKnownRepos();
      const composite = repos.filter((r) => r.repoName === "acme-dev/on-deck-1");
      const flat = repos.filter((r) => r.repoName === "on-deck-1");

      expect(composite.length).toBe(1);
      expect(composite[0]?.worktrees[0]?.path).toBe(independentSlot);
      expect(flat.length).toBe(0); // never emitted under its flat name too

      rmSync(root, { recursive: true, force: true });
    });
  });

  // ─── 13. Disposable cache ─────────────────────────────────────────────────

  describe("13. disposable cache", () => {
    test("a stale on-disk repos.json is ignored — the store is authoritative, nothing crashes", () => {
      const root = mkdtempSync(join(tmpdir(), "rt-cache-root-"));
      const repo = markerRepo(root, "stillhere");
      setRepoRoots([root]);

      // A leftover pre-migration file with different, stale data must never
      // resurface through getKnownRepos()'s default (missing rows excluded).
      const p = join(rtDir(), "repos.json");
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, JSON.stringify({ "stale-repo": "/nonexistent/path" }));

      const repos = getKnownRepos();
      expect(byName(repos, "stillhere")?.worktrees[0]?.path).toBe(repo);
      expect(byName(repos, "stale-repo")).toBeUndefined();
      expect(loadRepoIndex()["stale-repo"]).toBe("/nonexistent/path"); // imported into the store regardless
      // repos.json is the live out-of-process compat mirror gitq reads, NOT
      // a retired legacy file — it must never be renamed away, only kept
      // in sync (unlike every other migrated path in this fix round).
      expect(existsSync(p)).toBe(true);
      expect(existsSync(`${p}.migrated`)).toBe(false);

      rmSync(root, { recursive: true, force: true });
    });

    test("includeMissing: true surfaces that same stale entry, marked missing, instead of dropping it", () => {
      const root = mkdtempSync(join(tmpdir(), "rt-cache-root-"));
      const repo = markerRepo(root, "stillhere");
      setRepoRoots([root]);

      const p = join(rtDir(), "repos.json");
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, JSON.stringify({ "stale-repo": "/nonexistent/path" }));

      const repos = getKnownRepos({ includeMissing: true });
      expect(byName(repos, "stillhere")?.worktrees[0]?.path).toBe(repo);
      expect(byName(repos, "stale-repo")?.missing).toBe(true);
      expect(byName(repos, "stale-repo")?.worktrees[0]?.path).toBe("/nonexistent/path");

      rmSync(root, { recursive: true, force: true });
    });

    test("a pre-migration repos.json is imported on first read, and stays in place (refreshed, never renamed) as the live compat mirror", () => {
      const p = join(rtDir(), "repos.json");
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, JSON.stringify({ "repo-a": "/path/a", "repo-b": "/path/b" }));

      expect(loadRepoIndex()).toEqual({ "repo-a": "/path/a", "repo-b": "/path/b" });
      expect(existsSync(p)).toBe(true);
      expect(existsSync(`${p}.migrated`)).toBe(false);
      expect(JSON.parse(readFileSync(p, "utf8"))).toEqual({ "repo-a": "/path/a", "repo-b": "/path/b" });

      // A second read sees the store directly (namespace non-empty), not a re-import.
      expect(loadRepoIndex()).toEqual({ "repo-a": "/path/a", "repo-b": "/path/b" });
    });

    test("a daemon that only primes the index and never calls updateRepoIndex still leaves repos.json intact for gitq's out-of-process reader", () => {
      const p = join(rtDir(), "repos.json");
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, JSON.stringify({ "repo-a": "/path/a" }));

      // Simulates lib/daemon/repo-index.ts's boot-time prime: a read-only
      // call site that never writes through updateRepoIndex.
      loadRepoIndex();
      loadRepoIndex();

      expect(existsSync(p)).toBe(true);
      expect(JSON.parse(readFileSync(p, "utf8"))).toEqual({ "repo-a": "/path/a" });
    });

    test("corrupt repos.json warns and is left in place, index reads as empty", () => {
      const p = join(rtDir(), "repos.json");
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, "{ not valid json");

      expect(loadRepoIndex()).toEqual({});
      expect(existsSync(p)).toBe(true);
      expect(existsSync(`${p}.migrated`)).toBe(false);
      expect(warnSpy).toHaveBeenCalled();
    });

    test("updateRepoIndex never throws when state.db cannot be opened (e.g. root-owned after sudo)", () => {
      const parent = realpathSync(mkdtempSync(join(tmpdir(), "rt-updateindex-unopenable-")));
      const root = join(parent, "repo");
      realRepo(root);

      // Materialize state.db, then strip all permissions so the next open
      // throws instead of quarantining (quarantine only fires for
      // corruption, not permission errors) — the getRepoIdentity() crash
      // this test guards against.
      getStateDb();
      closeStateDb();
      const dbPath = join(rtDir(), "state.db");
      chmodSync(dbPath, 0o000);

      try {
        expect(() => updateRepoIndex("updated-repo", root)).not.toThrow();
      } finally {
        chmodSync(dbPath, 0o600); // afterEach's rmSync needs read access
      }

      rmSync(parent, { recursive: true, force: true });
    });

    test("getKnownRepos never throws when state.db cannot be opened — degrades to unregistered-scan results", () => {
      const root = mkdtempSync(join(tmpdir(), "rt-getknown-unopenable-"));
      const repo = markerRepo(root, "scannable");
      setRepoRoots([root]);

      getStateDb();
      closeStateDb();
      const dbPath = join(rtDir(), "state.db");
      chmodSync(dbPath, 0o000);

      try {
        let repos: ReturnType<typeof getKnownRepos> = [];
        expect(() => { repos = getKnownRepos(); }).not.toThrow();
        expect(byName(repos, "scannable")?.worktrees[0]?.path).toBe(repo);
      } finally {
        chmodSync(dbPath, 0o600);
      }

      rmSync(root, { recursive: true, force: true });
    });

    test("unset key + empty index = empty result, no crash", () => {
      expect(getKnownRepos()).toEqual([]);
    });

    test("updateRepoIndex round-trips through state.db, and rewrites repos.json as a synced compat mirror", () => {
      const parent = realpathSync(mkdtempSync(join(tmpdir(), "rt-updateindex-")));
      const root = join(parent, "repo");
      realRepo(root);

      const p = join(rtDir(), "repos.json");
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, JSON.stringify({ "stale-repo": "/somewhere" }));

      updateRepoIndex("updated-repo", root);

      // state.db is authoritative: the compat file is fully regenerated from
      // it, not merged with whatever was already on disk.
      expect(loadRepoIndex()["updated-repo"]).toBe(root);
      expect(JSON.parse(readFileSync(p, "utf8"))).toEqual({ "updated-repo": root });

      rmSync(parent, { recursive: true, force: true });
    });

    test("the compat file mirrors every repo-index entry, not just the one just updated", () => {
      const parent = realpathSync(mkdtempSync(join(tmpdir(), "rt-updateindex-multi-")));
      const rootA = join(parent, "repo-a");
      const rootB = join(parent, "repo-b");
      realRepo(rootA);
      realRepo(rootB);

      updateRepoIndex("repo-a", rootA);
      updateRepoIndex("repo-b", rootB);

      const p = join(rtDir(), "repos.json");
      expect(JSON.parse(readFileSync(p, "utf8"))).toEqual({ "repo-a": rootA, "repo-b": rootB });

      rmSync(parent, { recursive: true, force: true });
    });

    test("a repos.json compat-write failure never breaks the state.db write", () => {
      const parent = realpathSync(mkdtempSync(join(tmpdir(), "rt-updateindex-failcompat-")));
      const root = join(parent, "repo");
      realRepo(root);

      // Occupy the compat path with a directory so writeFileSync fails —
      // state.db lives at a different filename in the same rtDir, so its
      // own write is unaffected.
      const p = join(rtDir(), "repos.json");
      mkdirSync(p, { recursive: true });

      expect(() => updateRepoIndex("updated-repo", root)).not.toThrow();
      expect(loadRepoIndex()["updated-repo"]).toBe(root);

      rmSync(parent, { recursive: true, force: true });
    });
  });

  // ─── 14. Symlink-alias dedupe + spelling ─────────────────────────────────

  describe("14. symlink-alias dedupe", () => {
    test("a configured root reached via a symlinked path component does not double-emit; the candidate path keeps the configured spelling", () => {
      const real = mkdtempSync(join(tmpdir(), "rt-symlink-real-"));
      const alias = `${real}-alias`;
      symlinkSync(real, alias);
      const repo = markerRepo(real, "aliased-repo");

      // Configure the SYMLINKED spelling as the root.
      setRepoRoots([alias]);

      const repos = getKnownRepos();
      const found = repos.filter((r) => r.repoName === "aliased-repo");
      expect(found.length).toBe(1);
      // Emitted path begins with the configured (alias) spelling, not the realpath.
      expect(found[0]?.worktrees[0]?.path).toBe(join(alias, "aliased-repo"));
      expect(found[0]?.worktrees[0]?.path.startsWith(alias)).toBe(true);
      void repo;

      rmSync(alias, { force: true });
      rmSync(real, { recursive: true, force: true });
    });
  });

  // ─── 15. Inferred-root immunity ───────────────────────────────────────────

  describe("15. inferred-root immunity", () => {
    test("with no configured roots, a .git parent of an indexed repo is not itself emitted, and siblings still scan", () => {
      // realpathSync: git canonicalizes /var -> /private/var on macOS, and
      // the inferred root here comes from git's own `worktree list` report
      // (dirname of it), so the fixture must agree on the same spelling.
      const parent = realpathSync(mkdtempSync(join(tmpdir(), "rt-inferred-immune-")));
      mkdirSync(join(parent, ".git")); // parent looks like a repo (e.g. dotfiles)
      const known = join(parent, "known-repo");
      realRepo(known);
      indexRepo("known-repo", known);
      const sibling = markerRepo(parent, "sibling-repo");
      // No rt.repoRoots configured at all.

      const repos = getKnownRepos();
      const parentName = parent.split("/").pop() as string;
      expect(byName(repos, parentName)).toBeUndefined();
      expect(byName(repos, "sibling-repo")?.worktrees[0]?.path).toBe(sibling);

      rmSync(parent, { recursive: true, force: true });
    });

    test("a pool slot reachable only via an inferred root emits under its flat <slot> name, no composite", () => {
      const poolDir = realpathSync(mkdtempSync(join(tmpdir(), "rt-inferred-pool-")));
      const mainSlot = join(poolDir, "main");
      realRepo(mainSlot);
      indexRepo("acme-dev", mainSlot); // pool folder becomes an inferred root
      const slot2 = markerRepo(poolDir, "on-deck-1");
      // No rt.repoRoots configured — pool detection must NOT trigger.

      const repos = getKnownRepos();
      expect(byName(repos, "on-deck-1")?.worktrees[0]?.path).toBe(slot2);
      expect(byName(repos, "acme-dev/on-deck-1")).toBeUndefined();

      rmSync(poolDir, { recursive: true, force: true });
    });
  });

  // ─── 16. dataDir isolation ────────────────────────────────────────────────

  describe("16. dataDir isolation", () => {
    test("a pool candidate's dataDir is a sanitized single segment, never nested inside the pool's own data dir", () => {
      const root = mkdtempSync(join(tmpdir(), "rt-datadir-root-"));
      const poolDir = join(root, "acme-dev");
      mkdirSync(poolDir, { recursive: true });
      markerRepo(poolDir, "on-deck-1");
      setRepoRoots([root]);

      const repos = getKnownRepos();
      const candidate = byName(repos, "acme-dev/on-deck-1");
      expect(candidate).toBeDefined();
      expect(candidate?.dataDir).toBe(repoDataDir("acme-dev__on-deck-1"));
      expect(candidate?.dataDir.startsWith(repoDataDir("acme-dev") + "/")).toBe(false);

      // A preset-save-style mkdirSync against it must create nothing under
      // the pool repo's own data dir.
      mkdirSync(candidate!.dataDir, { recursive: true });
      expect(existsSync(join(repoDataDir("acme-dev"), "on-deck-1"))).toBe(false);

      rmSync(root, { recursive: true, force: true });
    });
  });

  // ─── 17. Two-level symlink skip ───────────────────────────────────────────

  describe("17. two-level symlink skip", () => {
    test("a symlinked child under a root, and a symlinked grandchild inside a pool folder, are both invisible", () => {
      const root = mkdtempSync(join(tmpdir(), "rt-symskip-root-"));
      const realChild = markerRepo(join(tmpdir(), "rt-symskip-real-child-" + Date.now()), "realchild");
      symlinkSync(realChild, join(root, "linked-child"));

      const poolDir = join(root, "acme-dev");
      mkdirSync(poolDir, { recursive: true });
      const realGrandchild = markerRepo(join(tmpdir(), "rt-symskip-real-grand-" + Date.now()), "realgrand");
      symlinkSync(realGrandchild, join(poolDir, "linked-slot"));
      // Give the pool folder at least one REAL grandchild so it still
      // qualifies as a pool folder in the first place.
      markerRepo(poolDir, "real-slot");

      setRepoRoots([root]);

      const repos = getKnownRepos();
      expect(byName(repos, "linked-child")).toBeUndefined();
      expect(byName(repos, "acme-dev/linked-slot")).toBeUndefined();
      expect(byName(repos, "acme-dev/real-slot")).toBeDefined();

      rmSync(join(root, "linked-child"), { force: true });
      rmSync(join(poolDir, "linked-slot"), { force: true });
      rmSync(root, { recursive: true, force: true });
      rmSync(realChild, { recursive: true, force: true });
      rmSync(realGrandchild, { recursive: true, force: true });
    });
  });
});

describe("repoOptions labels", () => {
  const { repoOption, repoOptions } = require("../repo-index.ts") as typeof import("../repo-index.ts");

  function known(repoName: string): import("../repo-index.ts").KnownRepo {
    return { repoName, worktrees: [{ path: "/tmp/x", branch: "main", isBare: false }] } as import("../repo-index.ts").KnownRepo;
  }

  test("a serialized identity renders as its last segment, value keeps the wire form", () => {
    const opt = repoOption(known("remote:gitlab.com%2Facme%2Facme-dev"));
    expect(opt.label).toBe("acme-dev");
    expect(opt.value).toBe("remote:gitlab.com%2Facme%2Facme-dev");
  });

  test("a path-kind identity renders as its basename", () => {
    expect(repoOption(known("path:%2FUsers%2Fmatt%2FDocuments%2FGitHub%2Ftraining-plan")).label).toBe("training-plan");
  });

  test("a legacy/unregistered name passes through unchanged", () => {
    expect(repoOption(known("tic-tac-whoa")).label).toBe("tic-tac-whoa");
  });

  test("qualified collisions escalate to the full id", () => {
    const labels = repoOptions([
      known("remote:github.com%2Facme%2Fapp"),
      known("remote:gitlab.com%2Facme%2Fapp"),
      known("path:%2Fa%2Fapp"),
      known("path:%2Fb%2Fapp"),
    ]).map((o) => o.label);
    expect(labels).toEqual(["github.com/acme/app", "gitlab.com/acme/app", "/a/app", "/b/app"]);
  });

  test("colliding last segments upgrade to owner/name; others stay short", () => {
    const labels = repoOptions([
      known("remote:github.com%2Fm4ttstack%2Fglance"),
      known("remote:github.com%2Fm4ttheweric%2Fglance"),
      known("remote:github.com%2Fm4ttstack%2Frt"),
    ]).map((o) => o.label);
    expect(labels).toEqual(["m4ttstack/glance", "m4ttheweric/glance", "rt"]);
  });

  describe("13. updateRepoIndex no-op on unchanged row", () => {
    test("re-registering the same repo at the same path skips the sqlite write", () => {
      const dir = mkdtempSync(join(tmpdir(), "rt-noop-root-"));
      const repo = join(dir, "r");
      mkdirSync(repo, { recursive: true });
      execSync("git init -q -b main", { cwd: repo, stdio: "pipe" });
      execSync('git -c user.email=t@t -c user.name=t commit --allow-empty -q -m init', { cwd: repo, stdio: "pipe" });
      updateRepoIndex("noop-repo", repo); // first registration writes the row + mirror
      const spy = spyOn(stateNs, "setKvValue");
      try {
        updateRepoIndex("noop-repo", repo); // unchanged path: must not write again
        expect(spy).not.toHaveBeenCalled();
      } finally {
        spy.mockRestore();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
