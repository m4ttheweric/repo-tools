/**
 * Runner lane persistence.
 *
 * Named runner configurations are stored in ~/.rt/runners/<name>.json.
 * Each file contains a LaneConfig[] where every lane knows which repo it belongs to.
 *
 * Runtime state (process liveness, proxy health) is never persisted here —
 * it lives in the rt daemon (ProcessManager, StateStore, ProxyManager).
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * A single service entry within a lane.
 * Each entry runs in its own daemon-managed PTY process on a stable ephemeral port.
 */
export interface LaneEntry {
  id: string;              // "a", "b", "c" — stable within the lane
  targetDir: string;       // absolute path to run the command in
  pm: string;              // package manager: "pnpm", "npm", "bun", etc.
  script: string;          // script name passed to `pm run`
  packageLabel: string;    // display name, e.g. "backend"
  worktree: string;        // absolute repo root (may differ from targetDir in monorepos)
  branch: string;          // git branch at the time of creation
  ephemeralPort: number;   // stable port for this entry's process
  /**
   * Shell command template used to start the service. `$PORT` is available as
   * an env var so services that take a port flag can use it directly, e.g.:
   *   "pnpm start -p $PORT"
   * Defaults to `${pm} run ${script}` which works for services that read PORT
   * from the environment.
   */
  commandTemplate: string;
}

/**
 * A lane — a canonical port with a proxy and zero or more service entries.
 * The proxy forwards :canonicalPort to the activeEntry's ephemeralPort.
 * Each lane is scoped to a single repo (`repoName`).
 */
/**
 * How a lane handles deactivated entries when switching the active one.
 *  "warm"   — SIGSTOP the old process (stays in memory, instant resume)
 *  "single" — kill the old process (frees resources, cold start on switch)
 */
export type LaneMode = "warm" | "single";

export interface LaneConfig {
  id: string;             // "1", "2", "3" — display number
  canonicalPort: number;  // user-declared, stable, browser-facing
  entries: LaneEntry[];
  activeEntryId?: string; // which entry the proxy is currently routing to
  repoName: string;       // e.g. "my-repo" — repo this lane is scoped to
  mode: LaneMode;         // how to handle deactivated entries (default: "warm")
}

// ─── ID helpers ──────────────────────────────────────────────────────────────

/** Next unused lane number (fills gaps). */
export function nextLaneId(lanes: LaneConfig[]): string {
  const ids = new Set(lanes.map((l) => l.id));
  for (let i = 1; i < 100; i++) {
    if (!ids.has(String(i))) return String(i);
  }
  return String(lanes.length + 1);
}

/** Next unused entry letter within a lane. */
export function nextEntryId(entries: LaneEntry[]): string {
  const used = new Set(entries.map((e) => e.id));
  for (const ch of "abcdefghijklmnopqrstuvwxyz") {
    if (!used.has(ch)) return ch;
  }
  return String(entries.length + 1);
}

/** Daemon process/proxy ID for a lane's proxy. */
export function proxyWindowName(laneId: string): string {
  return `proxy-${laneId}`;
}

/** Daemon process ID for a lane entry. */
export function entryWindowName(laneId: string, entryId: string): string {
  return `${laneId}-${entryId}`;
}

// ─── Runner config storage ────────────────────────────────────────────────────

function runnersDir(): string {
  return join(homedir(), ".rt", "runners");
}

function runnerPath(name: string): string {
  return join(runnersDir(), `${name}.json`);
}

function normalizeEntry(raw: any): LaneEntry {
  const pm = String(raw.pm ?? "");
  const script = String(raw.script ?? "");
  return {
    id: String(raw.id ?? ""),
    targetDir: String(raw.targetDir ?? ""),
    pm,
    script,
    packageLabel: String(raw.packageLabel ?? ""),
    worktree: String(raw.worktree ?? ""),
    branch: String(raw.branch ?? ""),
    ephemeralPort: Number(raw.ephemeralPort ?? 0),
    commandTemplate: String(raw.commandTemplate ?? (pm && script ? `${pm} run ${script}` : "")),
  };
}

function normalizeLane(raw: any): LaneConfig {
  const rawMode = raw.mode;
  const mode: LaneMode = rawMode === "single" ? "single" : "warm";
  return {
    id: String(raw.id ?? ""),
    canonicalPort: Number(raw.canonicalPort ?? 0),
    entries: Array.isArray(raw.entries) ? raw.entries.map(normalizeEntry) : [],
    activeEntryId: raw.activeEntryId ?? undefined,
    repoName: String(raw.repoName ?? ""),
    mode,
  };
}

/** List all saved runner config names (filenames without .json). */
export function listRunnerConfigs(): string[] {
  const dir = runnersDir();
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.slice(0, -5))
      .sort();
  } catch {
    return [];
  }
}

/** Load lanes from a named runner config. Returns [] if the config doesn't exist. */
export function loadRunnerConfig(name: string): LaneConfig[] {
  const path = runnerPath(name);
  if (!existsSync(path)) return [];
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    if (Array.isArray(raw)) return raw.map(normalizeLane);
    return [];
  } catch {
    return [];
  }
}

/** Persist lanes for a named runner config. */
export function saveRunnerConfig(name: string, lanes: LaneConfig[]): void {
  const dir = runnersDir();
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(runnerPath(name), JSON.stringify(lanes, null, 2));
  } catch {
    // best-effort
  }
}

/** Clear all lanes for a named runner config. */
export function resetRunnerConfig(name: string): LaneConfig[] {
  saveRunnerConfig(name, []);
  return [];
}
