import { describe, test, expect, beforeEach } from "bun:test";
import { execSync } from "child_process";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  currentBranchAsync,
  branchExistsLocalAsync,
  isAncestorAsync,
  remoteDefaultRef,
  ensureInfoExclude,
  listWorktreesAsync,
  runGit,
  gitOk,
  statusPorcelainAsync,
  remoteRefExists,
  headSha,
  stashChangesAsync,
  popStashAsync,
  findDesktopStashAsync,
} from "../git-async.ts";

function makeRepo(): string {
  // realpathSync: git canonicalizes /var → /private/var on macOS (Global Constraints)
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "rtgit-")));
  execSync("git init -b main && git -c user.email=t@t -c user.name=t commit --allow-empty -m init", { cwd: dir, shell: "/bin/zsh" });
  return dir;
}

describe("git-async", () => {
  let repo: string;
  beforeEach(() => { repo = makeRepo(); });

  test("currentBranchAsync", async () => expect(await currentBranchAsync(repo)).toBe("main"));

  test("currentBranchAsync returns null when detached", async () => {
    execSync("git checkout --detach HEAD", { cwd: repo, shell: "/bin/zsh" });
    expect(await currentBranchAsync(repo)).toBeNull();
  });

  test("branchExistsLocalAsync", async () => {
    expect(await branchExistsLocalAsync(repo, "main")).toBe(true);
    expect(await branchExistsLocalAsync(repo, "nope")).toBe(false);
  });

  test("isAncestorAsync HEAD of itself", async () => expect(await isAncestorAsync(repo, "HEAD", "HEAD")).toBe(true));

  test("remoteDefaultRef falls back with no remote", async () => expect(await remoteDefaultRef(repo)).toBe("origin/master"));

  test("remoteDefaultRef resolves origin/main on a main-default origin", async () => {
    // bare-clone repo as origin, add + fetch (this fixture shape is reused by Tasks 8/11/12/13)
    const bare = mkdtempSync(join(tmpdir(), "rtgit-bare-"));
    execSync(`git clone --bare ${repo} ${bare}/o.git && git -C ${repo} remote add origin ${bare}/o.git && git -C ${repo} fetch origin`, { shell: "/bin/zsh" });
    expect(await remoteDefaultRef(repo)).toBe("origin/main");
  });

  test("listWorktreesAsync lists main + added tree with branches", async () => {
    execSync(`git -C ${repo} worktree add ${repo}-wt -b side`, { shell: "/bin/zsh" });
    const trees = (await listWorktreesAsync(repo))!;
    expect(trees.length).toBe(2);
    expect(trees[1]).toEqual({ path: `${repo}-wt`, branch: "side", isBare: false });
  });

  test("listWorktreesAsync returns null on a nonzero git exit", async () => {
    const notARepo = mkdtempSync(join(tmpdir(), "rtgit-notrepo-"));
    expect(await listWorktreesAsync(notARepo)).toBeNull();
  });

  test("runGit captures stderr", async () => {
    const r = await runGit(repo, ["checkout", "definitely-not-a-ref"]);
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.length).toBeGreaterThan(0);
  });

  test("ensureInfoExclude appends once", async () => {
    expect(await ensureInfoExclude(repo, ".worktrees/")).toBe(true);
    expect(await ensureInfoExclude(repo, ".worktrees/")).toBe(false);
    const content = readFileSync(join(repo, ".git", "info", "exclude"), "utf8");
    expect(content.match(/\.worktrees\//g)!.length).toBe(1);
  });

  test("gitOk true/false on exit code", async () => {
    expect(await gitOk(repo, ["rev-parse", "HEAD"])).toBe(true);
    expect(await gitOk(repo, ["rev-parse", "no-such-ref"])).toBe(false);
  });

  test("statusPorcelainAsync reflects an untracked file", async () => {
    writeFileSync(join(repo, "untracked.txt"), "hi");
    const status = await statusPorcelainAsync(repo);
    expect(status).toContain("untracked.txt");
  });

  test("remoteRefExists true only after fetch", async () => {
    expect(await remoteRefExists(repo, "main")).toBe(false);
    const bare = mkdtempSync(join(tmpdir(), "rtgit-bare-"));
    execSync(`git clone --bare ${repo} ${bare}/o.git && git -C ${repo} remote add origin ${bare}/o.git && git -C ${repo} fetch origin`, { shell: "/bin/zsh" });
    expect(await remoteRefExists(repo, "main")).toBe(true);
  });

  test("headSha returns the current commit sha", async () => {
    const expected = execSync("git rev-parse HEAD", { cwd: repo, encoding: "utf8" }).trim();
    expect(await headSha(repo)).toBe(expected);
  });

  test("stashChangesAsync / findDesktopStashAsync / popStashAsync round-trip", async () => {
    writeFileSync(join(repo, "tracked.txt"), "v1");
    execSync("git add tracked.txt && git commit -m tracked", { cwd: repo, shell: "/bin/zsh" });
    writeFileSync(join(repo, "tracked.txt"), "v2");

    await stashChangesAsync(repo, "main");
    const status = await statusPorcelainAsync(repo);
    expect(status).toBe("");

    const found = await findDesktopStashAsync(repo, "main");
    expect(found).not.toBeNull();

    await popStashAsync(repo, found!.name);
    const content = readFileSync(join(repo, "tracked.txt"), "utf8");
    expect(content).toBe("v2");
  });

  test("findDesktopStashAsync returns null when no stash exists", async () => {
    expect(await findDesktopStashAsync(repo, "main")).toBeNull();
  });
});
