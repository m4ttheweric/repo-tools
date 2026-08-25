/**
 * The whole story against real state: a repo with a linked worktree under
 * `.worktrees/`, an ephemeral on-deck record, and a live endpoint claim, moved
 * on disk and then located. The assertion that matters most is the last one —
 * a reconcile pass over the located repo must prune nothing.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execSync } from "child_process";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { Logger } from "pino";
import { closeStateDb, listEndpointClaims, setKvValue } from "../state/index.ts";
import { loadRepoIndex, pruneRepoIndex } from "../repo-index.ts";
import { loadRegistry, saveRegistry } from "../worktree/registry.ts";
import { saveClaims } from "../endpoint/store.ts";
import { deriveRepoIdentity, serializeIdentity } from "../settings/identity.ts";
import { applyLocate, isRefusal, planLocate } from "../repo-locate.ts";
import { reconcileRepoRegistry } from "../daemon/worktree-reconciler.ts";

const silentLog = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as unknown as Logger;

describe("repo locate — real state", () => {
  const origHome = process.env.HOME;
  let home: string;
  let scratch: string;

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "rt-locate-e2e-home-")));
    scratch = realpathSync(mkdtempSync(join(tmpdir(), "rt-locate-e2e-repos-")));
    process.env.HOME = home;
    closeStateDb();
  });

  afterEach(() => {
    process.env.HOME = origHome;
    closeStateDb();
    rmSync(home, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  });

  test("a moved repo with a claimed pool survives locate intact", async () => {
    // ── a throwaway repo with a linked worktree under .worktrees/
    const dir = join(scratch, "acme-dev");
    mkdirSync(dir, { recursive: true });
    execSync("git init -q -b main", { cwd: dir, stdio: "pipe" });
    execSync("git remote add origin https://gitlab.com/acme/acme-dev.git", { cwd: dir, stdio: "pipe" });
    execSync("git -c user.email=t@t -c user.name=t commit --allow-empty -q -m init", { cwd: dir, stdio: "pipe" });
    const from = realpathSync(dir);
    const oldTree = join(from, ".worktrees", "tree-1");
    execSync(`git worktree add -q -b on-deck/tree-1 ${oldTree}`, { cwd: from, stdio: "pipe" });

    // ── registered in an isolated HOME's state.db: index row, registry with an
    //    ephemeral on-deck record, and an endpoint_claims row
    const identity = serializeIdentity(await deriveRepoIdentity(from));
    setKvValue("repo-index", identity, from);
    saveRegistry(identity, [
      { name: "main", path: from, kind: "main", branch: "main", createdAt: "2026-01-01T00:00:00.000Z" },
      {
        name: "tree-1",
        path: oldTree,
        kind: "ephemeral",
        state: "on-deck",
        branch: "on-deck/tree-1",
        createdAt: "2026-01-02T00:00:00.000Z",
        readyAt: "2026-01-02T01:00:00.000Z",
        readyStamp: "abc123",
      },
    ]);
    saveClaims(identity, [{ worktree: oldTree, role: "web", port: 4010, pid: 4242, ts: "2026-01-02T02:00:00.000Z" }]);

    // ── mv the repo
    const to = join(scratch, "moved", "acme-dev");
    mkdirSync(join(scratch, "moved"), { recursive: true });
    renameSync(from, to);
    const newTree = join(to, ".worktrees", "tree-1");

    // ── locate it, locally
    const plan = await planLocate({ newPath: to });
    if (isRefusal(plan)) throw new Error(`unexpected refusal: ${plan.message}`);
    const result = await applyLocate(plan);
    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();

    // index path updated
    expect(loadRepoIndex()[identity]).toBe(to);

    // registry record path updated, state intact
    const trees = loadRegistry(identity);
    expect(trees.map((t) => t.path).sort()).toEqual([to, newTree].sort());
    expect(trees.find((t) => t.path === newTree)).toMatchObject({
      kind: "ephemeral",
      state: "on-deck",
      branch: "on-deck/tree-1",
      readyStamp: "abc123",
    });

    // claim row updated
    expect(listEndpointClaims(identity)).toEqual([
      { worktree: newTree, role: "web", port: 4010, pid: 4242, ts: "2026-01-02T02:00:00.000Z" },
    ]);

    // git worktree list shows the new path (and not the old one)
    const listed = execSync("git worktree list --porcelain", { cwd: to, encoding: "utf8" });
    expect(listed).toContain(newTree);
    expect(listed).not.toContain(oldTree);

    // no prunable entries
    expect(pruneRepoIndex({ dryRun: true })).toEqual([]);

    // and the reconciler prunes nothing: the ordering this whole feature exists for
    const reconciled = await reconcileRepoRegistry({
      repoName: identity,
      repoPath: to,
      emit: () => {},
      log: silentLog,
    });
    expect(reconciled.map((t) => t.path).sort()).toEqual([to, newTree].sort());
    expect(reconciled.find((t) => t.path === newTree)).toMatchObject({ state: "on-deck", readyStamp: "abc123" });
  });
});
