import { describe, test, expect, beforeEach, spyOn } from "bun:test";
import { execSync } from "child_process";
import * as fsSync from "fs";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { teamSettingsPath } from "../../rt-paths.ts";
import { setSetting } from "../../settings/write.ts";
import { closeStateDb } from "../../state/index.ts";
import { loadRegistry, saveRegistry, type TreeRecord } from "../registry.ts";
import * as registryModule from "../registry.ts";
import { retainedTrashRoot } from "../trash.ts";
import { loadWorktreeRepoConfig } from "../config.ts";
import { disposeTree, type DisposeDeps } from "../dispose.ts";
import { listRestorableEntries, restoreTree, type RestoreDeps } from "../restore.ts";
import { legacyWorktreePoolRoots } from "../../rt-paths.ts";
import { branchExistsLocalAsync } from "../git-async.ts";

const GIT_ID = "-c user.email=t@t -c user.name=t";

function makeRepo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "rtrestore-")));
  writeFileSync(join(dir, "gen.txt"), "alpha\n");
  execSync(`git init -b main && git add gen.txt && git ${GIT_ID} commit -m init`, {
    cwd: dir,
    shell: "/bin/zsh",
    stdio: "pipe",
  });
  return dir;
}

function addBareOrigin(repo: string): string {
  const bare = join(realpathSync(mkdtempSync(join(tmpdir(), "rtrestore-bare-"))), "o.git");
  execSync(
    `git clone --bare ${repo} ${bare} && git -C ${repo} remote add origin ${bare} && git -C ${repo} fetch origin`,
    { shell: "/bin/zsh", stdio: "pipe" },
  );
  return bare;
}

const IDENTITY = "test/acme-restore";

function seedIdentity(originUrl: string): void {
  setSetting("rt.repoIdentityOverrides", { [originUrl]: IDENTITY }, "machine");
  const teamPath = teamSettingsPath("acme-restore");
  mkdirSync(dirname(teamPath), { recursive: true });
  writeFileSync(teamPath, "// team store\n{}\n");
}

function addTree(repo: string, name: string, branch: string, base = "origin/main"): string {
  const path = join(repo, ".worktrees", name);
  execSync(`git -C ${repo} worktree add -b ${branch} ${path} ${base}`, {
    shell: "/bin/zsh",
    stdio: "pipe",
  });
  return path;
}

function register(repoName: string, rec: TreeRecord): TreeRecord {
  saveRegistry(repoName, [...loadRegistry(repoName), rec]);
  return rec;
}

function ephemeral(name: string, path: string, branch: string, extra: Partial<TreeRecord> = {}): TreeRecord {
  return {
    name,
    path,
    kind: "ephemeral",
    state: "claimed",
    branch,
    createdAt: new Date(Date.now() - 60 * 60_000).toISOString(),
    ...extra,
  };
}

/** Poll until `cond` holds (for the detached strip/reap, which nobody awaits). */
async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("restoreTree", () => {
  const repoName = "acme-restore";
  let repo: string;
  let events: Array<{ type: string; data: unknown }>;

  beforeEach(() => {
    process.env.HOME = realpathSync(mkdtempSync(join(tmpdir(), "rtrestore-home-")));
    closeStateDb();
    repo = makeRepo();
    seedIdentity(addBareOrigin(repo));
    events = [];
  });

  function disposeDeps(): DisposeDeps {
    return {
      repoName,
      repoPath: repo,
      cacheEntries: {},
      emit: (type, data) => events.push({ type, data }),
      log: { info: () => {}, warn: () => {} },
      killProcesses: false,
    };
  }

  function restoreDeps(): RestoreDeps {
    return {
      repoName,
      repoPath: repo,
      emit: (type, data) => events.push({ type, data }),
      log: { info: () => {}, warn: () => {} },
    };
  }

  /** Dispose a tree carrying gitignored content, returning its trash path. */
  async function disposeATree(): Promise<{ trashPath: string; headSha: string }> {
    const path = addTree(repo, "tree-a", "feature-a");
    writeFileSync(join(path, ".gitignore"), "ignored.txt\n");
    writeFileSync(join(path, "ignored.txt"), "human-authored, gitignored\n");
    execSync(`git add .gitignore && git ${GIT_ID} commit -m gitignore`, { cwd: path, shell: "/bin/zsh", stdio: "pipe" });
    execSync(`git -C ${path} push origin feature-a && git -C ${repo} fetch origin`, {
      shell: "/bin/zsh",
      stdio: "pipe",
    });
    const headSha = execSync(`git -C ${path} rev-parse HEAD`, { encoding: "utf8" }).trim();
    const rec = register(repoName, ephemeral("tree-a", path, "feature-a"));

    const result = await disposeTree(disposeDeps(), rec, { auto: true });
    expect(result.disposed).toBe(true);
    if (!result.disposed) throw new Error("expected disposed");
    return { trashPath: result.trash!.path, headSha };
  }

  test("round-trip: restore rehydrates the tree, re-registers it, and clears the trash entry", async () => {
    const { trashPath, headSha } = await disposeATree();
    await waitFor(() => !existsSync(join(trashPath, "node_modules")));
    expect(loadRegistry(repoName).length).toBe(0);

    const result = await restoreTree(restoreDeps(), "tree-a");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`expected ok, got ${result.reason}`);

    // The worktree is live again with its tracked and gitignored content.
    expect(existsSync(result.path)).toBe(true);
    expect(readFileSync(join(result.path, "gen.txt"), "utf8")).toBe("alpha\n");
    expect(readFileSync(join(result.path, "ignored.txt"), "utf8")).toBe("human-authored, gitignored\n");
    expect(execSync(`git -C ${result.path} rev-parse HEAD`, { encoding: "utf8" }).trim()).toBe(headSha);

    // Re-registered as a claimed ephemeral tree the caller can pick up.
    const trees = loadRegistry(repoName);
    expect(trees.length).toBe(1);
    expect(trees[0]).toMatchObject({ name: "tree-a", kind: "ephemeral", state: "claimed", branch: "feature-a" });

    // The branch is real again, and the trash entry is gone.
    expect(await branchExistsLocalAsync(repo, "feature-a")).toBe(true);
    await waitFor(() => !existsSync(trashPath));
  });

  test("restore is refused when the manifest's branch exists again by restore time", async () => {
    const { trashPath } = await disposeATree();
    // Something else claimed the name in the meantime (dispose deleted the
    // original, so this is a genuinely different branch under the same name).
    execSync(`git -C ${repo} branch feature-a`, { shell: "/bin/zsh", stdio: "pipe" });

    const result = await restoreTree(restoreDeps(), "tree-a");
    expect(result).toMatchObject({ ok: false, reason: "branch-elsewhere" });
    // Nothing was clobbered: the trash entry is untouched, no tree registered.
    expect(existsSync(trashPath)).toBe(true);
    expect(loadRegistry(repoName).length).toBe(0);
  });

  test("restore reports not-found for a tree name with no retained entry", async () => {
    const result = await restoreTree(restoreDeps(), "never-disposed");
    expect(result).toMatchObject({ ok: false, reason: "not-found" });
  });

  test("a retained entry with no manifest (legacy/fallback) is not restorable", async () => {
    const legacyPath = join(retainedTrashRoot(join(repo, ".worktrees")), `legacy-${Date.now()}`);
    mkdirSync(legacyPath, { recursive: true });
    writeFileSync(join(legacyPath, "gen.txt"), "alpha\n");

    const result = await restoreTree(restoreDeps(), "legacy");
    expect(result).toMatchObject({ ok: false, reason: "no-manifest" });

    const restorable = await listRestorableEntries(repoName, repo);
    expect(restorable.some((e) => e.name === "legacy")).toBe(false);
  });

  test("copy-failed rolls back the newly created worktree and branch so a retry can succeed", async () => {
    const { trashPath, headSha } = await disposeATree();
    await waitFor(() => !existsSync(join(trashPath, "node_modules")));

    const cfg = await loadWorktreeRepoConfig(repoName, repo);
    const expectedPath = join(cfg.root, "tree-a");

    const cpSpy = spyOn(fsSync, "cpSync").mockImplementation(() => {
      throw new Error("forced copy failure");
    });
    let result;
    try {
      result = await restoreTree(restoreDeps(), "tree-a");
    } finally {
      cpSpy.mockRestore();
    }

    expect(result).toMatchObject({ ok: false, reason: "copy-failed" });
    // The worktree git worktree add created is gone, and so is the branch it
    // checked out, so nothing is left behind to block a retry.
    expect(existsSync(expectedPath)).toBe(false);
    expect(await branchExistsLocalAsync(repo, "feature-a")).toBe(false);
    // The retained entry itself is untouched: nothing is lost until a
    // restore fully succeeds.
    expect(existsSync(trashPath)).toBe(true);
    expect(loadRegistry(repoName).length).toBe(0);

    const retry = await restoreTree(restoreDeps(), "tree-a");
    expect(retry.ok).toBe(true);
    if (!retry.ok) throw new Error(`expected retry ok, got ${retry.reason}`);
    expect(execSync(`git -C ${retry.path} rev-parse HEAD`, { encoding: "utf8" }).trim()).toBe(headSha);
  });

  test("register-failed rolls back the newly created worktree and branch so a retry can succeed", async () => {
    const { trashPath } = await disposeATree();
    await waitFor(() => !existsSync(join(trashPath, "node_modules")));

    const cfg = await loadWorktreeRepoConfig(repoName, repo);
    const expectedPath = join(cfg.root, "tree-a");

    const saveSpy = spyOn(registryModule, "saveRegistry").mockReturnValue(false);
    let result;
    try {
      result = await restoreTree(restoreDeps(), "tree-a");
    } finally {
      saveSpy.mockRestore();
    }

    expect(result).toMatchObject({ ok: false, reason: "register-failed" });
    expect(existsSync(expectedPath)).toBe(false);
    expect(await branchExistsLocalAsync(repo, "feature-a")).toBe(false);
    expect(existsSync(trashPath)).toBe(true);
    expect(loadRegistry(repoName).length).toBe(0);

    const retry = await restoreTree(restoreDeps(), "tree-a");
    expect(retry.ok).toBe(true);
  });

  test("listRestorableEntries surfaces the manifest's keptUntil for the picker", async () => {
    await disposeATree();
    const restorable = await listRestorableEntries(repoName, repo);
    expect(restorable.length).toBe(1);
    expect(restorable[0]).toMatchObject({ name: "tree-a", branch: "feature-a", reason: "auto" });
    expect(Date.parse(restorable[0]!.keptUntil)).toBeGreaterThan(Date.now());
  });
});

describe("legacy pool-root retention stores stay readable", () => {
  test("an entry retired under a prior pool-root spelling is still listed", async () => {
    const repoName = "remote:example.com%2Facme%2Flegacy-trash";
    const repo = makeRepo();
    const legacyPct = legacyWorktreePoolRoots(repoName)[1]!;
    const entry = join(legacyPct, ".trash", "oldtree-1700000000000");
    mkdirSync(entry, { recursive: true });
    writeFileSync(join(entry, "manifest.json"), JSON.stringify({
      name: "oldtree",
      originalPath: join(legacyPct, "oldtree"),
      branch: "feat/old",
      headSha: null,
      reason: "test",
      disposedAt: new Date().toISOString(),
      keptUntil: new Date(Date.now() + 86400000).toISOString(),
    }));

    const restorable = await listRestorableEntries(repoName, repo);
    expect(restorable.some((e) => e.name === "oldtree")).toBe(true);
  });
});
