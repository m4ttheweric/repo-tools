import { describe, test, expect, beforeEach } from "bun:test";
import { execSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { teamSettingsPath } from "../../rt-paths.ts";
import { setSetting } from "../../settings/write.ts";
import { closeStateDb } from "../../state/index.ts";
import { loadRegistry, saveRegistry, type TreeRecord } from "../registry.ts";
import { readDisposalManifest, retainedTrashRoot } from "../trash.ts";
import { disposeTree, type DisposeDeps } from "../dispose.ts";

const GIT_ID = "-c user.email=t@t -c user.name=t";

function makeRepo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "rtmanifest-")));
  writeFileSync(join(dir, "gen.txt"), "alpha\n");
  execSync(`git init -b main && git add gen.txt && git ${GIT_ID} commit -m init`, {
    cwd: dir,
    shell: "/bin/zsh",
    stdio: "pipe",
  });
  return dir;
}

function addBareOrigin(repo: string): string {
  const bare = join(realpathSync(mkdtempSync(join(tmpdir(), "rtmanifest-bare-"))), "o.git");
  execSync(
    `git clone --bare ${repo} ${bare} && git -C ${repo} remote add origin ${bare} && git -C ${repo} fetch origin`,
    { shell: "/bin/zsh", stdio: "pipe" },
  );
  return bare;
}

const IDENTITY = "test/acme-manifest";

function seedIdentity(originUrl: string): void {
  setSetting("rt.repoIdentityOverrides", { [originUrl]: IDENTITY }, "machine");
  const teamPath = teamSettingsPath("acme-manifest");
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

describe("dispose writes a durable manifest", () => {
  const repoName = "acme-manifest";
  let repo: string;
  let events: Array<{ type: string; data: unknown }>;

  beforeEach(() => {
    process.env.HOME = realpathSync(mkdtempSync(join(tmpdir(), "rtmanifest-home-")));
    closeStateDb();
    repo = makeRepo();
    seedIdentity(addBareOrigin(repo));
    events = [];
  });

  function makeDeps(): DisposeDeps {
    return {
      repoName,
      repoPath: repo,
      cacheEntries: {},
      emit: (type, data) => events.push({ type, data }),
      log: { info: () => {}, warn: () => {} },
      killProcesses: false,
    };
  }

  test("a forced dispose writes manifest.json into the retained entry with the right fields", async () => {
    const path = addTree(repo, "tree-a", "feature-a");
    const headSha = execSync(`git -C ${path} rev-parse HEAD`, { encoding: "utf8" }).trim();
    const rec = register(repoName, ephemeral("tree-a", path, "feature-a"));

    const result = await disposeTree(makeDeps(), rec, { force: true });
    expect(result.disposed).toBe(true);
    if (!result.disposed) throw new Error("expected disposed");
    const trash = result.trash!;

    expect(existsSync(join(trash.path, "manifest.json"))).toBe(true);
    const manifest = await readDisposalManifest(trash.path);
    expect(manifest).not.toBeNull();
    expect(manifest).toMatchObject({
      name: "tree-a",
      originalPath: path,
      branch: "feature-a",
      headSha,
      reason: "force",
    });
    expect(typeof manifest!.disposedAt).toBe("string");
    expect(Date.parse(manifest!.disposedAt)).not.toBeNaN();
    expect(manifest!.keptUntil).toBe(trash.keptUntil);
  });

  test("a clean auto dispose (pushed branch, no MR) records reason \"auto\"", async () => {
    const path = addTree(repo, "tree-a", "feature-a");
    execSync(`git -C ${path} push origin feature-a && git -C ${repo} fetch origin`, {
      shell: "/bin/zsh",
      stdio: "pipe",
    });
    const rec = register(repoName, ephemeral("tree-a", path, "feature-a"));

    const result = await disposeTree(makeDeps(), rec, { auto: true });
    expect(result.disposed).toBe(true);
    if (!result.disposed) throw new Error("expected disposed");

    const manifest = await readDisposalManifest(result.trash!.path);
    expect(manifest?.reason).toBe("auto");
  });

  test("a manual dispose records reason \"manual\"", async () => {
    const path = addTree(repo, "tree-a", "feature-a");
    execSync(`git -C ${path} push origin feature-a && git -C ${repo} fetch origin`, {
      shell: "/bin/zsh",
      stdio: "pipe",
    });
    const rec = register(repoName, ephemeral("tree-a", path, "feature-a"));

    const result = await disposeTree(makeDeps(), rec, {});
    expect(result.disposed).toBe(true);
    if (!result.disposed) throw new Error("expected disposed");

    const manifest = await readDisposalManifest(result.trash!.path);
    expect(manifest?.reason).toBe("manual");
  });

  test("a branchless tree's manifest carries a null branch", async () => {
    const path = addTree(repo, "tree-a", "feature-a");
    execSync(`git -C ${path} push origin feature-a && git -C ${repo} fetch origin`, {
      shell: "/bin/zsh",
      stdio: "pipe",
    });
    const rec = register(repoName, { ...ephemeral("tree-a", path, "feature-a"), branch: null });

    const result = await disposeTree(makeDeps(), rec, {});
    expect(result.disposed).toBe(true);
    if (!result.disposed) throw new Error("expected disposed");

    const manifest = await readDisposalManifest(result.trash!.path);
    expect(manifest?.branch).toBeNull();
  });

  test("readDisposalManifest returns null for an entry with no manifest (fallback trash rename)", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "rtmanifest-none-")));
    const manifest = await readDisposalManifest(retainedTrashRoot(root));
    expect(manifest).toBeNull();
  });
});
