/**
 * lib/repo-locate-dispatch.ts's whole reason to exist is the daemon-vs-local
 * decision — a daemon that is up but unresponsive must hard-stop, never fall
 * through to a local apply that would race the worktree reconciler holding
 * the registry. That branch has no real daemon to exercise it against, so it
 * is covered here by faking the transport.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { locateMovedRepo } from "../repo-locate-dispatch.ts";
import type { LocatePlan } from "../repo-locate.ts";

// Captured before any mock.module call — mock.module mutates the live
// namespace object in place, so restoring with the ORIGINAL bindings (not a
// re-import) is what undoes it for every other test file sharing this process.
const realDaemonClient = await import("../daemon-client.ts");
const realIsDaemonRunning = realDaemonClient.isDaemonRunning;
const realDaemonSocketQuery = realDaemonClient.daemonSocketQuery;

const realRepoLocate = await import("../repo-locate.ts");
const realPlanLocate = realRepoLocate.planLocate;

afterEach(() => {
  mock.module("../daemon-client.ts", () => ({
    ...realDaemonClient,
    isDaemonRunning: realIsDaemonRunning,
    daemonSocketQuery: realDaemonSocketQuery,
  }));
  mock.module("../repo-locate.ts", () => ({
    ...realRepoLocate,
    planLocate: realPlanLocate,
  }));
});

describe("locateMovedRepo: daemon up but unresponsive is a hard stop", () => {
  test("never falls through to a local apply", async () => {
    let planLocateCalled = false;
    mock.module("../repo-locate.ts", () => ({
      ...realRepoLocate,
      planLocate: async () => {
        planLocateCalled = true;
        throw new Error("must not run planLocate — the daemon is holding the registry");
      },
    }));
    mock.module("../daemon-client.ts", () => ({
      ...realDaemonClient,
      isDaemonRunning: async () => true,
      daemonSocketQuery: async () => null, // timed out / no response
    }));

    const outcome = await locateMovedRepo({ newPath: "/wherever" });

    expect(planLocateCalled).toBe(false);
    expect(outcome).toEqual({
      via: "daemon",
      ok: false,
      error: "the rt daemon is running but did not answer repos:locate — not applying locally, which would race the worktree reconciler",
    });
  });
});

describe("locateMovedRepo: daemon transport", () => {
  test("a daemon refusal surfaces its error verbatim", async () => {
    mock.module("../daemon-client.ts", () => ({
      ...realDaemonClient,
      isDaemonRunning: async () => true,
      daemonSocketQuery: async () => ({ ok: false, error: "not-a-git-repo: /wherever is not a git repository" }),
    }));

    const outcome = await locateMovedRepo({ newPath: "/wherever" });

    expect(outcome).toEqual({ via: "daemon", ok: false, error: "not-a-git-repo: /wherever is not a git repository" });
  });

  test("a dry-run success unwraps the plan from the envelope", async () => {
    const plan: LocatePlan = {
      identity: "path:%2Fx",
      oldPath: "/old",
      newPath: "/new",
      indexKeys: ["path:%2Fx"],
      legacyKeys: [],
      registryRewrites: [],
      claimRewrites: [],
      gitRepairPaths: [],
    };
    let sentPayload: Record<string, unknown> | undefined;
    mock.module("../daemon-client.ts", () => ({
      ...realDaemonClient,
      isDaemonRunning: async () => true,
      daemonSocketQuery: async (_cmd: string, payload?: Record<string, unknown>) => {
        sentPayload = payload;
        return { ok: true, data: { dryRun: true, plan } };
      },
    }));

    const outcome = await locateMovedRepo({ newPath: "/new", repo: "path:%2Fx", dryRun: true });

    expect(outcome).toEqual({ via: "daemon", ok: true, dryRun: true, plan });
    expect(sentPayload).toEqual({ newPath: "/new", repo: "path:%2Fx", dryRun: true });
  });
});

describe("locateMovedRepo: no daemon running", () => {
  test("takes the local path without ever calling the daemon transport", async () => {
    let daemonSocketQueryCalled = false;
    mock.module("../daemon-client.ts", () => ({
      ...realDaemonClient,
      isDaemonRunning: async () => false,
      daemonSocketQuery: async () => {
        daemonSocketQueryCalled = true;
        return null;
      },
    }));
    mock.module("../repo-locate.ts", () => ({
      ...realRepoLocate,
      planLocate: async () => ({ refusal: "not-a-git-repo" as const, message: "/wherever is not a git repository" }),
    }));

    const outcome = await locateMovedRepo({ newPath: "/wherever" });

    expect(daemonSocketQueryCalled).toBe(false);
    expect(outcome).toEqual({ via: "local", ok: false, error: "not-a-git-repo: /wherever is not a git repository" });
  });
});
