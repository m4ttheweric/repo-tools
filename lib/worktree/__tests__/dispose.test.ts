import { describe, test, expect, beforeEach } from "bun:test";
import { execSync } from "child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync, realpathSync } from "fs";
import { tmpdir } from "os";
import { basename, dirname, join } from "path";
import { repoDataDir } from "../../rt-paths.ts";
import { saveSyncConfig } from "../../sync-config.ts";
import { loadRegistry, saveRegistry, type TreeRecord } from "../registry.ts";
import { branchExistsLocalAsync, listWorktreesAsync, remoteRefExists } from "../git-async.ts";
import { hasFreshAttendantLease } from "../lease.ts";
import {
  classifyDirtyAsync,
  disposeTree,
  STATUS_FAILED_BLOCKER,
  type DisposeDeps,
} from "../dispose.ts";

const GIT_ID = "-c user.email=t@t -c user.name=t";

/** A repo whose initial commit carries a tracked `gen.txt` (the "generated" file). */
function makeRepo(): string {
  // realpathSync: git canonicalizes /var -> /private/var on macOS (Global Constraints)
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "rtdispose-")));
  writeFileSync(join(dir, "gen.txt"), "alpha\nbeta\n");
  execSync(`git init -b main && git add gen.txt && git ${GIT_ID} commit -m init`, {
    cwd: dir,
    shell: "/bin/zsh",
    stdio: "pipe",
  });
  return dir;
}

/** Bare-clone `repo` as its own "origin" and fetch. Returns the bare repo path. */
function addBareOrigin(repo: string): string {
  const bare = join(realpathSync(mkdtempSync(join(tmpdir(), "rtdispose-bare-"))), "o.git");
  execSync(
    `git clone --bare ${repo} ${bare} && git -C ${repo} remote add origin ${bare} && git -C ${repo} fetch origin`,
    { shell: "/bin/zsh", stdio: "pipe" },
  );
  return bare;
}

/** Add a worktree on a fresh branch cut from `base`, and return its (canonical) path. */
function addTree(repo: string, name: string, branch: string, base = "origin/main"): string {
  const path = join(repo, ".worktrees", name);
  execSync(`git -C ${repo} worktree add -b ${branch} ${path} ${base}`, {
    shell: "/bin/zsh",
    stdio: "pipe",
  });
  return path;
}

/** Poll until `cond` holds — for the detached reaper, which nobody awaits. */
async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 20));
  }
}

function commitIn(worktree: string, file: string, content: string): void {
  writeFileSync(join(worktree, file), content);
  execSync(`git add ${file} && git ${GIT_ID} commit -m change`, {
    cwd: worktree,
    shell: "/bin/zsh",
    stdio: "pipe",
  });
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

function writeLease(filename: string, body: unknown): void {
  const dir = join(process.env.HOME!, ".mattstack", "ci-attendants");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, filename), typeof body === "string" ? body : JSON.stringify(body));
}

describe("hasFreshAttendantLease", () => {
  beforeEach(() => {
    process.env.HOME = realpathSync(mkdtempSync(join(tmpdir(), "rtlease-home-")));
  });

  test("no lease directory at all → false", () => {
    expect(hasFreshAttendantLease(42)).toBe(false);
  });

  test("fresh lease (real BOARD-10 shape) matches by filename suffix", () => {
    writeLease("assured-dev-42.json", {
      mr: "https://gitlab.com/acme/assured-dev/-/merge_requests/42",
      heartbeatAt: Date.now(),
      ttlSeconds: 300,
    });
    expect(hasFreshAttendantLease(42)).toBe(true);
    expect(hasFreshAttendantLease(43)).toBe(false);
  });

  test("lease whose filename carries no iid still matches by the mr URL's trailing iid", () => {
    writeLease("attendant.json", {
      mr: "https://gitlab.com/acme/assured-dev/-/merge_requests/77",
      heartbeatAt: Date.now(),
      ttlSeconds: 300,
    });
    expect(hasFreshAttendantLease(77)).toBe(true);
    expect(hasFreshAttendantLease(7)).toBe(false);
  });

  test("heartbeat older than ttlSeconds → stale", () => {
    writeLease("assured-dev-42.json", {
      mr: "https://gitlab.com/acme/assured-dev/-/merge_requests/42",
      heartbeatAt: Date.now() - 400_000,
      ttlSeconds: 300,
    });
    expect(hasFreshAttendantLease(42)).toBe(false);
  });

  test("missing ttlSeconds falls back to 300s", () => {
    writeLease("assured-dev-9.json", {
      mr: "https://gitlab.com/acme/assured-dev/-/merge_requests/9",
      heartbeatAt: Date.now() - 100_000,
    });
    expect(hasFreshAttendantLease(9)).toBe(true);

    writeLease("assured-dev-9.json", {
      mr: "https://gitlab.com/acme/assured-dev/-/merge_requests/9",
      heartbeatAt: Date.now() - 400_000,
    });
    expect(hasFreshAttendantLease(9)).toBe(false);
  });

  test("ISO-string heartbeatAt is tolerated", () => {
    writeLease("assured-dev-5.json", {
      mr: "https://gitlab.com/acme/assured-dev/-/merge_requests/5",
      heartbeatAt: new Date().toISOString(),
      ttlSeconds: 300,
    });
    expect(hasFreshAttendantLease(5)).toBe(true);
  });

  test("garbage files never block disposal", () => {
    writeLease("assured-dev-42.json", "{ not json at all");
    writeLease("assured-dev-43.json", { mr: 12345, heartbeatAt: "nonsense" });
    expect(hasFreshAttendantLease(42)).toBe(false);
    expect(hasFreshAttendantLease(43)).toBe(false);
  });

  test("`now` is injectable", () => {
    const heartbeatAt = 1_786_998_298_000;
    writeLease("assured-dev-42.json", {
      mr: "https://gitlab.com/acme/assured-dev/-/merge_requests/42",
      heartbeatAt,
      ttlSeconds: 300,
    });
    expect(hasFreshAttendantLease(42, heartbeatAt + 1_000)).toBe(true);
    expect(hasFreshAttendantLease(42, heartbeatAt + 300_001)).toBe(false);
  });
});

describe("classifyDirtyAsync", () => {
  let repo: string;
  let tree: string;
  const repoName = "acme";

  beforeEach(() => {
    process.env.HOME = realpathSync(mkdtempSync(join(tmpdir(), "rtdispose-home-")));
    repo = makeRepo();
    addBareOrigin(repo);
    tree = addTree(repo, "tree-a", "feature-a");
  });

  test("clean tree classifies as nothing at all", async () => {
    const result = await classifyDirtyAsync(tree, repoName);
    expect(result.discard).toEqual([]);
    expect(result.blockers).toEqual([]);
  });

  test("untracked file is a blocker", async () => {
    writeFileSync(join(tree, "scratch.txt"), "hi\n");
    const result = await classifyDirtyAsync(tree, repoName);
    expect(result.blockers).toEqual(["scratch.txt"]);
    expect(result.discard).toEqual([]);
  });

  test("declared generated file with whitespace-only drift is discardable", async () => {
    saveSyncConfig(repoDataDir(repoName), {
      autoResolve: [{ glob: "gen.txt", strategy: "theirs" }],
    });
    writeFileSync(join(tree, "gen.txt"), "alpha  \nbeta\n");

    const result = await classifyDirtyAsync(tree, repoName);
    expect(result.discard).toEqual(["gen.txt"]);
    expect(result.blockers).toEqual([]);
  });

  test("declared generated file with a substantive edit is a blocker", async () => {
    saveSyncConfig(repoDataDir(repoName), {
      autoResolve: [{ glob: "gen.txt", strategy: "theirs" }],
    });
    writeFileSync(join(tree, "gen.txt"), "alpha\nbeta\ngamma\n");

    const result = await classifyDirtyAsync(tree, repoName);
    expect(result.discard).toEqual([]);
    expect(result.blockers).toEqual(["gen.txt"]);
  });

  test("undeclared modified file is a blocker even when whitespace-only", async () => {
    writeFileSync(join(tree, "gen.txt"), "alpha  \nbeta\n");
    const result = await classifyDirtyAsync(tree, repoName);
    expect(result.blockers).toEqual(["gen.txt"]);
  });

  test("a failing git status fails CLOSED, never clean", async () => {
    const gone = join(tree, "nope", "not-a-worktree");
    const result = await classifyDirtyAsync(gone, repoName);
    expect(result.blockers).toEqual([STATUS_FAILED_BLOCKER]);
    expect(result.discard).toEqual([]);

    // Same for a directory git refuses to read as a repo.
    const notARepo = realpathSync(mkdtempSync(join(tmpdir(), "rtdispose-bare-dir-")));
    const outside = await classifyDirtyAsync(notARepo, repoName);
    expect(outside.blockers).toEqual([STATUS_FAILED_BLOCKER]);
  });
});

describe("disposeTree", () => {
  const repoName = "acme";
  let repo: string;
  let events: Array<{ type: string; data: unknown }>;

  beforeEach(() => {
    process.env.HOME = realpathSync(mkdtempSync(join(tmpdir(), "rtdispose-home-")));
    repo = makeRepo();
    addBareOrigin(repo);
    events = [];
  });

  function makeDeps(overrides: Partial<DisposeDeps> = {}): DisposeDeps {
    return {
      repoName,
      repoPath: repo,
      cacheEntries: {},
      emit: (type, data) => events.push({ type, data }),
      log: { info: () => {}, warn: () => {} },
      killProcesses: false,
      ...overrides,
    };
  }

  test("kind=main refuses even under force", async () => {
    const rec = register(repoName, {
      name: "main",
      path: repo,
      kind: "main",
      branch: "main",
      createdAt: new Date().toISOString(),
    });

    const result = await disposeTree(makeDeps(), rec, { force: true });
    expect(result).toEqual({ disposed: false, refusal: "kind-main" });
    expect(existsSync(repo)).toBe(true);
    expect(loadRegistry(repoName).length).toBe(1);
  });

  test("kind=unmanaged refuses even under force", async () => {
    const path = addTree(repo, "theirs", "someone-else");
    const rec = register(repoName, {
      name: "theirs",
      path,
      kind: "unmanaged",
      branch: "someone-else",
      createdAt: new Date().toISOString(),
    });

    const result = await disposeTree(makeDeps(), rec, { force: true });
    expect(result).toEqual({ disposed: false, refusal: "kind-unmanaged" });
    expect(existsSync(path)).toBe(true);
  });

  test("dirty tracked file refuses with \"dirty\"", async () => {
    const path = addTree(repo, "tree-a", "feature-a");
    writeFileSync(join(path, "gen.txt"), "alpha\nbeta\ngamma\n");
    const rec = register(repoName, ephemeral("tree-a", path, "feature-a"));

    const result = await disposeTree(makeDeps(), rec, {});
    expect(result).toEqual({ disposed: false, refusal: "dirty" });
    expect(existsSync(path)).toBe(true);
  });

  test("--force disposes a dirty tree", async () => {
    const path = addTree(repo, "tree-a", "feature-a");
    writeFileSync(join(path, "gen.txt"), "alpha\nbeta\ngamma\n");
    const rec = register(repoName, ephemeral("tree-a", path, "feature-a"));

    const result = await disposeTree(makeDeps(), rec, { force: true });
    expect(result).toEqual({ disposed: true });
    expect(existsSync(path)).toBe(false);
  });

  test("whitespace-only drift in a declared generated file does not refuse", async () => {
    saveSyncConfig(repoDataDir(repoName), {
      autoResolve: [{ glob: "gen.txt", strategy: "theirs" }],
    });
    const path = addTree(repo, "tree-a", "feature-a");
    writeFileSync(join(path, "gen.txt"), "alpha  \nbeta\n");
    const rec = register(repoName, ephemeral("tree-a", path, "feature-a"));

    const result = await disposeTree(makeDeps(), rec, {});
    expect(result).toEqual({ disposed: true });
    expect(existsSync(path)).toBe(false);
    const disposed = events.find((e) => e.type === "worktree:disposed");
    expect(disposed).toBeDefined();
    expect((disposed!.data as { discarded: string[] }).discarded).toEqual(["gen.txt"]);
  });

  test("unpushed commit refuses with \"unpushed\"", async () => {
    const path = addTree(repo, "tree-a", "feature-a");
    commitIn(path, "new.txt", "local only\n");
    const rec = register(repoName, ephemeral("tree-a", path, "feature-a"));

    const result = await disposeTree(makeDeps(), rec, {});
    expect(result).toEqual({ disposed: false, refusal: "unpushed" });
    expect(existsSync(path)).toBe(true);

    const forced = await disposeTree(makeDeps(), rec, { force: true });
    expect(forced).toEqual({ disposed: true });
  });

  test("pushed branch with no MR disposes via the origin/<branch> anchor", async () => {
    const path = addTree(repo, "tree-a", "feature-a");
    commitIn(path, "new.txt", "pushed\n");
    execSync(`git -C ${path} push origin feature-a && git -C ${repo} fetch origin`, {
      shell: "/bin/zsh",
      stdio: "pipe",
    });
    const rec = register(repoName, ephemeral("tree-a", path, "feature-a"));

    const result = await disposeTree(makeDeps(), rec, {});
    expect(result).toEqual({ disposed: true });

    // worktree, branch, and registry entry all gone
    expect(existsSync(path)).toBe(false);
    expect((await listWorktreesAsync(repo))!.some((w) => w.path === path)).toBe(false);
    expect(await branchExistsLocalAsync(repo, "feature-a")).toBe(false);
    expect(loadRegistry(repoName).length).toBe(0);

    const disposed = events.find((e) => e.type === "worktree:disposed");
    expect(disposed).toBeDefined();
    expect((disposed!.data as { tree: string }).tree).toBe("tree-a");
  });

  test("auto disposal anchors on the MR head sha, not the default branch", async () => {
    const path = addTree(repo, "tree-a", "feature-a");
    commitIn(path, "new.txt", "squash-merged upstream\n");
    const sha = execSync(`git -C ${path} rev-parse HEAD`, { encoding: "utf8" }).trim();
    const rec = register(repoName, ephemeral("tree-a", path, "feature-a", {
      claimedAt: new Date(Date.now() - 60 * 60_000).toISOString(),
    }));

    const deps = makeDeps({
      cacheEntries: { "feature-a": { mr: { iid: 42, sha, state: "merged" }, repoName } },
    });
    const result = await disposeTree(deps, rec, { auto: true });
    expect(result).toEqual({ disposed: true });
    expect(existsSync(path)).toBe(false);
  });

  test("a present-but-unresolvable MR sha refuses with \"mr-sha-unresolvable\"", async () => {
    const path = addTree(repo, "tree-a", "feature-a");
    const rec = register(repoName, ephemeral("tree-a", path, "feature-a", {
      claimedAt: new Date(Date.now() - 60 * 60_000).toISOString(),
    }));

    const deps = makeDeps({
      cacheEntries: {
        "feature-a": { mr: { iid: 42, sha: "0".repeat(40), state: "merged" }, repoName },
      },
    });
    const result = await disposeTree(deps, rec, { auto: true });
    expect(result).toEqual({ disposed: false, refusal: "mr-sha-unresolvable" });
    expect(existsSync(path)).toBe(true);
  });

  test("an MR with NO sha falls back to the remote anchor instead of refusing", async () => {
    const path = addTree(repo, "tree-a", "feature-a");
    const rec = register(repoName, ephemeral("tree-a", path, "feature-a", {
      claimedAt: new Date(Date.now() - 60 * 60_000).toISOString(),
    }));

    // sha absent entirely (the projection drops it for many merged MRs)
    const deps = makeDeps({ cacheEntries: { "feature-a": { mr: { iid: 42, state: "merged" }, repoName } } });
    const result = await disposeTree(deps, rec, { auto: true });
    expect(result).toEqual({ disposed: true });
    expect(existsSync(path)).toBe(false);
  });

  test("an MR with a null sha still gets a real containment check", async () => {
    const path = addTree(repo, "tree-a", "feature-a");
    commitIn(path, "new.txt", "local only\n");
    const rec = register(repoName, ephemeral("tree-a", path, "feature-a", {
      claimedAt: new Date(Date.now() - 60 * 60_000).toISOString(),
    }));

    const deps = makeDeps({
      cacheEntries: { "feature-a": { mr: { iid: 42, sha: null, state: "merged" }, repoName } },
    });
    const result = await disposeTree(deps, rec, { auto: true });
    expect(result).toEqual({ disposed: false, refusal: "unpushed" });
  });

  test("auto disposal refuses \"unpushed\" when HEAD is ahead of the MR head sha", async () => {
    const path = addTree(repo, "tree-a", "feature-a");
    commitIn(path, "new.txt", "in the MR\n");
    const sha = execSync(`git -C ${path} rev-parse HEAD`, { encoding: "utf8" }).trim();
    commitIn(path, "later.txt", "never pushed\n");
    const rec = register(repoName, ephemeral("tree-a", path, "feature-a", {
      claimedAt: new Date(Date.now() - 60 * 60_000).toISOString(),
    }));

    const deps = makeDeps({
      cacheEntries: { "feature-a": { mr: { iid: 42, sha, state: "merged" }, repoName } },
    });
    const result = await disposeTree(deps, rec, { auto: true });
    expect(result).toEqual({ disposed: false, refusal: "unpushed" });
  });

  test("MANUAL disposal of a squash-merged tree uses the MR sha anchor", async () => {
    // The shape that broke: squash-merged upstream, source branch deleted, so
    // the tip is an ancestor of nothing the remote still has. Before the fix a
    // human got "unpushed" here and was pushed toward --force, which also
    // strips the dirty guard.
    const path = addTree(repo, "tree-a", "feature-a");
    commitIn(path, "new.txt", "squash-merged upstream\n");
    const sha = execSync(`git -C ${path} rev-parse HEAD`, { encoding: "utf8" }).trim();
    const rec = register(repoName, ephemeral("tree-a", path, "feature-a"));
    expect(await remoteRefExists(path, "feature-a")).toBe(false);

    const deps = makeDeps({
      cacheEntries: { "feature-a": { mr: { iid: 42, sha, state: "merged" }, repoName } },
    });
    const result = await disposeTree(deps, rec, { auto: false });
    expect(result).toEqual({ disposed: true });
    expect(existsSync(path)).toBe(false);
  });

  test("manual disposal with an OPEN MR still uses the remote anchor", async () => {
    // An open MR's head sha would happily contain HEAD; the tree is still the
    // author's live work, so it must be judged on what is actually pushed.
    const path = addTree(repo, "tree-a", "feature-a");
    commitIn(path, "new.txt", "not pushed yet\n");
    const sha = execSync(`git -C ${path} rev-parse HEAD`, { encoding: "utf8" }).trim();
    const rec = register(repoName, ephemeral("tree-a", path, "feature-a"));

    const deps = makeDeps({
      cacheEntries: { "feature-a": { mr: { iid: 42, sha, state: "opened" }, repoName } },
    });
    const result = await disposeTree(deps, rec, { auto: false });
    expect(result).toEqual({ disposed: false, refusal: "unpushed" });
    expect(existsSync(path)).toBe(true);
  });

  test("a fresh attendant lease on the joined MR refuses with \"attended\"", async () => {
    const path = addTree(repo, "tree-a", "feature-a");
    const rec = register(repoName, ephemeral("tree-a", path, "feature-a"));
    writeLease("acme-42.json", {
      mr: "https://gitlab.com/acme/acme/-/merge_requests/42",
      heartbeatAt: Date.now(),
      ttlSeconds: 300,
    });

    const deps = makeDeps({
      cacheEntries: { "feature-a": { mr: { iid: 42, sha: null }, repoName } },
    });
    const result = await disposeTree(deps, rec, {});
    expect(result).toEqual({ disposed: false, refusal: "attended" });
    expect(existsSync(path)).toBe(true);

    const forced = await disposeTree(deps, rec, { force: true });
    expect(forced).toEqual({ disposed: true });
  });

  test("a stale attendant lease does not refuse", async () => {
    const path = addTree(repo, "tree-a", "feature-a");
    const rec = register(repoName, ephemeral("tree-a", path, "feature-a"));
    writeLease("acme-42.json", {
      mr: "https://gitlab.com/acme/acme/-/merge_requests/42",
      heartbeatAt: Date.now() - 400_000,
      ttlSeconds: 300,
    });

    const deps = makeDeps({
      cacheEntries: { "feature-a": { mr: { iid: 42, sha: null }, repoName } },
    });
    const result = await disposeTree(deps, rec, {});
    expect(result).toEqual({ disposed: true });
  });

  test("auto disposal of a just-claimed tree refuses with \"grace\"; explicit disposal proceeds", async () => {
    const path = addTree(repo, "tree-a", "feature-a");
    const rec = register(repoName, ephemeral("tree-a", path, "feature-a", {
      claimedAt: new Date().toISOString(),
    }));

    const auto = await disposeTree(makeDeps(), rec, { auto: true });
    expect(auto).toEqual({ disposed: false, refusal: "grace" });
    expect(existsSync(path)).toBe(true);

    const explicit = await disposeTree(makeDeps(), rec, { auto: false });
    expect(explicit).toEqual({ disposed: true });
    expect(existsSync(path)).toBe(false);
  });

  test("a claim older than the 10-minute grace window auto-disposes", async () => {
    const path = addTree(repo, "tree-a", "feature-a");
    const rec = register(repoName, ephemeral("tree-a", path, "feature-a", {
      claimedAt: new Date(Date.now() - 11 * 60_000).toISOString(),
    }));

    const result = await disposeTree(makeDeps(), rec, { auto: true });
    expect(result).toEqual({ disposed: true });
  });

  test("a cache entry with no repoName still joins its MR", async () => {
    const path = addTree(repo, "tree-a", "feature-a");
    const rec = register(repoName, ephemeral("tree-a", path, "feature-a"));
    writeLease("acme-42.json", {
      mr: "https://gitlab.com/acme/acme/-/merge_requests/42",
      heartbeatAt: Date.now(),
      ttlSeconds: 300,
    });

    const deps = makeDeps({ cacheEntries: { "feature-a": { mr: { iid: 42, sha: null } } } });
    expect(await disposeTree(deps, rec, {})).toEqual({ disposed: false, refusal: "attended" });
  });

  test("a cache entry attributed to another repo does not join", async () => {
    const path = addTree(repo, "tree-a", "feature-a");
    const rec = register(repoName, ephemeral("tree-a", path, "feature-a"));
    writeLease("other-42.json", {
      mr: "https://gitlab.com/other/other/-/merge_requests/42",
      heartbeatAt: Date.now(),
      ttlSeconds: 300,
    });

    const deps = makeDeps({
      cacheEntries: { "feature-a": { mr: { iid: 42, sha: null }, repoName: "other-repo" } },
    });
    expect(await disposeTree(deps, rec, {})).toEqual({ disposed: true });
  });

  test("a failing git status refuses \"dirty\" rather than disposing", async () => {
    const path = addTree(repo, "tree-a", "feature-a");
    const rec = register(repoName, {
      ...ephemeral("tree-a", path, "feature-a"),
      path: join(path, "gone", "missing"),
    });

    const result = await disposeTree(makeDeps(), rec, {});
    expect(result).toEqual({ disposed: false, refusal: "dirty" });
    expect(existsSync(path)).toBe(true);
    expect(loadRegistry(repoName).length).toBe(1);
  });

  test("a tree that cannot be renamed refuses \"remove-failed\" and keeps the registry row", async () => {
    const path = addTree(repo, "tree-a", "feature-a");
    const rec = register(repoName, ephemeral("tree-a", path, "feature-a"));
    // A rename needs write permission on the PARENT: a read-only .worktrees is
    // the mechanical, transient failure that stands in for a busy/held tree.
    const root = join(repo, ".worktrees");
    chmodSync(root, 0o555);

    try {
      const result = await disposeTree(makeDeps(), rec, { force: true });
      expect(result).toEqual({ disposed: false, refusal: "remove-failed" });
      // Nothing downstream of the rename ran: the tree, its branch, and its
      // registry row are all still there for the retry.
      expect(existsSync(path)).toBe(true);
      expect(loadRegistry(repoName).length).toBe(1);
      expect(await branchExistsLocalAsync(repo, "feature-a")).toBe(true);
      expect((await listWorktreesAsync(repo))!.some((w) => w.path === path)).toBe(true);
      expect(events.length).toBe(0);
    } finally {
      chmodSync(root, 0o755);
    }
  });

  test("disposal renames the tree to a .trash-* sibling and reaps it in the background", async () => {
    const path = addTree(repo, "tree-a", "feature-a");
    const rec = register(repoName, ephemeral("tree-a", path, "feature-a"));
    const root = join(repo, ".worktrees");

    const infos: Array<Record<string, unknown>> = [];
    const deps = makeDeps({
      log: { info: (fields: unknown) => infos.push(fields as Record<string, unknown>), warn: () => {} },
    });
    const result = await disposeTree(deps, rec, { force: true });
    expect(result).toEqual({ disposed: true });

    // The tree is gone from its own path the moment dispose returns, moved to
    // a trash sibling the log names (the reaper may already have eaten it).
    expect(existsSync(path)).toBe(false);
    const trash = infos.find((f) => typeof f.trash === "string")!.trash as string;
    expect(dirname(trash)).toBe(root);
    expect(basename(trash).startsWith(".trash-tree-a-")).toBe(true);
    expect(readdirSync(root).every((e) => e.startsWith(".trash-tree-a-"))).toBe(true);

    // The registration, branch, and registry row all went with it.
    expect((await listWorktreesAsync(repo))!.some((w) => w.path === path)).toBe(false);
    expect(await branchExistsLocalAsync(repo, "feature-a")).toBe(false);
    expect(loadRegistry(repoName).length).toBe(0);
    expect(events.some((e) => e.type === "worktree:disposed")).toBe(true);

    // …and the detached reaper finishes the delete without anyone awaiting it.
    await waitFor(() => readdirSync(root).length === 0);
  });

  test("guard order: dirty is reported before unpushed", async () => {
    const path = addTree(repo, "tree-a", "feature-a");
    commitIn(path, "new.txt", "local only\n");
    writeFileSync(join(path, "gen.txt"), "alpha\nbeta\ngamma\n");
    const rec = register(repoName, ephemeral("tree-a", path, "feature-a"));

    const result = await disposeTree(makeDeps(), rec, {});
    expect(result).toEqual({ disposed: false, refusal: "dirty" });
  });

  test("guard order: attended is reported before grace", async () => {
    const path = addTree(repo, "tree-a", "feature-a");
    const rec = register(repoName, ephemeral("tree-a", path, "feature-a", {
      claimedAt: new Date().toISOString(),
    }));
    writeLease("acme-42.json", {
      mr: "https://gitlab.com/acme/acme/-/merge_requests/42",
      heartbeatAt: Date.now(),
      ttlSeconds: 300,
    });

    const sha = execSync(`git -C ${path} rev-parse HEAD`, { encoding: "utf8" }).trim();
    const deps = makeDeps({
      cacheEntries: { "feature-a": { mr: { iid: 42, sha, state: "merged" }, repoName } },
    });
    const result = await disposeTree(deps, rec, { auto: true });
    expect(result).toEqual({ disposed: false, refusal: "attended" });
  });

  test("killProcesses wiring runs the killer without disturbing disposal", async () => {
    const path = addTree(repo, "tree-a", "feature-a");
    const rec = register(repoName, ephemeral("tree-a", path, "feature-a"));

    const result = await disposeTree(makeDeps({ killProcesses: true }), rec, {});
    expect(result).toEqual({ disposed: true });
    expect(existsSync(path)).toBe(false);
  });

  test("a branchless record disposes and prunes the registry", async () => {
    const path = addTree(repo, "tree-a", "feature-a");
    const rec = register(repoName, { ...ephemeral("tree-a", path, "feature-a"), branch: null });

    const result = await disposeTree(makeDeps(), rec, {});
    expect(result).toEqual({ disposed: true });
    expect(existsSync(path)).toBe(false);
    expect(loadRegistry(repoName).length).toBe(0);
  });

  test("dispose tolerates a branch git already deleted", async () => {
    const path = addTree(repo, "tree-a", "feature-a");
    const rec = register(repoName, ephemeral("tree-a", path, "feature-a"));
    execSync(`git -C ${repo} worktree remove --force ${path} && git -C ${repo} branch -D feature-a`, {
      shell: "/bin/zsh",
      stdio: "pipe",
    });

    const result = await disposeTree(makeDeps(), rec, { force: true });
    expect(result).toEqual({ disposed: true });
    expect(loadRegistry(repoName).length).toBe(0);
  });
});
