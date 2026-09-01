/**
 * RT-98: `tray:status` publishes the held-ready-ladder snapshot, which is what
 * the tray turns into its persistent badge and its transition notification.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execSync } from "child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { teamSettingsPath } from "../../rt-paths.ts";
import { readyLadderHash, writeReadyApproval } from "../../worktree/ready-approval.ts";
import { resetHeldReadyLaddersCache } from "../../worktree/ready-held.ts";
import { createStatusHandlers } from "../handlers/status.ts";

const IDENTITY = "gitlab.com/acme/tray-held";
const REMOTE = "git@gitlab.com:acme/tray-held.git";
const LADDER = [{ run: "make setup" }];

function fakeCtx(repoIndex: Record<string, string> = {}): any {
  return {
    startedAt: 123,
    identity: { flavor: "dev", version: "source", sourceRev: "abc1234", startedAt: 123 },
    watchedConfigs: new Map(),
    repoIndex: () => repoIndex,
    cache: { entries: {} },
    portCacheRef: { ports: [], updatedAt: null },
    refreshStatusRef: { lastRefreshAt: null },
    getHealth: () => ({
      level: "ok",
      reasons: [],
      metrics: { rss: 0, heapUsed: 0, external: 0, uptimeMs: 0, wsClients: 0, watchers: 0 },
      eventLoop: { maxLagMs: 0, lastStallAt: null, lastStallCmd: null, stalls: 0 },
    }),
    heartbeatSeq: () => 0,
  };
}

function repoWithTeamLadder(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "rttrayheld-")));
  execSync(`git init -q && git remote add origin ${REMOTE}`, { cwd: dir, shell: "/bin/zsh" });
  const file = teamSettingsPath("acme");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    JSON.stringify({ repos: { [IDENTITY]: { "rt.worktrees": { onDeck: 1, ready: LADDER } } } }),
  );
  return dir;
}

describe("tray:status worktreeReadyHeld", () => {
  const REAL_HOME = process.env.HOME;

  beforeEach(() => {
    process.env.HOME = realpathSync(mkdtempSync(join(tmpdir(), "rttrayheld-home-")));
    resetHeldReadyLaddersCache();
  });

  afterEach(() => {
    if (REAL_HOME === undefined) delete process.env.HOME;
    else process.env.HOME = REAL_HOME;
  });

  test("a held team ladder is published with the repo and the hash to approve", async () => {
    const repoPath = repoWithTeamLadder();
    const h = createStatusHandlers(fakeCtx({ [IDENTITY]: repoPath }));

    const res = (await h["tray:status"]!({}, undefined as any)) as any;

    expect(res.data.worktreeReadyHeld).toEqual([
      { repo: IDENTITY, hash: readyLadderHash(LADDER) },
    ]);
  });

  test("an approved ladder publishes an empty list, not an omitted field", async () => {
    const repoPath = repoWithTeamLadder();
    writeReadyApproval(IDENTITY, readyLadderHash(LADDER));
    const h = createStatusHandlers(fakeCtx({ [IDENTITY]: repoPath }));

    const res = (await h["tray:status"]!({}, undefined as any)) as any;

    expect(res.data.worktreeReadyHeld).toEqual([]);
  });

  test("no registered repos publishes an empty list", async () => {
    const h = createStatusHandlers(fakeCtx({}));

    const res = (await h["tray:status"]!({}, undefined as any)) as any;

    expect(res.data.worktreeReadyHeld).toEqual([]);
  });
});
