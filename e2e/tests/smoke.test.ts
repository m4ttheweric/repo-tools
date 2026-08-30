import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createTestHome, rt } from "../harness.ts";

describe("smoke", () => {
  let home: string;
  let cleanup: () => void;

  beforeAll(() => {
    ({ path: home, cleanup } = createTestHome());
  });

  afterAll(() => cleanup());

  test("rt --version prints version string", async () => {
    const result = await rt(["--version"], { home });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toMatch(/^rt /);
  });

  test("rt --help lists all top-level commands", async () => {
    const result = await rt(["--help"], { home });
    expect(result.exitCode).toBe(0);

    const output = result.stderr;
    const expectedCommands = [
      "git", "sync", "run", "commit",
      "port", "update", "version",
      "cd", "nav", "daemon", "settings", "hooks",
    ];
    for (const cmd of expectedCommands) {
      expect(output).toContain(cmd);
    }
  });

  test("rt git in non-TTY lists subcommands", async () => {
    const result = await rt(["git"], { home });
    expect(result.exitCode).toBe(0);

    const output = result.stderr;
    const expectedSubs = [
      "rebase", "reset", "commit",
      "backup", "restore", "pull", "push", "upstream",
    ];
    for (const sub of expectedSubs) {
      expect(output).toContain(sub);
    }
  });

  test("rt nonexistent exits non-zero with error", async () => {
    const result = await rt(["nonexistent"], { home });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("unknown command");
  });
});
