import { afterEach, describe, expect, test } from "bun:test";
import type { LaneConfig, LaneEntry } from "../../../runner-store.ts";
import type { KeymapContext } from "../types.ts";
import { createNormalKeymap } from "../normal.ts";

const previousShell = process.env.SHELL;

afterEach(() => {
  process.env.SHELL = previousShell;
});

function makeEntry(overrides: Partial<LaneEntry> = {}): LaneEntry {
  return {
    id: "a",
    targetDir: "/repo/app",
    packageLabel: "app",
    worktree: "/repo",
    branch: "main",
    ephemeralPort: 12345,
    commandTemplate: "pnpm run dev",
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

function makeState(lanes: LaneConfig[]) {
  return {
    lanes,
    laneIdx: 0,
    entryIdx: 0,
    mode: { type: "normal" },
    entryStates: new Map(),
    proxyStates: {},
    enrichment: {},
    inputValue: "",
    toast: null,
    spinnerFrame: 0,
    runnerName: "test",
    knownRepos: [],
    daemonReachable: true,
  };
}

describe("normal runner keymap", () => {
  test("t opens a shell in the selected entry target directory", () => {
    process.env.SHELL = "/bin/test-shell";
    const entry = makeEntry({ targetDir: "/repo/packages/web" });
    const state = makeState([makeLane([entry])]);
    const tempPanes: Array<{ cmd: string; opts: Record<string, unknown> | undefined }> = [];
    const ctx = {
      openTempPane: (cmd: string, opts?: Record<string, unknown>) => {
        tempPanes.push({ cmd, opts });
        return "%5";
      },
      displayPane: () => "%1",
      mrPane: {
        isEnabled: () => false,
        setEnabled: () => {},
        show: () => {},
        hide: () => {},
        update: () => {},
      },
      stopApp: () => {},
      setMode: () => {},
      getCurrentState: () => state,
      doDispatch: () => {},
      showToast: () => {},
      openPopup: () => {},
      switchDisplay: () => {},
      createBgPane: () => "%2",
      initDisplayPane: () => {},
      saveCurrent: () => {},
      addResolvedEntry: async () => {},
      activeEntryIdx: () => 0,
      focusedBranch: () => "",
      safeUpdate: () => {},
      rtShell: "rt",
      rtInvoke: ["rt"],
      initiator: "test",
    } as KeymapContext;

    createNormalKeymap(ctx).t({ state, update: () => {} } as any);

    expect(tempPanes).toEqual([
      {
        cmd: "/bin/test-shell",
        opts: { cwd: "/repo/packages/web", target: "%1", escToClose: true },
      },
    ]);
  });
});
