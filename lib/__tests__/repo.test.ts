import { describe, expect, test, afterEach, beforeEach, spyOn } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { execSync } from "child_process";
import * as cp from "child_process";

describe("getRepoIdentity identity field", () => {
  let scratch: string;
  const origHome = process.env.HOME;
  beforeEach(() => { scratch = mkdtempSync(join(tmpdir(), "rt-repo-")); process.env.HOME = scratch; });
  afterEach(() => { process.env.HOME = origHome; rmSync(scratch, { recursive: true, force: true }); });

  test("a remote repo's identity is the serialized remote id, and dataDir derives from it", async () => {
    const repo = join(scratch, "work");
    mkdirSync(repo);
    execSync("git init -q -b main", { cwd: repo, stdio: "pipe" });
    execSync("git remote add origin git@gitlab.com:group/repo.git", { cwd: repo, stdio: "pipe" });
    const { getRepoIdentityForRoot } = await import("../repo.ts");
    const id = await getRepoIdentityForRoot(repo);
    expect(id!.identity).toBe("remote:gitlab.com%2Fgroup%2Frepo");
    // dataDir is keyed by the serialized identity — a LITERAL colon delimiter
    // (the codec encodes only the id, not the "<kind>:" prefix), legal on APFS.
    expect(id!.dataDir).toContain("remote:gitlab.com%2Fgroup%2Frepo");
  });

  test("reads the origin URL once: identity, name, and URLs share a single git spawn", async () => {
    const repo = join(scratch, "work");
    mkdirSync(repo);
    execSync("git init -q -b main", { cwd: repo, stdio: "pipe" }); // real .git for the single-worktree fs check

    // Intercept every git spawn so we can count origin-URL reads deterministically
    // (getRemoteUrlForRoot/readOriginRemoteForIdentity do not pass env, so a
    // PATH-based fake would not be picked up under bun).
    const spy = spyOn(cp, "execSync").mockImplementation(((command: string) => {
      if (command.includes("config --get remote.origin.url")) return "git@gitlab.com:group/repo.git\n";
      if (command.includes("rev-parse --show-toplevel")) return `${repo}\n`;
      if (command.includes("worktree list")) return `worktree ${repo}\n`;
      return "\n";
    }) as unknown as typeof cp.execSync);
    try {
      const { getRepoIdentityForRoot } = await import("../repo.ts");
      const id = await getRepoIdentityForRoot(repo);
      expect(id!.identity).toBe("remote:gitlab.com%2Fgroup%2Frepo");
      expect(id!.repoName).toBe("repo");
      const cmds = spy.mock.calls.map((c) => String(c[0]));
      // Never `git remote get-url origin`, and the origin URL read exactly once.
      expect(cmds.some((c) => c.includes("remote get-url"))).toBe(false);
      expect(cmds.filter((c) => c.includes("remote.origin.url")).length).toBe(1);
    } finally {
      spy.mockRestore();
    }
  });
});
