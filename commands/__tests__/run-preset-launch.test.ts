import { afterEach, test, expect, mock } from "bun:test";
import { presetToSeed, launchPreset } from "../run.ts";
import type { Preset } from "../../lib/run-presets.ts";
import { __test__ as gate } from "../../lib/ui/gate.ts";

// mock.module mutates the live module namespace object IN PLACE (matches
// commands/__tests__/worktree.test.ts), so the real bindings must be
// captured BEFORE any mock.module call in this file, and restored with
// THOSE, not a fresh re-import of the module specifier.
//
// They are COPIES for that same reason: holding the namespace itself hands
// the restore an object the mock has already overwritten, so the stub
// outlives afterEach and leaks to every later suite in the process. A
// mocked herdrAvailable then answers true without touching a socket, and
// lib/herdr's own test sees an empty `seen`.
const realHerdrClient = { ...(await import("../../lib/herdr/client.ts")) };
const realHerdrLaunch = { ...(await import("../../lib/herdr-launch.ts")) };
const realRunner = { ...(await import("../runner.ts")) };

afterEach(() => {
  gate.setInteractive(undefined);
  mock.module("../../lib/herdr/client.ts", () => realHerdrClient);
  mock.module("../../lib/herdr-launch.ts", () => realHerdrLaunch);
  mock.module("../runner.ts", () => realRunner);
});

test("presetToSeed maps preset entries to seed entries", () => {
  const preset = {
    name: "backend-lite",
    entries: [
      { packageRelPath: "apps/web", packageLabel: "web", script: "dev" },
      {
        packageRelPath: "apps/api",
        packageLabel: "api",
        script: "start",
        command: "node server.js",
      },
    ],
  };
  const seed = presetToSeed(preset, "/home/me/repo");
  expect(seed).toEqual([
    {
      name: "dev",
      command: expect.stringContaining("run dev"),
      cwd: "/home/me/repo/apps/web",
      pkg: "web",
      repo: "repo",
    },
    {
      name: "start",
      command: "node server.js",
      cwd: "/home/me/repo/apps/api",
      pkg: "api",
      repo: "repo",
    },
  ]);
});

// Pins the regression: launchPreset used to route on herdrAvailable() alone,
// so a non-interactive caller (piped stdin, RT_BATCH) with the herdr daemon
// up hit the board's own `if (!interactive())` gate and hard-exited instead
// of ever reaching launchFallback.
test("non-interactive caller with herdr available falls back instead of routing to the board", async () => {
  gate.setInteractive(() => false);

  const fallbackCalls: unknown[][] = [];
  let boardCalled = false;
  mock.module("../../lib/herdr/client.ts", () => ({
    ...realHerdrClient,
    herdrAvailable: async () => true,
  }));
  mock.module("../../lib/herdr-launch.ts", () => ({
    ...realHerdrLaunch,
    launchFallback: (items: unknown[]) => {
      fallbackCalls.push(items);
    },
  }));
  mock.module("../runner.ts", () => ({
    ...realRunner,
    runSeededBoard: async () => {
      boardCalled = true;
    },
  }));

  const preset: Preset = {
    name: "backend-lite",
    entries: [
      { packageRelPath: "apps/web", packageLabel: "web", script: "dev" },
    ],
  };

  const exitSpy = mock(() => {
    throw new Error("unexpected exit");
  });
  const realExit = process.exit;
  process.exit = exitSpy as never;
  try {
    await launchPreset(preset, "/home/me/repo", {} as never);
  } finally {
    process.exit = realExit;
  }

  expect(fallbackCalls).toHaveLength(1);
  expect(boardCalled).toBe(false);
  expect(exitSpy).not.toHaveBeenCalled();
});
