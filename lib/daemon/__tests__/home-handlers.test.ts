/**
 * home:snapshot / home:snapshot-status — direct factory tests.
 * Pattern mirrors settings-handlers.test.ts: call the handler map directly
 * against a fake HomeSnapshotHandle, no daemon process and no real git.
 */

import { describe, expect, test } from "bun:test";
import { createHomeHandlers } from "../handlers/home.ts";
import type { HomeSnapshotHandle, SnapshotReason, SnapshotResult, SnapshotStatus } from "../home-snapshot.ts";

function fakeHandle(overrides: Partial<HomeSnapshotHandle> = {}): { handle: HomeSnapshotHandle; runNowCalls: SnapshotReason[] } {
  const runNowCalls: SnapshotReason[] = [];
  const result: SnapshotResult = { committed: true, sha: "deadbeef", paths: ["notes.md"], reason: "manual" };
  const status: SnapshotStatus = {
    enabled: true,
    watching: true,
    repoDir: "/fake/repo",
    lastRunAt: 123,
    lastCommit: { sha: "deadbeef", message: "snapshot: notes.md", at: 123 },
    lastCommitError: null,
    pushPending: false,
    lastPushAt: 123,
    lastPushError: null,
    claimedZones: ["prefs/"],
    firstSeenDirty: {},
    ownersError: null,
  };
  const handle: HomeSnapshotHandle = {
    stop: () => {},
    ready: Promise.resolve(),
    runNow: async (reason) => { runNowCalls.push(reason); return result; },
    status: () => status,
    ...overrides,
  };
  return { handle, runNowCalls };
}

describe("home handlers", () => {
  test("home:snapshot always triggers a 'manual' run regardless of payload", async () => {
    const { handle, runNowCalls } = fakeHandle();
    const handlers = createHomeHandlers(handle);

    const r = await handlers["home:snapshot"]({ reason: "manual" });

    expect(runNowCalls).toEqual(["manual"]);
    expect(r).toMatchObject({ ok: true, data: { committed: true, sha: "deadbeef" } });
  });

  test("home:snapshot ignores an absent/garbage payload — still runs manual", async () => {
    const { handle, runNowCalls } = fakeHandle();
    const handlers = createHomeHandlers(handle);

    await handlers["home:snapshot"](undefined);
    await handlers["home:snapshot"]({ reason: "janitor" });

    expect(runNowCalls).toEqual(["manual", "manual"]);
  });

  test("home:snapshot-status returns the handle's live status", async () => {
    const { handle } = fakeHandle();
    const handlers = createHomeHandlers(handle);

    const r = await handlers["home:snapshot-status"]({});

    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({ enabled: true, repoDir: "/fake/repo", claimedZones: ["prefs/"] });
  });

  test("home:snapshot-status surfaces a fail-closed owners error", async () => {
    const { handle } = fakeHandle({
      status: () => ({
        enabled: true, watching: true, repoDir: "/fake/repo", lastRunAt: 0, lastCommit: null, lastCommitError: null,
        pushPending: false, lastPushAt: 0, lastPushError: null,
        claimedZones: [], firstSeenDirty: {}, ownersError: "malformed jsonc",
      }),
    });
    const handlers = createHomeHandlers(handle);

    const r = await handlers["home:snapshot-status"]({});

    expect(r.data.ownersError).toBe("malformed jsonc");
  });
});
