import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync } from "fs";
import { join } from "path";
import { createTestHome, rtRaw } from "../harness.ts";

describe("first-run", () => {
  let home: string;
  let cleanup: () => void;

  beforeAll(() => {
    ({ path: home, cleanup } = createTestHome());
  });

  afterAll(() => cleanup());

  test("first run prints the not-set-up hint; the requested command still runs", async () => {
    expect(existsSync(join(home, ".mattstack", "rt", "daemon.json"))).toBe(false);

    // `daemon` isn't in the hint's skip list, so it triggers the hint; `daemon
    // install` itself (not the hook) is what then creates daemon.json.
    const result = await rtRaw(["daemon", "install"], { home });

    const combined = result.stdout + result.stderr;
    expect(combined).toContain("rt is not set up yet");
    expect(combined).toContain("rt setup");

    expect(existsSync(join(home, ".mattstack", "rt", "daemon.json"))).toBe(true);
  }, 30_000);

  test("subsequent run skips the hint", async () => {
    expect(existsSync(join(home, ".mattstack", "rt", "daemon.json"))).toBe(true);

    const result = await rtRaw(["daemon", "install"], { home });

    const combined = result.stdout + result.stderr;
    expect(combined).not.toContain("rt is not set up yet");
  }, 30_000);
});
