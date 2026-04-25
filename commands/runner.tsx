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
 *   Enter        activate selected entry (auto-starts if stopped)
 *   x            stop selected entry
 *   X            stop all entries in lane
 *   r            remove a process (entry picker)
 *   e            edit command template for selected entry
 *   D            delete selected lane
 *   R            reset all lanes (with confirmation)
 *   b            branch picker for the selected entry (switch / create / clean)
 *   c            open entry's worktree in editor (rt code)
 *   t            open a one-off shell at the entry's working directory
 *   q            quit
 */

import { rgb } from "@rezi-ui/jsx";
import { createNodeApp } from "@rezi-ui/node";
import { extendTheme, darkTheme } from "@rezi-ui/core";
import { spawnSync } from "node:child_process";
import { join, basename } from "node:path";
import { tmpdir, homedir } from "node:os";
import { existsSync, readFileSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { createInterface } from "node:readline";
import type { CommandContext } from "../lib/command-tree.ts";
import { daemonQuery, isDaemonRunning } from "../lib/daemon-client.ts";
import {
  readCurrentBranch, readCurrentBranchAsync, createGitWatcherPool,
} from "../lib/runner/git-watchers.ts";
import {
  listRunnerConfigs, loadRunnerConfig, saveRunnerConfig, resetRunnerConfig,
  acquireRunnerLock, releaseRunnerLock,
  nextEntryId, proxyWindowName, entryWindowName,
  type LaneConfig, type LaneEntry,
} from "../lib/runner-store.ts";
import { mergeOptimisticStates } from "../lib/runner/optimistic-state.ts";
import {
  dispatch,
  ensureProxy,
  type LaneAction,
} from "../lib/runner/dispatch.ts";
import { createNormalKeymap } from "../lib/runner/keys/normal.ts";
import { createLaneKeymap } from "../lib/runner/keys/lane.ts";
import { createProcessKeymap } from "../lib/runner/keys/process.ts";
import { createOpenKeymap } from "../lib/runner/keys/open.ts";
import { createPortKeymap } from "../lib/runner/keys/port.ts";
import { createPickerKeymap } from "../lib/runner/keys/picker.ts";
import { createConfirmResetKeymap, createConfirmSpreadKeymap } from "../lib/runner/keys/confirm.ts";
import type { KeymapContext } from "../lib/runner/keys/types.ts";
import type { RunResolveResult } from "./run.ts";
import { RT_ROOT, getKnownRepos, type KnownRepo } from "../lib/repo.ts";
import {
  T,
  C,
  STATUS_COLOR,
  STATUS_ICON,
  SPINNER_FRAMES,
  entryCommandLabel,
  type EntryState,
} from "../lib/runner/components/shared.ts";
import { EntryRow } from "../lib/runner/components/EntryRow.tsx";
import { LaneCard, entryGroupForIdx } from "../lib/runner/components/LaneCard.tsx";
import { HintBar } from "../lib/runner/components/HintBar.tsx";

// Re-export theme/status constants and the command-label helper for any external
// consumer that used to import them from this module. EntryState remains
// publicly exported for the same reason.
export type { EntryState };
export { C, STATUS_COLOR, STATUS_ICON, SPINNER_FRAMES, entryCommandLabel };

// ─── tmux helpers ─────────────────────────────────────────────────────────────

const CLI_PATH = join(RT_ROOT, "cli.ts");

// In dev mode, `process.execPath` is the bun interpreter and we need to pass
// cli.ts as the first arg. In prod (compiled binary), `process.execPath` IS
// the rt binary — cli.ts lives on a virtual bunfs filesystem that only the
// current process can see, so passing it as an arg would make a fresh child
// process fail with "unknown command: /$bunfs/root/cli.ts".
const IS_COMPILED_RT = basename(process.execPath) !== "bun";
// Dev mode is active when ~/.local/bin/rt exists (the wrapper script that points
// at local source). Mirrors the detection in commands/version.ts.
const IS_DEV_MODE = existsSync(join(homedir(), ".local/bin/rt"));
// Argv prefix for spawn/execFile calls: ["bun", "/path/cli.ts"] or ["rt"].
const RT_INVOKE: readonly string[] = IS_COMPILED_RT
  ? [process.execPath]
  : [process.execPath, CLI_PATH];
// Shell-escaped prefix for embedding into shell command strings.
const RT_SHELL = RT_INVOKE.map((s) => JSON.stringify(s)).join(" ");

/**
 * Open a vertical tmux split running `cmd`.
 * Always targets `targetPane` (the display pane) so the runner pane is never
 * resized and the Rezi layout stays intact.
 */
/**
 * Registry of all ZDOTDIR temp dirs created for Esc-able shell panes.
 *
 * The .zshrc trap handles normal exits; this Set + process exit handler is a
 * safety net for the case where tmux kills the pane with SIGHUP/SIGKILL
 * (e.g. the runner is quit while a shell pane is still open) and the shell
 * never gets a chance to run its own cleanup.
 */
const _zdotdirRegistry = new Set<string>();
process.once("exit", () => {
  for (const dir of _zdotdirRegistry) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

/**
 * Open a temporary tmux split pane. Returns the tmux pane ID.
 *
 * Use for **persistent** panes (lane log views, interactive shells)
 * where pane ID tracking and split layout are needed.
 *
 * For ephemeral task-oriented commands (pickers, editors), use openPopup() instead.
 */
function openTempPane(
  cmd: string,
  opts: { cwd?: string; target?: string; escToClose?: boolean } = {},
): string | undefined {
  let resolvedCmd = cmd;

  if (opts.escToClose) {
    const zdotdir  = join(tmpdir(), `rt-shell-${Date.now()}`);
    const rcFile   = join(zdotdir, ".zshrc");
    const realRc   = join(homedir(), ".zshrc");
    mkdirSync(zdotdir, { recursive: true });
    _zdotdirRegistry.add(zdotdir);
    writeFileSync(rcFile, [
      `# rt runner — sources real .zshrc then wires Esc→close silently`,
      `[[ -f "${realRc}" ]] && ZDOTDIR="${homedir()}" source "${realRc}"`,
      `esc-exit() { exit 0; }`,
      `zle -N esc-exit`,
      `bindkey '^[' esc-exit`,
      `trap 'rm -rf "${zdotdir}"' EXIT`,
      `trap 'rm -rf "${zdotdir}"; exit' HUP TERM`,
    ].join("\n"));
    resolvedCmd = `ZDOTDIR=${zdotdir} ${cmd}`;
  }

  const args = ["split-window", "-v", "-P", "-F", "#{pane_id}"];
  if (opts.target) args.push("-t", opts.target);
  if (opts.cwd)    args.push("-c", opts.cwd);
  args.push(resolvedCmd);
  const result = spawnSync("tmux", args, { encoding: "utf8" });
  return result.stdout?.trim() || undefined;
}

/**
 * Open a floating tmux popup (requires tmux ≥ 3.2).
 *
 * Use for **ephemeral** task-oriented commands (pickers, editors, one-off scripts).
 * The popup floats above the runner layout without resizing any panes.
 * Closes automatically when the command exits (-E flag).
 *
 * Does NOT return a pane ID — popups are truly ephemeral.
 */
function openPopup(
  cmd: string,
  opts: { cwd?: string; width?: string; height?: string; title?: string; hint?: string } = {},
): void {
  const w = opts.width ?? "80%";
  const h = opts.height ?? "80%";
  const title = opts.title ?? "";
  const hint = opts.hint ?? "Esc to close";
  const titleFmt = title
    ? ` ${title} #[align=right] ${hint} `
    : "";
  const args = [
    "display-popup", "-E",
    "-w", w, "-h", h,
    "-b", "rounded",
    "-s", "bg=#1a1b26",        // darker bg to distinguish from runner
    "-S", "fg=cyan",           // border color
  ];
  if (titleFmt) args.push("-T", titleFmt);
  if (opts.cwd) args.push("-d", opts.cwd);
  args.push("sh", "-c", `${cmd}; true`);
  spawnSync("tmux", args, { encoding: "utf8" });
}


// ─── Types ────────────────────────────────────────────────────────────────────

// EntryState moved to lib/runner/components/shared.ts and re-exported above.

type InteractiveRequest = { type: "quit" };

type Mode =
  | { type: "normal" }
  | { type: "lane-scope" }
  | { type: "process-scope" }
  | { type: "open-scope" }
  | { type: "port-input"; purpose: "edit-port"; laneId: string }
  | { type: "entry-picker"; purpose: "remove"; laneId: string; idx: number }
  | { type: "confirm-reset" }
  | { type: "confirm-spread"; laneId: string; entryId: string };

export interface RunnerUIState {
  lanes:         LaneConfig[];
  laneIdx:       number;
  entryIdx:      number;
  mode:          Mode;
  entryStates:   Map<string, EntryState>;
  /** Keyed by proxyWindowName(laneId); true = proxy is running. */
  proxyStates:   Record<string, boolean>;
  /**
   * Per-entry branch label, split into a left/right pair so the runner can
   * pin status icons to the right edge while the title clips on overflow.
   * Keyed by `${laneId}:${entryId}`.
   */
  enrichment:    Record<string, { leading: string; trailing: string }>;
  inputValue:    string;
  toast:         string | null;
  /** Monotonically incrementing counter used to animate the "starting" spinner. */
  spinnerFrame:  number;
  /** Name of the loaded runner config (displayed in header). */
  runnerName:    string;
  /** All known repos, used for repo-pick mode and resolving lane repoRoot. */
  knownRepos:    KnownRepo[];
}

// ─── Theme — bubble tea ✨ ───────────────────────────────────────────────────
//
// The T (raw tokens), C (semantic roles), STATUS_COLOR, STATUS_ICON, and
// SPINNER_FRAMES now live in lib/runner/components/shared.ts so they can be
// consumed by the extracted view components. `runnerTheme` still lives here
// because it's only used to configure the local Rezi app instance.
// ─────────────────────────────────────────────────────────────────────────────

/** Rezi canvas theme — bg pulled from T so it stays in sync with the palette. */
const runnerTheme = extendTheme(darkTheme, {
  colors: {
    bg: {
      base:     rgb(...T.bgBase),
      elevated: rgb(...T.bgElevated),
      overlay:  rgb(...T.bgOverlay),
      subtle:   rgb(...T.bgSubtle),
    },
  } as any,
});

// ─── Editor helpers ───────────────────────────────────────────────────────────

/**
 * Detect the best available terminal editor. Checks $EDITOR first, then
 * probes for nvim, vim, nano in order. Shared by [e] and [f] popup flows.
 */
function detectEditor(): string {
  if (process.env.EDITOR) return process.env.EDITOR;
  for (const ed of ["nvim", "vim", "nano"]) {
    if (spawnSync("which", [ed], { encoding: "utf8" }).status === 0) return ed;
  }
  return "nano";
}

/** Build an editor invocation string with editor-specific flags. */
function buildEditorCmd(filePath: string): { editorCmd: string; hint: string } {
  const editor = detectEditor();
  const isVim  = /\bnvi?m\b/.test(editor);
  const isNano = /\bnano\b/.test(editor);
  const editorCmd = isVim
    ? `${editor} '+call cursor(1, 1000)' -c 'startinsert!' '${filePath}'`
    : isNano ? `${editor} --save-on-exit '${filePath}'` : `${editor} '${filePath}'`;
  const hint = isVim ? ":wq to save" : isNano ? "Ctrl-X to save" : "save and close";
  return { editorCmd, hint };
}


// ─── Git HEAD helpers ─────────────────────────────────────────────────────────
// (branch readers and watcher-pool factory live in ../lib/runner/git-watchers.ts)

// ─── Enrichment ───────────────────────────────────────────────────────────────

async function fetchEnrichment(lanes: LaneConfig[]): Promise<Record<string, { leading: string; trailing: string }>> {
  const targets: { key: string; branch: string; worktree: string }[] = [];
  for (const lane of lanes) {
    for (const entry of lane.entries) {
      if (entry.branch) {
        targets.push({ key: `${lane.id}:${entry.id}`, branch: entry.branch, worktree: entry.worktree });
      }
    }
  }
  if (targets.length === 0) return {};

  const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

  try {
    const { formatBranchLabelParts } = await import("../lib/enrich.ts");

    // Primary: daemon in-memory cache (fast, always up-to-date after a refresh)
    const response = await daemonQuery("cache:read", { branches: targets.map((t) => t.branch) });
    const daemonCache = (response?.ok && response.data) ? response.data as Record<string, any> : {};

    // Fallback: disk cache for any branches the daemon doesn't have yet
    let diskCache: Record<string, any> = {};
    const missingFromDaemon = targets.filter(t => !daemonCache[t.branch]);
    if (missingFromDaemon.length > 0) {
      try {
        const { join } = await import("node:path");
        const { homedir } = await import("node:os");
        const raw = readFileSync(join(homedir(), ".rt", "branch-cache.json"), "utf8");
        diskCache = (JSON.parse(raw) as { entries: Record<string, any> }).entries ?? {};
      } catch { /* no disk cache */ }
    }

    const result: Record<string, { leading: string; trailing: string }> = {};
    for (const { key, branch, worktree } of targets) {
      const e = daemonCache[branch] ?? diskCache[branch];
      if (e) {
        const parts = formatBranchLabelParts({
          path: worktree, dirName: worktree.split("/").pop() ?? worktree,
          branch, linearId: e.linearId || null, ticket: e.ticket ?? null, mr: e.mr ?? null,
        });
        result[key] = { leading: stripAnsi(parts.leading), trailing: stripAnsi(parts.trailing) };
      } else {
        result[key] = { leading: branch, trailing: "" };
      }
    }
    return result;
  } catch {
    const result: Record<string, { leading: string; trailing: string }> = {};
    for (const { key, branch } of targets) result[key] = { leading: branch, trailing: "" };
    return result;
  }
}


// ─── Runner (one UI session) ──────────────────────────────────────────────────


async function runOnce(
  initialLanes: LaneConfig[],
  runnerName: string,
  knownRepos: KnownRepo[],
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

  // Pre-fetch process state, proxy state, and enrichment so the first frame is
  // already fully populated — avoids flashes of "stopped"/proxy-X/bare branch names.
  const [initStatesRes, initProxyRes, initialEnrichment] = await Promise.all([
    daemonQuery("process:states"),
    daemonQuery("proxy:list"),
    fetchEnrichment(initialLanes),
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

  // Start on the first lane that has a running entry, so launching the runner
  // lands on the work-in-progress instead of forcing the user to navigate.
  // Mirrors the j/k navigation default (which selects each lane's active entry).
  let initialLaneIdx = 0;
  let initialEntryIdx = 0;
  for (let li = 0; li < initialLanes.length; li++) {
    const lane = initialLanes[li];
    if (!lane) continue;
    const ei = lane.entries.findIndex(
      (e) => initialEntryStates.get(entryWindowName(lane.id, e.id)) === "running",
    );
    if (ei >= 0) {
      initialLaneIdx = li;
      initialEntryIdx = ei;
      break;
    }
  }

  const app = createNodeApp<RunnerUIState>({
    initialState: {
      lanes:        initialLanes,
      laneIdx:      initialLaneIdx,
      entryIdx:     initialEntryIdx,
      mode:         { type: "normal" },
      entryStates:  initialEntryStates,
      proxyStates:  initialProxyStates,
      enrichment:   initialEnrichment,
      inputValue:   "",
      toast:        null,
      spinnerFrame: 0,
      runnerName,
      knownRepos,
    },
    theme: runnerTheme,
    // In the compiled binary, Rezi's worker entry lives on the virtual
    // bunfs that a worker_threads.Worker can't see — forcing inline mode
    // keeps rendering on the main thread and avoids the "Unable to locate
    // worker entry" error. Dev (bun) keeps the faster worker path.
    config: IS_COMPILED_RT ? { executionMode: "inline" } : undefined,
  });

  // ── Helpers ───────────────────────────────────────────────────────────────

  function showToast(msg: string, ms = 2500) {
    safeUpdate((s) => ({ ...s, toast: msg }));
    setTimeout(() => safeUpdate((s) => ({ ...s, toast: null })), ms);
  }

  function saveCurrent(newLanes: LaneConfig[]) {
    currentLanes = newLanes;
    if (!saveRunnerConfig(runnerName, newLanes)) {
      // mtime guard refused the write — someone (another runner, a manual
      // edit) changed the file out from under us. The singleton lock should
      // make this unreachable, but if it triggers, warn the user so they can
      // quit and restart rather than lose edits silently.
      showToast("⚠ config changed on disk — restart runner to avoid drift", 5000);
    }
  }

  /** Port-allocate, create entry, persist lanes, update UI state. */
  async function addResolvedEntry(laneId: string, resolved: RunResolveResult): Promise<void> {
    const lane = currentLanes.find((l) => l.id === laneId);
    if (!lane) return;

    // Compute entryId BEFORE port allocation so we can use entryWindowName as
    // the port label — matching what port:release uses (avoids orphan ports).
    const entryId = nextEntryId(lane.entries);
    const processId = entryWindowName(lane.id, entryId);

    const portRes = await daemonQuery("port:allocate", { label: processId });
    const ephemeralPort: number = portRes?.ok
      ? Number((portRes.data as { port: number })?.port)
      : (10000 + Math.floor(Math.random() * 1000));
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
    syncGitWatchers(newLanes);

    await daemonQuery("group:add", { groupId: lane.id, processId });
    if (isFirst) await daemonQuery("proxy:set-upstream", { id: proxyWindowName(lane.id), port: ephemeralPort });

    // Ensure a bg pane exists for this lane; refresh it if this is the first entry
    if (!lanePanes.has(laneId)) {
      createBgPane(laneId, processId, `lane ${laneId} · ${lane.repoName} :${lane.canonicalPort}`);
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
      ? `while true; do ${RT_SHELL} attach ${processId} 2>&1 || true; printf '\\033[2m  ─ stopped ─\\033[0m\\r\\n'; sleep 1; done`
      : `while true; do printf '\\033[2m  no service\\033[0m\\r\\n'; sleep 5; done`;
  }

  function restoreFocus(): void {
    if (runnerPaneId) spawnSync("tmux", ["select-pane", "-t", runnerPaneId]);
  }

  /** Pane ID of the right-side display pane (used as split target to avoid resizing the runner). */
  function displayPane(): string | undefined {
    return displayedLaneId ? lanePanes.get(displayedLaneId) : undefined;
  }

  // ── MR info pane (bottom-right, hidden by default, toggled with [i]) ────────
  let mrPaneEnabled = false; // global on/off — persists across navigation
  let mrPaneId = "";         // tmux pane ID; "" = not yet spawned
  let mrPaneBranch = "";     // branch currently shown in the MR pane

  function showMrPane(branch: string): void {
    const displayPaneId = displayedLaneId ? lanePanes.get(displayedLaneId) : undefined;
    if (!displayPaneId) return;
    const cmd = `${RT_SHELL} mr-status ${branch || ""}`;
    const result = spawnSync("tmux", [
      "split-window", "-v", "-l", "50%", "-t", displayPaneId,
      "-P", "-F", "#{pane_id}", "-d", cmd,
    ], { encoding: "utf8" });
    mrPaneId = result.stdout.trim();
    mrPaneBranch = branch;
    if (mrPaneId) spawnSync("tmux", ["select-pane", "-t", mrPaneId, "-T", `MR · ${branch || "no branch"}`]);
    restoreFocus();
  }

  function hideMrPane(): void {
    if (!mrPaneId) return;
    spawnSync("tmux", ["kill-pane", "-t", mrPaneId]);
    mrPaneId = "";
    mrPaneBranch = "";
  }

  /** If the info pane is enabled and the branch changed, respawn it. */
  function updateMrPane(branch: string): void {
    if (!mrPaneEnabled) return;
    if (branch === mrPaneBranch && mrPaneId) return;
    hideMrPane();
    showMrPane(branch);
  }

  /** Index of the active entry in a lane (falls back to 0). */
  function activeEntryIdx(lane: LaneConfig | undefined): number {
    if (!lane || lane.entries.length === 0) return 0;
    const idx = lane.entries.findIndex((e) => e.id === lane.activeEntryId);
    return idx >= 0 ? idx : 0;
  }

  /** Branch of the currently focused lane entry. */
  function focusedBranch(s: { lanes: LaneConfig[]; laneIdx: number; entryIdx: number }): string {
    const lane = s.lanes[Math.min(s.laneIdx, s.lanes.length - 1)];
    if (!lane) return "";
    const entry = lane.entries[Math.min(s.entryIdx, lane.entries.length - 1)];
    return entry?.branch ?? "";
  }

  function ensureBgWindow(): void {
    if (bgWindowCreated) return;
    spawnSync("tmux", ["new-window", "-d", "-n", bgWindowName, "sleep infinity"]);
    bgWindowCreated = true;
  }

  /** Create a pane in the background window for `laneId`, return its pane ID. */
  function createBgPane(laneId: string, processId: string, paneTitle?: string): string {
    ensureBgWindow();
    const result = spawnSync("tmux", [
      "split-window", "-t", bgWindowName, "-d", "-P", "-F", "#{pane_id}",
      attachLoopCmd(processId),
    ], { encoding: "utf8" });
    const paneId = result.stdout.trim();
    lanePanes.set(laneId, paneId);
    if (paneTitle) spawnSync("tmux", ["select-pane", "-t", paneId, "-T", paneTitle]);
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

  // ── Async dispatch ────────────────────────────────────────────────────────
  //
  // dispatch() lives in lib/runner/dispatch.ts — pure (action, state) → Promise<patch>.
  // doDispatch wraps it with runner-local side effects (optimistic UI state,
  // persistence, pane refresh) that close over runOnce() state.

  // Minimum time (ms) to display optimistic "starting"/"stopping" states.
  // The daemon transitions happen so fast (spawn sets starting→running in <100ms)
  // that the poll immediately clears the optimistic state before the user sees
  // the spinner. This floor guarantees visual feedback.
  const MIN_TRANSIENT_MS = 800;
  const optimisticSetAt = new Map<string, number>();

  function doDispatch(action: LaneAction, currentState: RunnerUIState): void {
    // Show optimistic "starting"/"stopping" immediately for instant visual feedback.
    // The daemon also sets these states authoritatively, but the transient window
    // is often too brief for the 2s poll to catch (e.g. fast SIGTERM kills).
    // The optimistic state is cleared when dispatch completes and the next poll
    // returns the real daemon state.
    const startingIds: string[] = [];
    const stoppingIds: string[] = [];

    if (action.type === "spawn" || action.type === "respawn") {
      startingIds.push(entryWindowName(action.laneId, action.entryId));
    } else if (action.type === "activate") {
      const processId = entryWindowName(action.laneId, action.entryId);
      const st = currentState.entryStates.get(processId) ?? "stopped";
      if (st === "stopped" || st === "crashed") startingIds.push(processId);
    } else if (action.type === "warm-all") {
      const lane = currentState.lanes.find((l) => l.id === action.laneId);
      if (lane) {
        for (const e of lane.entries) {
          const id = entryWindowName(lane.id, e.id);
          const st = currentState.entryStates.get(id) ?? "stopped";
          if (st === "stopped" || st === "crashed") startingIds.push(id);
        }
      }
    } else if (action.type === "restart") {
      // Restart: show "starting" (not "stopping") since the intent is to get it running.
      startingIds.push(entryWindowName(action.laneId, action.entryId));
    } else if (action.type === "stop") {
      stoppingIds.push(entryWindowName(action.laneId, action.entryId));
    }

    if (startingIds.length > 0 || stoppingIds.length > 0) {
      const now = Date.now();
      for (const id of startingIds) optimisticSetAt.set(id, now);
      for (const id of stoppingIds) optimisticSetAt.set(id, now);
      safeUpdate((s) => {
        const next = new Map(s.entryStates);
        for (const id of startingIds) next.set(id, "starting");
        for (const id of stoppingIds) next.set(id, "stopping");
        return { ...s, entryStates: next };
      });
    }

    dispatch(action, { ...currentState, initiator: `runner:${runnerName}` }).then((patch) => {
      // app.update() calls the updater asynchronously — work that depends on
      // the mutated lanes (save, pane refresh, pane cleanup) must run INSIDE
      // the updater, not after safeUpdate() returns. A once-guard prevents
      // double-execution if the framework ever re-invokes the updater.
      let postMutateDone = false;
      safeUpdate((s) => {
        const previousLanes = s.lanes;
        const mutated: LaneConfig[] = patch.mutate ? patch.mutate(s.lanes) : s.lanes;

        const updates: Partial<RunnerUIState> = {};
        if (patch.mutate) updates.lanes = mutated;
        if (patch.laneIdx !== undefined) {
          const max = Math.max(0, mutated.length - 1);
          updates.laneIdx = Math.max(0, Math.min(patch.laneIdx, max));
        } else if (patch.mutate && mutated.length !== s.lanes.length) {
          updates.laneIdx = Math.max(0, Math.min(s.laneIdx, Math.max(0, mutated.length - 1)));
        }
        if (patch.entryIdx !== undefined) updates.entryIdx = patch.entryIdx;

        if (patch.mutate && !postMutateDone) {
          postMutateDone = true;
          saveCurrent(mutated);

          // Refresh lane panes whose active entry changed (spawn/activate/respawn)
          for (const newLane of mutated) {
            const oldLane = previousLanes.find((l) => l.id === newLane.id);
            if (oldLane && oldLane.activeEntryId !== newLane.activeEntryId && newLane.activeEntryId) {
              const newActiveEntry = newLane.entries.find((e) => e.id === newLane.activeEntryId);
              const processId = newActiveEntry ? entryWindowName(newLane.id, newActiveEntry.id) : "";
              refreshLanePane(newLane.id, processId);
            }
          }

          // Kill panes for lanes that were removed (remove-lane / reset).
          //
          // Swap a surviving lane's pane into the display slot BEFORE killing,
          // so the display split never collapses mid-operation (which would
          // trigger a SIGWINCH that blanks the Ink TUI).
          for (const oldLane of previousLanes) {
            if (mutated.find((l) => l.id === oldLane.id)) continue;
            const paneId = lanePanes.get(oldLane.id);
            if (!paneId) continue;
            const wasDisplayed = displayedLaneId === oldLane.id;
            lanePanes.delete(oldLane.id);
            if (wasDisplayed) {
              const nextLane = mutated.find((l) => lanePanes.has(l.id));
              const nextPaneId = nextLane ? lanePanes.get(nextLane.id) : undefined;
              if (nextLane && nextPaneId) {
                spawnSync("tmux", ["swap-pane", "-s", paneId, "-t", nextPaneId]);
                displayedLaneId = nextLane.id;
                restoreFocus();
              } else {
                displayedLaneId = "";
              }
            }
            spawnSync("tmux", ["kill-pane", "-t", paneId]);
          }
        }

        return { ...s, ...updates };
      });
    });
  }


  // ── View components ───────────────────────────────────────────────────────
  //
  // EntryRow, LaneCard, HintBar (plus the `computeEntryGroups` / `entryGroupForIdx`
  // helpers and the `entryCommandLabel` display helper) live in
  // lib/runner/components/. They're pure props-only views that only close over
  // imported constants/helpers, so hoisting them out avoids re-declaring them
  // on every call to runOnce().

  // ── View ──────────────────────────────────────────────────────────────────

  // Mutable ref updated on every render so onEvent handlers can read current state.
  let _currentState: RunnerUIState | null = null;

  app.view((s) => {
    _currentState = s;
    const Header = () => (
      <row gap={0}>
        <text style={{ fg: C.pink, bold: true }}>rt</text>
        {IS_DEV_MODE && <text style={{ fg: C.peach }}>{"  (dev mode)"}</text>}
        <text style={{ bold: true }}>{"  runner"}</text>
        <text style={{ fg: C.dim }}>{"  "}{s.runnerName}</text>
      </row>
    );

    // Entry-picker overlay
    if (s.mode.type === "entry-picker") {
      const pickerMode = s.mode as { type: "entry-picker"; laneId: string; purpose: "remove"; idx: number };
      const lane = s.lanes.find((l) => l.id === pickerMode.laneId);
      if (!lane) return <column p={1}><Header /></column>;

      const pickerIdx = pickerMode.idx;

      return (
        <column p={1} gap={1}>
          <Header />
          <box
            title={` Remove entry — LANE ${lane.id}  :${lane.canonicalPort} `}
            border="single"
            borderStyle={{ fg: C.pink }}
            px={1}
            gap={1}
          >
            {lane.entries.map((e, i) => {
              const win = entryWindowName(lane.id, e.id);
              const st = s.entryStates.get(win) ?? "stopped";
              const isSel = i === pickerIdx;
              return (
                <row key={e.id} gap={1}>
                  <text style={{ fg: isSel ? C.pink : C.dim }}>{isSel ? "❯" : " "}</text>
                  <text style={{ fg: STATUS_COLOR[st] }}>{STATUS_ICON[st]}</text>
                  <text style={{ fg: lane.activeEntryId === e.id ? C.mint : C.white }}>
                    {e.packageLabel !== "root" ? `${e.packageLabel} · ${e.script}` : e.script}
                  </text>
                  {lane.activeEntryId === e.id && <text style={{ fg: C.mint }}>{"← active"}</text>}
                </row>
              );
            })}
            <text style={{ fg: C.dim }}>{`[↑↓] select  [↵] remove  [Esc] cancel`}</text>
          </box>
        </column>
      );
    }

    // Bottom area: toast > modal > input > hints
    const Bottom = () => {
      if (s.toast) return <text style={{ fg: C.peach }}>{s.toast}</text>;
      if (s.mode.type === "confirm-reset") {
        return <text style={{ fg: C.coral }}>{"Reset all lanes and stop all processes?  [y] confirm  [n / Esc] cancel"}</text>;
      }
      if (s.mode.type === "confirm-spread") {
        const spreadMode = s.mode as { laneId: string; entryId: string };
        const spreadLane = s.lanes.find((l) => l.id === spreadMode.laneId);
        const spreadEntry = spreadLane?.entries.find((e) => e.id === spreadMode.entryId);
        const spreadLabel = spreadEntry ? `'${spreadEntry.script}'` : "command";
        return <text style={{ fg: C.peach }}>{`Spread ${spreadLabel} to all worktrees of ${spreadLane?.repoName ?? ""}?  [y] confirm  [n / Esc] cancel`}</text>;
      }
      if (s.mode.type === "port-input") {
        const label = "Edit port:";
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
      return <HintBar mode={s.mode.type} />;
    };

    return (
      <column p={1} gap={1}>
        <Header />
        {s.lanes.length === 0
          ? <text style={{ fg: C.dim }}>{"  No lanes — press [l] then [a] to create one"}</text>
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
    const [statesRes, proxyRes, remedyRes] = await Promise.all([
      daemonQuery("process:states"),
      daemonQuery("proxy:list"),
      daemonQuery("remedy:drain"),
    ]);

    if (!appRunning) return; // app may have stopped while we were awaiting

    // Surface any remedy fire events as toasts
    if (remedyRes?.ok && Array.isArray(remedyRes.data)) {
      for (const ev of remedyRes.data as { name: string; success: boolean }[]) {
        showToast(
          ev.success ? `✓ Remedy: ${ev.name}` : `✗ Remedy failed: ${ev.name}`,
          ev.success ? 3000 : 5000,
        );
      }
    }

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

    safeUpdate((s) => {
      // Merge daemon state with any in-flight optimistic transient states.
      // The daemon also sets "starting"/"stopping" authoritatively, but the
      // window is often too brief for the 2s poll to catch. So we preserve
      // client-side optimistic transients until (a) the daemon confirms the
      // expected terminal state AND (b) the minimum display time has elapsed.
      const { merged, expiredIds } = mergeOptimisticStates({
        daemonStates: entryStates,
        currentStates: s.entryStates,
        optimisticSetAt,
        now: Date.now(),
        minTransientMs: MIN_TRANSIENT_MS,
      });
      for (const id of expiredIds) optimisticSetAt.delete(id);
      return { ...s, entryStates: merged, proxyStates };
    });
  }


  void pollDaemon();
  const pollTimer = setInterval(() => { void pollDaemon(); }, 2000);

  // Advance the spinner frame at ~12fps.
  // Only triggers a re-render when something is actually in a transient state
  // ("starting" or "stopping") — avoids needless renders otherwise.
  const spinnerTimer = setInterval(() => {
    safeUpdate((s) => {
      const hasTransient = [...s.entryStates.values()].some(
        (st) => st === "starting" || st === "stopping",
      );
      if (!hasTransient) return s;
      return { ...s, spinnerFrame: s.spinnerFrame + 1 };
    });
  }, 80);

  const enrichTimer = setInterval(() => {
    void fetchEnrichment(currentLanes).then((enrichment) =>
      safeUpdate((s) => ({ ...s, enrichment }))
    );
  }, 3_000);

  // ── Git HEAD watchers (one per lane / repo) ───────────────────────────────
  // Watcher creation, per-lane debounce, and linked-worktree handling all live
  // in `createGitWatcherPool`. We hand it a callback that runs the state-
  // update logic for the lane whose HEAD moved.
  const gitWatcherPool = createGitWatcherPool((laneId) => doRepoChange(laneId));
  function syncGitWatchers(lanes: LaneConfig[]): void {
    gitWatcherPool.sync(lanes);
  }

  function doRepoChange(laneId: string, attempt = 0): void {
    // Read all current branches BEFORE entering the state updater.
    // spawnSync inside safeUpdate() blocks the render loop — keep the
    // updater callback a pure synchronous object merge.
    // currentLanes is kept in sync with app state by every mutation.
    const lane = currentLanes.find((l) => l.id === laneId);
    if (!lane) return;

    // Snapshot: entryId → freshly-read branch name
    const freshBranches = new Map<string, string>();
    for (const entry of lane.entries) {
      if (!entry.worktree) continue;
      const branch = readCurrentBranch(entry.worktree);
      if (branch) freshBranches.set(entry.id, branch);
    }

    const anyChanged = lane.entries.some(
      (e) => freshBranches.has(e.id) && freshBranches.get(e.id) !== e.branch,
    );

    if (!anyChanged) {
      // Debounce handles mid-write races in most cases, but schedule one
      // direct retry in case HEAD still hadn't been fully written.
      if (attempt < 1) {
        setTimeout(() => doRepoChange(laneId, attempt + 1), 250);
      }
      return;
    }

    // Pure state update — no I/O inside the updater.
    // IMPORTANT: saveRunnerConfig is called OUTSIDE safeUpdate (after the state
    // has been committed) to avoid a race with addResolvedEntry. If we saved
    // inside the updater callback, a queued safeUpdate from addResolvedEntry
    // that runs *after* ours could see s.lanes without the newly-added entry
    // and overwrite the file with a stale snapshot, erasing the new entry.
    let savedLanes: LaneConfig[] | null = null;

    safeUpdate((s) => {
      const targetLane = s.lanes.find((l) => l.id === laneId);
      if (!targetLane) return s;

      const updatedEntries = targetLane.entries.map((entry) => {
        const fresh = freshBranches.get(entry.id);
        if (!fresh || fresh === entry.branch) return entry;
        return { ...entry, branch: fresh };
      });

      const updatedLanes = s.lanes.map((l) =>
        l.id === laneId ? { ...l, entries: updatedEntries } : l
      );
      currentLanes = updatedLanes;
      savedLanes = updatedLanes; // capture for post-update save
      return { ...s, lanes: updatedLanes };
    });

    // Persist and re-enrich after the state update has been applied.
    if (savedLanes) {
      if (!saveRunnerConfig(runnerName, savedLanes)) {
        showToast("⚠ config changed on disk — restart runner to avoid drift", 5000);
      }
      void fetchEnrichment(savedLanes).then((enrichment) =>
        safeUpdate((s2) => ({ ...s2, enrichment }))
      );
    }
  }

  syncGitWatchers(initialLanes);

  // ── tmux window options ───────────────────────────────────────────────────
  // Pane borders: thick lines, dim inactive, cyan active, title in top border.
  spawnSync("tmux", ["set-option", "-w", "pane-border-lines",        "heavy"]);
  spawnSync("tmux", ["set-option", "-w", "pane-border-style",        "fg=colour238"]);
  spawnSync("tmux", ["set-option", "-w", "pane-active-border-style", "fg=cyan"]);
  spawnSync("tmux", ["set-option", "-w", "pane-border-status",       "top"]);
  spawnSync("tmux", ["set-option", "-w", "pane-border-format",       " #{pane_title} "]);
  // Mouse support: click to focus panes, scroll, resize.
  spawnSync("tmux", ["set-option", "-g", "mouse", "on"]);
  // Name the runner pane itself.
  if (runnerPaneId) spawnSync("tmux", ["select-pane", "-t", runnerPaneId, "-T", "rt runner"]);

  // ── Lane pane startup ─────────────────────────────────────────────────────
  // Create one background pane per lane and swap the first into the display split.
  for (const lane of initialLanes) {
    const entry = lane.entries.find((e) => e.id === lane.activeEntryId) ?? lane.entries[0];
    const processId = entry ? entryWindowName(lane.id, entry.id) : "";
    const title = `lane ${lane.id} · ${lane.repoName} :${lane.canonicalPort}`;
    createBgPane(lane.id, processId, title);
  }
  const firstInitLane = initialLanes[initialLaneIdx] ?? initialLanes[0];
  if (firstInitLane) {
    initDisplayPane(firstInitLane.id);
  }

  // ── Keymaps ───────────────────────────────────────────────────────────────
  //
  // All key handlers live in lib/runner/keys/. Each factory closes over the
  // same KeymapContext and returns a flat map of key → handler.

  const keymapContext: KeymapContext = {
    safeUpdate,
    setMode:         (m) => app.setMode(m),
    stopApp:         () => { app.stop(); },
    getCurrentState: () => _currentState,
    doDispatch,
    showToast,
    openPopup,
    openTempPane,
    displayPane,
    switchDisplay,
    createBgPane,
    initDisplayPane,
    mrPane: {
      isEnabled:  () => mrPaneEnabled,
      setEnabled: (b) => { mrPaneEnabled = b; },
      show:       showMrPane,
      hide:       hideMrPane,
      update:     updateMrPane,
    },
    saveCurrent,
    addResolvedEntry,
    activeEntryIdx,
    focusedBranch,
    rtShell:  RT_SHELL,
    rtInvoke: RT_INVOKE,
    initiator: `runner:${runnerName}`,
  };

  app.keys(createNormalKeymap(keymapContext));

  // ── Text event handler — only for shifted symbols that can't go in app.keys ─
  //
  // Unlike letter keys, `!` (shift+1) and `W` (shift+w) don't have lowercase
  // equivalents in app.keys that could double-fire, so they're safe here.
  app.onEvent((ev) => {
    if (ev.kind !== "engine" || ev.event.kind !== "text") return;
    if (app.getMode() !== "default") return;
    const char = String.fromCodePoint(ev.event.codepoint);
    if (!_currentState) return;
    switch (char) {
      case "!":
        safeUpdate((st) => ({ ...st, mode: { type: "confirm-reset" } }));
        app.setMode("confirm-reset");
        break;
    }
  });

  // ── Modal mode bindings ────────────────────────────────────────────────────

  app.modes({
    "lane-scope":      createLaneKeymap(keymapContext),
    "process-scope":   createProcessKeymap(keymapContext, { buildEditorCmd }),
    "open-scope":      createOpenKeymap(keymapContext),
    "port-input":      createPortKeymap(keymapContext),
    "entry-picker":    createPickerKeymap(keymapContext),
    "confirm-reset":   createConfirmResetKeymap(keymapContext),
    "confirm-spread":  createConfirmSpreadKeymap(keymapContext),
  });

  try {
    await app.run();
  } catch (err) {
    // If the backend fails to start (e.g. TTY not available, or race with
    // pollDaemon losing), log a clear message instead of crashing silently.
    const msg = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error && err.stack ? err.stack : msg;
    process.stderr.write(`\r\n\x1b[31m  ✗  rt runner failed to start: ${msg}\x1b[0m\r\n`);
    try {
      const logPath = join(RT_ROOT, "runner-error.log");
      writeFileSync(logPath, `[${new Date().toISOString()}] ${stack}\n`);
      process.stderr.write(`\x1b[2m     details: ${logPath}\x1b[0m\r\n`);
    } catch { /* best-effort */ }
    process.exitCode = 1;
  }

  appRunning = false;
  clearInterval(pollTimer);
  clearInterval(enrichTimer);
  clearInterval(spinnerTimer);
  gitWatcherPool.dispose();

  // ── Lane pane cleanup ─────────────────────────────────────────────────────
  hideMrPane();
  for (const paneId of lanePanes.values()) {
    spawnSync("tmux", ["kill-pane", "-t", paneId]);
  }
  if (bgWindowCreated) {
    spawnSync("tmux", ["kill-window", "-t", bgWindowName]);
  }

  return pending;
}

// ─── Entry ────────────────────────────────────────────────────────────────────

/** Prompt the user for a new runner config name via readline. */
async function promptRunnerName(): Promise<string | null> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question("  New runner name: ", (answer) => {
      rl.close();
      const name = answer.trim();
      resolve(name.length > 0 ? name : null);
    });
  });
}

export async function showRunner(args: string[], _ctx: CommandContext): Promise<void> {
  // Rezi's worker backend requires a real TTY. Show a clear error early.
  if (!process.stdin.isTTY && !process.stdout.isTTY && !process.stderr.isTTY) {
    console.error("\n  ✗  rt runner requires an interactive terminal (TTY)\n");
    console.error("     Run it directly in your terminal, not via a pipe or redirect.\n");
    process.exit(1);
  }

  // tmux is required — [t], [Enter], and [a] all open split panes.
  // If not already inside tmux, re-exec inside a new session transparently.
  if (!process.env.TMUX) {
    // Session name: rt-runner-<config> if the runner config is on the command
    // line, else just "rt-runner-<pid>". Named sessions let the user spot and
    // kill orphans, and let us detect duplicates on next start.
    const runnerArg = args.find((a) => a.startsWith("--runner="))?.split("=")[1];
    const sessionName = runnerArg ? `rt-runner-${runnerArg}` : `rt-runner-${process.pid}`;

    // `set destroy-unattached on` makes the session self-destruct as soon as
    // the last client disconnects (e.g. user closes the terminal window). This
    // is the upstream fix for stale tmux sessions accumulating with dead
    // runners inside them.
    const innerCmd = `${RT_SHELL} runner ${args.map((a) => JSON.stringify(a)).join(" ")}`;
    const setupCmd = `tmux set destroy-unattached on 2>/dev/null;`;
    const shellCmd = `${setupCmd} ${innerCmd}; rc=$?; if [ $rc -ne 0 ]; then printf '\\n\\033[31m  rt runner exited with code %s — press enter to close\\033[0m' "$rc"; read _; fi; exit $rc`;

    // If a session with this name already exists (e.g. user re-ran rt runner
    // after detaching), attach to it instead of creating a duplicate.
    const exists = spawnSync("tmux", ["has-session", "-t", `=${sessionName}`], { stdio: "ignore" }).status === 0;
    const tmuxArgs = exists
      ? ["attach-session", "-t", `=${sessionName}`]
      : ["new-session", "-s", sessionName, "--", "sh", "-c", shellCmd];

    const result = spawnSync("tmux", tmuxArgs, { stdio: "inherit" });
    process.exit(result.status ?? 0);
  }

  const daemonUp = await isDaemonRunning();
  if (!daemonUp) {
    console.error("\n  ✗  rt runner requires the rt daemon\n");
    console.error("     Start it:  rt daemon start\n");
    process.exit(1);
  }

  // ── Runner config selection (pre-TUI) ─────────────────────────────────────
  let runnerName: string;

  const runnerArg = args.find((a) => a.startsWith("--runner="))?.split("=")[1];
  if (runnerArg) {
    runnerName = runnerArg;
  } else {
    const configs = listRunnerConfigs();

    if (configs.length === 0) {
      // No configs yet — prompt for a name to create one
      console.log("\n  No runner configurations found. Create one:\n");
      const name = await promptRunnerName();
      if (!name) { console.error("  Cancelled.\n"); process.exit(0); }
      runnerName = name;
    } else {
      // Always show a picker so the user can choose or create a new config
      const { filterableSelect } = await import("../lib/rt-render.tsx");
      const options = [
        ...configs.map((c) => ({ value: c, label: c })),
        { value: "__new__", label: "＋ create new runner" },
      ];
      const picked = await filterableSelect({ message: "Select a runner", options });
      if (picked === null) { process.exit(0); }
      if (picked === "__new__") {
        console.log("");
        const name = await promptRunnerName();
        if (!name) { console.error("  Cancelled.\n"); process.exit(0); }
        runnerName = name;
      } else {
        runnerName = picked;
      }
    }
  }

  if (args.includes("--reset")) {
    resetRunnerConfig(runnerName);
    if (!process.stdin.isTTY) return;
  }

  // Singleton lock — prevent two rt runners from racing on the same config
  // file. Multiple concurrent writers overwrite each other's snapshots and
  // cause silent reverts (e.g. the branch watcher in one instance clobbering
  // an entry just added in another).
  const lockResult = acquireRunnerLock(runnerName, {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    tmuxSession: process.env.TMUX ? (process.env.TMUX_PANE ?? "") : undefined,
  });
  if (!lockResult.ok) {
    const h = lockResult.holder;
    console.error(`\n  ✗  rt runner "${runnerName}" is already running (pid ${h.pid}, started ${h.startedAt})\n`);
    console.error(`     Only one runner per config is allowed — concurrent writers cause config reverts.`);
    console.error(`     To take over: kill ${h.pid}  ${h.tmuxSession ? `(tmux pane ${h.tmuxSession})` : ""}\n`);
    process.exit(1);
  }

  // Release the lock on any exit path. SIGHUP fires when tmux destroys the
  // session out from under us (e.g. terminal window closed → destroy-unattached
  // tears down the session). Without this handler the lock would leak.
  const releaseLock = () => releaseRunnerLock(runnerName, process.pid);
  process.on("exit", releaseLock);
  process.on("SIGINT", () => { releaseLock(); process.exit(130); });
  process.on("SIGTERM", () => { releaseLock(); process.exit(143); });
  process.on("SIGHUP", () => { releaseLock(); process.exit(129); });

  const lanes = loadRunnerConfig(runnerName);

  // Branches are no longer stored in the config — read them from git eagerly
  // at startup so the display shows branch names from the first render. Read
  // in parallel: with 10+ entries this drops ~300ms of serial git calls to
  // the slowest single call.
  await Promise.all(
    lanes.flatMap((lane) =>
      lane.entries
        .filter((e) => e.worktree)
        .map(async (entry) => {
          const branch = await readCurrentBranchAsync(entry.worktree);
          if (branch) entry.branch = branch;
        }),
    ),
  );

  const knownRepos = getKnownRepos();

  // Ensure all existing lanes have proxies and exclusive groups in the daemon
  const bootInitiator = `runner:${runnerName}`;
  for (const lane of lanes) {
    void daemonQuery("group:create", { id: lane.id });
    void ensureProxy(lane, bootInitiator);
    for (const entry of lane.entries) {
      void daemonQuery("group:add", { groupId: lane.id, processId: entryWindowName(lane.id, entry.id) });
    }
  }

  await runOnce(lanes, runnerName, knownRepos);
}
