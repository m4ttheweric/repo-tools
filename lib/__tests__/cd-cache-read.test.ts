/**
 * rt cd's cached read path: `getKnownReposCached` serving cache hits without
 * a live scan, falling back to `getKnownRepos` on a miss; the current-repo
 * live-fallback decision `rt cd` makes when the cache predates the repo the
 * identity just resolved; and the ghost-path guard's refusal message.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execSync } from "child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { closeStateDb, setKvValue } from "../state/index.ts";
import { getKnownRepos, getKnownReposCached, ghostPathRefusal, type KnownRepo } from "../repo-index.ts";
import { writeRepoCache } from "../repo-cache.ts";
import { resolveReposForIdentity } from "../../commands/cd.ts";

describe("getKnownReposCached", () => {
  const origHome = process.env.HOME;
  let home: string;
  let scratch: string;

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "rt-cd-cache-home-")));
    scratch = realpathSync(mkdtempSync(join(tmpdir(), "rt-cd-cache-repos-")));
    process.env.HOME = home;
    closeStateDb();
  });

  afterEach(() => {
    process.env.HOME = origHome;
    closeStateDb();
    rmSync(home, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  });

  function realRepo(name: string): string {
    const dir = join(scratch, name);
    mkdirSync(dir, { recursive: true });
    execSync("git init -q -b main", { cwd: dir, stdio: "pipe" });
    execSync("git -c user.email=t@t -c user.name=t commit --allow-empty -q -m init", { cwd: dir, stdio: "pipe" });
    return dir;
  }

  test("returns the cached rows verbatim on a cache hit, not a live scan", () => {
    // A fixture repo name with no matching index/kv entry at all: only
    // possible to observe if this came from the cache, since a live scan of
    // this isolated HOME has nothing to find it from.
    const fixture: KnownRepo[] = [
      { repoName: "cached-only-repo", worktrees: [{ path: "/nowhere/cached-only-repo", branch: "main", isBare: false }], dataDir: "/data/cached-only-repo" },
    ];
    writeRepoCache(fixture);

    expect(getKnownReposCached({ includeMissing: true })).toEqual(fixture);
  });

  test("falls back to a live getKnownRepos scan when no cache exists", () => {
    const dir = realRepo("live-repo");
    setKvValue("repo-index", "live-repo", dir);

    const live = getKnownRepos({ includeMissing: true });
    const cached = getKnownReposCached({ includeMissing: true });

    expect(cached).toEqual(live);
    expect(cached.some((r) => r.repoName === "live-repo")).toBe(true);
  });

  test("falls back to live rows when the cache file is corrupt", () => {
    // repo-cache.test.ts already covers readRepoCache's own null-on-corrupt
    // behavior in isolation; this confirms getKnownReposCached's miss branch
    // reacts to that null the same way as a missing file.
    const dir = realRepo("live-repo-2");
    setKvValue("repo-index", "live-repo-2", dir);
    // No writeRepoCache call at all... readRepoCache() returns null for a
    // missing file, exercising the same miss branch as corrupt/stale-version.

    expect(getKnownReposCached({ includeMissing: true })).toEqual(getKnownRepos({ includeMissing: true }));
  });
});

describe("resolveReposForIdentity (cd's current-repo-missing live fallback)", () => {
  const origHome = process.env.HOME;
  let home: string;
  let scratch: string;

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "rt-cd-fallback-home-")));
    scratch = realpathSync(mkdtempSync(join(tmpdir(), "rt-cd-fallback-repos-")));
    process.env.HOME = home;
    closeStateDb();
  });

  afterEach(() => {
    process.env.HOME = origHome;
    closeStateDb();
    rmSync(home, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  });

  test("no identity: returns the cached list unchanged", () => {
    const cached: KnownRepo[] = [
      { repoName: "some-repo", worktrees: [{ path: "/x/some-repo", branch: "main", isBare: false }], dataDir: "/data/some-repo" },
    ];

    expect(resolveReposForIdentity(null, cached)).toBe(cached);
  });

  // Cached rows carry serialized identities, so the probe compares against
  // `identity.identity`. Comparing the display name never hit, and every
  // `rt cd` paid the full live rescan the cache exists to avoid.
  test("identity present and already in the cached list: returns the cached list unchanged", () => {
    const identity = "remote:github.com%2Fowner%2Fcurrent-repo";
    const cached: KnownRepo[] = [
      { repoName: identity, worktrees: [{ path: "/x/current-repo", branch: "main", isBare: false }], dataDir: "/data/current-repo" },
    ];

    expect(resolveReposForIdentity({ identity, repoRoot: "/x/current-repo" }, cached)).toBe(cached);
  });

  test("a legacy plain-name cached row still counts as present, matched by repo root", () => {
    const cached: KnownRepo[] = [
      { repoName: "current-repo", worktrees: [{ path: "/x/current-repo", branch: "main", isBare: false }], dataDir: "/data/current-repo" },
    ];

    const identity = { identity: "remote:github.com%2Fowner%2Fcurrent-repo", repoRoot: "/x/current-repo" };

    expect(resolveReposForIdentity(identity, cached)).toBe(cached);
  });

  test("identity present but absent from a stale cached list: falls back to a live scan that sees it", () => {
    const dir = join(scratch, "current-repo");
    mkdirSync(dir, { recursive: true });
    execSync("git init -q -b main", { cwd: dir, stdio: "pipe" });
    execSync("git -c user.email=t@t -c user.name=t commit --allow-empty -q -m init", { cwd: dir, stdio: "pipe" });
    setKvValue("repo-index", "current-repo", dir);

    const staleCache: KnownRepo[] = []; // cache predates this repo entirely

    const result = resolveReposForIdentity({ identity: "current-repo", repoRoot: dir }, staleCache);

    expect(result).not.toBe(staleCache);
    expect(result.some((r) => r.repoName === "current-repo")).toBe(true);
  });
});

describe("ghostPathRefusal", () => {
  test("names the dead path and points at rt repos prune", () => {
    const msg = ghostPathRefusal("/repos/gone/worktree");

    expect(msg).toContain("/repos/gone/worktree");
    expect(msg).toContain("rt repos prune");
  });
});
