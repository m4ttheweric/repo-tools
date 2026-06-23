/**
 * resolveWorktree unit tests — pure path-prefix matching of a cwd against a
 * known set of repo worktrees. No git, no filesystem.
 */

import { describe, test, expect } from "bun:test";
import { resolveWorktree, type WorktreeInfo } from "../resolve-worktree.ts";

const WORKTREES: WorktreeInfo[] = [
  { repo: "assured", path: "/Users/x/assured/assured-primary", branch: "main" },
  { repo: "assured", path: "/Users/x/assured/assured-wktree-2", branch: "feature/a" },
  { repo: "other", path: "/Users/x/other", branch: "trunk" },
];

describe("resolveWorktree", () => {
  test("returns the worktree when cwd is exactly its path", () => {
    expect(resolveWorktree("/Users/x/assured/assured-primary", WORKTREES))
      .toEqual({ repo: "assured", path: "/Users/x/assured/assured-primary", branch: "main" });
  });

  test("returns the worktree when cwd is a subdirectory of it (monorepo package)", () => {
    expect(resolveWorktree("/Users/x/assured/assured-wktree-2/apps/adjuster", WORKTREES))
      .toEqual({ repo: "assured", path: "/Users/x/assured/assured-wktree-2", branch: "feature/a" });
  });

  test("returns undefined when cwd matches no worktree", () => {
    expect(resolveWorktree("/Users/x/unrelated/project", WORKTREES)).toBeUndefined();
  });

  test("does not match on a non-boundary prefix", () => {
    // "/Users/x/other-thing" must NOT match the "/Users/x/other" worktree.
    expect(resolveWorktree("/Users/x/other-thing", WORKTREES)).toBeUndefined();
  });

  test("longest matching prefix wins when worktrees are nested", () => {
    const nested: WorktreeInfo[] = [
      { repo: "r", path: "/a/b", branch: "outer" },
      { repo: "r", path: "/a/b/c", branch: "inner" },
    ];
    expect(resolveWorktree("/a/b/c/src", nested)?.branch).toBe("inner");
  });
});
