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
import { join, basename, relative } from "node:path";
import { tmpdir, homedir } from "node:os";
import { existsSync, readFileSync, unlinkSync, mkdirSync, writeFileSync, rmSync, watch, type FSWatcher } from "node:fs";
import { createInterface } from "node:readline";
import type { CommandContext } from "../lib/command-tree.ts";
import { daemonQuery, isDaemonRunning } from "../lib/daemon-client.ts";
import {
  listRunnerConfigs, loadRunnerConfig, saveRunnerConfig, resetRunnerConfig,
  nextLaneId, nextEntryId, proxyWindowName, entryWindowName,
  type LaneConfig, type LaneEntry, type LaneMode,
} from "../lib/runner-store.ts";
import type { ProcessState } from "../lib/daemon/state-store.ts";
import type { RunResolveResult } from "./run.ts";
import { RT_ROOT, getKnownRepos, type KnownRepo } from "../lib/repo.ts";
import { willPrompt } from "./code.ts";

// ─── tmux helpers ─────────────────────────────────────────────────────────────

const CLI_PATH = join(RT_ROOT, "cli.ts");

// In dev mode, `process.execPath` is the bun interpreter and we need to pass
// cli.ts as the first arg. In prod (compiled binary), `process.execPath` IS
// the rt binary — cli.ts lives on a virtual bunfs filesystem that only the
// current process can see, so passing it as an arg would make a fresh child
// process fail with "unknown command: /$bunfs/root/cli.ts".
const IS_COMPILED_RT = basename(process.execPath) !== "bun";
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
  args.push("sh", "-c", cmd);
  spawnSync("tmux", args, { encoding: "utf8" });
}


// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * States a lane entry can be in.
 *
 * "starting" is a UI-only optimistic state shown immediately when the user
 * triggers a spawn/respawn — before the daemon has confirmed the process is
 * alive. It is replaced by the real daemon state on the next poll.
 */
export type EntryState = ProcessState | "starting" | "stopping";

type InteractiveRequest = { type: "quit" };

type Mode =
  | { type: "normal" }
  | { type: "port-input"; purpose: "edit-port"; laneId: string }
  | { type: "entry-picker"; purpose: "remove"; laneId: string; idx: number }
  | { type: "confirm-reset" }
  | { type: "confirm-spread"; laneId: string; entryId: string };

type LaneAction =
  | { type: "spawn";        laneId: string; entryId: string }
  | { type: "activate";     laneId: string; entryId: string }
  | { type: "warm-all";     laneId: string }
  | { type: "respawn";      laneId: string; entryId: string }
  | { type: "stop";         laneId: string; entryId: string }
  | { type: "stop-all";     laneId: string }
  | { type: "pause-lane";   laneId: string }
  | { type: "restart";      laneId: string; entryId: string }
  | { type: "remove-entry"; laneId: string; entryId: string }
  | { type: "remove-lane";  laneId: string }
  | { type: "toggle-mode";  laneId: string }
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
  /** Name of the loaded runner config (displayed in header). */
  runnerName:    string;
  /** All known repos, used for repo-pick mode and resolving lane repoRoot. */
  knownRepos:    KnownRepo[];
}

// ─── Theme — bubble tea ✨ ───────────────────────────────────────────────────
//
// Two-layer system:
//   T  — raw color tokens (edit these to retheme everything)
//   C  — semantic roles (what the UI code references — don't change these names)
//
// To switch themes: only touch the `T` block below.
// ─────────────────────────────────────────────────────────────────────────────

/** Raw palette tokens — one place to edit per color. */
const T = {
  // ── Backgrounds ────────────────────────────────────────────────────────────
  bgBase:     [22,  18,  36] as const,  // #161224  dark plum-black   (canvas fill)
  bgElevated: [35,  28,  55] as const,  // #231C37  slightly lighter
  bgOverlay:  [50,  40,  75] as const,  // #32284B  overlays / overlaid boxes
  bgSubtle:   [28,  22,  44] as const,  // #1C162C  subtly lighter than base
  bgSelBg:    [55,  40,  75] as const,  // #37284B  selected-row highlight

  // ── Accents ────────────────────────────────────────────────────────────────
  pink:  [255, 107, 157] as const,  // #FF6B9D  rose pink    — primary / borders / active
  lav:   [189, 147, 249] as const,  // #BD93F9  soft lavender — secondary hints
  mint:  [ 98, 230, 168] as const,  // #62E6A8  mint green   — running / healthy
  peach: [255, 183, 122] as const,  // #FFB77A  warm peach   — warnings / toasts
  coral: [255, 121, 121] as const,  // #FF7979  coral rose   — errors / stopped
  warm:  [255, 210, 100] as const,  // #FFD264  warm yellow  — warm/idle state
  cyan:  [ 90, 170, 255] as const,  // #5AAAFF  electric blue — group headers

  // ── Neutrals ───────────────────────────────────────────────────────────────
  dim:   [168, 160, 198] as const,  // #A8A0C6  muted plum   — secondary text / borders
  muted: [210, 205, 235] as const,  // #D2CDEB  lilac-grey   — tertiary text
  white: [230, 224, 255] as const,  // #E6E0FF  lavender white — primary text
};

/** Semantic color roles — reference these in JSX (never raw T values). */
const C = {
  // accents
  pink:  rgb(...T.pink),
  lav:   rgb(...T.lav),
  mint:  rgb(...T.mint),
  peach: rgb(...T.peach),
  coral: rgb(...T.coral),
  cyan:  rgb(...T.cyan),
  // neutrals
  dim:   rgb(...T.dim),
  muted: rgb(...T.muted),
  white: rgb(...T.white),
  // backgrounds
  selBg: rgb(...T.bgSelBg),
};

/** Status state → display color (references T tokens). */
const STATUS_COLOR: Record<EntryState, number> = {
  starting: rgb(...T.mint),
  stopping: rgb(...T.coral),
  running:  rgb(...T.mint),
  warm:     rgb(...T.warm),
  crashed:  rgb(...T.coral),
  stopped:  rgb(...T.dim),
};

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


const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠣", "⠏"];

const STATUS_ICON: Record<EntryState, string> = {
  starting: SPINNER_FRAMES[0]!, // overridden at render time with animated frame
  stopping: SPINNER_FRAMES[0]!, // overridden at render time with animated frame
  running:  "●",
  warm:     "❄",
  crashed:  "✗",
  stopped:  "○",
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

/**
 * Start an entry's process via the daemon.
 * Handles port auto-allocation, command substitution, spawn, group activation,
 * and proxy upstream routing.
 * Returns the actual ephemeral port used.
 */
async function startEntry(lane: LaneConfig, entry: LaneEntry): Promise<number> {
  // Auto-heal entries saved with ephemeralPort: 0.
  let ephemeralPort = entry.ephemeralPort;
  if (!ephemeralPort) {
    const win = entryWindowName(lane.id, entry.id);
    const portRes = await daemonQuery("port:allocate", { label: win });
    ephemeralPort = portRes?.ok ? Number((portRes.data as { port: number })?.port) : (10000 + Math.floor(Math.random() * 55000));
  }

  const port = String(ephemeralPort);
  const canonicalPort = String(lane.canonicalPort);
  const cmd = entry.commandTemplate
    .replace(/\$\{?PORT\}?/g, port)
    .replace(/\$\{?CANONICAL_PORT\}?/g, canonicalPort);

  const processId = entryWindowName(lane.id, entry.id);
  await daemonQuery("process:spawn", {
    id: processId,
    cmd,
    cwd: entry.targetDir,
    env: { PORT: port, CANONICAL_PORT: canonicalPort },
  });
  await daemonQuery("group:activate", { groupId: lane.id, processId, mode: lane.mode ?? "warm" });
  await daemonQuery("proxy:set-upstream", { id: proxyWindowName(lane.id), port: ephemeralPort });

  return ephemeralPort;
}

/**
 * Restart an entry's process via the daemon (kill awaited → spawn).
 * Returns the actual ephemeral port used.
 */
async function restartEntry(lane: LaneConfig, entry: LaneEntry): Promise<number> {
  let ephemeralPort = entry.ephemeralPort;
  if (!ephemeralPort) {
    const win = entryWindowName(lane.id, entry.id);
    const portRes = await daemonQuery("port:allocate", { label: win });
    ephemeralPort = portRes?.ok ? Number((portRes.data as { port: number })?.port) : (10000 + Math.floor(Math.random() * 55000));
  }

  const port = String(ephemeralPort);
  const canonicalPort = String(lane.canonicalPort);
  const cmd = entry.commandTemplate
    .replace(/\$\{?PORT\}?/g, port)
    .replace(/\$\{?CANONICAL_PORT\}?/g, canonicalPort);

  const processId = entryWindowName(lane.id, entry.id);
  // Kill first, then spawn fresh
  await daemonQuery("process:kill", { id: processId });
  await daemonQuery("process:spawn", {
    id: processId,
    cmd,
    cwd: entry.targetDir,
    env: { PORT: port, CANONICAL_PORT: canonicalPort },
  });
  await daemonQuery("group:activate", { groupId: lane.id, processId, mode: lane.mode ?? "warm" });
  await daemonQuery("proxy:set-upstream", { id: proxyWindowName(lane.id), port: ephemeralPort });

  return ephemeralPort;
}



// ─── Git HEAD helpers ─────────────────────────────────────────────────────────

/**
 * Returns the common .git directory for any worktree path.
 * `git rev-parse --git-common-dir` always returns the main repo's .git dir,
 * even when called from a linked worktree — so this is the right thing to watch
 * for a lane (one watcher covers all worktrees of that repo).
 */
function repoGitDir(worktreePath: string): string | null {
  try {
    const result = spawnSync("git", ["rev-parse", "--git-common-dir"], { cwd: worktreePath, encoding: "utf8" });
    if (result.status !== 0) return null;
    const gitDir = result.stdout.trim();
    return gitDir.startsWith("/") ? gitDir : join(worktreePath, gitDir);
  } catch {
    return null;
  }
}

function readCurrentBranch(worktreePath: string): string | null {
  try {
    const result = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: worktreePath, encoding: "utf8" });
    return result.status === 0 ? result.stdout.trim() : null;
  } catch {
    return null;
  }
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

    const result: Record<string, string> = {};
    for (const { key, branch, worktree } of targets) {
      const e = daemonCache[branch] ?? diskCache[branch];
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

  const app = createNodeApp<RunnerUIState>({
    initialState: {
      lanes:        initialLanes,
      laneIdx:      0,
      entryIdx:     0,
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
    saveRunnerConfig(runnerName, newLanes);
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
        await ensureProxy(lane);
        const actualPort = await startEntry(lane, entry);
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
        const entryState = est(processId);
        await ensureProxy(lane);
        if (entryState === "stopped" || entryState === "crashed") {
          // Not running — do a full start (spawn + group:activate + proxy)
          const actualPort = await startEntry(lane, entry);
          const updatedEntries = lane.entries.map((e) =>
            e.id === action.entryId ? { ...e, ephemeralPort: actualPort } : e
          );
          return { lanes: lanes.map((l) => l.id === action.laneId
            ? { ...l, activeEntryId: action.entryId, entries: updatedEntries }
            : l) };
        }
        // Already running or warm — just group:activate (resumes + suspends others)
        // and update proxy upstream.
        await daemonQuery("group:activate", { groupId: lane.id, processId, mode: lane.mode ?? "warm" });
        await daemonQuery("proxy:set-upstream", { id: proxyWindowName(lane.id), port: entry.ephemeralPort });
        return { lanes: lanes.map((l) => l.id === action.laneId ? { ...l, activeEntryId: action.entryId } : l) };
      }

      case "warm-all": {
        const lane = lanes.find((l) => l.id === action.laneId);
        if (!lane) return {};
        const activeId = lane.activeEntryId ?? lane.entries[0]?.id;
        await ensureProxy(lane);
        // Start stopped/crashed entries individually.
        // process:start handles group:activate internally so each entry
        // correctly suspends/resumes others as it starts.
        // For warm-all we want everything spawned, so use process:spawn directly
        // for non-active entries to avoid them suspending each other mid-startup,
        // then do a final group:activate for just the active one.
        const portFixes = new Map<string, number>();
        for (const entry of lane.entries) {
          const win = entryWindowName(lane.id, entry.id);
          const st = est(win);
          if (st === "stopped" || st === "crashed") {
            let ephemeralPort = entry.ephemeralPort;
            if (!ephemeralPort) {
              const portRes = await daemonQuery("port:allocate", { label: win });
              ephemeralPort = portRes?.ok ? Number((portRes.data as { port: number })?.port) : (10000 + Math.floor(Math.random() * 55000));
            }
            const port = String(ephemeralPort);
            const canonicalPort = String(lane.canonicalPort);
            const cmd = entry.commandTemplate
              .replace(/\$\{?PORT\}?/g, port)
              .replace(/\$\{?CANONICAL_PORT\}?/g, canonicalPort);
            // Use process:spawn (not process:start) to avoid premature group:activate
            // on non-active entries while others are still starting up.
            await daemonQuery("process:spawn", {
              id: win, cmd, cwd: entry.targetDir,
              env: { PORT: port, CANONICAL_PORT: canonicalPort },
            });
            if (ephemeralPort !== entry.ephemeralPort) portFixes.set(entry.id, ephemeralPort);
          }
        }
        // Activate the designated active entry after all are spawned.
        if (activeId) {
          await daemonQuery("group:activate", {
            groupId: lane.id,
            processId: entryWindowName(lane.id, activeId),
            mode: lane.mode ?? "warm",
          });
          const activeEntry = lane.entries.find((e) => e.id === activeId);
          const activePort = portFixes.get(activeId) ?? activeEntry?.ephemeralPort;
          if (activePort) {
            await daemonQuery("proxy:set-upstream", { id: proxyWindowName(lane.id), port: activePort });
          }
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
        // Re-run port allocation and command substitution via process:start.
        // This prevents a stale command stored in the daemon from being replayed.
        const lane = lanes.find((l) => l.id === action.laneId);
        const entry = lane?.entries.find((e) => e.id === action.entryId);
        if (!lane || !entry) return {};
        await ensureProxy(lane);
        const actualPort = await startEntry(lane, entry);
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

      case "restart": {
        // Single atomic round-trip: kill (awaited in daemon) → spawn → activate → proxy.
        const lane = lanes.find((l) => l.id === action.laneId);
        const entry = lane?.entries.find((e) => e.id === action.entryId);
        if (!lane || !entry) return {};
        await ensureProxy(lane);
        const actualPort = await restartEntry(lane, entry);
        const updatedEntries = lane.entries.map((e) =>
          e.id === action.entryId ? { ...e, ephemeralPort: actualPort } : e
        );
        return { lanes: lanes.map((l) => l.id === action.laneId
          ? { ...l, activeEntryId: action.entryId, entries: updatedEntries }
          : l) };
      }

      case "stop-all": {
        const lane = lanes.find((l) => l.id === action.laneId);
        if (!lane) return {};
        await Promise.all(
          lane.entries
            .filter((e) => {
              const st = est(entryWindowName(action.laneId, e.id));
              return st === "running" || st === "warm" || st === "starting" || st === "stopping";
            })
            .map((e) => daemonQuery("process:kill", { id: entryWindowName(action.laneId, e.id) }))
        );
        return {};
      }

      case "pause-lane": {
        // Stop the proxy — frees the canonical port.
        // All processes keep running; only the proxy is torn down.
        // [S] (warm-all) will restart the proxy and re-route traffic.
        const lane = lanes.find((l) => l.id === action.laneId);
        if (!lane) return {};
        await daemonQuery("proxy:stop", { id: proxyWindowName(action.laneId) });
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
          if (e) await daemonQuery("proxy:set-upstream", { id: proxyWindowName(lane.id), port: e.ephemeralPort });
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

      case "toggle-mode": {
        const lane = lanes.find((l) => l.id === action.laneId);
        if (!lane) return {};
        const newMode: LaneMode = (lane.mode ?? "warm") === "warm" ? "single" : "warm";
        const updatedLanes = lanes.map((l) => l.id === action.laneId ? { ...l, mode: newMode } : l);
        saveCurrent(updatedLanes);
        return { lanes: updatedLanes };
      }

      case "reset": {
        await Promise.all(
          lanes.flatMap((lane) => [
            ...lane.entries.map((e) => daemonQuery("process:kill", { id: entryWindowName(lane.id, e.id) })),
            daemonQuery("proxy:stop", { id: proxyWindowName(lane.id) }),
            daemonQuery("group:remove", { id: lane.id }),
          ])
        );
        saveRunnerConfig(runnerName, []);
        currentLanes = [];
        return { lanes: [], laneIdx: 0, entryIdx: 0 };
      }
    }
  }

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
    } else if (action.type === "stop-all") {
      const lane = currentState.lanes.find((l) => l.id === action.laneId);
      if (lane) {
        for (const e of lane.entries) {
          const id = entryWindowName(lane.id, e.id);
          const st = currentState.entryStates.get(id) ?? "stopped";
          if (st === "running" || st === "warm") stoppingIds.push(id);
        }
      }
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

  /** Compute the display label for an entry's command (package · script or custom template). */
  function entryCommandLabel(entry: LaneEntry): string {
    const defaultCmd = `${entry.pm} run ${entry.script}`;
    const hasCustomCmd = entry.commandTemplate !== defaultCmd;
    return entry.packageLabel !== "root"
      ? `${entry.packageLabel} · ${hasCustomCmd ? entry.commandTemplate : entry.script}`
      : (hasCustomCmd ? entry.commandTemplate : entry.script);
  }

  function EntryRow({ lane, entry, ei, isSelectedLane, selectedEi, s, uniform }: {
    lane: LaneConfig; entry: LaneEntry; ei: number;
    isSelectedLane: boolean; selectedEi: number; s: RunnerUIState;
    uniform: boolean;
  }) {
    const win = entryWindowName(lane.id, entry.id);
    const state = s.entryStates.get(win) ?? "stopped";
    const isActive = lane.activeEntryId === entry.id;
    const isSelected = isSelectedLane && ei === selectedEi;
    const eKey = `${lane.id}:${entry.id}`;

    const stateColor = STATUS_COLOR[state];
    const branchLabel = s.enrichment[eKey] ?? entry.branch ?? "";
    const nameColor = isActive ? C.mint : (isSelected ? C.white : C.muted);
    const spinnerChar = SPINNER_FRAMES[s.spinnerFrame % SPINNER_FRAMES.length]!;
    const stateIcon = (state === "starting" || state === "stopping") ? spinnerChar : STATUS_ICON[state];
    const stateLabel =
      state === "starting" ? "starting…" :
      state === "stopping" ? "stopping…" :
      null;

    const rowBg = isSelected ? C.selBg : undefined;

    if (uniform) {
      // Compact single-row: only the branch/worktree label differs between entries
      return (
        <row key={eKey} gap={1} style={{ bg: rowBg }}>
          <text style={{ fg: isSelected ? C.pink : C.dim, bg: rowBg }}>{isSelected ? "❯" : " "}</text>
          <text style={{ fg: stateColor, bg: rowBg }}>{stateIcon}</text>
          <text style={{ fg: nameColor, bold: isActive, bg: rowBg }}>{branchLabel || entry.branch || entry.worktree}</text>
          <spacer flex={1} />
          {stateLabel && <text style={{ fg: stateColor, bg: rowBg }}>{stateLabel}</text>}
        </row>
      );
    }

    // Normal two-row layout when commands differ between entries
    const label = entryCommandLabel(entry);
    return (
      <column key={eKey} gap={0}>
        <row key={`${eKey}-1`} gap={1} style={{ bg: rowBg }}>
          <text style={{ fg: isSelected ? C.pink : C.dim, bg: rowBg }}>{isSelected ? "❯" : " "}</text>
          <text style={{ fg: stateColor, bg: rowBg }}>{stateIcon}</text>
          <text style={{ fg: nameColor, bold: isActive, bg: rowBg }}>{label}</text>
          <spacer flex={1} />
          {stateLabel && <text style={{ fg: stateColor, bg: rowBg }}>{stateLabel}</text>}
        </row>
        <row key={`${eKey}-2`} gap={0} style={{ bg: rowBg }}>
          <text style={{ bg: rowBg }}>{"    "}</text>
          {branchLabel && <text style={{ fg: C.dim, bg: rowBg }}>{branchLabel}</text>}
        </row>
      </column>
    );
  }

  /** Compute ordered entry groups keyed by exact commandTemplate. */
  function computeEntryGroups(entries: LaneEntry[]): { key: string; label: string; entries: LaneEntry[] }[] {
    const groupOrder: string[] = [];
    const groupMap = new Map<string, LaneEntry[]>();
    for (const entry of entries) {
      const key = entry.commandTemplate;
      if (!groupMap.has(key)) {
        groupOrder.push(key);
        groupMap.set(key, []);
      }
      groupMap.get(key)!.push(entry);
    }
    return groupOrder.map((key) => {
      const groupEntries = groupMap.get(key)!;
      return { key, label: entryCommandLabel(groupEntries[0]!), entries: groupEntries };
    });
  }

  /** Find which group an entry belongs to (by index into the flat entries array). */
  function entryGroupForIdx(entries: LaneEntry[], idx: number): { key: string; entries: LaneEntry[] } | null {
    const entry = entries[idx];
    if (!entry) return null;
    const key = entry.commandTemplate;
    return { key, entries: entries.filter((e) => e.commandTemplate === key) };
  }

  function LaneCard({ lane, li, s }: { lane: LaneConfig; li: number; s: RunnerUIState }) {
    const isSelected = li === s.laneIdx;
    const safeEi = Math.min(s.entryIdx, Math.max(0, lane.entries.length - 1));
    const proxyUp = s.proxyStates[proxyWindowName(lane.id)] ?? false;
    const modeLabel = (lane.mode ?? "warm") === "single" ? "single" : "warm";
    const title = ` LANE ${lane.id}  ·  ${lane.repoName}  ·  :${lane.canonicalPort}  ·  ${modeLabel}  `;

    const groups = computeEntryGroups(lane.entries);

    // Build the entry list with group separators
    const entryElements: any[] = [];
    if (lane.entries.length === 0) {
      entryElements.push(<text key="empty" style={{ fg: C.dim }}>{"  press [a] to add a process"}</text>);
    } else {
      let globalEi = 0;
      for (let gi = 0; gi < groups.length; gi++) {
        const group = groups[gi]!;
        // Separator between groups (not before the first)
        if (gi > 0) {
          entryElements.push(
            <text key={`sep-${gi}`} style={{ fg: C.dim }}>{"  ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌"}</text>
          );
        }
        // Group sub-header
        entryElements.push(
          <text key={`gh-${gi}`} style={{ fg: C.cyan }}>{`  ${group.label}`}</text>
        );
        // Entries in this group — compact/uniform within the group
        for (const entry of group.entries) {
          entryElements.push(
            <EntryRow
              key={`${lane.id}:${entry.id}`}
              lane={lane} entry={entry} ei={globalEi}
              isSelectedLane={isSelected} selectedEi={safeEi} s={s}
              uniform={true}
            />
          );
          globalEi++;
        }
      }
    }

    return (
      <box
        key={lane.id}
        title={title}
        titleAlign="left"
        border={isSelected ? "heavy" : "single"}
        borderStyle={{ fg: isSelected ? C.pink : C.dim }}
        px={1}
        gap={0}
      >
        <row gap={1}>
          <text style={{ fg: proxyUp ? C.mint : C.coral }}>{proxyUp ? "proxy ✓" : "proxy ✗"}</text>
        </row>
        {entryElements}
      </box>
    );
  }

  function HintBar({ canSpread }: { canSpread?: boolean }) {
    // Separator between the section label and its commands
    const Sep = () => <text style={{ fg: C.lav }}>{"  "}</text>;
    // Dim pipe divider between groups on the same row
    const Pipe = () => <text style={{ fg: C.dim }}>{"  ·  "}</text>;

    const Key = ({ k }: { k: string }) => <text style={{ fg: C.muted }}>{`[${k}]`}</text>;
    const Label = ({ l }: { l: string }) => <text style={{ fg: C.dim }}>{l}</text>;
    const Cmd = ({ k, l }: { k: string; l: string }) => (
      <row gap={1}><Key k={k} /><Label l={l} /></row>
    );
    const Section = ({ name }: { name: string }) => (
      <text style={{ fg: C.lav, bold: true }}>{name.padEnd(7)}</text>
    );

    return (
      <column gap={0}>
        {/* Row 1 — Lane management */}
        <row gap={1}>
          <Section name="lane" /><Sep />
          <Cmd k="A" l="add" />
          <Cmd k="p" l="port" />
          <Cmd k="R" l="remove" />
          <Cmd k="m" l="mode" />
          <Cmd k="Z" l="pause" />
        </row>
        {/* Row 2 — Process lifecycle */}
        <row gap={1}>
          <Section name="process" /><Sep />
          <Cmd k="a" l="add" />
          <Cmd k="s" l="start/restart" />
          <Cmd k="S" l="warm/resume" />
          <Cmd k="↵" l="activate" />
          <Cmd k="x/X" l="stop" />
          <Cmd k="r" l="remove" />
        </row>
        {/* Row 3 — Open / navigate */}
        <row gap={1}>
          <Section name="open" /><Sep />
          <Cmd k="b" l="branch" />
          <Cmd k="c" l="code" />
          <Cmd k="o" l="browser" />
          <Cmd k="t" l="shell" />
          <Cmd k="f" l="run" />
          <Cmd k="e" l="cmd" />
          <Cmd k="i" l="info" />
        </row>
        {/* Row 4 — Global */}
        <row gap={1}>
          <Section name="global" /><Sep />
          <Cmd k="q" l="quit" />
          <Cmd k="!" l="reset all" />
          {canSpread && <Cmd k="W" l="spread to worktrees" />}
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
        <text style={{ fg: C.pink, bold: true }}>rt</text>
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
      const activeLane = s.lanes[Math.min(s.laneIdx, s.lanes.length - 1)];
      const focusedEi = Math.min(s.entryIdx, Math.max(0, (activeLane?.entries.length ?? 1) - 1));
      const focusedGroup = activeLane ? entryGroupForIdx(activeLane.entries, focusedEi) : null;
      const canSpread = focusedGroup ? focusedGroup.entries.length === 1 : false;
      return <HintBar canSpread={canSpread} />;
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

    safeUpdate((s) => {
      // Merge daemon state with any in-flight optimistic transient states.
      // The daemon also sets "starting"/"stopping" authoritatively, but the
      // window is often too brief for the 2s poll to catch. So we preserve
      // client-side optimistic transients until (a) the daemon confirms the
      // expected terminal state AND (b) the minimum display time has elapsed.
      const merged = new Map(entryStates);
      const now = Date.now();
      for (const [id, current] of s.entryStates) {
        if (current === "stopping") {
          const fresh = entryStates.get(id) ?? "stopped";
          const age = now - (optimisticSetAt.get(id) ?? 0);
          if (fresh !== "stopped" && fresh !== "crashed" || age < MIN_TRANSIENT_MS) {
            merged.set(id, "stopping");
          } else {
            optimisticSetAt.delete(id);
          }
        } else if (current === "starting") {
          const fresh = entryStates.get(id);
          const age = now - (optimisticSetAt.get(id) ?? 0);
          if (fresh !== "running" && fresh !== "crashed" || age < MIN_TRANSIENT_MS) {
            merged.set(id, "starting");
          } else {
            optimisticSetAt.delete(id);
          }
        }
      }
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
  // Each lane is bound to one repo. We watch that repo's common .git dir with
  // recursive: true — a single FSEvents watcher covers HEAD changes in all
  // linked worktrees (.git/worktrees/<name>/HEAD) as well as the main one.
  const gitWatchers = new Map<string, FSWatcher>(); // laneId → watcher

  function syncGitWatchers(lanes: LaneConfig[]): void {
    const activeLaneIds = new Set(lanes.map((l) => l.id));

    // Remove watchers for lanes that no longer exist
    for (const [laneId, w] of gitWatchers) {
      if (!activeLaneIds.has(laneId)) { try { w.close(); } catch { /* */ } gitWatchers.delete(laneId); }
    }

    // Add a watcher for each lane that has at least one entry with a worktree.
    // Watch only the git common dir's HEAD-adjacent files (not the entire .git
    // dir recursively) so the watcher only fires on real branch changes and not
    // on every git operation (fetch, gc, ref updates, etc.) — which previously
    // triggered spurious doRepoChange calls that could race with addResolvedEntry
    // and save a stale lane snapshot that dropped newly-added entries.
    for (const lane of lanes) {
      if (gitWatchers.has(lane.id)) continue;
      const anyWorktree = lane.entries.find((e) => e.worktree)?.worktree;
      if (!anyWorktree) continue;
      const gitDir = repoGitDir(anyWorktree);
      if (!gitDir || !existsSync(gitDir)) continue;
      try {
        // Watch the git common dir NON-recursively and filter to HEAD only.
        // This fires when the main worktree switches branches. Linked worktrees
        // have their HEAD under .git/worktrees/<name>/HEAD — watch that subdir too.
        const onEvent = (_evt: string, filename: string | null) => {
          if (filename === "HEAD") onRepoChange(lane.id);
        };
        const w = watch(gitDir, onEvent);
        gitWatchers.set(lane.id, w);
        // Also watch the worktrees subdir if it exists (linked worktree HEADs live here)
        const worktreesDir = join(gitDir, "worktrees");
        if (existsSync(worktreesDir)) {
          try {
            const ww = watch(worktreesDir, { recursive: true }, (_evt, filename) => {
              if (filename?.endsWith("HEAD")) onRepoChange(lane.id);
            });
            // Store under a derived key so cleanup still works
            gitWatchers.set(`${lane.id}:wt`, ww);
          } catch { /* worktrees subdir watch failed — main HEAD watcher still active */ }
        }
      } catch { /* fs.watch not available for this path */ }
    }
  }

  // Debounce per-lane: git checkout touches dozens of .git/ files, causing
  // a storm of FSEvents. Without debouncing, each event calls spawnSync which
  // blocks the event loop and makes arrow keys unresponsive for several seconds.
  const repoChangeDebounce = new Map<string, ReturnType<typeof setTimeout>>();

  function onRepoChange(laneId: string): void {
    const existing = repoChangeDebounce.get(laneId);
    if (existing) clearTimeout(existing);
    repoChangeDebounce.set(
      laneId,
      setTimeout(() => {
        repoChangeDebounce.delete(laneId);
        doRepoChange(laneId);
      }, 150), // 150ms quiet period — git finishes writing before we read HEAD
    );
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
      saveRunnerConfig(runnerName, savedLanes);
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
  const firstInitLane = initialLanes[0];
  if (firstInitLane) {
    initDisplayPane(firstInitLane.id);
  }

  // ── Key bindings (default / normal mode) ───────────────────────────────────

  app.keys({
    q: () => { app.stop(); },

    j: ({ state, update }) => {
      const newLi = Math.min(state.laneIdx + 1, state.lanes.length - 1);
      const newEi = activeEntryIdx(state.lanes[newLi]);
      update((s) => ({ ...s, laneIdx: newLi, entryIdx: newEi }));
      switchDisplay(state.lanes[newLi]?.id ?? "");
      updateMrPane(state.lanes[newLi]?.entries[newEi]?.branch ?? "");
    },
    k: ({ state, update }) => {
      const newLi = Math.max(0, state.laneIdx - 1);
      const newEi = activeEntryIdx(state.lanes[newLi]);
      update((s) => ({ ...s, laneIdx: newLi, entryIdx: newEi }));
      switchDisplay(state.lanes[newLi]?.id ?? "");
      updateMrPane(state.lanes[newLi]?.entries[newEi]?.branch ?? "");
    },
    down: ({ state, update }) => {
      const newLi = Math.min(state.laneIdx + 1, state.lanes.length - 1);
      const newEi = activeEntryIdx(state.lanes[newLi]);
      update((s) => ({ ...s, laneIdx: newLi, entryIdx: newEi }));
      switchDisplay(state.lanes[newLi]?.id ?? "");
      updateMrPane(state.lanes[newLi]?.entries[newEi]?.branch ?? "");
    },
    up: ({ state, update }) => {
      const newLi = Math.max(0, state.laneIdx - 1);
      const newEi = activeEntryIdx(state.lanes[newLi]);
      update((s) => ({ ...s, laneIdx: newLi, entryIdx: newEi }));
      switchDisplay(state.lanes[newLi]?.id ?? "");
      updateMrPane(state.lanes[newLi]?.entries[newEi]?.branch ?? "");
    },

    right: ({ state, update }) => {
      const lane = state.lanes[Math.min(state.laneIdx, state.lanes.length - 1)];
      const len = lane?.entries.length ?? 1;
      const newEi = (state.entryIdx + 1) % len;
      update((s) => ({ ...s, entryIdx: newEi }));
      updateMrPane(lane?.entries[newEi]?.branch ?? "");
    },
    left: ({ state, update }) => {
      const lane = state.lanes[Math.min(state.laneIdx, state.lanes.length - 1)];
      const len = lane?.entries.length ?? 1;
      const newEi = (state.entryIdx - 1 + len) % len;
      update((s) => ({ ...s, entryIdx: newEi }));
      updateMrPane(lane?.entries[newEi]?.branch ?? "");
    },

    // [A] add lane — open tmux picker (repo + port), poll for result
    // NOTE: uppercase A arrives as a text event — handled in onEvent block below

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
      const laneRepo = state.knownRepos.find((r) => r.repoName === lane.repoName);
      const laneRepoRoot = laneRepo?.worktrees[0]?.path ?? process.cwd();
      const tmpFile = join(tmpdir(), `rt-resolve-${Date.now()}.json`);
      const cmd = `${RT_SHELL} run --resolve-only --repo ${lane.repoName} > ${tmpFile}`;
      openTempPane(cmd, { cwd: laneRepoRoot, target: displayPane() });

      const poll = setInterval(() => {
        if (!existsSync(tmpFile)) return;
        const content = readFileSync(tmpFile, "utf8").trim();
        if (!content) return; // file created by shell redirect but not yet written — keep polling
        clearInterval(poll);
        try {
          const resolved = JSON.parse(content) as RunResolveResult;
          unlinkSync(tmpFile);
          void addResolvedEntry(lane.id, resolved);
        } catch { /* ignore parse errors */ }
      }, 300);
    },

    // [s] start / restart / activate / respawn
    s: ({ state }) => {
      const li = Math.min(state.laneIdx, state.lanes.length - 1);
      const lane = state.lanes[li];
      if (!lane) return;
      const ei = Math.min(state.entryIdx, lane.entries.length - 1);
      const entry = lane.entries[ei];
      if (!entry) return;
      const win = entryWindowName(lane.id, entry.id);
      const st = state.entryStates.get(win) ?? "stopped";
      if (st === "starting" || st === "stopping") return; // already in flight
      const action: LaneAction =
        st === "stopped" ? { type: "spawn",   laneId: lane.id, entryId: entry.id } :
        st === "crashed" ? { type: "respawn", laneId: lane.id, entryId: entry.id } :
        (st === "running" && lane.activeEntryId === entry.id)
          ? { type: "restart",  laneId: lane.id, entryId: entry.id } :
            { type: "activate", laneId: lane.id, entryId: entry.id };
      doDispatch(action, state);
    },

    // [S] warm all — handled via onEvent for text events (see below)

    // [Enter] activate the ←/→ selected entry — auto-starts if stopped/crashed
    enter: ({ state }) => {
      const li = Math.min(state.laneIdx, state.lanes.length - 1);
      const lane = state.lanes[li];
      if (!lane) return;
      const ei = Math.min(state.entryIdx, lane.entries.length - 1);
      const entry = lane.entries[ei];
      if (!entry) return;
      if (lane.activeEntryId === entry.id) return; // already active
      doDispatch({ type: "activate", laneId: lane.id, entryId: entry.id }, state);
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

    // [e] edit command template via $EDITOR in a popup
    e: ({ state, update }) => {
      const lane = state.lanes[Math.min(state.laneIdx, state.lanes.length - 1)];
      if (!lane) return;
      const entry = lane.entries[Math.min(state.entryIdx, lane.entries.length - 1)];
      if (!entry) return;

      // Use a clean short path so editors show a readable name in their header
      const tmpFile = `/tmp/rt-edit-${entry.id}.sh`;
      writeFileSync(tmpFile, entry.commandTemplate + "\n");

      // Prefer $EDITOR, then detect best available: nvim > vim > nano
      const detectEditor = () => {
        for (const e of ["nvim", "vim", "nano"]) {
          const r = spawnSync("which", [e], { encoding: "utf8" });
          if (r.status === 0) return e;
        }
        return "nano";
      };
      const editor = process.env.EDITOR || detectEditor();
      // Build editor invocation
      //   nano: --save-on-exit auto-saves on Ctrl-X without Y/N/filename prompts
      //   vim/nvim: open directly in insert mode at end of line
      const isVim = /\bnvi?m\b/.test(editor);
      const isNano = /\bnano\b/.test(editor);
      const editorCmd = isVim
        ? `${editor} '+call cursor(1, 1000)' -c 'startinsert!' '${tmpFile}'`
        : isNano
          ? `${editor} --save-on-exit '${tmpFile}'`
          : `${editor} '${tmpFile}'`;

      // Popup blocks until editor exits — no signal dance needed
      openPopup(editorCmd, {
        title: "edit command",
        hint: isVim ? ":wq to save" : isNano ? "Ctrl-X to save" : "save and close",
        width: "100",
        height: "12",
      });

      try {
        const newCmd = readFileSync(tmpFile, "utf8").trim();
        if (newCmd && newCmd !== entry.commandTemplate) {
          update((s) => {
            const next = s.lanes.map((l) =>
              l.id === lane.id
                ? { ...l, entries: l.entries.map((e) => e.id === entry.id ? { ...e, commandTemplate: newCmd } : e) }
                : l
            );
            saveCurrent(next);
            return { ...s, lanes: next };
          });
          showToast("command updated — restart entry to apply");
        }
      } catch { /* file gone or unreadable */ }
      try { unlinkSync(tmpFile); } catch { /* already cleaned */ }
    },

    // [A] add lane  — handled via onEvent (uppercase text event)
    // [R] delete lane — handled via onEvent (uppercase text event)
    // [!] reset all  — handled via onEvent (text event)

    // [c] open entry's worktree in editor (rt code)
    c: ({ state }) => {
      const lane = state.lanes[Math.min(state.laneIdx, state.lanes.length - 1)];
      if (!lane) return;
      const entry = lane.entries[Math.min(state.entryIdx, lane.entries.length - 1)];
      if (!entry) return;
      if (willPrompt(entry.worktree)) {
        // Needs a picker — open in a popup so the UI is visible
        openPopup(`${RT_SHELL} code`, {
          cwd: entry.worktree,
          title: "rt code",
          width: "100",
          height: "20",
        });
      } else {
        // No picker needed — fire rt code directly with RT_BATCH=1 to bypass TTY guard
        spawnSync(RT_INVOKE[0]!, [...RT_INVOKE.slice(1), "code"], {
          cwd: entry.worktree,
          stdio: "pipe",
          env: { ...process.env, RT_BATCH: "1" },
        });
        showToast(`↗ opened ${entry.worktree.split("/").pop()} in editor`);
      }
    },

    // [b] open rt branch picker (switch / create / clean) in the entry's worktree
    b: ({ state }) => {
      const lane = state.lanes[Math.min(state.laneIdx, state.lanes.length - 1)];
      if (!lane) return;
      const entry = lane.entries[Math.min(state.entryIdx, lane.entries.length - 1)];
      if (!entry) return;
      openPopup(`${RT_SHELL} branch`, {
        cwd: entry.worktree,
        title: "rt branch",
        width: "100",
        height: "20",
      });
    },

    // [t] open a one-off interactive shell at the entry's working directory
    t: ({ state }) => {
      const lane = state.lanes[Math.min(state.laneIdx, state.lanes.length - 1)];
      if (!lane) return;
      const entry = lane.entries[Math.min(state.entryIdx, lane.entries.length - 1)];
      if (!entry) return;
      // Shell stays as a split pane — Esc conflicts with vim, and shells are persistent
      openTempPane(process.env.SHELL ?? "zsh", {
        cwd: entry.targetDir,
        target: displayPane(),
        escToClose: true,
      });
    },

    // [f] run a one-off package script at the entry's working directory
    f: ({ state }) => {
      const lane = state.lanes[Math.min(state.laneIdx, state.lanes.length - 1)];
      if (!lane) return;
      const entry = lane.entries[Math.min(state.entryIdx, lane.entries.length - 1)];
      if (!entry) return;
      openPopup(`${RT_SHELL} run`, {
        cwd: entry.targetDir,
        title: "rt run",
        width: "100",
        height: "20",
      });
    },

    // [o] open the active lane's canonical port in the default browser
    o: ({ state }) => {
      const lane = state.lanes[Math.min(state.laneIdx, state.lanes.length - 1)];
      if (!lane?.canonicalPort) return;
      try {
        spawnSync("open", [`http://localhost:${lane.canonicalPort}`]);
      } catch { /* ignore */ }
    },

    // [i] toggle the MR/ticket info pane (bottom-right, hidden by default)
    i: ({ state }) => {
      if (mrPaneEnabled) {
        mrPaneEnabled = false;
        hideMrPane();
      } else {
        mrPaneEnabled = true;
        showMrPane(focusedBranch(state));
      }
    },

    // [m] toggle lane mode between "warm" (suspend old) and "single" (kill old)
    m: ({ state }) => {
      const lane = state.lanes[state.laneIdx];
      if (!lane) return;
      doDispatch({ type: "toggle-mode", laneId: lane.id }, state);
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
      case "Z": // pause lane — stop proxy + all services, keep config intact
        if (lane) doDispatch({ type: "pause-lane", laneId: lane.id }, s);
        break;
      case "A": { // [A] add lane — open tmux picker
        if (_currentState && _currentState.knownRepos.length === 0) {
          showToast("No known repos — run rt in a repo first");
          break;
        }
        const tmpFile = join(tmpdir(), `rt-lane-${Date.now()}.json`);
        const cmd = `${RT_SHELL} pick-lane > ${tmpFile}`;
        openTempPane(cmd, { target: displayPane() });
        const poll = setInterval(() => {
          if (!existsSync(tmpFile)) return;
          const content = readFileSync(tmpFile, "utf8").trim();
          if (!content) return;
          clearInterval(poll);
          try {
            const { repoName, port } = JSON.parse(content) as { repoName: string; port: number };
            unlinkSync(tmpFile);
            safeUpdate((s) => {
              if (s.lanes.find((l) => l.canonicalPort === port)) {
                showToast(`port ${port} is already used by another lane`);
                return s;
              }
              const id = nextLaneId(s.lanes);
              const newLane: LaneConfig = { id, canonicalPort: port, entries: [], repoName, mode: "warm" };
              void daemonQuery("group:create", { id: newLane.id });
              void ensureProxy(newLane);
              createBgPane(newLane.id, "", `lane ${newLane.id} · ${newLane.repoName} :${newLane.canonicalPort}`);
              initDisplayPane(newLane.id);
              const next = [...s.lanes, newLane];
              saveCurrent(next);
              return { ...s, lanes: next, laneIdx: next.length - 1 };
            });
          } catch { /* ignore parse errors */ }
        }, 300);
        break;
      }
      case "R": // [R] delete selected lane
        if (lane) doDispatch({ type: "remove-lane", laneId: lane.id }, s);
        break;
      case "!": // [!] reset all lanes with confirmation
        safeUpdate((st) => ({ ...st, mode: { type: "confirm-reset" } }));
        app.setMode("confirm-reset");
        break;
      case "W": { // spread focused entry's command to all worktrees
        if (!lane) break;
        const spreadEi = Math.min(s.entryIdx, lane.entries.length - 1);
        const spreadGroup = entryGroupForIdx(lane.entries, spreadEi);
        const spreadEntry = lane.entries[spreadEi];
        if (spreadGroup && spreadGroup.entries.length === 1 && spreadEntry) {
          safeUpdate((st) => ({ ...st, mode: { type: "confirm-spread", laneId: lane.id, entryId: spreadEntry.id } }));
          app.setMode("confirm-spread");
        }
        break;
      }
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
          doDispatch({ type: "remove-entry", laneId: lane.id, entryId: entry.id }, state);
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

    "confirm-spread": {
      y: ({ state, update }) => {
        const mode = state.mode;
        if (mode.type !== "confirm-spread") return;
        const lane = state.lanes.find((l) => l.id === mode.laneId);
        const entry = lane?.entries.find((e) => e.id === mode.entryId);
        if (!lane || !entry) {
          update((s) => ({ ...s, mode: { type: "normal" } }));
          app.setMode("default");
          return;
        }
        // Only spread to worktrees that don't already have an entry with this command
        const sameGroupWorktrees = new Set(
          lane.entries.filter((e) => e.commandTemplate === entry.commandTemplate).map((e) => e.worktree)
        );
        const repo = state.knownRepos.find((r) => r.repoName === lane.repoName);
        const worktrees = repo?.worktrees ?? [];
        const relPath = relative(entry.worktree, entry.targetDir);
        let added = 0;
        for (const wt of worktrees) {
          if (sameGroupWorktrees.has(wt.path)) continue;
          const targetDir = relPath ? join(wt.path, relPath) : wt.path;
          if (!existsSync(targetDir)) continue;
          void addResolvedEntry(lane.id, {
            targetDir,
            pm: entry.pm,
            script: entry.script,
            packageLabel: entry.packageLabel,
            worktree: wt.path,
            branch: wt.branch,
          });
          added++;
        }
        showToast(
          added > 0
            ? `added to ${added} worktree${added === 1 ? "" : "s"}`
            : "no new worktrees to add",
        );
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
  for (const w of gitWatchers.values()) { try { w.close(); } catch { /* */ } }
  gitWatchers.clear();

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
    // Wrap the re-exec in a shell so a crash inside tmux doesn't silently
    // eat its own error. On non-zero exit we pause so the user can see it.
    const innerCmd = `${RT_SHELL} runner ${args.map((a) => JSON.stringify(a)).join(" ")}`;
    const shellCmd = `${innerCmd}; rc=$?; if [ $rc -ne 0 ]; then printf '\\n\\033[31m  rt runner exited with code %s — press enter to close\\033[0m' "$rc"; read _; fi; exit $rc`;
    const result = spawnSync(
      "tmux",
      ["new-session", "--", "sh", "-c", shellCmd],
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

  const lanes = loadRunnerConfig(runnerName);
  const knownRepos = getKnownRepos();

  // Ensure all existing lanes have proxies and exclusive groups in the daemon
  for (const lane of lanes) {
    void daemonQuery("group:create", { id: lane.id });
    void ensureProxy(lane);
    for (const entry of lane.entries) {
      void daemonQuery("group:add", { groupId: lane.id, processId: entryWindowName(lane.id, entry.id) });
    }
  }

  await runOnce(lanes, runnerName, knownRepos);
}
