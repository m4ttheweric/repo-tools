/**
 * The locate core: plan a move by identity, then apply index + registry +
 * claim + git-admin rewrites as one unit.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execSync } from "child_process";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { closeStateDb, listEndpointClaims, setKvValue } from "../state/index.ts";
import { loadRepoIndex } from "../repo-index.ts";
import { loadRegistry, saveRegistry, type TreeRecord } from "../worktree/registry.ts";
import { saveClaims } from "../endpoint/store.ts";
import { deriveRepoIdentity, serializeIdentity } from "../settings/identity.ts";
import { applyLocate, findLocateCandidates, isRefusal, planLocate } from "../repo-locate.ts";

describe("repo locate", () => {
  const origHome = process.env.HOME;
  let home: string;
  let scratch: string;

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "rt-locate-home-")));
    scratch = realpathSync(mkdtempSync(join(tmpdir(), "rt-locate-repos-")));
    process.env.HOME = home;
    closeStateDb();
  });

  afterEach(() => {
    process.env.HOME = origHome;
    closeStateDb();
    rmSync(home, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  });

  /** A repo with an origin remote, so its identity is remote-kind and survives the move. */
  function repoWithRemote(name: string): string {
    const dir = join(scratch, name);
    mkdirSync(dir, { recursive: true });
    execSync("git init -q -b main", { cwd: dir, stdio: "pipe" });
    execSync(`git remote add origin https://gitlab.com/g/${name}.git`, { cwd: dir, stdio: "pipe" });
    execSync("git -c user.email=t@t -c user.name=t commit --allow-empty -q -m init", { cwd: dir, stdio: "pipe" });
    return realpathSync(dir);
  }

  function localRepo(name: string): string {
    const dir = join(scratch, name);
    mkdirSync(dir, { recursive: true });
    execSync("git init -q -b main", { cwd: dir, stdio: "pipe" });
    execSync("git -c user.email=t@t -c user.name=t commit --allow-empty -q -m init", { cwd: dir, stdio: "pipe" });
    return realpathSync(dir);
  }

  function rec(over: Partial<TreeRecord> & { path: string }): TreeRecord {
    return { name: "t", kind: "unmanaged", branch: null, createdAt: "2026-01-01T00:00:00.000Z", ...over };
  }

  test("a directory that is not a git repo is refused", async () => {
    const plain = join(scratch, "plain");
    mkdirSync(plain);
    const out = await planLocate({ newPath: plain });
    expect(isRefusal(out) && out.refusal).toBe("not-a-git-repo");
  });

  test("nothing lost in the index is refused", async () => {
    const repo = repoWithRemote("alpha");
    const out = await planLocate({ newPath: repo });
    expect(isRefusal(out) && out.refusal).toBe("nothing-lost");
  });

  test("a derived identity matching no lost row refuses and names both sides", async () => {
    setKvValue("repo-index", "remote:gitlab.com%2Fg%2Fsomething-else", join(scratch, "gone"));
    const repo = repoWithRemote("beta");

    const out = await planLocate({ newPath: repo });

    expect(isRefusal(out) && out.refusal).toBe("identity-mismatch");
    expect(isRefusal(out) && out.message).toContain("remote:gitlab.com%2Fg%2Fbeta");
    expect(isRefusal(out) && out.message).toContain("remote:gitlab.com%2Fg%2Fsomething-else");
  });

  test("a remote-less repo is refused: its identity IS its path, so a move mints a new one", async () => {
    setKvValue("repo-index", `path:${encodeURIComponent(join(scratch, "gone"))}`, join(scratch, "gone"));
    const repo = localRepo("gamma");

    const out = await planLocate({ newPath: repo });

    expect(isRefusal(out) && out.refusal).toBe("identity-changed");
    expect(isRefusal(out) && out.message).toContain("rt repos register");
  });

  test("an old path that still exists is a second clone, not a move", async () => {
    const original = repoWithRemote("delta");
    const clone = join(scratch, "delta-clone");
    execSync(`git clone -q ${original} ${clone}`, { stdio: "pipe" });
    execSync(`git remote set-url origin https://gitlab.com/g/delta.git`, { cwd: clone, stdio: "pipe" });
    setKvValue("repo-index", serializeIdentity(await deriveRepoIdentity(original)), original);

    const out = await planLocate({ newPath: realpathSync(clone) });

    expect(isRefusal(out) && out.refusal).toBe("old-path-exists");
  });

  test("plans the index keys, registry rewrite, claim rewrite and repair paths of a moved repo", async () => {
    const repo = repoWithRemote("epsilon");
    const identity = serializeIdentity(await deriveRepoIdentity(repo));
    const treePath = join(repo, ".worktrees", "t1");
    execSync(`git worktree add -q -b feat ${treePath}`, { cwd: repo, stdio: "pipe" });
    setKvValue("repo-index", identity, repo);
    setKvValue("repo-index", "epsilon-legacy", repo);
    saveRegistry(identity, [rec({ name: "main", path: repo, kind: "main", branch: "main" })]);
    saveRegistry("epsilon-legacy", [rec({ name: "t1", path: treePath, kind: "ephemeral", state: "on-deck", branch: "feat" })]);
    saveClaims(identity, [{ worktree: treePath, role: "web", port: 4001, ts: "2026-01-01T00:00:00.000Z" }]);

    const moved = join(scratch, "epsilon-moved");
    renameSync(repo, moved);

    const plan = await planLocate({ newPath: moved });
    if (isRefusal(plan)) throw new Error(`unexpected refusal: ${plan.message}`);

    expect(plan.identity).toBe(identity);
    expect(plan.oldPath).toBe(repo);
    expect(plan.newPath).toBe(moved);
    expect(plan.indexKeys.sort()).toEqual([identity, "epsilon-legacy"].sort());
    expect(plan.legacyKeys).toEqual(["epsilon-legacy"]);
    expect(plan.gitRepairPaths).toEqual([join(moved, ".worktrees", "t1")]);
    expect(plan.claimRewrites).toEqual([
      { repoKey: identity, worktree: treePath, newWorktree: join(moved, ".worktrees", "t1") },
    ]);
  });

  test("apply re-points the index, merges the pair's registries, rewrites claims and repairs git", async () => {
    const repo = repoWithRemote("zeta");
    const identity = serializeIdentity(await deriveRepoIdentity(repo));
    const treePath = join(repo, ".worktrees", "t1");
    execSync(`git worktree add -q -b feat ${treePath}`, { cwd: repo, stdio: "pipe" });
    setKvValue("repo-index", identity, repo);
    setKvValue("repo-index", "zeta-legacy", repo);
    saveRegistry(identity, [rec({ name: "main", path: repo, kind: "main", branch: "main" })]);
    saveRegistry("zeta-legacy", [rec({ name: "t1", path: treePath, kind: "ephemeral", state: "claimed", owner: "matt", branch: "feat" })]);
    saveClaims(identity, [{ worktree: treePath, role: "web", port: 4001, ts: "2026-01-01T00:00:00.000Z" }]);

    const moved = join(scratch, "zeta-moved");
    renameSync(repo, moved);
    const newTree = join(moved, ".worktrees", "t1");

    const plan = await planLocate({ newPath: moved });
    if (isRefusal(plan)) throw new Error(`unexpected refusal: ${plan.message}`);
    const result = await applyLocate(plan);

    expect(result.ok).toBe(true);
    expect(loadRepoIndex()[identity]).toBe(moved);
    expect(loadRepoIndex()["zeta-legacy"]).toBeUndefined();
    expect(loadRegistry(identity).map((t) => t.path).sort()).toEqual([moved, newTree].sort());
    expect(loadRegistry(identity).find((t) => t.path === newTree)).toMatchObject({ state: "claimed", owner: "matt" });
    expect(listEndpointClaims(identity)[0]?.worktree).toBe(newTree);
    expect(
      execSync("git worktree list --porcelain", { cwd: moved, encoding: "utf8" }),
    ).toContain(newTree);
    expect(result.legacyRows).toEqual([{ key: "zeta-legacy", outcome: "collapsed" }]);
  });

  test("a worktree outside the moved tree keeps its own path", async () => {
    const repo = repoWithRemote("iota");
    const identity = serializeIdentity(await deriveRepoIdentity(repo));
    const inTree = join(repo, ".worktrees", "t1");
    const external = join(scratch, "iota-external");
    execSync(`git worktree add -q -b feat ${inTree}`, { cwd: repo, stdio: "pipe" });
    execSync(`git worktree add -q -b other ${external}`, { cwd: repo, stdio: "pipe" });
    setKvValue("repo-index", identity, repo);
    saveRegistry(identity, [
      rec({ name: "main", path: repo, kind: "main", branch: "main" }),
      rec({ name: "t1", path: inTree, kind: "ephemeral", state: "on-deck", branch: "feat" }),
      rec({ name: "ext", path: external, kind: "ephemeral", state: "claimed", owner: "matt", branch: "other" }),
    ]);

    const moved = join(scratch, "iota-moved");
    renameSync(repo, moved);

    const plan = await planLocate({ newPath: moved });
    if (isRefusal(plan)) throw new Error(`unexpected refusal: ${plan.message}`);
    const result = await applyLocate(plan);

    expect(plan.gitRepairPaths).toEqual([join(moved, ".worktrees", "t1")]);
    expect(result.ok).toBe(true);
    expect(loadRegistry(identity).find((t) => t.name === "ext")).toMatchObject({
      path: external,
      state: "claimed",
      owner: "matt",
    });
  });

  test("a registry record whose tree is gone is reported stale, not a failure", async () => {
    const repo = repoWithRemote("eta");
    const identity = serializeIdentity(await deriveRepoIdentity(repo));
    setKvValue("repo-index", identity, repo);
    saveRegistry(identity, [
      rec({ name: "main", path: repo, kind: "main", branch: "main" }),
      rec({ name: "ghost", path: join(repo, ".worktrees", "ghost"), kind: "ephemeral", state: "on-deck" }),
    ]);

    const moved = join(scratch, "eta-moved");
    renameSync(repo, moved);

    const plan = await planLocate({ newPath: moved });
    if (isRefusal(plan)) throw new Error(`unexpected refusal: ${plan.message}`);
    const result = await applyLocate(plan);

    expect(result.ok).toBe(true);
    expect(result.stalePaths).toEqual([join(moved, ".worktrees", "ghost")]);
    expect(loadRepoIndex()[identity]).toBe(moved);
  });

  test("a failed verification restores the pre-apply rows", async () => {
    const repo = repoWithRemote("theta");
    const identity = serializeIdentity(await deriveRepoIdentity(repo));
    const treePath = join(repo, ".worktrees", "t1");
    execSync(`git worktree add -q -b feat ${treePath}`, { cwd: repo, stdio: "pipe" });
    setKvValue("repo-index", identity, repo);
    saveRegistry(identity, [rec({ name: "main", path: repo, kind: "main", branch: "main" })]);

    const moved = join(scratch, "theta-moved");
    renameSync(repo, moved);

    const plan = await planLocate({ newPath: moved });
    if (isRefusal(plan)) throw new Error(`unexpected refusal: ${plan.message}`);
    // A directory that exists but git will never list: the exact shape a
    // failed `git worktree repair` leaves behind.
    const decoy = join(moved, "decoy");
    mkdirSync(decoy, { recursive: true });
    plan.registryRewrites[0]!.movedPaths.push(decoy);

    const result = await applyLocate(plan);

    expect(result.ok).toBe(false);
    expect(result.restored).toBe(true);
    expect(loadRepoIndex()[identity]).toBe(repo);
    expect(loadRegistry(identity)[0]?.path).toBe(repo);
  });

  test("candidates pair a scanned directory with the lost row it derives", async () => {
    const repo = repoWithRemote("kappa");
    const identity = serializeIdentity(await deriveRepoIdentity(repo));
    setKvValue("repo-index", identity, repo);

    const moved = join(scratch, "kappa-moved");
    renameSync(repo, moved);

    expect(await findLocateCandidates()).toEqual([{ path: moved, identity }]);
  });
});
