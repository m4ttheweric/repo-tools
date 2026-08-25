import { describe, expect, test, afterEach, beforeEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { execSync } from "child_process";

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
});
