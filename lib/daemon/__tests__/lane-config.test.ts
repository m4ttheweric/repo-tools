/**
 * lane-config read-path tests.
 *
 * Ported from the deleted runner-store tests: only the load/normalize path
 * survives (the runner TUI and its save path are gone), so these pin the
 * on-disk shapes the daemon still consumes — compact entry expansion,
 * command menus, legacy pm/script fallback, id collision salting, and the
 * tunnel flag read by the tunnel subsystem.
 *
 * Isolation strategy: lane-config.ts hard-codes `~/.rt/runners/` via
 * `homedir()`, which Bun does NOT override via runtime `process.env.HOME`
 * (homedir resolves once from /etc/passwd at process start). Rather than
 * modify source to add a path override, each test uses a uniquely-named
 * runner config (`rt-unit-test-<pid>-<rand>`) and cleans up the files it wrote.
 */

import { describe, test, expect, afterEach } from "bun:test";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import {
  loadRunnerConfig,
  normalizeLane,
  collectRunnerPortLabels,
  entryWindowName,
  proxyWindowName,
} from "../lane-config.ts";

const RUNNERS_DIR = join(homedir(), ".rt", "runners");

/** Unique runner-config name per test to avoid colliding with real configs. */
function uniqueName(): string {
  return `rt-unit-test-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
}

const createdNames = new Set<string>();
function writeRawConfig(raw: unknown): string {
  const name = uniqueName();
  createdNames.add(name);
  mkdirSync(RUNNERS_DIR, { recursive: true });
  writeFileSync(join(RUNNERS_DIR, `${name}.json`), JSON.stringify(raw, null, 2));
  return name;
}

afterEach(() => {
  for (const name of createdNames) {
    const p = join(RUNNERS_DIR, `${name}.json`);
    try { if (existsSync(p)) unlinkSync(p); } catch { /* */ }
  }
  createdNames.clear();
});

describe("loadRunnerConfig — on-disk shape normalization", () => {
  test("singular compact entry shape (worktrees[]) expands on load", () => {
    const name = writeRawConfig([{
      id: "1",
      canonicalPort: 3001,
      repoName: "r",
      mode: "warm",
      entry: {
        packagePath: "app",
        packageLabel: "web",
        commandTemplate: "pnpm start",
        worktrees: [
          { root: "/scratch/wtA" },
          { root: "/scratch/wtB" },
        ],
      },
    }]);

    const lanes = loadRunnerConfig(name);
    expect(lanes).toHaveLength(1);
    expect(lanes[0]!.entries).toHaveLength(2);
    // worktreeEntryId defaults to basename for index 0
    const ids = lanes[0]!.entries.map((e) => e.id).sort();
    expect(ids).toEqual(["wtA", "wtB"]);
    expect(lanes[0]!.entries.every((e) => e.commandTemplate === "pnpm start")).toBe(true);
    expect(lanes[0]!.entries[0]!.targetDir.endsWith("/app")).toBe(true);
  });

  test("multi-command compact shape expands per-worktree with a menu", () => {
    const name = writeRawConfig([{
      id: "1",
      canonicalPort: 3002,
      repoName: "r",
      mode: "single",
      entry: {
        packagePath: "",
        packageLabel: "svc",
        commandTemplate: ["bun run dev", "bun run debug"],
        worktrees: [{ root: "/scratch/primary" }],
      },
    }]);

    const lanes = loadRunnerConfig(name);
    expect(lanes).toHaveLength(1);
    // 1 worktree → 1 entry; the 2 cmds live on availableCommands as a menu.
    expect(lanes[0]!.entries).toHaveLength(1);
    const e = lanes[0]!.entries[0]!;
    expect(e.id).toBe("primary");
    expect(e.commandTemplate).toBe("bun run dev");        // active defaults to idx 0
    expect(e.availableCommands?.map((c) => c.cmd)).toEqual(["bun run dev", "bun run debug"]);
    expect(lanes[0]!.mode).toBe("single");
  });

  test("activeCmdIdx on a compact entry selects a non-default command", () => {
    const name = writeRawConfig([{
      id: "1",
      canonicalPort: 3007,
      repoName: "r",
      mode: "warm",
      entry: {
        packagePath: "",
        packageLabel: "svc",
        commandTemplate: ["bun run dev", { cmd: "bun run debug", alias: "debug" }],
        activeCmdIdx: 1,
        worktrees: [{ root: "/scratch/primary" }],
      },
    }]);

    const e = loadRunnerConfig(name)[0]!.entries[0]!;
    expect(e.commandTemplate).toBe("bun run debug");
    expect(e.alias).toBe("debug");
  });

  test("legacy pm/script fields synthesize a commandTemplate when one is missing", () => {
    // Pre-cleanup configs only carried pm + script; commandTemplate was derived
    // at runtime as `${pm} run ${script}`. Loader must still handle these.
    const name = writeRawConfig([{
      id: "1",
      canonicalPort: 3009,
      repoName: "r",
      mode: "warm",
      entry: {
        pm: "pnpm",
        script: "dev",
        packagePath: "",
        packageLabel: "svc",
        worktrees: [{ root: "/scratch/primary" }],
      },
    }]);

    expect(loadRunnerConfig(name)[0]!.entries[0]!.commandTemplate).toBe("pnpm run dev");
  });

  test("unknown mode coerces to 'warm' (default)", () => {
    const name = writeRawConfig([{
      id: "1",
      canonicalPort: 3003,
      repoName: "r",
      mode: "nonsense",
      entry: null,
    }]);

    const lanes = loadRunnerConfig(name);
    expect(lanes).toHaveLength(1);
    expect(lanes[0]!.mode).toBe("warm");
  });

  test("tunnel flag loads: absent stays undefined, explicit values survive", () => {
    const name = writeRawConfig([
      { id: "1", canonicalPort: 4000, repoName: "r", mode: "warm", entry: null },
      { id: "2", canonicalPort: 4001, repoName: "r", mode: "warm", entry: null, tunnel: { enabled: true } },
      { id: "3", canonicalPort: 4002, repoName: "r", mode: "warm", entry: null, tunnel: { enabled: false } },
    ]);

    const lanes = loadRunnerConfig(name);
    expect(lanes[0]!.tunnel).toBeUndefined();
    expect(lanes[1]!.tunnel).toEqual({ enabled: true });
    expect(lanes[2]!.tunnel).toEqual({ enabled: false });
  });

  test("missing config loads as empty array", () => {
    expect(loadRunnerConfig(`rt-unit-test-nonexistent-${process.pid}`)).toEqual([]);
  });
});

describe("normalizeLane — entry id collision salting", () => {
  test("duplicate basenames get a salt suffix, not a silent alias", () => {
    // Two worktrees whose roots share a basename would both expand to id
    // "app" — which would alias their PTY output. The second gets ~<hash>.
    const lane = normalizeLane({
      id: "1",
      canonicalPort: 3005,
      repoName: "r",
      mode: "warm",
      entry: {
        packagePath: "",
        packageLabel: "svc",
        commandTemplate: "bun dev",
        worktrees: [
          { root: "/a/app" },
          { root: "/b/app" },
        ],
      },
    });

    const [first, second] = lane.entries;
    expect(first!.id).toBe("app");
    expect(second!.id).toMatch(/^app~[0-9a-f]{6}$/);
    expect(first!.id).not.toBe(second!.id);
  });
});

describe("collectRunnerPortLabels", () => {
  test("includes entryWindowName for every entry across configs", () => {
    const name = writeRawConfig([{
      id: "7",
      canonicalPort: 3050,
      repoName: "r",
      mode: "warm",
      entry: {
        packagePath: "",
        packageLabel: "svc",
        commandTemplate: "bun dev",
        worktrees: [{ root: "/scratch/wt-labels" }],
      },
    }]);

    const labels = collectRunnerPortLabels();
    expect(labels.has(entryWindowName("7", "wt-labels"))).toBe(true);
    expect(createdNames.has(name)).toBe(true);
  });
});

describe("id helpers", () => {
  test("window names are stable", () => {
    expect(proxyWindowName("3")).toBe("proxy-3");
    expect(entryWindowName("3", "a")).toBe("3-a");
  });
});
