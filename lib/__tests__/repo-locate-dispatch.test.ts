/**
 * lib/repo-locate-dispatch.ts's whole reason to exist is the daemon-vs-local
 * decision — a present daemon must hard-stop rather than fall through to a
 * local apply that would race the worktree reconciler holding the registry,
 * and "present" must come from liveness evidence (a live pid, or the socket
 * file existing), not a ping: an event-loop-stalled daemon fails a ping the
 * same way a dead one does, and treating that as "absent" would race the very
 * daemon still holding the registry. Both branches — and the true-absent
 * local branch — have no real daemon process to exercise them against, so
 * they are covered here by faking the transport and the presence checks.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { locateMovedRepo } from "../repo-locate-dispatch.ts";
import type { LocatePlan } from "../repo-locate.ts";

// Captured before any mock.module call — mock.module mutates the live
// namespace object in place, so restoring with the ORIGINAL bindings (not a
// re-import) is what undoes it for every other test file sharing this process.
const realDaemonClient = await import("../daemon-client.ts");
const realDaemonSocketQuery = realDaemonClient.daemonSocketQuery;

const realDaemonConfig = await import("../daemon-config.ts");
const realIsDaemonProcessRunning = realDaemonConfig.isDaemonProcessRunning;
const realSockPath = realDaemonConfig.DAEMON_SOCK_PATH;

const realRepoLocate = await import("../repo-locate.ts");
const realPlanLocate = realRepoLocate.planLocate;

/** A path guaranteed not to exist, for the "no socket file" half of presence. */
const NO_SOCKET_PATH = join(tmpdir(), "rt-locate-dispatch-test-no-such-socket");

afterEach(() => {
  mock.module("../daemon-client.ts", () => ({
    ...realDaemonClient,
    daemonSocketQuery: realDaemonSocketQuery,
  }));
  mock.module("../daemon-config.ts", () => ({
    ...realDaemonConfig,
    isDaemonProcessRunning: realIsDaemonProcessRunning,
    DAEMON_SOCK_PATH: realSockPath,
  }));
  mock.module("../repo-locate.ts", () => ({
    ...realRepoLocate,
    planLocate: realPlanLocate,
  }));
});

describe("locateMovedRepo: presence by pid, no answer", () => {
  test("a live pid with an unresponsive daemon hard-stops — planLocate never runs", async () => {
    let planLocateCalled = false;
    mock.module("../repo-locate.ts", () => ({
      ...realRepoLocate,
      planLocate: async () => {
        planLocateCalled = true;
        throw new Error("must not run planLocate — the daemon is holding the registry");
      },
    }));
    mock.module("../daemon-config.ts", () => ({
      ...realDaemonConfig,
      isDaemonProcessRunning: () => true,
      DAEMON_SOCK_PATH: NO_SOCKET_PATH,
    }));
    mock.module("../daemon-client.ts", () => ({
      ...realDaemonClient,
      daemonSocketQuery: async () => null, // event-loop stalled, or otherwise not answering
    }));

    const outcome = await locateMovedRepo({ newPath: "/wherever" });

    expect(planLocateCalled).toBe(false);
    expect(outcome).toEqual({
      via: "daemon",
      ok: false,
      error: "the rt daemon is present but did not answer repos:locate; not applying locally (would race the worktree reconciler) — check `rt daemon status` and retry",
    });
  });
});

describe("locateMovedRepo: presence by socket file, no answer", () => {
  test("a socket file with no live pid still hard-stops", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "rt-locate-dispatch-sock-"));
    const sockPath = join(scratch, "rt.sock");
    writeFileSync(sockPath, ""); // presence is decided by existence, not connectability
    let planLocateCalled = false;
    try {
      mock.module("../repo-locate.ts", () => ({
        ...realRepoLocate,
        planLocate: async () => {
          planLocateCalled = true;
          throw new Error("must not run planLocate — the daemon is holding the registry");
        },
      }));
      mock.module("../daemon-config.ts", () => ({
        ...realDaemonConfig,
        isDaemonProcessRunning: () => false, // pid file stale/absent
        DAEMON_SOCK_PATH: sockPath,
      }));
      mock.module("../daemon-client.ts", () => ({
        ...realDaemonClient,
        daemonSocketQuery: async () => null,
      }));

      const outcome = await locateMovedRepo({ newPath: "/wherever" });

      expect(planLocateCalled).toBe(false);
      expect(outcome).toEqual({
        via: "daemon",
        ok: false,
        error: "the rt daemon is present but did not answer repos:locate; not applying locally (would race the worktree reconciler) — check `rt daemon status` and retry",
      });
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

describe("locateMovedRepo: daemon transport, present and answering", () => {
  test("a daemon refusal surfaces its error verbatim", async () => {
    mock.module("../daemon-config.ts", () => ({
      ...realDaemonConfig,
      isDaemonProcessRunning: () => true,
      DAEMON_SOCK_PATH: NO_SOCKET_PATH,
    }));
    mock.module("../daemon-client.ts", () => ({
      ...realDaemonClient,
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
    mock.module("../daemon-config.ts", () => ({
      ...realDaemonConfig,
      isDaemonProcessRunning: () => true,
      DAEMON_SOCK_PATH: NO_SOCKET_PATH,
    }));
    mock.module("../daemon-client.ts", () => ({
      ...realDaemonClient,
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

describe("locateMovedRepo: daemon absent (no live pid, no socket file)", () => {
  test("takes the local path without ever calling the daemon transport", async () => {
    let daemonSocketQueryCalled = false;
    mock.module("../daemon-config.ts", () => ({
      ...realDaemonConfig,
      isDaemonProcessRunning: () => false,
      DAEMON_SOCK_PATH: NO_SOCKET_PATH,
    }));
    mock.module("../daemon-client.ts", () => ({
      ...realDaemonClient,
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
