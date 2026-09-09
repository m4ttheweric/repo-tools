/**
 * `rt cd`'s cache seam. `resolveReposForIdentity` re-reads the repo index live
 * only when the cd cache predates the repo you are standing in. Matching the
 * cached rows (serialized identities) against the identity's DISPLAY name
 * never hit, so every `rt cd` invocation paid a full live rescan. The cache
 * was dead weight, not a fast path.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { closeStateDb } from "../../lib/state/index.ts";
import type { KnownRepo } from "../../lib/repo-index.ts";
import { dropGhostWorktrees, resolveReposForIdentity } from "../cd.ts";

const SKILLS_ID = "remote:github.com%2Fm4ttheweric%2Fskills";

function repo(repoName: string, path: string): KnownRepo {
  return { repoName, worktrees: [{ path, branch: "main", isBare: false }], dataDir: `/data/${repoName}` };
}

describe("resolveReposForIdentity", () => {
  const origHome = process.env.HOME;
  const origCwd = process.cwd();
  let home: string;
  let scratch: string;

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "rt-cd-identity-home-")));
    scratch = realpathSync(mkdtempSync(join(tmpdir(), "rt-cd-identity-scratch-")));
    process.env.HOME = home;
    closeStateDb();
    // Off any real repo, so a rescan cannot register a live row and confuse
    // the miss assertion below.
    process.chdir(scratch);
  });

  afterEach(() => {
    process.chdir(origCwd);
    process.env.HOME = origHome;
    closeStateDb();
    rmSync(home, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  });

  test("serves the cached rows when they already carry the resolved identity", () => {
    const cached = [repo(SKILLS_ID, "/repos/matt-skills")];

    const resolved = resolveReposForIdentity(
      { identity: SKILLS_ID, repoRoot: "/repos/matt-skills" },
      cached,
    );

    expect(resolved).toBe(cached);
  });

  test("rescans when the cached rows predate the resolved identity", () => {
    const cached = [repo("remote:github.com%2Fm4ttstack%2Frt", "/repos/repo-tools")];

    const resolved = resolveReposForIdentity(
      { identity: SKILLS_ID, repoRoot: "/repos/matt-skills" },
      cached,
    );

    expect(resolved).not.toBe(cached);
  });

  // Making the cache actually hit exposed this: a row matched by identity can
  // still predate a worktree added since it was written, and serving it hides
  // that worktree from `rt cd --worktree <branch>` and from the picker.
  test("rescans when the cached row predates a worktree added since", () => {
    const cached = [repo(SKILLS_ID, "/repos/matt-skills")];

    const resolved = resolveReposForIdentity(
      { identity: SKILLS_ID, repoRoot: "/trees/brand-new" },
      cached,
    );

    expect(resolved).not.toBe(cached);
  });

  test("serves the cached rows unchanged with no identity to resolve", () => {
    const cached = [repo(SKILLS_ID, "/repos/matt-skills")];

    expect(resolveReposForIdentity(null, cached)).toBe(cached);
  });
});

// The cd-cache is rebuilt on a timer, so a row can carry a worktree disposed
// (trashed) since the last refresh. Rows are validated at pick time; the lead
// worktree stays even when missing so the repo-level missingRepoRefusal path
// still gets its row.
describe("dropGhostWorktrees", () => {
  function multiRepo(paths: string[]): KnownRepo {
    return {
      repoName: "x",
      dataDir: "/data/x",
      worktrees: paths.map((path) => ({ path, branch: "b", isBare: false })),
    };
  }

  test("drops linked worktrees whose path no longer exists", () => {
    const repos = [multiRepo(["/r/main", "/r/gone", "/r/live"])];
    const out = dropGhostWorktrees(repos, (p) => p !== "/r/gone");
    expect(out[0]!.worktrees.map((w) => w.path)).toEqual(["/r/main", "/r/live"]);
  });

  test("keeps the lead worktree even when its path is gone", () => {
    const repos = [multiRepo(["/r/main-gone", "/r/live"])];
    const out = dropGhostWorktrees(repos, (p) => p !== "/r/main-gone");
    expect(out[0]!.worktrees.map((w) => w.path)).toEqual(["/r/main-gone", "/r/live"]);
  });

  test("returns the same array when every path exists", () => {
    const repos = [multiRepo(["/r/main", "/r/live"])];
    expect(dropGhostWorktrees(repos, () => true)).toBe(repos);
  });

  test("drops a linked row inside the trash even when its path exists", () => {
    const repos = [multiRepo(["/r/main", "/pool/x/.trash/alpha-1725000000000", "/r/live"])];
    const out = dropGhostWorktrees(repos, () => true);
    expect(out[0]!.worktrees.map((w) => w.path)).toEqual(["/r/main", "/r/live"]);
  });
});
