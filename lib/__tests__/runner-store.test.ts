/**
 * runner-store unit tests.
 *
 * Covers the writable runner-config persistence layer:
 *   • saveRunnerConfig / loadRunnerConfig round-trip
 *   • saveRunnerConfig's mtime guard (refuses to clobber external edits)
 *   • acquireRunnerLock / releaseRunnerLock lifecycle
 *   • normalizeLane's legacy/compact input shapes
 *
 * Isolation strategy: runner-store.ts hard-codes `~/.rt/runners/` via
 * `homedir()`, which Bun does NOT override via runtime `process.env.HOME`
 * (homedir resolves once from /etc/passwd at process start). Rather than
 * modify source to add a path override, each test uses a uniquely-named
 * runner config (`rt-test-<tmpdir-basename>-<rand>`) and cleans up the
 * files it wrote. See test-scope comment below.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";
import {
  saveRunnerConfig,
  loadRunnerConfig,
  acquireRunnerLock,
  releaseRunnerLock,
  resetRunnerConfig,
  type LaneConfig,
} from "../runner-store.ts";

const RUNNERS_DIR = join(homedir(), ".rt", "runners");

/** Unique runner-config name per test to avoid colliding with real configs. */
function uniqueName(): string {
  return `rt-unit-test-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
}

const createdNames = new Set<string>();
function track(name: string): string {
  createdNames.add(name);
  return name;
}

/** Remove the runner file and sibling lock for one test's name, if present. */
function cleanup(name: string) {
  const runner = join(RUNNERS_DIR, `${name}.json`);
  const lock = join(RUNNERS_DIR, `.${name}.lock`);
  for (const p of [runner, lock]) {
    try { if (existsSync(p)) unlinkSync(p); } catch { /* */ }
  }
}

let scratchDir: string;
beforeEach(() => {
  scratchDir = mkdtempSync(join(tmpdir(), "rt-runner-store-test-"));
});

afterEach(() => {
  for (const name of createdNames) cleanup(name);
  createdNames.clear();
  rmSync(scratchDir, { recursive: true, force: true });
});

// ── normalizeLane (legacy/compact input shapes) ─────────────────────────────

describe("normalizeLane — on-disk shape normalization", () => {
  test("expanded (legacy) entry shape round-trips via save → load", () => {
    const name = track(uniqueName());

    const lane: LaneConfig = {
      id: "1",
      canonicalPort: 3000,
      entries: [{
        id: "primary",
        targetDir: join(scratchDir, "primary"),
        pm: "pnpm",
        script: "dev",
        packageLabel: "api",
        worktree: join(scratchDir, "primary"),
        branch: "main",
        ephemeralPort: 0,
        commandTemplate: "pnpm run dev",
      }],
      repoName: "my-repo",
      mode: "warm",
    };

    expect(saveRunnerConfig(name, [lane])).toBe(true);
    const loaded = loadRunnerConfig(name);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.id).toBe("1");
    expect(loaded[0]!.canonicalPort).toBe(3000);
    expect(loaded[0]!.repoName).toBe("my-repo");
    expect(loaded[0]!.mode).toBe("warm");
    expect(loaded[0]!.entries).toHaveLength(1);
    expect(loaded[0]!.entries[0]!.id).toBe("primary");
    expect(loaded[0]!.entries[0]!.commandTemplate).toBe("pnpm run dev");
  });

  test("compact entry shape (worktrees[]) expands on load", () => {
    const name = track(uniqueName());

    // Hand-craft a raw compact-format file — use writeFileSync directly to
    // bypass the save-time compaction path and prove load-time expansion.
    const runnerPath = join(RUNNERS_DIR, `${name}.json`);
    const raw = [{
      id: "1",
      canonicalPort: 3001,
      repoName: "r",
      mode: "warm",
      entries: [{
        pm: "pnpm",
        script: "dev",
        packagePath: "app",
        packageLabel: "web",
        commandTemplate: "pnpm start",
        worktrees: [
          { root: join(scratchDir, "wtA") },
          { root: join(scratchDir, "wtB") },
        ],
      }],
    }];

    writeFileSync(runnerPath, JSON.stringify(raw, null, 2));

    const lanes = loadRunnerConfig(name);
    expect(lanes).toHaveLength(1);
    expect(lanes[0]!.entries).toHaveLength(2);
    // worktreeEntryId defaults to basename for index 0
    const ids = lanes[0]!.entries.map((e) => e.id).sort();
    expect(ids).toEqual(["wtA", "wtB"]);
    expect(lanes[0]!.entries.every((e) => e.commandTemplate === "pnpm start")).toBe(true);
    expect(lanes[0]!.entries[0]!.targetDir.endsWith("/app")).toBe(true);
  });

  test("multi-command compact shape expands cross-product", () => {
    const name = track(uniqueName());
    const runnerPath = join(RUNNERS_DIR, `${name}.json`);

    const raw = [{
      id: "1",
      canonicalPort: 3002,
      repoName: "r",
      mode: "single",
      entries: [{
        pm: "bun",
        script: "dev",
        packagePath: "",
        packageLabel: "svc",
        commandTemplate: ["bun run dev", "bun run debug"],
        worktrees: [
          { root: join(scratchDir, "primary") },
        ],
      }],
    }];
    writeFileSync(runnerPath, JSON.stringify(raw, null, 2));

    const lanes = loadRunnerConfig(name);
    expect(lanes).toHaveLength(1);
    // 2 commands × 1 worktree = 2 entries
    expect(lanes[0]!.entries).toHaveLength(2);
    expect(lanes[0]!.entries[0]!.id).toBe("primary");     // cmd index 0, no suffix
    expect(lanes[0]!.entries[1]!.id).toBe("primary-1");   // cmd index 1, -1 suffix
    expect(lanes[0]!.entries[0]!.commandTemplate).toBe("bun run dev");
    expect(lanes[0]!.entries[1]!.commandTemplate).toBe("bun run debug");
    expect(lanes[0]!.mode).toBe("single");
  });

  test("unknown mode coerces to 'warm' (default)", () => {
    const name = track(uniqueName());
    const runnerPath = join(RUNNERS_DIR, `${name}.json`);

    writeFileSync(runnerPath, JSON.stringify([{
      id: "1",
      canonicalPort: 3003,
      repoName: "r",
      mode: "nonsense",
      entries: [],
    }]));

    const lanes = loadRunnerConfig(name);
    expect(lanes).toHaveLength(1);
    expect(lanes[0]!.mode).toBe("warm");
  });

  test("duplicate entry IDs within a lane are preserved as-is (no salt in this branch)", () => {
    // NOTE: the spec asked us to test a worktree-sha1-salted suffix for
    // duplicate entry IDs. That behavior does NOT exist in this branch of
    // runner-store.ts (normalizeLane does not detect or rewrite duplicates).
    // We document the current behavior here: duplicates survive the round-trip.
    const name = track(uniqueName());
    const runnerPath = join(RUNNERS_DIR, `${name}.json`);

    writeFileSync(runnerPath, JSON.stringify([{
      id: "1",
      canonicalPort: 3010,
      repoName: "r",
      mode: "warm",
      entries: [
        {
          id: "dup",
          targetDir: join(scratchDir, "one"),
          pm: "pnpm",
          script: "dev",
          packageLabel: "svc",
          worktree: join(scratchDir, "one"),
          branch: "",
          commandTemplate: "pnpm run dev",
        },
        {
          id: "dup",
          targetDir: join(scratchDir, "two"),
          pm: "pnpm",
          script: "dev",
          packageLabel: "svc",
          worktree: join(scratchDir, "two"),
          branch: "",
          commandTemplate: "pnpm run dev",
        },
      ],
    }]));

    const lanes = loadRunnerConfig(name);
    expect(lanes).toHaveLength(1);
    expect(lanes[0]!.entries).toHaveLength(2);
    const ids = lanes[0]!.entries.map((e) => e.id);
    // In this branch both entries keep id "dup" — no salt suffix applied.
    expect(ids).toEqual(["dup", "dup"]);
  });
});

// ── saveRunnerConfig / loadRunnerConfig round-trip ──────────────────────────

describe("saveRunnerConfig / loadRunnerConfig", () => {
  test("writes the file and round-trips entries through load", () => {
    const name = track(uniqueName());
    const lane: LaneConfig = {
      id: "2",
      canonicalPort: 4000,
      entries: [{
        id: "primary",
        targetDir: join(scratchDir, "primary"),
        pm: "npm",
        script: "start",
        packageLabel: "web",
        worktree: join(scratchDir, "primary"),
        branch: "main",
        ephemeralPort: 0,
        commandTemplate: "npm run start",
      }],
      repoName: "my-repo",
      mode: "single",
      activeEntryId: "primary",
    };

    expect(saveRunnerConfig(name, [lane])).toBe(true);

    const runnerPath = join(RUNNERS_DIR, `${name}.json`);
    expect(existsSync(runnerPath)).toBe(true);

    const loaded = loadRunnerConfig(name);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.canonicalPort).toBe(4000);
    expect(loaded[0]!.mode).toBe("single");
    expect(loaded[0]!.activeEntryId).toBe("primary");
  });

  test("resetRunnerConfig clears lanes to empty array", () => {
    const name = track(uniqueName());
    const lane: LaneConfig = {
      id: "1",
      canonicalPort: 4200,
      entries: [],
      repoName: "r",
      mode: "warm",
    };
    saveRunnerConfig(name, [lane]);
    expect(loadRunnerConfig(name)).toHaveLength(1);

    resetRunnerConfig(name);
    expect(loadRunnerConfig(name)).toEqual([]);
  });
});

// ── mtime guard ──────────────────────────────────────────────────────────────

describe("saveRunnerConfig mtime guard", () => {
  test("returns false when on-disk file is changed between load and save", () => {
    const name = track(uniqueName());
    const runnerPath = join(RUNNERS_DIR, `${name}.json`);

    const lane: LaneConfig = {
      id: "1",
      canonicalPort: 5000,
      entries: [],
      repoName: "r",
      mode: "warm",
    };

    // Initial write + load, so lastKnownMtimeMs is populated.
    expect(saveRunnerConfig(name, [lane])).toBe(true);
    const lanes = loadRunnerConfig(name);
    expect(lanes).toHaveLength(1);

    // Simulate an external writer modifying the file. We both rewrite and
    // bump the mtime by 2 seconds so the mtime is definitely different.
    writeFileSync(runnerPath, JSON.stringify([{ ...lane, canonicalPort: 9999 }]));
    const future = new Date(statSync(runnerPath).mtimeMs + 2000);
    utimesSync(runnerPath, future, future);

    // Now attempt to save our stale in-memory snapshot — must refuse.
    const result = saveRunnerConfig(name, [lane]);
    expect(result).toBe(false);

    // And the file must still contain the external writer's value.
    const onDisk = JSON.parse(require("fs").readFileSync(runnerPath, "utf8"));
    expect(onDisk[0].canonicalPort).toBe(9999);
  });
});

// ── acquireRunnerLock / releaseRunnerLock ───────────────────────────────────

describe("runner lock lifecycle", () => {
  test("acquire succeeds on a fresh name", () => {
    const name = track(uniqueName());
    const r = acquireRunnerLock(name, { pid: process.pid, startedAt: "2025-01-01T00:00:00Z" });
    expect(r).toEqual({ ok: true });
    const lockPath = join(RUNNERS_DIR, `.${name}.lock`);
    expect(existsSync(lockPath)).toBe(true);
  });

  test("second acquire from a different live pid returns existing holder", () => {
    const name = track(uniqueName());
    // Use this process's PID for the first holder — it is guaranteed live.
    const firstHolder = { pid: process.pid, startedAt: "2025-01-01T00:00:00Z", tmuxSession: "s1" };
    expect(acquireRunnerLock(name, firstHolder)).toEqual({ ok: true });

    // Pretend a different process tries to acquire. Use a pid that isn't ours.
    const otherPid = process.pid + 1;
    const result = acquireRunnerLock(name, { pid: otherPid, startedAt: "2025-01-01T00:00:01Z" });
    expect(result.ok).toBe(false);
    if (result.ok === false) {
      expect(result.holder.pid).toBe(process.pid);
      expect(result.holder.tmuxSession).toBe("s1");
    }
  });

  test("stale lock (dead pid) is reclaimed", () => {
    const name = track(uniqueName());
    const lockPath = join(RUNNERS_DIR, `.${name}.lock`);

    // Write a lock held by an impossibly-dead pid (very high number).
    writeFileSync(lockPath, JSON.stringify({ pid: 999999, startedAt: "2025-01-01" }));

    const r = acquireRunnerLock(name, { pid: process.pid, startedAt: "2025-01-01T00:00:00Z" });
    expect(r).toEqual({ ok: true });

    // Lock file now belongs to us.
    const held = JSON.parse(require("fs").readFileSync(lockPath, "utf8"));
    expect(held.pid).toBe(process.pid);
  });

  test("releaseRunnerLock removes the lock only for the owning pid", () => {
    const name = track(uniqueName());
    const lockPath = join(RUNNERS_DIR, `.${name}.lock`);
    acquireRunnerLock(name, { pid: process.pid, startedAt: "2025-01-01T00:00:00Z" });
    expect(existsSync(lockPath)).toBe(true);

    // Non-owning pid → no-op
    releaseRunnerLock(name, process.pid + 1);
    expect(existsSync(lockPath)).toBe(true);

    // Owning pid → released
    releaseRunnerLock(name, process.pid);
    expect(existsSync(lockPath)).toBe(false);
  });

  test("releaseRunnerLock is safe to call when no lock exists", () => {
    const name = track(uniqueName());
    expect(() => releaseRunnerLock(name, process.pid)).not.toThrow();
  });
});
