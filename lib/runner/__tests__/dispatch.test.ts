import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { LaneConfig, LaneEntry } from "../../runner-store.ts";
import type { EntryState } from "../components/shared.ts";

type DaemonCall = { cmd: string; payload?: Record<string, any> };

const daemonCalls: DaemonCall[] = [];

mock.module("../../daemon-client.ts", () => ({
  daemonQuery: async (cmd: string, payload?: Record<string, any>) => {
    daemonCalls.push({ cmd, payload });
    if (cmd === "proxy:status") return { ok: true, data: { running: true, paused: false } };
    if (cmd === "port:allocate") return { ok: true, data: { port: 15000 } };
    return { ok: true };
  },
}));

const { dispatch } = await import("../dispatch.ts");

const menu = [
  { cmd: "pnpm run dev" },
  { cmd: "pnpm run build", alias: "build" },
];

function makeEntry(overrides: Partial<LaneEntry>): LaneEntry {
  return {
    id: "a",
    targetDir: "/repo",
    packageLabel: "app",
    worktree: "/repo",
    branch: "main",
    ephemeralPort: 12345,
    commandTemplate: "pnpm run dev",
    availableCommands: menu,
    ...overrides,
  };
}

function makeLane(entries: LaneEntry[]): LaneConfig {
  return {
    id: "1",
    canonicalPort: 3000,
    entries,
    activeEntryId: entries[0]?.id,
    repoName: "repo",
    mode: "warm",
  };
}

describe("runner dispatch", () => {
  beforeEach(() => {
    daemonCalls.length = 0;
  });

  test("switch-cmd-group restarts running entries with the selected command template", async () => {
    const lane = makeLane([
      makeEntry({ id: "a", ephemeralPort: 12345 }),
      makeEntry({ id: "b", targetDir: "/repo-b", worktree: "/repo-b", ephemeralPort: 12346 }),
    ]);
    const entryStates = new Map<string, EntryState>([
      ["1-a", "running"],
      ["1-b", "warm"],
    ]);

    const patch = await dispatch(
      {
        type: "switch-cmd-group",
        laneId: "1",
        groupEntryIds: ["a", "b"],
        command: { cmd: "pnpm run build", alias: "build" },
      } as any,
      { lanes: [lane], entryStates, initiator: "test" },
    );

    const spawnCalls = daemonCalls.filter((c) => c.cmd === "process:spawn");
    expect(spawnCalls).toHaveLength(2);
    expect(spawnCalls.map((c) => c.payload?.cmd)).toEqual([
      "pnpm run build",
      "pnpm run build",
    ]);

    const next = patch.mutate?.([lane]) ?? [lane];
    expect(next[0]!.entries.map((e) => e.commandTemplate)).toEqual([
      "pnpm run build",
      "pnpm run build",
    ]);
    expect(next[0]!.entries.map((e) => e.alias)).toEqual(["build", "build"]);
  });
});
