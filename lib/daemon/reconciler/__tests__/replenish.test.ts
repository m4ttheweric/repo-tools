import { describe, test, expect, beforeEach } from "bun:test";
import { execSync } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { Logger } from "pino";
import { closeStateDb } from "../../../state/index.ts";
import { machineSettingsPath } from "../../../rt-paths.ts";
import { deriveRepoIdentity } from "../../../settings/identity.ts";
import { saveRegistry, type TreeRecord } from "../../../worktree/registry.ts";
import type { WorktreeAppConfig } from "../../../worktree/config.ts";
import { withCreateLock, poolCounts, hasFreeDiskGb, replenishAndShrink, createBackoff } from "../replenish.ts";

function onDeckEntry(path: string, overrides: Partial<TreeRecord> = {}): TreeRecord {
  return {
    name: path,
    path,
    kind: "ephemeral",
    state: "on-deck",
    branch: "feature",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function fakeLog(): Logger {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as unknown as Logger;
}

function fakeAppConfig(overrides: Partial<WorktreeAppConfig> = {}): WorktreeAppConfig {
  return { enabled: true, killProcesses: false, ...overrides };
}

function makeRepo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "rtreplenish-repo-")));
  execSync(
    "git init -b main && git -c user.email=t@t -c user.name=t commit --allow-empty -m init",
    { cwd: dir, shell: "/bin/zsh" },
  );
  return dir;
}

function addBareOrigin(repo: string): void {
  const bare = mkdtempSync(join(tmpdir(), "rtreplenish-bare-"));
  execSync(
    `git clone --bare ${repo} ${bare}/o.git && git -C ${repo} remote add origin ${bare}/o.git && git -C ${repo} fetch origin`,
    { shell: "/bin/zsh" },
  );
}

function readMachineStore(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(machineSettingsPath(), "utf8"));
  } catch {
    return {};
  }
}

function writeMachineStore(obj: Record<string, unknown>): void {
  mkdirSync(join(machineSettingsPath(), ".."), { recursive: true });
  writeFileSync(machineSettingsPath(), JSON.stringify(obj));
}

async function declareWorktrees(repoPath: string, repoName: string, declared: unknown): Promise<void> {
  let remote: string | null = null;
  try {
    remote = execSync("git config --get remote.origin.url", { cwd: repoPath, encoding: "utf8" }).trim() || null;
  } catch { /* no origin yet */ }
  if (!remote) {
    remote = `git@rttest:${repoName}.git`;
    execSync(`git remote add origin ${remote}`, { cwd: repoPath, shell: "/bin/zsh" });
  }
  let identity: string;
  const direct = await deriveRepoIdentity(repoPath);
  if (direct.kind === "remote") {
    identity = direct.id;
  } else {
    identity = `rttest.local/${repoName}`;
    const store = readMachineStore();
    const overrides = { ...(store["rt.repoIdentityOverrides"] as Record<string, string> ?? {}), [remote]: identity };
    writeMachineStore({ ...store, "rt.repoIdentityOverrides": overrides });
  }
  const store = readMachineStore();
  const repos = { ...(store.repos as Record<string, unknown> ?? {}), [identity]: { "rt.worktrees": declared } };
  writeMachineStore({ ...store, repos });
}

describe("replenish.ts: withCreateLock", () => {
  test("serializes concurrent calls for the same repoPath: never two holders at once", async () => {
    const order: string[] = [];
    let active = 0;
    let maxActive = 0;
    const run = (id: string) => withCreateLock("/repo/a", async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      order.push(`start-${id}`);
      await new Promise((r) => setTimeout(r, 10));
      order.push(`end-${id}`);
      active--;
    });
    await Promise.all([run("1"), run("2"), run("3")]);
    expect(maxActive).toBe(1);
    expect(order).toEqual(["start-1", "end-1", "start-2", "end-2", "start-3", "end-3"]);
  });

  test("different repoPaths are not serialized against each other", async () => {
    let active = 0;
    let maxActive = 0;
    const run = (path: string) => withCreateLock(path, async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
    });
    await Promise.all([run("/repo/b"), run("/repo/c")]);
    expect(maxActive).toBe(2);
  });

  test("a holder that throws still releases the lock for the next caller", async () => {
    await expect(withCreateLock("/repo/d", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    let ran = false;
    await withCreateLock("/repo/d", async () => { ran = true; });
    expect(ran).toBe(true);
  });
});

describe("replenish.ts: poolCounts", () => {
  const repoName = "acme";

  beforeEach(() => {
    process.env.HOME = realpathSync(mkdtempSync(join(tmpdir(), "rtreplenish-home-")));
    closeStateDb();
  });

  test("counts on-deck and creating entries, ready gated on nextRetryAt", () => {
    saveRegistry(repoName, [
      onDeckEntry("/t/a"),
      onDeckEntry("/t/b", { nextRetryAt: new Date(Date.now() + 60_000).toISOString() }),
      onDeckEntry("/t/c", { state: "creating" }),
      onDeckEntry("/t/claimed", { state: "claimed" }),
    ]);

    const counts = poolCounts(repoName);
    expect(counts.ready).toBe(1);
    expect(counts.totalUnclaimed).toBe(3);
    expect(counts.onDeckEntries.map((t) => t.path).sort()).toEqual(["/t/a", "/t/b"]);
  });
});

describe("replenish.ts: hasFreeDiskGb", () => {
  test("a probe failure on an unresolvable path degrades to true", async () => {
    expect(await hasFreeDiskGb("/no/such/path/at/all", 5)).toBe(true);
  });
});

describe("replenish.ts: per-instance backoff", () => {
  const repoName = "acme";
  let repo: string;

  beforeEach(() => {
    process.env.HOME = realpathSync(mkdtempSync(join(tmpdir(), "rtbackoff-home-")));
    closeStateDb();
    createBackoff.clear();
    repo = makeRepo();
    addBareOrigin(repo);
  });

  test("a create failure lands on the backoff map threaded via deps.backoff, not the module-scope default", async () => {
    await declareWorktrees(repo, repoName, { onDeck: 1, root: join(repo, ".worktrees"), ready: [{ run: "exit 1" }] });
    const instanceBackoff = new Map<string, { failures: number; nextRetryAt: string }>();

    await replenishAndShrink(
      { repoName, repoPath: repo, emit: () => {}, log: fakeLog(), backoff: instanceBackoff },
      new Map(),
      fakeAppConfig(),
    );

    expect(instanceBackoff.get(repoName)?.failures).toBe(1);
    // The module-scope default two instances would otherwise share stays clean.
    expect(createBackoff.has(repoName)).toBe(false);
  });

  test("two instances' backoff maps are independent: one's active backoff does not gate the other", async () => {
    await declareWorktrees(repo, repoName, { onDeck: 1, root: join(repo, ".worktrees"), ready: [{ run: "exit 1" }] });
    const a = new Map<string, { failures: number; nextRetryAt: string }>();
    const b = new Map<string, { failures: number; nextRetryAt: string }>();
    const deps = { repoName, repoPath: repo, emit: () => {}, log: fakeLog() };

    await replenishAndShrink({ ...deps, backoff: a }, new Map(), fakeAppConfig());
    // A now holds an active backoff deadline. A shared map would make B skip its
    // create; independent maps let B attempt and charge its own failure.
    await replenishAndShrink({ ...deps, backoff: b }, new Map(), fakeAppConfig());

    expect(Date.parse(a.get(repoName)!.nextRetryAt)).toBeGreaterThan(Date.now());
    expect(a.get(repoName)?.failures).toBe(1);
    expect(b.get(repoName)?.failures).toBe(1);
  });
});
