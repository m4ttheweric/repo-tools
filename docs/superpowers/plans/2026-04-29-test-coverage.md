# Risk-First Test Coverage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a risk-first test safety net so agent-driven changes get fast feedback on core CLI, daemon, runner, notification, Git, persistence, and extension behavior.

**Architecture:** Keep tests close to the modules they protect and prefer dependency-injected helpers over whole-app integration tests. Start by making the default test command trustworthy, then add targeted unit and handler tests around the highest-risk logic. Use temporary directories and fake contexts for filesystem, Git, daemon, and VS Code boundaries.

**Tech Stack:** Bun test, TypeScript, temporary filesystem fixtures, real Git repos for parser/CLI boundary tests, fake daemon handler contexts, lightweight extension unit tests.

---

## Scope Check

The approved design covers several independent subsystems. This plan is organized as separately commit-able tasks so each subsystem can be implemented, reviewed, and verified independently while still following one risk-ranked rollout.

## File Structure

- `package.json`: expand root test scripts so agents run the real suite by default.
- `docs/testing.md`: document how to run tests, how to interpret the PTY smoke skip, and what test expectations apply to future agent work.
- `lib/__tests__/repo-config.test.ts`: cover per-repo config defaults, corrupt JSON, partial config merge, non-TTY first-run save, and save/load round trips.
- `lib/__tests__/parking-lot-config.test.ts`: cover parking-lot config defaults and save/load behavior through path-injected helpers.
- `lib/parking-lot-config.ts`: add optional path injection while preserving current default behavior.
- `lib/__tests__/git-ops.test.ts`: cover branch parsing, worktree branch parsing, detached HEAD handling, and Desktop-compatible stash discovery.
- `lib/__tests__/enrich.test.ts`: cover remote URL parsing and branch label formatting.
- `lib/notifier.ts`: expose transition detectors through `__test__` without changing production behavior.
- `lib/__tests__/notifier.test.ts`: expand notification transition coverage.
- `lib/daemon/__tests__/handlers.test.ts`: cover handler success and error envelopes with a fake `HandlerContext`.
- `lib/runner/__tests__/dispatch.test.ts`: expand runner dispatch coverage for lifecycle and cleanup actions.
- `lib/runner/keys/__tests__/*.test.ts`: expand keymap collision coverage for the remaining keymap modules.
- `extensions/vscode/rt-context/src/__tests__/branchParser.test.ts`: cover Linear ID and remote URL parsing.
- `extensions/vscode/rt-context/src/__tests__/cache.test.ts`: cover extension cache TTL and invalidation behavior.
- `extensions/vscode/rt-context/package.json`: add an extension-local test script.

---

### Task 1: Make Root Test Execution Trustworthy

**Files:**
- Modify: `package.json`
- Create: `docs/testing.md`

- [ ] **Step 1: Update root test scripts**

Change the `scripts` block in `package.json` to:

```json
{
  "test": "bun test commands/__tests__ lib/__tests__ lib/daemon/__tests__ lib/runner/__tests__ lib/runner/keys/__tests__",
  "test:watch": "bun test --watch commands/__tests__ lib/__tests__ lib/daemon/__tests__ lib/runner/__tests__ lib/runner/keys/__tests__",
  "test:coverage": "bun test --coverage commands/__tests__ lib/__tests__ lib/daemon/__tests__ lib/runner/__tests__ lib/runner/keys/__tests__"
}
```

- [ ] **Step 2: Create the testing policy doc**

Create `docs/testing.md` with:

~~~markdown
# Testing

Run the default suite:

```bash
bun test
```

Run the coverage suite:

```bash
bun run test:coverage
```

The PTY smoke test may skip when a real daemon already owns port `9401`. That skip is acceptable for normal unit-test runs. To run the smoke test against the live daemon, stop the daemon first or set `RT_PTY_TEST_ALLOW_REAL_DAEMON=1` intentionally.

## Agent-Driven Development Policy

- Changes to covered modules should update or add tests.
- Changes to uncovered modules should add tests when the module owns decision logic, persistence, process lifecycle, Git behavior, daemon routing, notifications, runner state, or extension parsing.
- Bug fixes should include a regression test that fails before the fix when the bug is reproducible.
- A change that cannot be tested should explain the reason in the pull request or commit notes.

## Confidence Signals

Coverage percentage is a trend, not the target. The main target is regression coverage for critical workflows.
~~~

- [ ] **Step 3: Verify default tests**

Run:

```bash
bun test
```

Expected: existing tests pass with `0 fail`. PTY smoke tests may skip with the documented port `9401` message.

- [ ] **Step 4: Verify coverage script**

Run:

```bash
bun run test:coverage
```

Expected: existing tests pass with `0 fail` and a coverage table is printed.

- [ ] **Step 5: Commit**

```bash
git add package.json docs/testing.md
git commit -m "test: run full bun suite by default"
```

---

### Task 2: Add Persistence and Config Tests

**Files:**
- Modify: `lib/parking-lot-config.ts`
- Create: `lib/__tests__/repo-config.test.ts`
- Create: `lib/__tests__/parking-lot-config.test.ts`

- [ ] **Step 1: Write failing repo config tests**

Create `lib/__tests__/repo-config.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  loadOrCreateRepoConfig,
  loadRepoConfig,
  saveRepoConfig,
} from "../repo-config.ts";

let tmp: string;
let originalIsTTY: boolean | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "rt-repo-config-test-"));
  originalIsTTY = process.stdin.isTTY;
});

afterEach(() => {
  Object.defineProperty(process.stdin, "isTTY", { value: originalIsTTY, configurable: true });
  rmSync(tmp, { recursive: true, force: true });
});

describe("loadRepoConfig", () => {
  test("returns defaults when config is missing", () => {
    expect(loadRepoConfig(tmp)).toEqual({
      setup: [],
      clean: [],
      startScript: "start",
      open: { base: "" },
    });
  });

  test("returns defaults when config JSON is corrupt", () => {
    writeFileSync(join(tmp, "config.json"), "{bad json");
    expect(loadRepoConfig(tmp)).toEqual({
      setup: [],
      clean: [],
      startScript: "start",
      open: { base: "" },
    });
  });

  test("merges partial config with defaults", () => {
    writeFileSync(join(tmp, "config.json"), JSON.stringify({ clean: ["rm -rf dist"] }));
    expect(loadRepoConfig(tmp)).toEqual({
      setup: [],
      clean: ["rm -rf dist"],
      startScript: "start",
      open: { base: "" },
    });
  });
});

describe("saveRepoConfig", () => {
  test("writes config that loadRepoConfig can read", () => {
    saveRepoConfig(tmp, {
      setup: [{ label: "deps", command: "pnpm install" }],
      clean: ["rm -rf .turbo"],
      startScript: "dev",
      open: { base: "http://localhost:3000" },
    });

    expect(loadRepoConfig(tmp)).toEqual({
      setup: [{ label: "deps", command: "pnpm install" }],
      clean: ["rm -rf .turbo"],
      startScript: "dev",
      open: { base: "http://localhost:3000" },
    });
  });
});

describe("loadOrCreateRepoConfig", () => {
  test("creates default config without launching wizard when stdin is not a TTY", async () => {
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });

    const config = await loadOrCreateRepoConfig(tmp, "/repo", "repo");

    expect(config).toEqual({
      setup: [],
      clean: [],
      startScript: "start",
      open: { base: "" },
    });
    expect(existsSync(join(tmp, "config.json"))).toBe(true);
    expect(JSON.parse(readFileSync(join(tmp, "config.json"), "utf8"))).toEqual(config);
  });
});
```

- [ ] **Step 2: Run repo config tests to verify current behavior**

Run:

```bash
bun test lib/__tests__/repo-config.test.ts
```

Expected: PASS. These tests document current behavior before changing config helpers.

- [ ] **Step 3: Add path injection to parking-lot config**

Change `lib/parking-lot-config.ts` to:

```ts
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { RT_DIR } from "./daemon-config.ts";

export const PARKING_LOT_CONFIG_PATH = join(RT_DIR, "parking-lot.json");

export interface ParkingLotConfig {
  enabled: boolean;
}

export function loadParkingLotConfig(path = PARKING_LOT_CONFIG_PATH): ParkingLotConfig {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    return { enabled: raw?.enabled !== false };
  } catch {
    return { enabled: true };
  }
}

export function saveParkingLotConfig(
  config: ParkingLotConfig,
  path = PARKING_LOT_CONFIG_PATH,
): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(config, null, 2));
  } catch { /* best-effort */ }
}
```

- [ ] **Step 4: Add parking-lot config tests**

Create `lib/__tests__/parking-lot-config.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  loadParkingLotConfig,
  saveParkingLotConfig,
} from "../parking-lot-config.ts";

let tmp: string;
let configPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "rt-parking-config-test-"));
  configPath = join(tmp, "parking-lot.json");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("loadParkingLotConfig", () => {
  test("defaults to enabled when file is missing", () => {
    expect(loadParkingLotConfig(configPath)).toEqual({ enabled: true });
  });

  test("defaults to enabled when JSON is corrupt", () => {
    writeFileSync(configPath, "{bad json");
    expect(loadParkingLotConfig(configPath)).toEqual({ enabled: true });
  });

  test("only explicit false disables parking-lot behavior", () => {
    writeFileSync(configPath, JSON.stringify({ enabled: false }));
    expect(loadParkingLotConfig(configPath)).toEqual({ enabled: false });

    writeFileSync(configPath, JSON.stringify({ enabled: null }));
    expect(loadParkingLotConfig(configPath)).toEqual({ enabled: true });
  });
});

describe("saveParkingLotConfig", () => {
  test("creates parent directory and round-trips config", () => {
    const nestedPath = join(tmp, "nested", "parking-lot.json");
    saveParkingLotConfig({ enabled: false }, nestedPath);
    expect(loadParkingLotConfig(nestedPath)).toEqual({ enabled: false });
  });
});
```

- [ ] **Step 5: Verify tests**

Run:

```bash
bun test lib/__tests__/repo-config.test.ts lib/__tests__/parking-lot-config.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/parking-lot-config.ts lib/__tests__/repo-config.test.ts lib/__tests__/parking-lot-config.test.ts
git commit -m "test: cover config persistence"
```

---

### Task 3: Add Git, Repo, and Enrichment Logic Tests

**Files:**
- Create: `lib/__tests__/git-ops.test.ts`
- Create: `lib/__tests__/enrich.test.ts`

- [ ] **Step 1: Add Git operation tests**

Create `lib/__tests__/git-ops.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  findDesktopStash,
  getCurrentBranch,
  getRemoteDefaultBranch,
  getWorktreeBranches,
  hasUncommittedChanges,
  listAllBranches,
  stashChanges,
} from "../git-ops.ts";

let tmp: string;

async function git(args: string[]) {
  const proc = Bun.spawn(["git", ...args], { cwd: tmp, stdout: "pipe", stderr: "pipe" });
  const code = await proc.exited;
  if (code !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${await new Response(proc.stderr).text()}`);
  }
}

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "rt-git-ops-test-"));
  await git(["init", "-q"]);
  await git(["config", "user.email", "test@example.com"]);
  await git(["config", "user.name", "Test User"]);
  writeFileSync(join(tmp, "README.md"), "hello\n");
  await git(["add", "README.md"]);
  await git(["commit", "-q", "-m", "init"]);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("git branch helpers", () => {
  test("getCurrentBranch returns the checked-out branch", () => {
    expect(getCurrentBranch(tmp)).toMatch(/^(main|master)$/);
  });

  test("getCurrentBranch returns null in detached HEAD", async () => {
    await git(["checkout", "-q", "HEAD~0"]);
    expect(getCurrentBranch(tmp)).toBeNull();
  });

  test("listAllBranches deduplicates local and origin refs by display name", async () => {
    await git(["checkout", "-q", "-b", "feature/test"]);
    const branches = listAllBranches(tmp);
    expect(branches.some((b) => b.name === "feature/test" && b.isLocal)).toBe(true);
  });

  test("getWorktreeBranches returns checked-out branch names", () => {
    const branches = getWorktreeBranches(tmp);
    expect([...branches].some((name) => name === "main" || name === "master")).toBe(true);
  });
});

describe("git working tree helpers", () => {
  test("hasUncommittedChanges detects modified files", () => {
    expect(hasUncommittedChanges(tmp)).toBe(false);
    writeFileSync(join(tmp, "README.md"), "changed\n");
    expect(hasUncommittedChanges(tmp)).toBe(true);
  });

  test("stashChanges writes a Desktop-compatible stash discoverable by branch", () => {
    const branch = getCurrentBranch(tmp)!;
    writeFileSync(join(tmp, "README.md"), "changed\n");
    stashChanges(tmp, branch);
    expect(findDesktopStash(tmp, branch)).toEqual({
      name: "stash@{0}",
      branchName: branch,
    });
  });

  test("getRemoteDefaultBranch returns null when no origin/main or origin/master exists", () => {
    expect(getRemoteDefaultBranch(tmp)).toBeNull();
  });
});
```

- [ ] **Step 2: Add enrichment pure-logic tests**

Create `lib/__tests__/enrich.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  formatBranchLabel,
  formatBranchLabelParts,
  parseRemoteUrl,
  type EnrichedBranch,
} from "../enrich.ts";

function branch(overrides: Partial<EnrichedBranch>): EnrichedBranch {
  return {
    path: "/repo",
    dirName: "repo",
    branch: "feature/ABC-123-test",
    linearId: "ABC-123",
    ticket: null,
    mr: null,
    ...overrides,
  };
}

describe("parseRemoteUrl", () => {
  test("parses SSH GitLab-style remotes", () => {
    expect(parseRemoteUrl("git@gitlab.example.com:org/project.git")).toEqual({
      host: "gitlab.example.com",
      projectPath: "org/project",
    });
  });

  test("parses HTTPS remotes", () => {
    expect(parseRemoteUrl("https://gitlab.example.com/org/project.git")).toEqual({
      host: "gitlab.example.com",
      projectPath: "org/project",
    });
  });

  test("returns null for unsupported remote strings", () => {
    expect(parseRemoteUrl("not-a-remote")).toBeNull();
  });
});

describe("formatBranchLabelParts", () => {
  test("includes ticket and MR state when present", () => {
    const parts = formatBranchLabelParts(branch({
      ticket: { identifier: "ABC-123", title: "Fix checkout", stateName: "In Progress" } as any,
      mr: { state: "opened", pipeline: { status: "success" } } as any,
    }));

    expect(parts.leading).toContain("repo");
    expect(parts.leading).toContain("Fix checkout");
    expect(parts.leading).toContain("[In Progress]");
    expect(parts.trailing.length).toBeGreaterThan(0);
  });

  test("falls back to branch name without ticket data", () => {
    const label = formatBranchLabel(branch({ linearId: null, ticket: null, mr: null }));
    expect(label).toContain("feature/ABC-123-test");
  });
});
```

- [ ] **Step 3: Verify tests**

Run:

```bash
bun test lib/__tests__/git-ops.test.ts lib/__tests__/enrich.test.ts
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add lib/__tests__/git-ops.test.ts lib/__tests__/enrich.test.ts
git commit -m "test: cover git and enrichment helpers"
```

---

### Task 4: Expand Notification Transition Coverage

**Files:**
- Modify: `lib/notifier.ts`
- Modify: `lib/__tests__/notifier.test.ts`

- [ ] **Step 1: Expose transition detectors for tests**

Modify the `__test__` export at the bottom of `lib/notifier.ts` to:

```ts
export const __test__ = {
  detectBranchTransitions,
  detectStalePortTransitions,
  shouldNotifyApprovalTransition,
  snapshotBranch,
};
```

- [ ] **Step 2: Add branch transition tests**

Append to `lib/__tests__/notifier.test.ts`:

```ts
describe("branch transition detection", () => {
  test("records a pipeline failure transition once", () => {
    const fired = new Set<string>();
    const logs: string[] = [];
    const prefs = { pipeline_failed: false } as any;

    __test__.detectBranchTransitions(
      {
        "feature/a": {
          pipelineStatus: "running",
          mrState: "opened",
          approved: false,
          approvedByUserIds: [],
          conflicts: false,
          needsRebase: false,
          isReady: false,
          mergeError: null,
          ticketState: null,
        },
      },
      {
        "feature/a": {
          ticket: null,
          linearId: "ABC-1",
          fetchedAt: 1,
          mr: {
            state: "opened",
            status: "opened",
            webUrl: "https://example.com/mr/1",
            pipeline: { status: "failed" },
            reviews: { isApproved: false, approvedBy: [] },
            blockers: { hasConflicts: false, needsRebase: false, mergeError: null },
            isReady: false,
          },
        },
      },
      fired,
      prefs,
      (msg) => logs.push(msg),
      null,
    );

    expect([...fired]).toEqual(["pipeline:failed:feature/a"]);
    expect(logs.some((msg) => msg.includes("pipeline failed"))).toBe(true);

    __test__.detectBranchTransitions(
      {
        "feature/a": {
          pipelineStatus: "running",
          mrState: "opened",
          approved: false,
          approvedByUserIds: [],
          conflicts: false,
          needsRebase: false,
          isReady: false,
          mergeError: null,
          ticketState: null,
        },
      },
      {
        "feature/a": {
          ticket: null,
          linearId: "ABC-1",
          fetchedAt: 2,
          mr: {
            state: "opened",
            status: "opened",
            webUrl: "https://example.com/mr/1",
            pipeline: { status: "failed" },
            reviews: { isApproved: false, approvedBy: [] },
            blockers: { hasConflicts: false, needsRebase: false, mergeError: null },
            isReady: false,
          },
        },
      },
      fired,
      prefs,
      (msg) => logs.push(msg),
      null,
    );

    expect([...fired]).toEqual(["pipeline:failed:feature/a"]);
    expect(logs.some((msg) => msg.includes("suppressed duplicate pipeline_failed"))).toBe(true);
  });

  test("skips branches when current MR data is null", () => {
    const fired = new Set<string>();
    const logs: string[] = [];

    __test__.detectBranchTransitions(
      {
        "feature/a": {
          pipelineStatus: "running",
          mrState: "opened",
          approved: false,
          approvedByUserIds: [],
          conflicts: false,
          needsRebase: false,
          isReady: false,
          mergeError: null,
          ticketState: null,
        },
      },
      {
        "feature/a": { ticket: null, linearId: "ABC-1", fetchedAt: 1, mr: null },
      },
      fired,
      { pipeline_failed: true } as any,
      (msg) => logs.push(msg),
      null,
    );

    expect([...fired]).toEqual([]);
    expect(logs).toEqual([]);
  });
});
```

- [ ] **Step 3: Add stale port transition test**

Append to `lib/__tests__/notifier.test.ts`:

```ts
describe("stale port transition detection", () => {
  test("marks stale ports once and prunes missing ports", () => {
    const now = Date.now();
    const ports: Record<string, any> = {
      "10:3000": {
        pid: 10,
        port: 3000,
        command: "dev",
        repo: "repo",
        branch: "main",
        relativeDir: ".",
        firstSeen: now - (25 * 60 * 60 * 1000),
        staleNotified: false,
      },
      "11:3001": {
        pid: 11,
        port: 3001,
        command: "old",
        repo: "repo",
        branch: "main",
        relativeDir: ".",
        firstSeen: now,
        staleNotified: false,
      },
    };
    const logs: string[] = [];

    __test__.detectStalePortTransitions(
      ports,
      [{ pid: 10, port: 3000, command: "dev", repo: "repo", branch: "main", relativeDir: "." } as any],
      { stale_port: false } as any,
      (msg) => logs.push(msg),
    );

    expect(ports["10:3000"].staleNotified).toBe(true);
    expect(ports["11:3001"]).toBeUndefined();
    expect(logs.some((msg) => msg.includes("stale port dev"))).toBe(true);
  });
});
```

- [ ] **Step 4: Verify notifier tests**

Run:

```bash
bun test lib/__tests__/notifier.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/notifier.ts lib/__tests__/notifier.test.ts
git commit -m "test: expand notification transition coverage"
```

---

### Task 5: Add Daemon Handler Coverage

**Files:**
- Create: `lib/daemon/__tests__/handlers.test.ts`

- [ ] **Step 1: Add fake handler context and process/cache/proxy/group tests**

Create `lib/daemon/__tests__/handlers.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { createCacheHandlers } from "../handlers/cache.ts";
import { createGroupsHandlers } from "../handlers/groups.ts";
import { createProcessHandlers } from "../handlers/process.ts";
import { createProxyHandlers } from "../handlers/proxy.ts";
import type { HandlerContext } from "../handlers/types.ts";

function ctx(overrides: Partial<HandlerContext> = {}): HandlerContext {
  const calls: any[] = [];
  return {
    processManager: {
      spawn: async (...args: any[]) => calls.push(["process.spawn", ...args]),
      kill: async (...args: any[]) => calls.push(["process.kill", ...args]),
      respawn: async (...args: any[]) => calls.push(["process.respawn", ...args]),
      remove: (...args: any[]) => calls.push(["process.remove", ...args]),
      list: () => [{ id: "p1" }],
      getSpawnConfig: () => ({ cwd: "/repo", cmd: "bun dev" }),
    } as any,
    stateStore: {
      getAll: () => ({ p1: "running" }),
      getState: (id: string) => id === "p1" ? "running" : "stopped",
      remove: (...args: any[]) => calls.push(["state.remove", ...args]),
    } as any,
    remedyEngine: {
      onSpawn: (...args: any[]) => calls.push(["remedy.onSpawn", ...args]),
      unregister: (...args: any[]) => calls.push(["remedy.unregister", ...args]),
    } as any,
    suspendManager: {
      suspend: async (...args: any[]) => calls.push(["suspend", ...args]),
      resume: async (...args: any[]) => calls.push(["resume", ...args]),
    } as any,
    proxyManager: {
      start: (...args: any[]) => calls.push(["proxy.start", ...args]),
      stop: (...args: any[]) => calls.push(["proxy.stop", ...args]),
      pause: (...args: any[]) => calls.push(["proxy.pause", ...args]),
      resume: (...args: any[]) => calls.push(["proxy.resume", ...args]),
      setUpstream: (...args: any[]) => calls.push(["proxy.setUpstream", ...args]),
      getStatus: (id: string) => ({ id, running: true }),
      list: () => [{ id: "proxy" }],
    } as any,
    attachServer: {
      close: (...args: any[]) => calls.push(["attach.close", ...args]),
      socketPath: (id: string) => `/tmp/${id}.sock`,
    } as any,
    logBuffer: {
      remove: (...args: any[]) => calls.push(["log.remove", ...args]),
      getLastLines: (id: string, n?: number) => [`${id}:${n ?? "all"}`],
    } as any,
    exclusiveGroup: {
      create: (...args: any[]) => calls.push(["group.create", ...args]),
      remove: (...args: any[]) => calls.push(["group.remove", ...args]),
      addMember: (...args: any[]) => calls.push(["group.addMember", ...args]),
      removeMember: (...args: any[]) => calls.push(["group.removeMember", ...args]),
      activate: async (...args: any[]) => calls.push(["group.activate", ...args]),
      list: () => [{ id: "g1" }],
      get: (id: string) => ({ id, members: [] }),
    } as any,
    cache: { entries: { main: { ticket: null, linearId: "ABC-1", mr: null, fetchedAt: 1 } } },
    refreshCache: async () => { calls.push(["refreshCache"]); },
    loadCache: () => calls.push(["loadCache"]),
    flushCache: () => calls.push(["flushCache"]),
    remedyEvents: [],
    portAllocator: {} as any,
    log: (msg: string) => calls.push(["log", msg]),
    startedAt: 1,
    portCacheRef: { ports: [], updatedAt: 0 },
    watchedConfigs: new Map(),
    repoIndex: () => ({}),
    checkAndRepairHooksPath: () => false,
    startWatchingRepo: () => {},
    refreshStatusRef: { lastRefreshAt: 0 },
    __calls: calls,
    ...overrides,
  } as HandlerContext & { __calls: any[] };
}

describe("process handlers", () => {
  test("process:spawn validates required fields", async () => {
    const handlers = createProcessHandlers(ctx());
    expect(await handlers["process:spawn"]({ id: "p1" })).toEqual({
      ok: false,
      error: "missing id, cmd, or cwd",
    });
  });

  test("process:remove tears down every per-process store", async () => {
    const fake = ctx() as HandlerContext & { __calls: any[] };
    const handlers = createProcessHandlers(fake);
    expect(await handlers["process:remove"]({ id: "p1" })).toEqual({ ok: true });
    expect(fake.__calls).toEqual([
      ["remedy.unregister", "p1"],
      ["attach.close", "p1"],
      ["log.remove", "p1"],
      ["process.remove", "p1"],
      ["state.remove", "p1"],
    ]);
  });
});

describe("cache handlers", () => {
  test("cache:read filters requested branches", async () => {
    const handlers = createCacheHandlers(ctx());
    expect(await handlers["cache:read"]({ branches: ["main", "missing"] })).toEqual({
      ok: true,
      data: { main: { ticket: null, linearId: "ABC-1", mr: null, fetchedAt: 1 } },
    });
  });
});

describe("proxy handlers", () => {
  test("proxy:start requires an initiator", async () => {
    const handlers = createProxyHandlers(ctx());
    expect(await handlers["proxy:start"]({ id: "p", canonicalPort: 3000, upstreamPort: 4000 })).toEqual({
      ok: false,
      error: "missing initiator",
    });
  });

  test("proxy:set-upstream calls proxy manager", async () => {
    const fake = ctx() as HandlerContext & { __calls: any[] };
    const handlers = createProxyHandlers(fake);
    expect(await handlers["proxy:set-upstream"]({ id: "p", port: 4000 })).toEqual({ ok: true });
    expect(fake.__calls).toContainEqual(["proxy.setUpstream", "p", 4000]);
  });
});

describe("group handlers", () => {
  test("group:add validates ids", async () => {
    const handlers = createGroupsHandlers(ctx());
    expect(await handlers["group:add"]({ groupId: "g1" })).toEqual({
      ok: false,
      error: "missing groupId or processId",
    });
  });
});
```

- [ ] **Step 2: Verify handler tests**

Run:

```bash
bun test lib/daemon/__tests__/handlers.test.ts
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add lib/daemon/__tests__/handlers.test.ts
git commit -m "test: cover daemon handler envelopes"
```

---

### Task 6: Expand Runner Dispatch and Keymap Coverage

**Files:**
- Modify: `lib/runner/__tests__/dispatch.test.ts`
- Modify/Create: `lib/runner/keys/__tests__/*.test.ts`

- [ ] **Step 1: Add dispatch cleanup tests**

Append to `lib/runner/__tests__/dispatch.test.ts`:

```ts
test("remove-entry clears remedy, process, group, port, and daemon-side process state", async () => {
  const lane = makeLane([
    makeEntry({ id: "a", targetDir: "/repo/a", worktree: "/repo/a", ephemeralPort: 4001 }),
    makeEntry({ id: "b", targetDir: "/repo/b", worktree: "/repo/b", ephemeralPort: 4002 }),
  ]);

  const patch = await dispatch(
    { type: "remove-entry", laneId: "1", entryId: "a" },
    { lanes: [lane], entryStates: new Map(), initiator: "test" },
  );

  expect(daemonCalls.map((c) => c.cmd)).toEqual([
    "remedy:clear",
    "process:kill",
    "group:remove-member",
    "port:release",
    "process:remove",
    "proxy:set-upstream",
  ]);

  const next = patch.mutate!([lane]);
  expect(next[0]!.entries.map((e) => e.id)).toEqual(["b"]);
  expect(next[0]!.activeEntryId).toBe("b");
});
```

- [ ] **Step 2: Add mode toggle dispatch test**

Append to `lib/runner/__tests__/dispatch.test.ts`:

```ts
test("toggle-mode flips warm to single and single to warm", async () => {
  const warmLane = { ...makeLane([]), mode: "warm" as const };
  const singleLane = { ...makeLane([]), mode: "single" as const };

  const warmPatch = await dispatch(
    { type: "toggle-mode", laneId: "1" },
    { lanes: [warmLane], entryStates: new Map(), initiator: "test" },
  );
  expect(warmPatch.mutate!([warmLane])[0]!.mode).toBe("single");

  const singlePatch = await dispatch(
    { type: "toggle-mode", laneId: "1" },
    { lanes: [singleLane], entryStates: new Map(), initiator: "test" },
  );
  expect(singlePatch.mutate!([singleLane])[0]!.mode).toBe("warm");
});
```

- [ ] **Step 3: Add keymap collision tests**

Create `lib/runner/keys/__tests__/scope-collisions.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { createConfirmResetKeymap, createConfirmSpreadKeymap } from "../confirm.ts";
import { createLaneKeymap } from "../lane.ts";
import { createOpenKeymap } from "../open.ts";
import { createPickerKeymap } from "../picker.ts";
import { createPortKeymap } from "../port.ts";

describe("scoped runner keymaps", () => {
  test("lane scope does not duplicate top-level quit or reset shortcuts", () => {
    const keys = createLaneKeymap({} as any);
    expect("q" in keys).toBe(false);
    expect("R" in keys).toBe(false);
    expect(typeof keys.escape).toBe("function");
  });

  test("picker scope keeps navigation local and leaves quit to escape", () => {
    const keys = createPickerKeymap({} as any);
    expect("q" in keys).toBe(false);
    expect(typeof keys.enter).toBe("function");
    expect(typeof keys.escape).toBe("function");
  });

  test("port scope only handles submit and escape", () => {
    const keys = createPortKeymap({} as any);
    expect(Object.keys(keys).sort()).toEqual(["enter", "escape"]);
  });

  test("open scope does not duplicate top-level quit", () => {
    const keys = createOpenKeymap({} as any);
    expect("q" in keys).toBe(false);
    expect(typeof keys.escape).toBe("function");
  });

  test("confirmation scopes expose only explicit confirm, deny, and escape", () => {
    expect(Object.keys(createConfirmResetKeymap({} as any)).sort()).toEqual(["escape", "n", "y"]);
    expect(Object.keys(createConfirmSpreadKeymap({} as any)).sort()).toEqual(["escape", "n", "y"]);
  });
});
```

- [ ] **Step 4: Verify runner tests**

Run:

```bash
bun test lib/runner/__tests__/dispatch.test.ts lib/runner/keys/__tests__
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/runner/__tests__/dispatch.test.ts lib/runner/keys/__tests__
git commit -m "test: expand runner action coverage"
```

---

### Task 7: Add VS Code Extension Pure Unit Tests

**Files:**
- Modify: `package.json`
- Modify: `extensions/vscode/rt-context/package.json`
- Create: `extensions/vscode/rt-context/src/__tests__/branchParser.test.ts`
- Create: `extensions/vscode/rt-context/src/__tests__/cache.test.ts`

- [ ] **Step 1: Add extension test script**

In `extensions/vscode/rt-context/package.json`, add:

```json
{
  "scripts": {
    "test": "bun test src/__tests__"
  }
}
```

Preserve the existing `build`, `watch`, `package`, and `install-local` scripts.

- [ ] **Step 2: Add branch parser tests**

Create `extensions/vscode/rt-context/src/__tests__/branchParser.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { extractLinearId, parseRemoteUrl } from "../branchParser.ts";

describe("extractLinearId", () => {
  test("extracts uppercase ticket id from branch segments", () => {
    expect(extractLinearId("feature/ABC-123-fix-login")).toBe("ABC-123");
  });

  test("normalizes lowercase ticket id to uppercase", () => {
    expect(extractLinearId("matt/abc-123-fix-login")).toBe("ABC-123");
  });

  test("returns null when no ticket id is present", () => {
    expect(extractLinearId("feature/no-ticket")).toBeNull();
  });
});

describe("parseRemoteUrl", () => {
  test("parses SSH remotes", () => {
    expect(parseRemoteUrl("git@gitlab.example.com:org/repo.git")).toEqual({
      host: "https://gitlab.example.com",
      projectPath: "org/repo",
    });
  });

  test("parses HTTPS remotes", () => {
    expect(parseRemoteUrl("https://gitlab.example.com/org/repo.git")).toEqual({
      host: "https://gitlab.example.com",
      projectPath: "org/repo",
    });
  });
});
```

- [ ] **Step 3: Add cache tests**

Create `extensions/vscode/rt-context/src/__tests__/cache.test.ts`:

```ts
import { describe, expect, mock, test } from "bun:test";

mock.module("vscode", () => ({}));

const { BranchListCache, PersistedCache } = await import("../cache.ts");

describe("PersistedCache", () => {
  test("stores, reads, and clears branch data", () => {
    const cache = new PersistedCache();
    cache.set("feature/a", { linearId: "ABC-1", ticket: null, mrUrl: null, fetchedAt: 1 });

    expect(cache.get("feature/a")).toEqual({
      linearId: "ABC-1",
      ticket: null,
      mrUrl: null,
      fetchedAt: 1,
    });

    cache.clear();
    expect(cache.get("feature/a")).toBeUndefined();
  });
});

describe("BranchListCache", () => {
  test("stores and clears branch list snapshots", () => {
    const cache = new BranchListCache();
    cache.set([{ name: "main", ref: "main", isLocal: true, commitEpoch: 1 }], ["main"]);

    expect(cache.get()?.branches).toEqual([{ name: "main", ref: "main", isLocal: true, commitEpoch: 1 }]);
    expect(cache.get()?.worktreeBranches).toEqual(["main"]);
    expect(typeof cache.get()?.savedAt).toBe("number");

    cache.clear();
    expect(cache.get()).toBeNull();
  });
});
```

- [ ] **Step 4: Verify extension tests**

Run:

```bash
cd extensions/vscode/rt-context
bun test src/__tests__
```

Expected: PASS.

- [ ] **Step 5: Add root extension test script**

In root `package.json`, add this script without changing the `test`, `test:watch`, or `test:coverage` scripts from Task 1:

```json
{
  "test:extension": "cd extensions/vscode/rt-context && bun test src/__tests__"
}
```

Then add `bun run test:extension` to the command list in `docs/testing.md`.

- [ ] **Step 6: Commit**

```bash
git add extensions/vscode/rt-context/package.json extensions/vscode/rt-context/src/__tests__ docs/testing.md package.json
git commit -m "test: add extension unit coverage"
```

---

### Task 8: Final Verification and Coverage Baseline

**Files:**
- Modify: `docs/testing.md`

- [ ] **Step 1: Run the full root suite**

Run:

```bash
bun test
```

Expected: `0 fail`. PTY smoke skips are acceptable only when they match the documented port `9401` live-daemon condition.

- [ ] **Step 2: Run root coverage**

Run:

```bash
bun run test:coverage
```

Expected: `0 fail` and coverage output includes the newly imported modules.

- [ ] **Step 3: Run extension tests**

Run:

```bash
cd extensions/vscode/rt-context
bun test src/__tests__
```

Expected: `0 fail`.

- [ ] **Step 4: Record the new baseline**

Append this section to `docs/testing.md`:

~~~markdown
## Current Baseline

After the first risk-first coverage pass, the required checks are:

```bash
bun test
bun run test:coverage
```

Also run the extension unit tests:

```bash
cd extensions/vscode/rt-context
bun test src/__tests__
```
~~~

- [ ] **Step 5: Commit**

```bash
git add docs/testing.md
git commit -m "docs: record test coverage baseline"
```
