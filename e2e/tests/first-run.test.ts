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

  test("first run triggers post-install setup", async () => {
    expect(existsSync(join(home, ".mattstack", "rt", "daemon.json"))).toBe(false);

    // Use `daemon install` which enters the else block (triggering first-run)
    // and then directly runs the daemon install command, creating daemon.json.
    const result = await rtRaw(["daemon", "install"], { home });

    const combined = result.stdout + result.stderr;
    expect(combined).toContain("first run detected");
    expect(combined).toContain("post-install");

    expect(existsSync(join(home, ".mattstack", "rt", "daemon.json"))).toBe(true);
  }, 30_000);

  test("subsequent run skips setup", async () => {
    expect(existsSync(join(home, ".mattstack", "rt", "daemon.json"))).toBe(true);

    const result = await rtRaw(["daemon", "install"], { home });

    const combined = result.stdout + result.stderr;
    expect(combined).not.toContain("first run detected");
  }, 30_000);
});
