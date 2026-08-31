import { test, expect } from "bun:test";
import { presetToSeed } from "../run.ts";

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
