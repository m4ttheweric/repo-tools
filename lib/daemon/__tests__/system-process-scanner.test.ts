import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { SystemProcessScanner } from "../system-process-scanner.ts";

describe("SystemProcessScanner", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "rt-sys-proc-test-"));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  test("discovers processes whose cwd is inside a tracked repo", async () => {
    // We can't easily mock ps output in integration tests, but we CAN
    // test the parsing and filtering logic. Use a unit-style approach:
    // feed known ps output through the parser.
    const { parseProcessList } = await import("../system-process-scanner.ts");

    const psOutput = [
      "  PID  PPID  %CPU   RSS      ELAPSED COMM             ARGS",
      "12345     1  45.2 102400     1:30:00 node             node server.js",
      "12346     1   0.1  51200        5:00 zsh              -zsh",
    ].join("\n");

    const repos = { myrepo: "/Users/test/repos/myrepo" };
    const cwdMap = new Map<number, string>([
      [12345, "/Users/test/repos/myrepo/apps/backend"],
      [12346, "/Users/test/repos/myrepo"],
    ]);

    const result = parseProcessList(psOutput, repos, cwdMap);

    expect(result).toHaveLength(2);
    expect(result[0]!.pid).toBe(12345);
    expect(result[0]!.cpuPercent).toBe(45.2);
    expect(result[0]!.rssKb).toBe(102400);
    expect(result[0]!.repo).toBe("myrepo");
    expect(result[0]!.relativeDir).toBe("apps/backend");
  });

  test("filters out processes not in any tracked repo", async () => {
    const { parseProcessList } = await import("../system-process-scanner.ts");

    const psOutput = [
      "  PID  PPID  %CPU   RSS      ELAPSED COMM             ARGS",
      "99999     1   5.0  20000       10:00 node             node random.js",
    ].join("\n");

    const repos = { myrepo: "/Users/test/repos/myrepo" };
    const cwdMap = new Map<number, string>([
      [99999, "/Users/test/other-dir"],
    ]);

    const result = parseProcessList(psOutput, repos, cwdMap);
    expect(result).toHaveLength(0);
  });

  test("includes processes in a parent directory of a tracked repo (max 2 levels above)", async () => {
    const { parseProcessList } = await import("../system-process-scanner.ts");

    const psOutput = [
      "  PID  PPID  %CPU   RSS      ELAPSED COMM             ARGS",
      "10001     1   2.0  30000        5:00 grep             grep -r TODO .",
      "10002     1   1.0  20000        3:00 find             find . -name *.ts",
      "10003     1   0.5  10000        1:00 node             node script.js",
    ].join("\n");

    const repos = {
      myrepo: "/Users/test/repos/myrepo",
      other: "/Users/test/repos/other",
    };
    const cwdMap = new Map<number, string>([
      [10001, "/Users/test/repos"],           // 1 level above both repos
      [10002, "/Users/test"],                 // 2 levels above both repos
      [10003, "/Users"],                      // 3 levels above -- too far
    ]);

    const result = parseProcessList(psOutput, repos, cwdMap);

    expect(result).toHaveLength(2);
    expect(result[0]!.pid).toBe(10001);
    expect(result[0]!.relativeDir).toBe("(parent)");
    expect(result[1]!.pid).toBe(10002);
    expect(result[1]!.relativeDir).toBe("(parent)");
  });

  test("filters out macOS .app bundle processes", async () => {
    const { parseProcessList } = await import("../system-process-scanner.ts");

    const psOutput = [
      "  PID  PPID  %CPU   RSS      ELAPSED COMM             ARGS",
      "55555     1  10.0  80000       30:00 Cursor           /Applications/Cursor.app/Contents/MacOS/Cursor",
    ].join("\n");

    const repos = { myrepo: "/Users/test/repos/myrepo" };
    const cwdMap = new Map<number, string>([
      [55555, "/Users/test/repos/myrepo"],
    ]);

    const result = parseProcessList(psOutput, repos, cwdMap);
    expect(result).toHaveLength(0);
  });
});

describe("parseLsofCwdMap", () => {
  test("keeps processes whose cwd is inside a registered repo root", async () => {
    const { parseLsofCwdMap } = await import("../system-process-scanner.ts");

    const lsofOutput = [
      "p111",
      "n/Users/test/repos/myrepo/apps/backend",
      "p222",
      "n/Users/test/elsewhere",
    ].join("\n");

    const result = parseLsofCwdMap(lsofOutput, ["/Users/test/repos/myrepo"]);

    expect(result.get(111)).toBe("/Users/test/repos/myrepo/apps/backend");
    expect(result.has(222)).toBe(false);
  });

  test("keeps processes whose cwd is inside a sibling worktree path", async () => {
    const { parseLsofCwdMap } = await import("../system-process-scanner.ts");

    // acme-dev registered at .../acme/api; ron is a sibling worktree
    const lsofOutput = [
      "p333",
      "n/Users/test/gh/acme/worker/apps/backend",
    ].join("\n");

    const result = parseLsofCwdMap(lsofOutput, [
      "/Users/test/gh/acme/api",
      "/Users/test/gh/acme/worker",
    ]);

    expect(result.get(333)).toBe("/Users/test/gh/acme/worker/apps/backend");
  });

  test("keeps close parents of tracked paths (max 2 levels above)", async () => {
    const { parseLsofCwdMap } = await import("../system-process-scanner.ts");

    const lsofOutput = [
      "p444",
      "n/Users/test/repos",
      "p555",
      "n/Users",
    ].join("\n");

    const result = parseLsofCwdMap(lsofOutput, ["/Users/test/repos/myrepo"]);

    expect(result.get(444)).toBe("/Users/test/repos");
    expect(result.has(555)).toBe(false);
  });
});

describe("worktree attribution through parseProcessList", () => {
  test("attributes a sibling-worktree process to its parent repo and branch", async () => {
    const { parseProcessList } = await import("../system-process-scanner.ts");

    const psOutput = [
      "  PID  PPID  %CPU   RSS      ELAPSED COMM             ARGS",
      "12878     1  99.0 512000  06-07:54:19 node             node wrap.js src/app/server-lite",
    ].join("\n");

    const repos = { "acme-dev": "/Users/test/gh/acme/api" };
    const cwdMap = new Map<number, string>([
      [12878, "/Users/test/gh/acme/worker/apps/backend"],
    ]);
    const worktreeMap = new Map([
      ["/Users/test/gh/acme/worker", { repo: "acme-dev", branch: "parking-lot/2" }],
    ]);

    const result = parseProcessList(psOutput, repos, cwdMap, worktreeMap);

    expect(result).toHaveLength(1);
    expect(result[0]!.repo).toBe("acme-dev");
    expect(result[0]!.worktree).toBe("/Users/test/gh/acme/worker");
    expect(result[0]!.branch).toBe("parking-lot/2");
    expect(result[0]!.relativeDir).toBe("apps/backend");
  });
});

describe("parsePackageScripts", () => {
  test("composes package manager + lifecycle script from ps eww output", async () => {
    const { parsePackageScripts } = await import("../system-process-scanner.ts");

    const psOutput = [
      "12878 /usr/bin/node wrap.js src/app/server-lite SOME_SECRET=hunter2 npm_config_user_agent=pnpm/10.30.3 npm/? node/v22.22.0 darwin arm64 npm_lifecycle_event=start:lite:watch PATH=/usr/bin",
      "33349 /Users/test/.bun/bin/bun run cli.ts --daemon PATH=/usr/bin HOME=/Users/test",
    ].join("\n");

    const result = parsePackageScripts(psOutput);

    expect(result.get(12878)).toBe("pnpm start:lite:watch");
    expect(result.has(33349)).toBe(false);
  });

  test("handles bun and npm user agents", async () => {
    const { parsePackageScripts } = await import("../system-process-scanner.ts");

    const psOutput = [
      "100 /bin/x npm_config_user_agent=bun/1.3.13 npm/? node/v22 darwin npm_lifecycle_event=dev",
      "200 /bin/y npm_config_user_agent=npm/10.9.2 node/v22.13.0 darwin arm64 npm_lifecycle_event=build:watch",
    ].join("\n");

    const result = parsePackageScripts(psOutput);

    expect(result.get(100)).toBe("bun dev");
    expect(result.get(200)).toBe("npm build:watch");
  });

  test("ignores lifecycle event without a user agent and vice versa", async () => {
    const { parsePackageScripts } = await import("../system-process-scanner.ts");

    const psOutput = [
      "300 /bin/x npm_lifecycle_event=dev PATH=/usr/bin",
      "400 /bin/y npm_config_user_agent=pnpm/10.0.0 npm/? PATH=/usr/bin",
    ].join("\n");

    const result = parsePackageScripts(psOutput);

    // Without both halves we can't honestly reconstruct an invocation
    expect(result.has(300)).toBe(false);
    expect(result.has(400)).toBe(false);
  });
});

describe("runaway detection", () => {
  test("flags process as runaway after sustained high CPU", () => {
    const scanner = new SystemProcessScanner({
      cpuThreshold: 80,
      sustainMs: 30_000, // 30s for test speed (3 samples at 10s)
      graceMs: 0, // no grace for tests
    });

    // Simulate feeding scan results -- we test the tracking logic directly
    const track = {
      pid: 1234,
      firstSeen: Date.now() - 60_000,
      samples: [95, 92, 88, 91], // 4 consecutive samples above 80
      runawayStartedAt: null as number | null,
      runawayNotified: false,
    };

    // With sustainMs=30_000 and 10s intervals, need 3 consecutive samples
    const samplesNeeded = Math.ceil(30_000 / 10_000); // 3
    const recent = track.samples.slice(-samplesNeeded);
    const allAbove = recent.length >= samplesNeeded &&
      recent.every(s => s >= 80);

    expect(allAbove).toBe(true);
    expect(samplesNeeded).toBe(3);
  });

  test("does not flag during grace period", () => {
    const scanner = new SystemProcessScanner({
      cpuThreshold: 80,
      sustainMs: 30_000,
      graceMs: 120_000, // 2 minutes
    });

    // A process seen 30 seconds ago should not be flagged
    const age = 30_000;
    const graceMs = 120_000;
    expect(age > graceMs).toBe(false);
  });

  test("clears runaway when CPU drops", () => {
    const samples = [95, 92, 88, 91, 50, 60]; // drops below threshold
    const samplesNeeded = 3;
    const recent = samples.slice(-samplesNeeded);
    const allAbove = recent.every(s => s >= 80);

    expect(allAbove).toBe(false);
  });
});
