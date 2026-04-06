/** @jsxImportSource @rezi-ui/jsx */
/**
 * rt runner — Rezi-based lane/service runner backed by the rt daemon.
 *
 * Each lane has a canonical port, a daemon-managed proxy, and one or more
 * service entries running on ephemeral ports. The proxy forwards :canonicalPort
 * to whichever entry is currently active.
 *
 * Architecture: the rt daemon is the source of truth for all process state.
 * ProcessManager, ProxyManager, and ExclusiveGroup daemon units handle
 * lifecycle, proxying, and the "at most one running per lane" invariant.
 * `pollDaemon` fetches authoritative state every 2 seconds.
 *
 * All process mutations go through async `dispatch(action)` which calls
 * daemon IPC commands instead of tmux.
 *
 * Keys (normal / default mode):
 *   j/k  ↑/↓    navigate lanes
 *   ←/→          navigate entries within selected lane
 *   l            add lane (prompts for port)
 *   p            edit port of selected lane
 *   a            add process (interactive rt run picker)
 *   s            start / resume / restart selected entry
 *   S            warm all entries in lane (spawn all, only active runs)
 *   w            switch active entry (proxy target)
 *   x            stop selected entry
 *   X            stop all entries in lane
 *   r            remove a process (entry picker)
 *   e            edit command template for selected entry
 *   D            delete selected lane
 *   R            reset all lanes (with confirmation)
 *   t            open a one-off shell at the entry's working directory
 *   q            quit
 */

import { rgb } from "@rezi-ui/jsx";
import { createNodeApp } from "@rezi-ui/node";
import { spawnSync } from "node:child_process";
import { join, basename } from "node:path";
import { homedir, tmpdir } from "node:os";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import type { CommandContext } from "../lib/command-tree.ts";
import { getRepoRoot } from "../lib/git.ts";
import { daemonQuery, isDaemonRunning } from "../lib/daemon-client.ts";
import {
  loadLanes, saveLanes, resetLanes,
  nextLaneId, nextEntryId, proxyWindowName, entryWindowName,
  type LaneConfig, type LaneEntry,
} from "../lib/runner-store.ts";
import type { ProcessState } from "../lib/daemon/state-store.ts";
import type { RunResolveResult } from "./run.ts";
import { RT_ROOT } from "../lib/repo.ts";

// ─── tmux helpers ─────────────────────────────────────────────────────────────

const CLI_PATH = join(RT_ROOT, "cli.ts");

/** Open a horizontal tmux split running `cmd`. Non-blocking — returns immediately. */
function tmuxSplit(cmd: string, cwd?: string): void {
  const args = ["split-window", "-h"];
  if (cwd) args.push("-c", cwd);
  args.push(cmd);
  spawnSync("tmux", args);
}

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * States a lane entry can be in.
 *
 * "starting" is a UI-only optimistic state shown immediately when the user
 * triggers a spawn/respawn — before the daemon has confirmed the process is
 * alive. It is replaced by the real daemon state on the next poll.
 */
export type EntryState = ProcessState | "starting";

type InteractiveRequest = { type: "quit" };

type Mode =
  | { type: "normal" }
  | { type: "port-input"; purpose: "new-lane" | "edit-port"; laneId?: string }
  | { type: "entry-picker"; purpose: "switch" | "remove"; laneId: string; idx: number }
  | { type: "command-edit"; laneId: string; entryId: string }
  | { type: "confirm-reset" };

type LaneAction =
  | { type: "spawn";        laneId: string; entryId: string }
  | { type: "activate";     laneId: string; entryId: string }
  | { type: "warm-all";     laneId: string }
  | { type: "respawn";      laneId: string; entryId: string }
  | { type: "stop";         laneId: string; entryId: string }
  | { type: "stop-all";     laneId: string }
  | { type: "remove-entry"; laneId: string; entryId: string }
  | { type: "remove-lane";  laneId: string }
  | { type: "reset" };

/** Fields that dispatch() may modify (merged into full state by doDispatch). */
type DispatchPatch = Partial<Pick<RunnerUIState, "lanes" | "laneIdx" | "entryIdx">>;

interface RunnerUIState {
  lanes:         LaneConfig[];
  laneIdx:       number;
  entryIdx:      number;
  mode:          Mode;
  entryStates:   Map<string, EntryState>;
  /** Keyed by proxyWindowName(laneId); true = proxy is running. */
  proxyStates:   Record<string, boolean>;
  enrichment:    Record<string, string>;
  inputValue:    string;
  toast:         string | null;
  /** Monotonically incrementing counter used to animate the "starting" spinner. */
  spinnerFrame:  number;
}

// ─── Palette ──────────────────────────────────────────────────────────────────

const C = {
  cyan:  rgb(80,  220, 220),
  green: rgb(80,  200, 100),
  yel:   rgb(220, 180,  50),
  red:   rgb(220,  80,  80),
  dim:   rgb(100, 100, 100),
  muted: rgb(160, 160, 160),
  white: rgb(220, 220, 220),
};

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠣", "⠏"];

const STATUS_ICON: Record<EntryState, string> = {
  starting: SPINNER_FRAMES[0]!, // overridden at render time with animated frame
  running:  "●",
  warm:     "❄",
  crashed:  "✗",
  stopped:  "○",
};

const STATUS_COLOR: Record<EntryState, number> = {
  starting: rgb(80,  200, 100),
  running:  rgb(80,  200, 100),
  warm:     rgb(220, 180,  50),
  crashed: rgb(220,  80,  80),
  stopped: rgb(100, 100, 100),
};

// ─── Daemon helpers ───────────────────────────────────────────────────────────

/** Ensure the proxy for a lane is running (creates it if missing). */
async function ensureProxy(lane: LaneConfig): Promise<void> {
  const proxyId = proxyWindowName(lane.id);
  const status = await daemonQuery("proxy:status", { id: proxyId });
  if (!status?.ok || !status.data) {
    const activeEntry = lane.entries.find((e) => e.id === lane.activeEntryId);
    await daemonQuery("proxy:start", {
      id: proxyId,
      canonicalPort: lane.canonicalPort,
      upstreamPort: activeEntry?.ephemeralPort ?? 0,
    });
  }
}

/** Spawn a single entry process in the daemon (no-op if already alive). */
/**
 * Spawn an entry's process via the daemon.
 * Returns the actual ephemeral port used — may differ from entry.ephemeralPort
 * if the saved value was 0 (unallocated), in which case a new port is allocated.
 */
async function spawnEntry(lane: LaneConfig, entry: LaneEntry): Promise<number> {
  // Auto-heal entries that were saved with ephemeralPort: 0 (before port
  // allocation was wired up, or if allocation failed at add-time).
  let ephemeralPort = entry.ephemeralPort;
  if (!ephemeralPort) {
    const portRes = await daemonQuery("port:allocate", { label: `entry-${lane.id}-${entry.id}-spawn` });
    ephemeralPort = portRes?.ok ? Number((portRes.data as { port: number })?.port) : (10000 + Math.floor(Math.random() * 55000));
  }

  const port = String(ephemeralPort);
  const canonicalPort = String(lane.canonicalPort);
  const cmd = entry.commandTemplate
    .replace(/\$\{?PORT\}?/g, port)
    .replace(/\$\{?CANONICAL_PORT\}?/g, canonicalPort);

  await daemonQuery("process:spawn", {
    id: entryWindowName(lane.id, entry.id),
    cmd,
    cwd: entry.targetDir,
    env: { PORT: port, CANONICAL_PORT: canonicalPort },
  });

  return ephemeralPort;
}

/** Tell the daemon proxy to route the lane's canonical port to an ephemeral port. */
async function setProxyUpstream(laneId: string, ephemeralPort: number): Promise<void> {
  await daemonQuery("proxy:set-upstream", { id: proxyWindowName(laneId), port: ephemeralPort });
}

// ─── Enrichment ───────────────────────────────────────────────────────────────

async function fetchEnrichment(lanes: LaneConfig[]): Promise<Record<string, string>> {
  const targets: { key: string; branch: string; worktree: string }[] = [];
  for (const lane of lanes) {
    for (const entry of lane.entries) {
      if (entry.branch) {
        targets.push({ key: `${lane.id}:${entry.id}`, branch: entry.branch, worktree: entry.worktree });
      }
    }
  }
  if (targets.length === 0) return {};

  try {
    const { formatBranchLabel } = await import("../lib/enrich.ts");
    const response = await daemonQuery("cache:read", { branches: targets.map((t) => t.branch) });
    if (!response?.ok || !response.data) return {};
    const cache = response.data as Record<string, any>;
    const result: Record<string, string> = {};
    for (const { key, branch, worktree } of targets) {
      const e = cache[branch];
      const raw = e
        ? formatBranchLabel({ path: worktree, dirName: worktree.split("/").pop() ?? worktree, branch, linearId: e.linearId || null, ticket: e.ticket ?? null, mr: e.mr ?? null })
        : branch;
      result[key] = raw.replace(/\x1b\[[0-9;]*m/g, "");
    }
    return result;
  } catch {
    const result: Record<string, string> = {};
    for (const { key, branch } of targets) result[key] = branch;
    return result;
  }
}

// ─── Runner (one UI session) ──────────────────────────────────────────────────

async function runOnce(
  initialLanes: LaneConfig[],
  dataDir: string,
  repoLabel: string,
  repoRoot: string,
): Promise<InteractiveRequest> {
  const pending: InteractiveRequest = { type: "quit" };
  let currentLanes = initialLanes;

  // ── Pane management ───────────────────────────────────────────────────────
  const lanePanes = new Map<string, string>(); // laneId → tmux pane ID
  let displayedLaneId = "";                    // laneId whose pane is in the display position
  const bgWindowName = `rt-bg-${process.pid}`;
  let bgWindowCreated = false;
  // $TMUX_PANE is set by tmux to the pane ID where the process is running.
  // We use it to snap focus back to the runner after any tmux swap/split.
  const runnerPaneId = process.env.TMUX_PANE ?? "";

  // Pre-fetch process and proxy state so the first frame is already correct —
  // avoids the 1-3s flash of "stopped" / proxy-X after returning from rt attach.
  const [initStatesRes, initProxyRes] = await Promise.all([
    daemonQuery("process:states"),
    daemonQuery("proxy:list"),
  ]);
  const initialEntryStates = new Map<string, EntryState>();
  if (initStatesRes?.ok && initStatesRes.data) {
    for (const [id, st] of Object.entries(initStatesRes.data as Record<string, string>)) {
      initialEntryStates.set(id, st as EntryState);
    }
  }
  const initialProxyStates: Record<string, boolean> = {};
  if (initProxyRes?.ok && Array.isArray(initProxyRes.data)) {
    for (const p of initProxyRes.data as { id: string }[]) {
      initialProxyStates[p.id] = true;
    }
  }

  const app = createNodeApp<RunnerUIState>({
    initialState: {
      lanes:        initialLanes,
      laneIdx:      0,
      entryIdx:     0,
      mode:         { type: "normal" },
      entryStates:  initialEntryStates,
      proxyStates:  initialProxyStates,
      enrichment:   {},
      inputValue:   "",
      toast:        null,
      spinnerFrame: 0,
    },
  });

  // ── Helpers ───────────────────────────────────────────────────────────────

  function showToast(msg: string, ms = 2500) {
    safeUpdate((s) => ({ ...s, toast: msg }));
    setTimeout(() => safeUpdate((s) => ({ ...s, toast: null })), ms);
  }

  function saveCurrent(newLanes: LaneConfig[]) {
    currentLanes = newLanes;
    saveLanes(dataDir, newLanes);
  }

  /** Port-allocate, create entry, persist lanes, update UI state. */
  async function addResolvedEntry(laneId: string, resolved: RunResolveResult): Promise<void> {
    const lane = currentLanes.find((l) => l.id === laneId);
    if (!lane) return;

    const portRes = await daemonQuery("port:allocate", { label: `entry-${laneId}-${Date.now()}` });
    const ephemeralPort: number = portRes?.ok
      ? Number((portRes.data as { port: number })?.port)
      : (10000 + Math.floor(Math.random() * 1000));

    const entryId = nextEntryId(lane.entries);
    const processId = entryWindowName(lane.id, entryId);
    const newEntry: LaneEntry = {
      id: entryId,
      targetDir: resolved.targetDir,
      pm: resolved.pm,
      script: resolved.script,
      packageLabel: resolved.packageLabel,
      worktree: resolved.worktree,
      branch: resolved.branch,
      ephemeralPort,
      commandTemplate: `${resolved.pm} run ${resolved.script}`,
    };

    const isFirst = lane.entries.length === 0;
    const updatedLane: LaneConfig = {
      ...lane,
      entries: [...lane.entries, newEntry],
      activeEntryId: isFirst ? entryId : lane.activeEntryId,
    };

    const newLanes = currentLanes.map((l) => (l.id === laneId ? updatedLane : l));
    saveCurrent(newLanes);
    safeUpdate((s) => ({ ...s, lanes: newLanes }));

    await daemonQuery("group:add", { groupId: lane.id, processId });
    if (isFirst) await setProxyUpstream(lane.id, ephemeralPort);

    // Ensure a bg pane exists for this lane; refresh it if this is the first entry
    if (!lanePanes.has(laneId)) {
      createBgPane(laneId, processId);
      initDisplayPane(laneId);
    } else if (isFirst) {
      // Lane had no entries before — update the "no service" pane to the real attach loop
      refreshLanePane(laneId, processId);
    }
  }

  // ── tmux lane pane helpers ────────────────────────────────────────────────

  /** Shell loop that keeps attaching to `processId` and shows a "stopped" banner on exit. */
  function attachLoopCmd(processId: string): string {
    return processId
      ? `while true; do ${process.execPath} ${CLI_PATH} attach ${processId} 2>&1 || true; printf '\\033[2m  ─ stopped ─\\033[0m\\r\\n'; sleep 1; done`
      : `while true; do printf '\\033[2m  no service\\033[0m\\r\\n'; sleep 5; done`;
  }

  function restoreFocus(): void {
    if (runnerPaneId) spawnSync("tmux", ["select-pane", "-t", runnerPaneId]);
  }

  function ensureBgWindow(): void {
    if (bgWindowCreated) return;
    spawnSync("tmux", ["new-window", "-d", "-n", bgWindowName, "sleep infinity"]);
    bgWindowCreated = true;
  }

  /** Create a pane in the background window for `laneId`, return its pane ID. */
  function createBgPane(laneId: string, processId: string): string {
    ensureBgWindow();
    const result = spawnSync("tmux", [
      "split-window", "-t", bgWindowName, "-d", "-P", "-F", "#{pane_id}",
      attachLoopCmd(processId),
    ], { encoding: "utf8" });
    const paneId = result.stdout.trim();
    lanePanes.set(laneId, paneId);
    return paneId;
  }

  /**
   * Swap the selected lane's pane into the right display position.
   * The previously displayed pane returns to the background window.
   */
  function switchDisplay(newLaneId: string): void {
    if (newLaneId === displayedLaneId || !lanePanes.has(newLaneId) || displayedLaneId === "") return;
    const currentPaneId = lanePanes.get(displayedLaneId)!;
    const newPaneId = lanePanes.get(newLaneId)!;
    spawnSync("tmux", ["swap-pane", "-s", currentPaneId, "-t", newPaneId]);
    displayedLaneId = newLaneId;
    restoreFocus();
  }

  /**
   * Create the right-side display split (once) and swap the given lane's pane into it.
   * No-op if the display has already been initialised.
   */
  function initDisplayPane(laneId: string): void {
    if (displayedLaneId !== "") {
      // Display exists — just switch to this lane if needed
      switchDisplay(laneId);
      return;
    }
    const lanePaneId = lanePanes.get(laneId);
    if (!lanePaneId) return;
    // Create a placeholder right-pane in the runner window (-d keeps focus on runner)
    const tmp = spawnSync("tmux", [
      "split-window", "-h", "-d", "-P", "-F", "#{pane_id}", "sleep infinity",
    ], { encoding: "utf8" }).stdout.trim();
    // Swap lane pane into display; placeholder goes to bg window
    spawnSync("tmux", ["swap-pane", "-s", lanePaneId, "-t", tmp]);
    displayedLaneId = laneId;
    restoreFocus();
  }

  /**
   * Replace a lane's background pane with a new one running a different processId.
   * If that lane is currently displayed, the display is updated atomically.
   */
  function refreshLanePane(laneId: string, processId: string): void {
    const oldPaneId = lanePanes.get(laneId);
    if (!oldPaneId) return;
    const wasDisplayed = displayedLaneId === laneId;
    // Create new pane first (sets lanePanes[laneId] = newPaneId)
    const newPaneId = createBgPane(laneId, processId);
    if (wasDisplayed) {
      // Swap new bg pane into display, old display pane goes to bg, then kill it
      spawnSync("tmux", ["swap-pane", "-s", oldPaneId, "-t", newPaneId]);
      // After swap: newPaneId is in display, oldPaneId is in bg
      restoreFocus();
    }
    spawnSync("tmux", ["kill-pane", "-t", oldPaneId]);
  }

  function returnToNormal(update: (fn: (s: RunnerUIState) => RunnerUIState) => void, extra: Partial<RunnerUIState> = {}) {
    update((s) => ({ ...s, mode: { type: "normal" }, inputValue: "", ...extra }));
    app.setMode("default");
  }

  // ── Async dispatch ────────────────────────────────────────────────────────
  //
  // Returns a patch of only the fields that changed (lanes, laneIdx, entryIdx).
  // doDispatch merges the patch into the current app state without clobbering
  // mode, toast, entryStates, or proxyStates (managed by other paths).

  async function dispatch(action: LaneAction, s: RunnerUIState): Promise<DispatchPatch> {
    const { lanes, entryStates } = s;

    function est(win: string): EntryState {
      return entryStates.get(win) ?? "stopped";
    }

    switch (action.type) {
      case "spawn": {
        const lane = lanes.find((l) => l.id === action.laneId);
        const entry = lane?.entries.find((e) => e.id === action.entryId);
        if (!lane || !entry) return {};
        const processId = entryWindowName(lane.id, entry.id);
        await ensureProxy(lane);
        const actualPort = await spawnEntry(lane, entry);
        await daemonQuery("group:activate", { groupId: lane.id, processId });
        await setProxyUpstream(lane.id, actualPort);
        // Persist the actual port back into the entry if it changed (e.g. was 0)
        const updatedEntries = lane.entries.map((e) =>
          e.id === action.entryId ? { ...e, ephemeralPort: actualPort } : e
        );
        return { lanes: lanes.map((l) => l.id === action.laneId
          ? { ...l, activeEntryId: action.entryId, entries: updatedEntries }
          : l) };
      }

      case "activate": {
        const lane = lanes.find((l) => l.id === action.laneId);
        const entry = lane?.entries.find((e) => e.id === action.entryId);
        if (!lane || !entry) return {};
        const processId = entryWindowName(lane.id, entry.id);
        await daemonQuery("group:activate", { groupId: lane.id, processId });
        await setProxyUpstream(lane.id, entry.ephemeralPort);
        return { lanes: lanes.map((l) => l.id === action.laneId ? { ...l, activeEntryId: action.entryId } : l) };
      }

      case "warm-all": {
        const lane = lanes.find((l) => l.id === action.laneId);
        if (!lane) return {};
        const activeId = lane.activeEntryId ?? lane.entries[0]?.id;
        await ensureProxy(lane);
        // Accumulate port fixes (entries with ephemeralPort: 0 get real ports allocated)
        const portFixes = new Map<string, number>();
        for (const entry of lane.entries) {
          const win = entryWindowName(lane.id, entry.id);
          const st = est(win);
          if (st === "stopped") {
            const actualPort = await spawnEntry(lane, entry);
            if (actualPort !== entry.ephemeralPort) portFixes.set(entry.id, actualPort);
          } else if (st === "crashed") {
            await daemonQuery("process:respawn", { id: win });
          }
          // warm/running entries are handled by group:activate below
        }
        if (activeId) {
          await daemonQuery("group:activate", {
            groupId: lane.id,
            processId: entryWindowName(lane.id, activeId),
          });
          const activeEntry = lane.entries.find((e) => e.id === activeId);
          const activePort = portFixes.get(activeId) ?? activeEntry?.ephemeralPort;
          if (activePort) await setProxyUpstream(lane.id, activePort);
          const updatedEntries = lane.entries.map((e) =>
            portFixes.has(e.id) ? { ...e, ephemeralPort: portFixes.get(e.id)! } : e
          );
          return { lanes: lanes.map((l) => l.id === action.laneId
            ? { ...l, activeEntryId: activeId, entries: updatedEntries }
            : l) };
        }
        return {};
      }

      case "respawn": {
        // Always do a full fresh spawn rather than process:respawn so we
        // re-run port allocation and command substitution. This prevents a
        // stale bad command (e.g. "pnpm run start -p NaN") stored in the
        // daemon's spawnConfigs from being replayed on every restart.
        const lane = lanes.find((l) => l.id === action.laneId);
        const entry = lane?.entries.find((e) => e.id === action.entryId);
        if (!lane || !entry) return {};
        const processId = entryWindowName(lane.id, entry.id);
        await ensureProxy(lane);
        const actualPort = await spawnEntry(lane, entry);
        await daemonQuery("group:activate", { groupId: lane.id, processId });
        await setProxyUpstream(lane.id, actualPort);
        const updatedEntries = lane.entries.map((e) =>
          e.id === action.entryId ? { ...e, ephemeralPort: actualPort } : e
        );
        return { lanes: lanes.map((l) => l.id === action.laneId
          ? { ...l, activeEntryId: action.entryId, entries: updatedEntries }
          : l) };
      }

      case "stop": {
        const win = entryWindowName(action.laneId, action.entryId);
        await daemonQuery("process:kill", { id: win });
        return {};
      }

      case "stop-all": {
        const lane = lanes.find((l) => l.id === action.laneId);
        if (!lane) return {};
        await Promise.all(
          lane.entries.map((e) => daemonQuery("process:kill", { id: entryWindowName(action.laneId, e.id) }))
        );
        return {};
      }

      case "remove-entry": {
        const lane = lanes.find((l) => l.id === action.laneId);
        if (!lane) return {};
        const win = entryWindowName(action.laneId, action.entryId);
        await daemonQuery("process:kill", { id: win });
        await daemonQuery("group:remove-member", { groupId: lane.id, processId: win });
        await daemonQuery("port:release", { label: win });
        const nextEntries = lane.entries.filter((e) => e.id !== action.entryId);
        const nextActive = lane.activeEntryId === action.entryId ? nextEntries[0]?.id : lane.activeEntryId;
        if (nextActive && nextActive !== lane.activeEntryId) {
          const e = nextEntries.find((e) => e.id === nextActive);
          if (e) await setProxyUpstream(lane.id, e.ephemeralPort);
        }
        return {
          lanes: lanes.map((l) => l.id === action.laneId ? { ...l, entries: nextEntries, activeEntryId: nextActive } : l),
          entryIdx: 0,
        };
      }

      case "remove-lane": {
        const lane = lanes.find((l) => l.id === action.laneId);
        if (!lane) return {};
        await Promise.all(lane.entries.map((e) => daemonQuery("process:kill", { id: entryWindowName(action.laneId, e.id) })));
        await daemonQuery("proxy:stop", { id: proxyWindowName(action.laneId) });
        await daemonQuery("group:remove", { id: action.laneId });
        for (const e of lane.entries) {
          await daemonQuery("port:release", { label: entryWindowName(action.laneId, e.id) });
        }
        const newLanes = lanes.filter((l) => l.id !== action.laneId);
        return {
          lanes: newLanes,
          laneIdx: Math.max(0, Math.min(s.laneIdx, newLanes.length - 1)),
          entryIdx: 0,
        };
      }

      case "reset": {
        await Promise.all(
          lanes.flatMap((lane) => [
            ...lane.entries.map((e) => daemonQuery("process:kill", { id: entryWindowName(lane.id, e.id) })),
            daemonQuery("proxy:stop", { id: proxyWindowName(lane.id) }),
            daemonQuery("group:remove", { id: lane.id }),
          ])
        );
        resetLanes(dataDir);
        currentLanes = [];
        return { lanes: [], laneIdx: 0, entryIdx: 0 };
      }
    }
  }

  function doDispatch(action: LaneAction, currentState: RunnerUIState): void {
    // For actions that start a process, show an optimistic "starting" state
    // immediately so the UI responds at once rather than after the daemon round-trip.
    const startingIds: string[] = [];
    if (action.type === "spawn" || action.type === "respawn") {
      startingIds.push(entryWindowName(action.laneId, action.entryId));
    } else if (action.type === "warm-all") {
      const lane = currentState.lanes.find((l) => l.id === action.laneId);
      if (lane) {
        for (const e of lane.entries) {
          const id = entryWindowName(lane.id, e.id);
          const st = currentState.entryStates.get(id) ?? "stopped";
          if (st === "stopped" || st === "crashed") startingIds.push(id);
        }
      }
    }

    if (startingIds.length > 0) {
      app.update((s) => {
        const next = new Map(s.entryStates);
        for (const id of startingIds) next.set(id, "starting");
        return { ...s, entryStates: next };
      });
    }

    dispatch(action, currentState).then((patch) => {
      safeUpdate((s) => ({ ...s, ...patch }));
      if (patch.lanes && patch.lanes !== currentState.lanes) {
        saveCurrent(patch.lanes);

        // Refresh lane panes whose active entry changed (e.g. spawn/activate/respawn)
        for (const newLane of patch.lanes) {
          const oldLane = currentState.lanes.find((l) => l.id === newLane.id);
          if (oldLane && oldLane.activeEntryId !== newLane.activeEntryId && newLane.activeEntryId) {
            const newActiveEntry = newLane.entries.find((e) => e.id === newLane.activeEntryId);
            const processId = newActiveEntry ? entryWindowName(newLane.id, newActiveEntry.id) : "";
            refreshLanePane(newLane.id, processId);
          }
        }

        // Kill panes for lanes that were removed (remove-lane / reset)
        for (const oldLane of currentState.lanes) {
          if (!patch.lanes.find((l) => l.id === oldLane.id)) {
            const paneId = lanePanes.get(oldLane.id);
            if (paneId) {
              const wasDisplayed = displayedLaneId === oldLane.id;
              spawnSync("tmux", ["kill-pane", "-t", paneId]);
              lanePanes.delete(oldLane.id);
              if (wasDisplayed) {
                displayedLaneId = "";
                const nextLane = patch.lanes[0];
                if (nextLane && lanePanes.has(nextLane.id)) {
                  initDisplayPane(nextLane.id);
                }
              }
            }
          }
        }
      }
    });
  }

  // ── View components ───────────────────────────────────────────────────────

  function EntryRow({ lane, entry, ei, isSelectedLane, selectedEi, s }: {
    lane: LaneConfig; entry: LaneEntry; ei: number;
    isSelectedLane: boolean; selectedEi: number; s: RunnerUIState;
  }) {
    const win = entryWindowName(lane.id, entry.id);
    const state = s.entryStates.get(win) ?? "stopped";
    const isActive = lane.activeEntryId === entry.id;
    const isSelected = isSelectedLane && ei === selectedEi;
    const eKey = `${lane.id}:${entry.id}`;

    const stateColor = STATUS_COLOR[state];
    const defaultCmd = `${entry.pm} run ${entry.script}`;
    const hasCustomCmd = entry.commandTemplate !== defaultCmd;
    const label = entry.packageLabel !== "root"
      ? `${entry.packageLabel} · ${hasCustomCmd ? entry.commandTemplate : entry.script}`
      : (hasCustomCmd ? entry.commandTemplate : entry.script);
    const branchLabel = s.enrichment[eKey] ?? entry.branch ?? "";
    const nameColor = isActive ? C.green : (isSelected ? C.white : C.muted);
    const spinnerChar = SPINNER_FRAMES[s.spinnerFrame % SPINNER_FRAMES.length]!;
    const stateIcon = state === "starting" ? spinnerChar : STATUS_ICON[state];
    const stateLabel =
      state === "starting" ? "starting…" :
      state === "warm"     ? "❄ warm"    : state;

    return (
      <column key={eKey} gap={0}>
        <row key={`${eKey}-1`} gap={1}>
          <text style={{ fg: isSelected ? C.cyan : C.dim }}>{isSelected ? "❯" : " "}</text>
          <text style={{ fg: stateColor }}>{stateIcon}</text>
          <text style={{ fg: nameColor, bold: isActive }}>{label}</text>
          <spacer flex={1} />
          <text style={{ fg: C.dim }}>:{entry.ephemeralPort}</text>
          <text style={{ fg: stateColor }}>{stateLabel}</text>
        </row>
        <row key={`${eKey}-2`} gap={0}>
          <text>{"    "}</text>
          {branchLabel && <text style={{ fg: C.dim }}>{branchLabel}</text>}
        </row>
      </column>
    );
  }

  function LaneCard({ lane, li, s }: { lane: LaneConfig; li: number; s: RunnerUIState }) {
    const isSelected = li === s.laneIdx;
    const safeEi = Math.min(s.entryIdx, Math.max(0, lane.entries.length - 1));
    const proxyUp = s.proxyStates[proxyWindowName(lane.id)] ?? false;
    const title = ` ${isSelected ? "❯ " : ""}LANE ${lane.id}  ·  :${lane.canonicalPort}  `;

    return (
      <box
        key={lane.id}
        title={title}
        titleAlign="left"
        border={isSelected ? "heavy" : "single"}
        borderStyle={{ fg: isSelected ? C.cyan : C.dim }}
        px={1}
        gap={1}
      >
        <text style={{ fg: proxyUp ? C.green : C.red }}>{proxyUp ? "proxy ✓" : "proxy ✗"}</text>
        {lane.entries.length === 0
          ? <text style={{ fg: C.dim }}>{"  press [a] to add a process"}</text>
          : lane.entries.map((entry, ei) => (
              <EntryRow
                key={`${lane.id}:${entry.id}`}
                lane={lane} entry={entry} ei={ei}
                isSelectedLane={isSelected} selectedEi={safeEi} s={s}
              />
            ))
        }
      </box>
    );
  }

  function HintBar() {
    return (
      <column gap={0}>
        <row gap={1}>          
          <text style={{ fg: C.muted }}>[q]</text><text style={{ fg: C.dim }}>quit</text>          
          <text style={{ fg: C.muted }}>[l]</text><text style={{ fg: C.dim }}>add lane</text>
          <text style={{ fg: C.muted }}>[p]</text><text style={{ fg: C.dim }}>port</text>
          <text style={{ fg: C.muted }}>[D]</text><text style={{ fg: C.dim }}>del</text>
          <text style={{ fg: C.muted }}>[R]</text><text style={{ fg: C.dim }}>reset</text>
        </row>
        <row gap={1}>
          <text style={{ fg: C.muted }}>[a]</text><text style={{ fg: C.dim }}>add</text>
          <text style={{ fg: C.muted }}>[s]</text><text style={{ fg: C.dim }}>start</text>
          <text style={{ fg: C.muted }}>[S]</text><text style={{ fg: C.dim }}>warm</text>
          <text style={{ fg: C.muted }}>[w]</text><text style={{ fg: C.dim }}>switch</text>
          <text style={{ fg: C.muted }}>[x/X]</text><text style={{ fg: C.dim }}>stop</text>
          <text style={{ fg: C.muted }}>[r]</text><text style={{ fg: C.dim }}>remove</text>
          <text style={{ fg: C.muted }}>[e]</text><text style={{ fg: C.dim }}>cmd</text>
          <text style={{ fg: C.muted }}>[t]</text><text style={{ fg: C.dim }}>shell</text>
        </row>
      </column>
    );
  }

  // ── View ──────────────────────────────────────────────────────────────────

  // Mutable ref updated on every render so onEvent handlers can read current state.
  let _currentState: RunnerUIState | null = null;

  app.view((s) => {
    _currentState = s;
    const Header = () => (
      <row gap={0}>
        <text style={{ fg: C.cyan, bold: true }}>rt</text>
        <text style={{ bold: true }}>{"  runner"}</text>
        <text style={{ fg: C.dim }}>{"  "}{repoLabel}</text>
      </row>
    );

    // Entry-picker overlay
    if (s.mode.type === "entry-picker") {
      const pickerMode = s.mode as { type: "entry-picker"; laneId: string; purpose: "switch" | "remove"; idx: number };
      const lane = s.lanes.find((l) => l.id === pickerMode.laneId);
      if (!lane) return <column p={1}><Header /></column>;

      const isSwitch = pickerMode.purpose === "switch";
      const pickerIdx = pickerMode.idx;

      return (
        <column p={1} gap={1}>
          <Header />
          <box
            title={` ${isSwitch ? "Switch active entry" : "Remove entry"} — LANE ${lane.id}  :${lane.canonicalPort} `}
            border="single"
            borderStyle={{ fg: C.cyan }}
            px={1}
            gap={1}
          >
            {lane.entries.map((e, i) => {
              const win = entryWindowName(lane.id, e.id);
              const st = s.entryStates.get(win) ?? "stopped";
              const isSel = i === pickerIdx;
              return (
                <row key={e.id} gap={1}>
                  <text style={{ fg: isSel ? C.cyan : C.dim }}>{isSel ? "❯" : " "}</text>
                  <text style={{ fg: STATUS_COLOR[st] }}>{STATUS_ICON[st]}</text>
                  <text style={{ fg: lane.activeEntryId === e.id ? C.green : C.white }}>
                    {e.packageLabel !== "root" ? `${e.packageLabel} · ${e.script}` : e.script}
                  </text>
                  <text style={{ fg: C.dim }}>:{e.ephemeralPort}</text>
                  {lane.activeEntryId === e.id && <text style={{ fg: C.green }}>{"← active"}</text>}
                </row>
              );
            })}
            <text style={{ fg: C.dim }}>{`[↑↓] select  [↵] ${isSwitch ? "activate" : "remove"}  [Esc] cancel`}</text>
          </box>
        </column>
      );
    }

    // Bottom area: toast > modal > input > hints
    const Bottom = () => {
      if (s.toast) return <text style={{ fg: C.yel }}>{s.toast}</text>;
      if (s.mode.type === "confirm-reset") {
        return <text style={{ fg: C.red }}>{"Reset all lanes and stop all processes?  [y] confirm  [n / Esc] cancel"}</text>;
      }
      if (s.mode.type === "port-input") {
        const label = s.mode.purpose === "new-lane" ? "Add lane — port:" : "Edit port:";
        return (
          <focusTrap id="input-trap" active={true} initialFocus="port-input">
            <row gap={1}>
              <text style={{ fg: C.muted }}>{label}</text>
              <input
                id="port-input"
                value={s.inputValue}
                onInput={(v) => app.update((st) => ({ ...st, inputValue: v.replace(/\D/g, "") }))}
              />
              <text style={{ fg: C.dim }}>{"[↵] confirm  [Esc] cancel"}</text>
            </row>
          </focusTrap>
        );
      }
      if (s.mode.type === "command-edit") {
        return (
          <focusTrap id="input-trap" active={true} initialFocus="cmd-input">
            <column gap={0}>
              <text style={{ fg: C.dim }}>{"Edit command  ($PORT is replaced with the ephemeral port)"}</text>
              <row gap={1}>
                <text style={{ fg: C.dim }}>$</text>
                <input
                  id="cmd-input"
                  value={s.inputValue}
                  onInput={(v) => app.update((st) => ({ ...st, inputValue: v }))}
                />
                <text style={{ fg: C.dim }}>{"[↵] save  [Esc] cancel"}</text>
              </row>
            </column>
          </focusTrap>
        );
      }
      return <HintBar />;
    };

    return (
      <column p={1} gap={1}>
        <Header />
        {s.lanes.length === 0
          ? <text style={{ fg: C.dim }}>{"  No lanes — press [l] to create one"}</text>
          : s.lanes.map((lane, li) => <LaneCard key={lane.id} lane={lane} li={li} s={s} />)
        }
        <Bottom />
      </column>
    );
  });

  // ── Polling ────────────────────────────────────────────────────────────────

  // Guard: set to false when the app stops so async callbacks don't call app.update()
  // on a disposed app (which throws ZRUI_INVALID_STATE).
  let appRunning = true;

  // Safe wrapper: app.update() throws ZRUI_INVALID_STATE if the app is still
  // initializing (pre-run) or already disposed (post-run). All async callbacks
  // that may fire during either window must use this instead of calling
  // app.update() directly.
  function safeUpdate(updater: (s: RunnerUIState) => RunnerUIState) {
    if (!appRunning) return;
    try { app.update(updater); } catch { /* app not ready or already disposed */ }
  }

  async function pollDaemon() {
    if (!appRunning) return;
    const [statesRes, proxyRes] = await Promise.all([
      daemonQuery("process:states"),
      daemonQuery("proxy:list"),
    ]);

    if (!appRunning) return; // app may have stopped while we were awaiting

    const entryStates = new Map<string, EntryState>();
    if (statesRes?.ok && statesRes.data) {
      for (const [id, state] of Object.entries(statesRes.data as Record<string, string>)) {
        entryStates.set(id, state as EntryState);
      }
    }

    const proxyStates: Record<string, boolean> = {};
    if (proxyRes?.ok && Array.isArray(proxyRes.data)) {
      for (const p of proxyRes.data as { id: string }[]) {
        proxyStates[p.id] = true;
      }
    }

    safeUpdate((s) => ({ ...s, entryStates, proxyStates }));
  }

  void pollDaemon();
  const pollTimer = setInterval(() => { void pollDaemon(); }, 2000);

  // Advance the spinner frame at ~12fps (only re-renders when something is "starting")
  const spinnerTimer = setInterval(() => {
    safeUpdate((s) => {
      const hasStarting = [...s.entryStates.values()].some((st) => st === "starting");
      if (!hasStarting) return s; // no-op if nothing is starting — avoids needless renders
      return { ...s, spinnerFrame: s.spinnerFrame + 1 };
    });
  }, 80);

  void fetchEnrichment(currentLanes).then((enrichment) =>
    safeUpdate((s) => ({ ...s, enrichment }))
  );
  const enrichTimer = setInterval(() => {
    void fetchEnrichment(currentLanes).then((enrichment) =>
      safeUpdate((s) => ({ ...s, enrichment }))
    );
  }, 30_000);

  // ── Lane pane startup ─────────────────────────────────────────────────────
  // Create one background pane per lane and swap the first into the display split.
  for (const lane of initialLanes) {
    const entry = lane.entries.find((e) => e.id === lane.activeEntryId) ?? lane.entries[0];
    const processId = entry ? entryWindowName(lane.id, entry.id) : "";
    createBgPane(lane.id, processId);
  }
  const firstInitLane = initialLanes[0];
  if (firstInitLane) {
    initDisplayPane(firstInitLane.id);
  }

  // ── Key bindings (default / normal mode) ───────────────────────────────────

  app.keys({
    q: () => { app.stop(); },

    j: ({ state, update }) => {
      const newLi = Math.min(state.laneIdx + 1, state.lanes.length - 1);
      update((s) => ({ ...s, laneIdx: newLi, entryIdx: 0 }));
      switchDisplay(state.lanes[newLi]?.id ?? "");
    },
    k: ({ state, update }) => {
      const newLi = Math.max(0, state.laneIdx - 1);
      update((s) => ({ ...s, laneIdx: newLi, entryIdx: 0 }));
      switchDisplay(state.lanes[newLi]?.id ?? "");
    },
    down: ({ state, update }) => {
      const newLi = Math.min(state.laneIdx + 1, state.lanes.length - 1);
      update((s) => ({ ...s, laneIdx: newLi, entryIdx: 0 }));
      switchDisplay(state.lanes[newLi]?.id ?? "");
    },
    up: ({ state, update }) => {
      const newLi = Math.max(0, state.laneIdx - 1);
      update((s) => ({ ...s, laneIdx: newLi, entryIdx: 0 }));
      switchDisplay(state.lanes[newLi]?.id ?? "");
    },

    right: ({ state, update }) => {
      const lane = state.lanes[Math.min(state.laneIdx, state.lanes.length - 1)];
      update((s) => ({ ...s, entryIdx: Math.min(s.entryIdx + 1, (lane?.entries.length ?? 1) - 1) }));
    },
    left: ({ update }) => update((s) => ({ ...s, entryIdx: Math.max(0, s.entryIdx - 1) })),

    // [l] add lane
    l: ({ update }) => {
      update((s) => ({ ...s, mode: { type: "port-input", purpose: "new-lane" }, inputValue: "" }));
      app.setMode("port-input");
    },

    // [p] edit canonical port
    p: ({ state, update }) => {
      const lane = state.lanes[Math.min(state.laneIdx, state.lanes.length - 1)];
      if (!lane) return;
      update((s) => ({
        ...s,
        mode: { type: "port-input", purpose: "edit-port", laneId: lane.id },
        inputValue: String(lane.canonicalPort),
      }));
      app.setMode("port-input");
    },

    // [a] add process — open tmux split running rt run --resolve-only, poll for result
    a: ({ state }) => {
      const lane = state.lanes[Math.min(state.laneIdx, state.lanes.length - 1)];
      if (!lane) return;
      const tmpFile = join(tmpdir(), `rt-resolve-${Date.now()}.json`);
      const cmd = `${process.execPath} ${CLI_PATH} run --resolve-only --pick-worktree > ${tmpFile} 2>/dev/null`;
      tmuxSplit(cmd, repoRoot);

      const poll = setInterval(() => {
        if (!existsSync(tmpFile)) return;
        clearInterval(poll);
        try {
          const resolved = JSON.parse(readFileSync(tmpFile, "utf8").trim()) as RunResolveResult;
          unlinkSync(tmpFile);
          void addResolvedEntry(lane.id, resolved);
        } catch { /* ignore parse errors */ }
      }, 300);
    },

    // [s] start / activate / respawn
    s: ({ state }) => {
      const li = Math.min(state.laneIdx, state.lanes.length - 1);
      const lane = state.lanes[li];
      if (!lane) return;
      const ei = Math.min(state.entryIdx, lane.entries.length - 1);
      const entry = lane.entries[ei];
      if (!entry) return;
      const win = entryWindowName(lane.id, entry.id);
      const st = state.entryStates.get(win) ?? "stopped";
      if (st === "starting") return; // already in flight, ignore
      const action: LaneAction =
        st === "stopped" ? { type: "spawn",   laneId: lane.id, entryId: entry.id } :
        st === "crashed" ? { type: "respawn", laneId: lane.id, entryId: entry.id } :
                           { type: "activate", laneId: lane.id, entryId: entry.id };
      doDispatch(action, state);
    },

    // [S] warm all — handled via onEvent for text events (see below)

    // [w] switch active entry (opens entry picker)
    w: ({ state, update }) => {
      const lane = state.lanes[Math.min(state.laneIdx, state.lanes.length - 1)];
      if (!lane || lane.entries.length < 2) return;
      const currentIdx = Math.max(0, lane.entries.findIndex((e) => e.id === lane.activeEntryId));
      update((s) => ({ ...s, mode: { type: "entry-picker", purpose: "switch", laneId: lane.id, idx: currentIdx } }));
      app.setMode("entry-picker");
    },

    // [x] stop selected entry
    x: ({ state }) => {
      const lane = state.lanes[Math.min(state.laneIdx, state.lanes.length - 1)];
      if (!lane) return;
      const entry = lane.entries[Math.min(state.entryIdx, lane.entries.length - 1)];
      if (!entry) return;
      doDispatch({ type: "stop", laneId: lane.id, entryId: entry.id }, state);
    },

    // [X] stop all — handled via onEvent for text events (see below)

    // [r] remove entry (opens entry picker)
    r: ({ state, update }) => {
      const lane = state.lanes[Math.min(state.laneIdx, state.lanes.length - 1)];
      if (!lane || lane.entries.length === 0) return;
      const safeEi = Math.min(state.entryIdx, lane.entries.length - 1);
      update((s) => ({ ...s, mode: { type: "entry-picker", purpose: "remove", laneId: lane.id, idx: safeEi } }));
      app.setMode("entry-picker");
    },

    // [e] edit command template
    e: ({ state, update }) => {
      const lane = state.lanes[Math.min(state.laneIdx, state.lanes.length - 1)];
      if (!lane) return;
      const entry = lane.entries[Math.min(state.entryIdx, lane.entries.length - 1)];
      if (!entry) return;
      update((s) => ({
        ...s,
        mode: { type: "command-edit", laneId: lane.id, entryId: entry.id },
        inputValue: entry.commandTemplate,
      }));
      app.setMode("command-edit");
    },

    // [D] delete lane — handled via onEvent for text events (see below)
    // [R] reset — handled via onEvent for text events (see below)

    // [t] open a one-off interactive shell at the entry's working directory
    t: ({ state }) => {
      const lane = state.lanes[Math.min(state.laneIdx, state.lanes.length - 1)];
      if (!lane) return;
      const entry = lane.entries[Math.min(state.entryIdx, lane.entries.length - 1)];
      if (!entry) return;
      tmuxSplit(process.env.SHELL ?? "zsh", entry.targetDir);
    },

    // [Enter] — right pane always shows the service; no explicit action needed
  });

  // ── Uppercase shortcut handler ────────────────────────────────────────────
  //
  // Rezi's keybinding system only matches "key" events. In many terminal
  // configurations (including Ghostty without full Kitty Keyboard Protocol),
  // Shift+letter arrives as a "text" event (codepoint = uppercase char) rather
  // than a "key" event with the shift modifier bit set. We intercept "text"
  // events here and route uppercase letters to their respective actions.
  //
  // A mutable ref holds the latest state so the onEvent callback can read it
  // without going through app.update().
  app.onEvent((ev) => {
    if (ev.kind !== "engine") return;
    const event = ev.event;
    // Only handle text events for printable uppercase letters A-Z (codepoints 65-90).
    // Only act in the default mode — don't intercept while a modal/input is active.
    if (event.kind !== "text") return;
    if (app.getMode() !== "default") return;
    const char = String.fromCodePoint(event.codepoint);
    if (!_currentState) return;
    const s = _currentState;
    const lane = s.lanes[Math.min(s.laneIdx, s.lanes.length - 1)];
    switch (char) {
      case "S": // warm all entries in selected lane
        if (lane) doDispatch({ type: "warm-all", laneId: lane.id }, s);
        break;
      case "X": // stop all entries in selected lane
        if (lane) doDispatch({ type: "stop-all", laneId: lane.id }, s);
        break;
      case "D": // delete selected lane
        if (lane) doDispatch({ type: "remove-lane", laneId: lane.id }, s);
        break;
      case "R": // reset with confirmation
        safeUpdate((st) => ({ ...st, mode: { type: "confirm-reset" } }));
        app.setMode("confirm-reset");
        break;
    }
  });

  // ── Modal mode bindings ────────────────────────────────────────────────────

  app.modes({
    // Port input: digits go to ui.input(), only enter/escape handled here
    "port-input": {
      enter: ({ state, update }) => {
        const mode = state.mode;
        if (mode.type !== "port-input") return;
        const port = parseInt(state.inputValue, 10);
        if (!isNaN(port) && port > 1024 && port < 65536) {
          const ephemeralConflict = state.lanes.some((l) =>
            l.entries.some((e) => e.ephemeralPort === port)
          );
          if (ephemeralConflict) {
            showToast(`port ${port} is used by a running entry — pick another`);
            returnToNormal(update);
          } else if (mode.purpose === "new-lane") {
            if (!state.lanes.find((l) => l.canonicalPort === port)) {
              const id = nextLaneId(state.lanes);
              const newLane: LaneConfig = { id, canonicalPort: port, entries: [] };
              // Ensure proxy + group exist asynchronously; UI updates immediately
              void daemonQuery("group:create", { id: newLane.id });
              void ensureProxy(newLane);
              // Create a "no service" bg pane for the new lane
              createBgPane(newLane.id, "");
              initDisplayPane(newLane.id);
              update((s) => {
                const next = [...s.lanes, newLane];
                saveCurrent(next);
                return { ...s, lanes: next, laneIdx: next.length - 1, mode: { type: "normal" }, inputValue: "" };
              });
              app.setMode("default");
            } else {
              showToast(`port ${port} is already used by another lane`);
              returnToNormal(update);
            }
          } else if (mode.purpose === "edit-port" && mode.laneId) {
            const oldLane = state.lanes.find((l) => l.id === mode.laneId);
            if (oldLane && !state.lanes.find((l) => l.canonicalPort === port && l.id !== mode.laneId)) {
              // Stop old proxy and start new one on the updated port
              void daemonQuery("proxy:stop", { id: proxyWindowName(mode.laneId) }).then(() => {
                const updatedLane = { ...oldLane, canonicalPort: port };
                void ensureProxy(updatedLane);
              });
              update((s) => {
                const updatedLane = { ...oldLane, canonicalPort: port };
                const next = s.lanes.map((l) => l.id === mode.laneId ? updatedLane : l);
                saveCurrent(next);
                return { ...s, lanes: next, mode: { type: "normal" }, inputValue: "" };
              });
              app.setMode("default");
            } else {
              showToast(`port ${port} is already used by another lane`);
              returnToNormal(update);
            }
          }
        } else {
          returnToNormal(update);
        }
      },
      escape: ({ update }) => returnToNormal(update),
    },

    // Command edit: all characters go to ui.input(), only enter/escape handled
    "command-edit": {
      enter: ({ state, update }) => {
        const mode = state.mode;
        if (mode.type !== "command-edit") return;
        const cmd = state.inputValue.trim();
        if (cmd) {
          update((s) => {
            const next = s.lanes.map((l) =>
              l.id === mode.laneId
                ? { ...l, entries: l.entries.map((e) => e.id === mode.entryId ? { ...e, commandTemplate: cmd } : e) }
                : l
            );
            saveCurrent(next);
            return { ...s, lanes: next, mode: { type: "normal" }, inputValue: "" };
          });
          showToast("command updated — restart entry to apply");
        } else {
          returnToNormal(update);
        }
        app.setMode("default");
      },
      escape: ({ update }) => returnToNormal(update),
    },

    // Entry picker: navigate with j/k, select with Enter, cancel with Escape
    "entry-picker": {
      j: ({ state, update }) => {
        const mode = state.mode;
        if (mode.type !== "entry-picker") return;
        const lane = state.lanes.find((l) => l.id === mode.laneId);
        if (!lane) return;
        update((s) => s.mode.type === "entry-picker"
          ? { ...s, mode: { ...s.mode, idx: Math.min(s.mode.idx + 1, lane.entries.length - 1) } }
          : s
        );
      },
      k: ({ state, update }) => {
        if (state.mode.type !== "entry-picker") return;
        update((s) => s.mode.type === "entry-picker"
          ? { ...s, mode: { ...s.mode, idx: Math.max(0, s.mode.idx - 1) } }
          : s
        );
      },
      down: ({ state, update }) => {
        const mode = state.mode;
        if (mode.type !== "entry-picker") return;
        const lane = state.lanes.find((l) => l.id === mode.laneId);
        if (!lane) return;
        update((s) => s.mode.type === "entry-picker"
          ? { ...s, mode: { ...s.mode, idx: Math.min(s.mode.idx + 1, lane.entries.length - 1) } }
          : s
        );
      },
      up: ({ state, update }) => {
        if (state.mode.type !== "entry-picker") return;
        update((s) => s.mode.type === "entry-picker"
          ? { ...s, mode: { ...s.mode, idx: Math.max(0, s.mode.idx - 1) } }
          : s
        );
      },
      enter: ({ state, update }) => {
        const mode = state.mode;
        if (mode.type !== "entry-picker") return;
        const lane = state.lanes.find((l) => l.id === mode.laneId);
        if (!lane) { update((s) => ({ ...s, mode: { type: "normal" } })); app.setMode("default"); return; }
        const entry = lane.entries[mode.idx];
        if (entry) {
          if (mode.purpose === "switch")  doDispatch({ type: "activate",      laneId: lane.id, entryId: entry.id }, state);
          else                            doDispatch({ type: "remove-entry",  laneId: lane.id, entryId: entry.id }, state);
        }
        update((s) => ({ ...s, mode: { type: "normal" } }));
        app.setMode("default");
      },
      escape: ({ update }) => { update((s) => ({ ...s, mode: { type: "normal" } })); app.setMode("default"); },
    },

    // Confirm reset: y to confirm, n / Escape to cancel
    "confirm-reset": {
      y: ({ state, update }) => {
        doDispatch({ type: "reset" }, state);
        update((s) => ({ ...s, mode: { type: "normal" } }));
        app.setMode("default");
      },
      n: ({ update }) => { update((s) => ({ ...s, mode: { type: "normal" } })); app.setMode("default"); },
      escape: ({ update }) => { update((s) => ({ ...s, mode: { type: "normal" } })); app.setMode("default"); },
    },
  });

  try {
    await app.run();
  } catch (err) {
    // If the backend fails to start (e.g. TTY not available, or race with
    // pollDaemon losing), log a clear message instead of crashing silently.
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`\r\n\x1b[31m  ✗  rt runner failed to start: ${msg}\x1b[0m\r\n`);
  }

  appRunning = false;
  clearInterval(pollTimer);
  clearInterval(enrichTimer);
  clearInterval(spinnerTimer);

  // ── Lane pane cleanup ─────────────────────────────────────────────────────
  for (const paneId of lanePanes.values()) {
    spawnSync("tmux", ["kill-pane", "-t", paneId]);
  }
  if (bgWindowCreated) {
    spawnSync("tmux", ["kill-window", "-t", bgWindowName]);
  }

  return pending;
}

// ─── Entry ────────────────────────────────────────────────────────────────────

export async function showRunner(args: string[], ctx: CommandContext): Promise<void> {
  // Rezi's worker backend requires a real TTY. Show a clear error early.
  if (!process.stdin.isTTY && !process.stdout.isTTY && !process.stderr.isTTY) {
    console.error("\n  ✗  rt runner requires an interactive terminal (TTY)\n");
    console.error("     Run it directly in your terminal, not via a pipe or redirect.\n");
    process.exit(1);
  }

  // tmux is required — [t], [Enter], and [a] all open split panes.
  // If not already inside tmux, re-exec inside a new session transparently.
  if (!process.env.TMUX) {
    const result = spawnSync(
      "tmux",
      ["new-session", "--", process.execPath, CLI_PATH, "runner", ...args],
      { stdio: "inherit" },
    );
    process.exit(result.status ?? 0);
  }

  const daemonUp = await isDaemonRunning();
  if (!daemonUp) {
    console.error("\n  ✗  rt runner requires the rt daemon\n");
    console.error("     Start it:  rt daemon start\n");
    process.exit(1);
  }

  const repoRoot = ctx.identity?.repoRoot ?? getRepoRoot() ?? process.cwd();
  const dataDir = ctx.identity?.dataDir ?? join(homedir(), ".rt", "runner");
  const repoLabel = basename(repoRoot);

  if (args.includes("--reset")) {
    resetLanes(dataDir);
    if (!process.stdin.isTTY) return;
  }

  const lanes = loadLanes(dataDir);

  // Ensure all existing lanes have proxies and exclusive groups in the daemon
  for (const lane of lanes) {
    void daemonQuery("group:create", { id: lane.id });
    void ensureProxy(lane);
    for (const entry of lane.entries) {
      void daemonQuery("group:add", { groupId: lane.id, processId: entryWindowName(lane.id, entry.id) });
    }
  }

  await runOnce(lanes, dataDir, repoLabel, repoRoot);
}
