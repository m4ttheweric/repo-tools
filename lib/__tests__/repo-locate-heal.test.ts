/**
 * The implicit heal must move a repo, not re-point one row of it: the sync
 * seam is reachable from the daemon thread (no sync git there) and cannot
 * await `git worktree repair`, so it declines the write and the async seam
 * performs the whole locate.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execSync } from "child_process";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { closeStateDb, setKvValue } from "../state/index.ts";
import { loadRepoIndex, updateRepoIndex, updateRepoIndexAsync } from "../repo-index.ts";
import { loadRegistry, saveRegistry } from "../worktree/registry.ts";
import { deriveRepoIdentity, serializeIdentity } from "../settings/identity.ts";

describe("move-aware index heal", () => {
  const origHome = process.env.HOME;
  let home: string;
  let scratch: string;

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "rt-heal-home-")));
    scratch = realpathSync(mkdtempSync(join(tmpdir(), "rt-heal-repos-")));
    process.env.HOME = home;
    closeStateDb();
  });

  afterEach(() => {
    process.env.HOME = origHome;
    closeStateDb();
    rmSync(home, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  });

  async function movedRepo(name: string): Promise<{ identity: string; from: string; to: string; tree: string }> {
    const dir = join(scratch, name);
    mkdirSync(dir, { recursive: true });
    execSync("git init -q -b main", { cwd: dir, stdio: "pipe" });
    execSync(`git remote add origin https://gitlab.com/g/${name}.git`, { cwd: dir, stdio: "pipe" });
    execSync("git -c user.email=t@t -c user.name=t commit --allow-empty -q -m init", { cwd: dir, stdio: "pipe" });
    const from = realpathSync(dir);
    const tree = join(from, ".worktrees", "t1");
    execSync(`git worktree add -q -b feat ${tree}`, { cwd: from, stdio: "pipe" });
    const identity = serializeIdentity(await deriveRepoIdentity(from));
    setKvValue("repo-index", identity, from);
    saveRegistry(identity, [
      { name: "main", path: from, kind: "main", branch: "main", createdAt: "2026-01-01T00:00:00.000Z" },
      { name: "t1", path: tree, kind: "ephemeral", state: "on-deck", branch: "feat", createdAt: "2026-01-01T00:00:00.000Z" },
    ]);
    const to = join(scratch, `${name}-moved`);
    renameSync(from, to);
    return { identity, from, to, tree };
  }

  test("the sync seam refuses to re-point a row whose stored path is gone", async () => {
    const { identity, from, to } = await movedRepo("alpha");

    updateRepoIndex(identity, to);

    expect(loadRepoIndex()[identity]).toBe(from);
  });

  test("the sync seam still writes a live path and a brand-new row", async () => {
    const dir = join(scratch, "beta");
    mkdirSync(dir, { recursive: true });
    execSync("git init -q -b main", { cwd: dir, stdio: "pipe" });
    const live = realpathSync(dir);

    updateRepoIndex("beta-key", live);
    expect(loadRepoIndex()["beta-key"]).toBe(live);

    updateRepoIndex("beta-key", live);
    expect(loadRepoIndex()["beta-key"]).toBe(live);
  });

  test("the sync seam overwrites a stored path that still exists — a second clone, not a move", () => {
    const first = join(scratch, "eps-a");
    const second = join(scratch, "eps-b");
    for (const dir of [first, second]) {
      mkdirSync(dir, { recursive: true });
      execSync("git init -q -b main", { cwd: dir, stdio: "pipe" });
    }

    updateRepoIndex("eps-key", realpathSync(first));
    updateRepoIndex("eps-key", realpathSync(second));

    expect(loadRepoIndex()["eps-key"]).toBe(realpathSync(second));
  });

  test("the async seam heals the move as one unit", async () => {
    const { identity, to } = await movedRepo("gamma");

    await updateRepoIndexAsync(identity, to);

    expect(loadRepoIndex()[identity]).toBe(to);
    expect(loadRegistry(identity).map((t) => t.path).sort()).toEqual(
      [to, join(to, ".worktrees", "t1")].sort(),
    );
    expect(loadRegistry(identity).find((t) => t.path === join(to, ".worktrees", "t1"))?.state).toBe("on-deck");
    expect(execSync("git worktree list --porcelain", { cwd: to, encoding: "utf8" })).toContain(join(to, ".worktrees", "t1"));
  });

  test("the async seam is a plain write when nothing moved", async () => {
    const dir = join(scratch, "delta");
    mkdirSync(dir, { recursive: true });
    execSync("git init -q -b main", { cwd: dir, stdio: "pipe" });
    const live = realpathSync(dir);

    await updateRepoIndexAsync("delta-key", live);

    expect(loadRepoIndex()["delta-key"]).toBe(live);
  });
});
