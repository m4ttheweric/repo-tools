/**
 * Runner lane persistence.
 *
 * Named runner configurations are stored in ~/.rt/runners/<name>.json.
 * Each file contains a LaneConfig[] where every lane knows which repo it belongs to.
 *
 * Runtime state (process liveness, proxy health) is never persisted here —
 * it lives in the rt daemon (ProcessManager, StateStore, ProxyManager).
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "fs";
import { createHash } from "crypto";
import { homedir } from "os";
import { join } from "path";
import { compactEntries, normalizeEntry, normalizeRemedy } from "./runner-store/compact.ts";

export { compactEntries, normalizeEntry };

/** 6-char sha1 prefix of the input — enough to disambiguate a handful of entries. */
function hashShort(s: string): string {
  return createHash("sha1").update(s).digest("hex").slice(0, 6);
}

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * An auto-remedy rule attached to a lane entry.
 *
 * When the daemon detects `pattern` in the entry's live PTY output, it runs
 * `cmds` in the entry's working directory and optionally restarts the process.
 * Used for mechanical fixes like clearing a corrupted cache directory.
 */
export interface Remedy {
  name: string;          // human label, e.g. "Clear parcel cache"
  /**
   * One or more regex strings matched against ANSI-stripped log lines.
   * A single string or an array — if array, ANY match triggers the remedy (OR logic).
   */
  pattern: string | string[];
  cmds: string[];        // ordered shell commands to execute, e.g. ["rm -rf .parcel-cache"]
  thenRestart?: boolean; // restart the process after cmds complete? (default: true)
  cooldownMs?: number;   // min ms between triggers to prevent flapping (default: 30_000)
}

/**
 * A global auto-remedy rule stored in ~/.rt/remedies/_global.json.
 *
 * Applies to any process whose working directory contains `cwdContains`
 * AND whose command contains `cmdContains`. Both matchers are optional
 * substrings (case-insensitive). If both are omitted the rule matches every
 * process — useful for truly universal fixes.
 *
 * Extends Remedy with the two selector fields.
 */
export interface GlobalRemedy extends Remedy {
  /** Substring that must appear in the process's working directory path. */
  cwdContains?: string;
  /** Substring that must appear in the process's command string. */
  cmdContains?: string;
}

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
  /** Auto-remedy rules — see RemedyEngine in the daemon. */
  remedies?: Remedy[];
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

// ─── Remedies directory ──────────────────────────────────────────────────────

/** Directory where remedy files live: ~/.rt/remedies/ */
export function remediesDir(): string {
  return join(homedir(), ".rt", "remedies");
}

/** Absolute path for the per-entry remedy file (keyed by daemon processId). */
export function entryRemedyPath(processId: string): string {
  return join(remediesDir(), `${processId}.json`);
}

/** Absolute path for the global remedy file. */
export function globalRemedyPath(): string {
  return join(remediesDir(), "_global.json");
}

function normalizeGlobalRemedy(raw: any): GlobalRemedy {
  return {
    ...normalizeRemedy(raw),
    ...(raw.cwdContains !== undefined ? { cwdContains: String(raw.cwdContains) } : {}),
    ...(raw.cmdContains !== undefined ? { cmdContains: String(raw.cmdContains) } : {}),
  };
}

/**
 * Load global remedies from ~/.rt/remedies/_global.json.
 *
 * Returns [] when the file doesn't exist (fresh install).
 * Throws on JSON parse failure or non-array shape so callers can preserve
 * their last-good state instead of silently wiping everything — editors
 * commonly produce transient invalid states during atomic-rename saves.
 */
export function loadGlobalRemedies(): GlobalRemedy[] {
  const path = globalRemedyPath();
  if (!existsSync(path)) return [];
  const raw = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(raw)) throw new Error("global remedy file is not a JSON array");
  return raw.map(normalizeGlobalRemedy);
}

/** Persist global remedies to ~/.rt/remedies/_global.json. */
export function saveGlobalRemedies(remedies: GlobalRemedy[]): void {
  const dir = remediesDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(globalRemedyPath(), JSON.stringify(remedies, null, 2));
}

// ─── Runner config storage ────────────────────────────────────────────────────

function runnersDir(): string {
  return join(homedir(), ".rt", "runners");
}

function runnerPath(name: string): string {
  return join(runnersDir(), `${name}.json`);
}

// ─── Compact format (read + write) ───────────────────────────────────────────
//
// The compact↔expanded transform lives in ./runner-store/compact.ts.
// Round-trip behavior is pinned by ./__tests__/runner-store-compact.test.ts.
//
// `commandTemplate` may be a single string OR an array of command variants.
// When it is an array, the cross-product of commands × worktrees is expanded.
// Ephemeral ports are NOT stored — they are dynamically allocated by the daemon
// port allocator (keyed by entryWindowName) on every start.
//
// Single-command shape:  { commandTemplate, packagePath, ..., worktrees: [{id, root, branch?}] }
// Multi-command shape:   { commandTemplate: [cmd0, cmd1], ..., worktrees: [{ids:[id0,id1], root, branch?}] }

export function normalizeLane(raw: any): LaneConfig {
  const rawMode = raw.mode;
  const mode: LaneMode = rawMode === "single" ? "single" : "warm";
  const entries: LaneEntry[] = Array.isArray(raw.entries) ? raw.entries.flatMap(normalizeEntry) : [];

  // Detect entry.id basename collisions within a single lane. Process ids are
  // built from lane + entry.id, so a duplicate silently aliases two entries'
  // PTY output and state — worse than a loud error. Append a salt to break ties.
  const seen = new Map<string, number>();
  for (const e of entries) {
    const count = (seen.get(e.id) ?? 0) + 1;
    seen.set(e.id, count);
    if (count > 1) {
      const hash = hashShort(e.worktree || e.targetDir || e.id);
      e.id = `${e.id}~${hash}`;
    }
  }

  // `activeWorktree` (path) is the canonical stored form; derive the entry id
  // from it at load time. Fall back to legacy `activeEntryId` letter for old files.
  let activeEntryId: string | undefined = raw.activeEntryId ?? undefined;
  if (raw.activeWorktree) {
    const match = entries.find((e) => e.worktree === raw.activeWorktree);
    if (match) activeEntryId = match.id;
  }

  return {
    id:            String(raw.id ?? ""),
    canonicalPort: Number(raw.canonicalPort ?? 0),
    entries,
    activeEntryId,
    repoName:      String(raw.repoName ?? ""),
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
    // Record mtime so saveRunnerConfig can detect external writes after this
    // point. Set before returning so even the empty-array path is tracked.
    lastKnownMtimeMs.set(name, fileMtimeMs(path));
    if (Array.isArray(raw)) return raw.map(normalizeLane);
    return [];
  } catch {
    return [];
  }
}

/**
 * mtime of the runner config file at the moment it was last read or written
 * by this process. Used to detect if someone else (another runner, a manual
 * edit) clobbered the file between our snapshots, which would indicate our
 * in-memory copy is stale and saving it would revert their change.
 *
 * Keyed by name so multiple configs can coexist in one process (unusual, but
 * the picker flow briefly loads several).
 */
const lastKnownMtimeMs = new Map<string, number>();

function fileMtimeMs(path: string): number {
  try { return statSync(path).mtimeMs; } catch { return 0; }
}

/**
 * Persist lanes for a named runner config.
 *
 * Returns `true` on success, `false` when the on-disk file changed since we
 * last read/wrote it (meaning another writer edited it — we refuse to clobber).
 * Callers should reload and retry on `false`.
 *
 * The race we're guarding against: multiple `rt runner` processes for the same
 * config each hold their own in-memory `currentLanes` snapshot. If one of them
 * wrote last, a background save in another (e.g. branch-watcher firing after
 * `doRepoChange`) would silently overwrite it with a stale snapshot.
 */
export function saveRunnerConfig(name: string, lanes: LaneConfig[]): boolean {
  const dir = runnersDir();
  const path = runnerPath(name);
  try {
    mkdirSync(dir, { recursive: true });
    const diskMtime = fileMtimeMs(path);
    const lastKnown = lastKnownMtimeMs.get(name) ?? 0;
    // lastKnown === 0 means we've never read or written this file in-process
    // yet — allow the first write. Otherwise any drift means someone else
    // touched it; bail.
    if (lastKnown !== 0 && diskMtime !== 0 && diskMtime !== lastKnown) {
      return false;
    }
    writeFileSync(path, JSON.stringify(lanes.map((l) => {
      // Convert activeEntryId back to activeWorktree (path) for storage
      const activeEntry = l.entries.find((e) => e.id === l.activeEntryId);
      const { activeEntryId: _id, ...laneRest } = l;
      return {
        ...laneRest,
        ...(activeEntry?.worktree ? { activeWorktree: activeEntry.worktree } : {}),
        entries: compactEntries(l.entries),
      };
    }), null, 2));
    lastKnownMtimeMs.set(name, fileMtimeMs(path));
    return true;
  } catch {
    return false;
  }
}

/** Clear all lanes for a named runner config. */
export function resetRunnerConfig(name: string): LaneConfig[] {
  saveRunnerConfig(name, []);
  return [];
}

// ─── Singleton lock ──────────────────────────────────────────────────────────
// Prevents two `rt runner` processes from running against the same config and
// racing on save. Lock is a sibling file `~/.rt/runners/.<name>.lock` holding
// the owning PID.

function lockPath(name: string): string {
  return join(runnersDir(), `.${name}.lock`);
}

function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export interface RunnerLockHolder {
  pid: number;
  startedAt: string;
  tmuxSession?: string;
}

/**
 * Attempt to acquire the runner lock.
 * Returns `{ ok: true }` on success, or `{ ok: false, holder }` if another
 * live process already owns it. Stale locks (dead PID) are reclaimed.
 */
export function acquireRunnerLock(
  name: string,
  holder: RunnerLockHolder,
): { ok: true } | { ok: false; holder: RunnerLockHolder } {
  const dir = runnersDir();
  mkdirSync(dir, { recursive: true });
  const path = lockPath(name);
  if (existsSync(path)) {
    try {
      const existing = JSON.parse(readFileSync(path, "utf8")) as RunnerLockHolder;
      if (isPidAlive(existing.pid) && existing.pid !== holder.pid) {
        return { ok: false, holder: existing };
      }
    } catch { /* corrupt lock — overwrite */ }
  }
  writeFileSync(path, JSON.stringify(holder, null, 2));
  return { ok: true };
}

/** Release the lock if we still own it. Safe to call multiple times. */
export function releaseRunnerLock(name: string, pid: number): void {
  const path = lockPath(name);
  try {
    const existing = JSON.parse(readFileSync(path, "utf8")) as RunnerLockHolder;
    if (existing.pid === pid) unlinkSync(path);
  } catch { /* already gone or corrupt */ }
}
