import { describe, test, expect } from "bun:test";
import { execSync } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { machineSettingsPath } from "../../rt-paths.ts";
import { deriveRepoIdentity } from "../../settings/identity.ts";
import { createStatusHandlers } from "../handlers/status.ts";

function fakeCtx(repoIndex: Record<string, string> = {}): any {
  return {
    startedAt: 123,
    identity: { flavor: "dev", version: "source", sourceRev: "abc1234", startedAt: 123 },
    watchedConfigs: new Map(),
    repoIndex: () => repoIndex,
    cache: { entries: {} },
    portCacheRef: { ports: [], updatedAt: null },
    getHealth: () => ({
      level: "ok",
      reasons: [],
      metrics: { rss: 0, heapUsed: 0, external: 0, uptimeMs: 0, wsClients: 0, watchers: 0 },
      eventLoop: { maxLagMs: 0, lastStallAt: null, lastStallCmd: null, stalls: 0 },
    }),
    heartbeatSeq: () => 0,
  };
}

describe("daemon identity", () => {
  test("ping carries flavor/version/sourceRev", async () => {
    const h = createStatusHandlers(fakeCtx());
    const res = await h["ping"]!({}, undefined as any);
    expect(res).toMatchObject({ ok: true, flavor: "dev", version: "source", sourceRev: "abc1234" });
  });

  test("ping carries a supervision summary (Task 10)", async () => {
    const h = createStatusHandlers(fakeCtx());
    const res = (await h["ping"]!({}, undefined as any)) as any;
    // Loose on values deliberately: daemon-supervision kv is process-wide
    // (lib/daemon/supervision-state.ts, `getStateDb("daemon")`), so this test
    // sharing a `bun test` process with supervision-state.test.ts can see
    // whatever that suite last wrote. The shape/cap is what this test owns.
    expect(typeof res.supervision.bootAttempts).toBe("number");
    expect(typeof res.supervision.lastReadyAt).toBe("number");
    expect(Array.isArray(res.supervision.recentFailures)).toBe(true);
    expect(res.supervision.recentFailures.length).toBeLessThanOrEqual(3);
    expect(res.supervision.lastExit === null || typeof res.supervision.lastExit === "object").toBe(true);
  });

  test("status.data carries the identity object", async () => {
    const h = createStatusHandlers(fakeCtx());
    const res = (await h["status"]!({}, undefined as any)) as any;
    expect(res.data.identity).toEqual({ flavor: "dev", version: "source", sourceRev: "abc1234", startedAt: 123 });
  });
});

describe("S077: status.data.worktreePool dormant surfacing", () => {
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

  /** A repo with a resolvable identity and a team-declared onDeck pool. */
  async function makeDeclaredRepo(): Promise<{ repoName: string; repoPath: string }> {
    const repoPath = realpathSync(mkdtempSync(join(tmpdir(), "rtstatus-dormant-")));
    const remote = "git@rttest:acme/dormant.git";
    execSync(`git init -q && git remote add origin ${remote}`, { cwd: repoPath, shell: "/bin/zsh" });
    const direct = await deriveRepoIdentity(repoPath);
    const identity = direct.kind === "remote" ? direct.id : "rttest.local/dormant";
    const store = readMachineStore();
    if (direct.kind !== "remote") {
      const overrides = { ...(store["rt.repoIdentityOverrides"] as Record<string, string> ?? {}), [remote]: identity };
      writeMachineStore({ ...store, "rt.repoIdentityOverrides": overrides });
    }
    const store2 = readMachineStore();
    const repos = { ...(store2.repos as Record<string, unknown> ?? {}), [identity]: { "rt.worktrees": { onDeck: 1 } } };
    writeMachineStore({ ...store2, repos });
    return { repoName: "dormant-repo", repoPath };
  }

  test("an unowned machine surfaces the declared repo as dormant, naming the enable command", async () => {
    process.env.HOME = realpathSync(mkdtempSync(join(tmpdir(), "rtstatus-dormant-home-")));
    const { repoName, repoPath } = await makeDeclaredRepo();

    const h = createStatusHandlers(fakeCtx({ [repoName]: repoPath }));
    const res = (await h["status"]!({}, undefined as any)) as any;

    expect(res.data.worktreePool).toEqual({
      dormant: true,
      repos: [repoName],
      message: expect.stringContaining('rt settings set rt.worktreeApp \'{"enabled":true}\' --scope machine'),
    });
  });

  test("an explicitly enabled machine is never dormant, even with a declared pool", async () => {
    process.env.HOME = realpathSync(mkdtempSync(join(tmpdir(), "rtstatus-owned-home-")));
    const { repoName, repoPath } = await makeDeclaredRepo();
    const store = readMachineStore();
    writeMachineStore({ ...store, "rt.worktreeApp": { enabled: true } });

    const h = createStatusHandlers(fakeCtx({ [repoName]: repoPath }));
    const res = (await h["status"]!({}, undefined as any)) as any;

    expect(res.data.worktreePool).toEqual({ dormant: false });
  });

  test("no repos declared: worktreePool.dormant is false", async () => {
    process.env.HOME = realpathSync(mkdtempSync(join(tmpdir(), "rtstatus-empty-home-")));
    const h = createStatusHandlers(fakeCtx({}));
    const res = (await h["status"]!({}, undefined as any)) as any;
    expect(res.data.worktreePool).toEqual({ dormant: false });
  });
});
