/**
 * cd-cache-refresh: the daemon's periodic tick that keeps cd-cache.json warm.
 * Covers the injectable-deps contract (includeMissing: true, write called
 * with the fetched rows, a debug log with rows/durationMs) and the never-
 * throws-out-of-the-tick guarantee independent of scheduleSweep's own wrap.
 */

import { describe, expect, mock, test } from "bun:test";
import { refreshCdCache } from "../cd-cache-refresh.ts";
import type { KnownRepo } from "../../repo-index.ts";

function fakeLogger() {
  const debugCalls: unknown[][] = [];
  const warnCalls: unknown[][] = [];
  return {
    debug: (...args: unknown[]) => { debugCalls.push(args); },
    warn: (...args: unknown[]) => { warnCalls.push(args); },
    debugCalls,
    warnCalls,
  };
}

const sampleRepos: KnownRepo[] = [
  { repoName: "repo-tools", worktrees: [{ path: "/repos/repo-tools", branch: "main", isBare: false }], dataDir: "/data/repo-tools" },
];

describe("refreshCdCache", () => {
  test("fetches with includeMissing: true and writes the result", async () => {
    const getKnownRepos = mock(async (_opts?: { includeMissing?: boolean }) => sampleRepos);
    const writeCache = mock((_repos: KnownRepo[]) => {});
    const log = fakeLogger();

    await refreshCdCache(log as unknown as Parameters<typeof refreshCdCache>[0], { getKnownRepos, writeCache });

    expect(getKnownRepos).toHaveBeenCalledTimes(1);
    expect(getKnownRepos.mock.calls[0]?.[0]).toEqual({ includeMissing: true });
    expect(writeCache).toHaveBeenCalledTimes(1);
    expect(writeCache.mock.calls[0]?.[0]).toEqual(sampleRepos);
  });

  test("logs a debug domain event with rows and durationMs, not an outcome line", async () => {
    const getKnownRepos = mock(async () => sampleRepos);
    const writeCache = mock((_repos: KnownRepo[]) => {});
    const log = fakeLogger();
    let tick = 0;
    const now = () => { tick += 5; return tick; };

    await refreshCdCache(log as unknown as Parameters<typeof refreshCdCache>[0], { getKnownRepos, writeCache, now });

    expect(log.debugCalls).toHaveLength(1);
    const [payload] = log.debugCalls[0]!;
    expect(payload).toEqual({ rows: sampleRepos.length, durationMs: 5 });
    expect(log.warnCalls).toHaveLength(0);
  });

  test("never throws when the repo fetch rejects", async () => {
    const getKnownRepos = mock(async () => { throw new Error("boom"); });
    const writeCache = mock((_repos: KnownRepo[]) => {});
    const log = fakeLogger();

    await expect(
      refreshCdCache(log as unknown as Parameters<typeof refreshCdCache>[0], { getKnownRepos, writeCache }),
    ).resolves.toBeUndefined();

    expect(writeCache).not.toHaveBeenCalled();
    expect(log.warnCalls).toHaveLength(1);
  });
});
