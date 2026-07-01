/**
 * Legacy runner lane configuration (read-only).
 *
 * Named runner configurations are stored in ~/.rt/runners/<name>.json.
 * Each file contains a LaneConfig[] where every lane knows which repo it
 * belongs to. On disk, a lane has one singular `entry` service definition;
 * at load time that service expands to `entries` — one row per worktree.
 *
 * The runner TUI that wrote these files is gone. What remains live:
 *   - LaneConfig/LaneEntry types — tunnel:apply payloads and ingress YAML
 *     generation (lib/tunnel-ingress.ts, tunnel-manager.ts)
 *   - proxyWindowName/entryWindowName — daemon process/proxy id naming
 *   - the read path (loadRunnerConfig) — startup port-allocation pruning
 *     via collectRunnerPortLabels()
 * The write path (save, compaction, locks) was deleted with the TUI.
 *
 * Compact on-disk shapes handled by the read path:
 *   Single-command:  entry: { commandTemplate, packagePath, ..., worktrees: [{root}] }
 *   Multi-command:   entry: { commandTemplate: [cmd0, cmd1], ..., worktrees: [{root}] }
 *                    (one runtime entry per worktree; commands become a menu)
 * Any command variant can also be an object `{ cmd, alias? }` — the alias is a
 * human-friendly label shown in place of the raw shell command.
 */

import { existsSync, readdirSync, readFileSync } from "fs";
import { createHash } from "crypto";
import { homedir } from "os";
import { basename, join } from "path";
import { normalizeRemedy, type Remedy } from "./remedy-config.ts";

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * A single service entry within a lane.
 * Each entry runs in its own daemon-managed PTY process on a stable ephemeral port.
 */
export interface LaneEntry {
  id: string;              // "a", "b", "c" — stable within the lane
  targetDir: string;       // absolute path to run the command in
  packageLabel: string;    // display name, e.g. "backend"
  worktree: string;        // absolute repo root (may differ from targetDir in monorepos)
  branch: string;          // git branch at the time of creation
  ephemeralPort: number;   // stable port for this entry's process
  /**
   * Shell command template used to start the service. `$PORT` is available as
   * an env var so services that take a port flag can use it directly, e.g.:
   *   "pnpm start -p $PORT"
   */
  commandTemplate: string;
  /**
   * Optional human-friendly label shown in the UI instead of the raw command.
   * Populated from the `{cmd, alias}` object form of `commandTemplate` in the
   * on-disk compact config.
   */
  alias?: string;
  /**
   * When the on-disk compact entry defined a `commandTemplate` array, each
   * worktree entry carries the full menu here. `commandTemplate` above is
   * whichever variant is currently active.
   */
  availableCommands?: Array<{ cmd: string; alias?: string }>;
  /** Auto-remedy rules — see RemedyEngine in the daemon. */
  remedies?: Remedy[];
}

/**
 * How a lane handles deactivated entries when switching the active one.
 *  "warm"   — SIGSTOP the old process (stays in memory, instant resume)
 *  "single" — kill the old process (frees resources, cold start on switch)
 */
export type LaneMode = "warm" | "single";

/**
 * A lane — a canonical port with a proxy and zero or more runtime service rows.
 * The proxy forwards :canonicalPort to the activeEntry's ephemeralPort.
 * Each lane is scoped to a single repo (`repoName`).
 */
export interface LaneConfig {
  id: string;             // "1", "2", "3" — display number
  canonicalPort: number;  // user-declared, stable, browser-facing
  entries: LaneEntry[];    // runtime expansion of the singular persisted `entry`
  activeEntryId?: string; // which entry the proxy is currently routing to
  repoName: string;       // e.g. "my-repo" — repo this lane is scoped to
  mode: LaneMode;         // how to handle deactivated entries (default: "warm")
  /**
   * Cloudflare tunnel publishing. Absent ≡ disabled.
   * When enabled the daemon's TunnelManager includes this lane's
   * canonicalPort in the generated cloudflared ingress for the active board.
   */
  tunnel?: { enabled: boolean };
}

// ─── ID helpers ──────────────────────────────────────────────────────────────

/** Daemon process/proxy ID for a lane's proxy. */
export function proxyWindowName(laneId: string): string {
  return `proxy-${laneId}`;
}

/** Daemon process ID for a lane entry. */
export function entryWindowName(laneId: string, entryId: string): string {
  return `${laneId}-${entryId}`;
}

/** 6-char sha1 prefix of the input — enough to disambiguate a handful of entries. */
function hashShort(s: string): string {
  return createHash("sha1").update(s).digest("hex").slice(0, 6);
}

// ─── Entry expansion (read path) ─────────────────────────────────────────────

/**
 * Derive a stable, human-readable entry ID from the worktree root path and
 * command index. The basename of the worktree path is unique within a single
 * repo's worktrees (e.g. "assured-primary", "assured-wktree-2").
 * For the first (or only) command no suffix is added; further variants get a
 * numeric suffix: "assured-primary-1", "assured-primary-2".
 */
function worktreeEntryId(worktreeRoot: string, cmdIdx = 0): string {
  const base = basename(worktreeRoot);
  return cmdIdx === 0 ? base : `${base}-${cmdIdx}`;
}

/**
 * Parse a commandTemplate variant into its cmd/alias pair.
 * Accepts a bare string (no alias) or `{ cmd, alias? }`. Unknown shapes
 * coerce to a string so loading never throws on malformed input.
 */
function parseCmd(raw: any): { cmd: string; alias?: string } {
  if (raw && typeof raw === "object" && typeof raw.cmd === "string") {
    return typeof raw.alias === "string" && raw.alias
      ? { cmd: raw.cmd, alias: raw.alias }
      : { cmd: raw.cmd };
  }
  return { cmd: String(raw ?? "") };
}

/**
 * Expand a compact entry (has `worktrees` array) into individual LaneEntry objects.
 *
 * When `commandTemplate` is an array, the variants form a *menu* — one per
 * entry is active (selected by `activeCmdIdx`, default 0) and the full list
 * is carried on every expanded entry as `availableCommands`.
 *
 * ephemeralPort is always 0 on load — the daemon allocates it dynamically.
 */
function expandCompactEntry(raw: any): LaneEntry[] {
  if (!Array.isArray(raw.worktrees) || raw.worktrees.length === 0) {
    return [normalizeExpandedEntry(raw)];
  }

  const packagePath  = String(raw.packagePath ?? "");
  const packageLabel = String(raw.packageLabel ?? "");
  const remedies     = Array.isArray(raw.remedies) ? raw.remedies.map(normalizeRemedy) : undefined;

  // Normalise commandTemplate → always { cmd, alias? }[].
  // Legacy fallback: pre-cleanup configs may have `pm`/`script` instead of an
  // explicit commandTemplate. Reconstruct it so old files keep loading.
  const rawCmd = raw.commandTemplate;
  const legacyCmd = raw.pm && raw.script ? `${raw.pm} run ${raw.script}` : "";
  const rawCmds: any[] = Array.isArray(rawCmd)
    ? rawCmd
    : [rawCmd ?? legacyCmd];
  const commands = rawCmds.map(parseCmd);

  const activeIdxRaw = Number(raw.activeCmdIdx ?? 0);
  const activeIdx = Number.isFinite(activeIdxRaw) && activeIdxRaw >= 0 && activeIdxRaw < commands.length
    ? activeIdxRaw
    : 0;
  const active = commands[activeIdx]!;
  const hasMenu = commands.length > 1;
  // Strip undefined aliases when forwarding to availableCommands so the
  // shape stays minimal.
  const availableCommands = hasMenu
    ? commands.map((c) => c.alias ? { cmd: c.cmd, alias: c.alias } : { cmd: c.cmd })
    : undefined;

  const entries: LaneEntry[] = [];
  for (const wt of raw.worktrees as any[]) {
    const root      = String(wt.root ?? "");
    const targetDir = packagePath && packagePath !== "." ? `${root}/${packagePath}` : root;
    entries.push({
      id:              worktreeEntryId(root, 0),
      targetDir,
      packageLabel,
      worktree:        root,
      branch:          "",  // populated at runtime by git watcher
      ephemeralPort:   0,   // allocated at runtime by port allocator
      commandTemplate: active.cmd,
      ...(active.alias ? { alias: active.alias } : {}),
      ...(availableCommands ? { availableCommands } : {}),
      ...(remedies ? { remedies } : {}),
    } satisfies LaneEntry);
  }

  return entries;
}

/** Normalise a plain (already-expanded) entry object. */
function normalizeExpandedEntry(raw: any): LaneEntry {
  const worktree = String(raw.worktree ?? "");
  // Derive id from worktree basename if not explicitly stored
  const id = String(raw.id || (worktree ? worktreeEntryId(worktree) : ""));
  // commandTemplate on an expanded entry can also be the object form;
  // a top-level `alias` field takes precedence if present. Legacy fallback:
  // synthesize from pm/script if commandTemplate is missing.
  const legacyCmd = raw.pm && raw.script ? `${raw.pm} run ${raw.script}` : "";
  const parsed = raw.commandTemplate !== undefined
    ? parseCmd(raw.commandTemplate)
    : { cmd: legacyCmd };
  const alias = typeof raw.alias === "string" && raw.alias ? raw.alias : parsed.alias;
  const availableCommands: Array<{ cmd: string; alias?: string }> | undefined = Array.isArray(raw.availableCommands)
    ? (raw.availableCommands as any[]).map((r): { cmd: string; alias?: string } => {
        const parsed = parseCmd(r);
        return parsed.alias ? { cmd: parsed.cmd, alias: parsed.alias } : { cmd: parsed.cmd };
      })
    : undefined;
  return {
    id,
    targetDir:       String(raw.targetDir ?? ""),
    packageLabel:    String(raw.packageLabel ?? ""),
    worktree,
    branch:          "",  // populated at runtime
    ephemeralPort:   0,   // allocated at runtime
    commandTemplate: parsed.cmd,
    ...(alias ? { alias } : {}),
    ...(availableCommands && availableCommands.length > 1 ? { availableCommands } : {}),
    remedies:        Array.isArray(raw.remedies) ? raw.remedies.map(normalizeRemedy) : undefined,
  };
}

/** Parse an entry that may be compact or expanded. */
function normalizeEntry(raw: any): LaneEntry[] {
  return Array.isArray(raw.worktrees) ? expandCompactEntry(raw) : [normalizeExpandedEntry(raw)];
}

// ─── Lane normalization + config loading ────────────────────────────────────

export function normalizeLane(raw: any): LaneConfig {
  const rawMode = raw.mode;
  const mode: LaneMode = rawMode === "single" ? "single" : "warm";
  const entries: LaneEntry[] = raw.entry ? normalizeEntry(raw.entry) : [];

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
  // from it at load time.
  let activeEntryId: string | undefined;
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
    ...(raw.tunnel && typeof raw.tunnel === "object"
      ? { tunnel: { enabled: Boolean(raw.tunnel.enabled) } }
      : {}),
  };
}

function runnersDir(): string {
  return join(homedir(), ".rt", "runners");
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
  const path = join(runnersDir(), `${name}.json`);
  if (!existsSync(path)) return [];
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    if (Array.isArray(raw)) return raw.map(normalizeLane);
    return [];
  } catch {
    return [];
  }
}

/**
 * The set of all valid port-allocation labels derivable from persisted runner
 * configs (entryWindowName for every entry across all lanes). Used at daemon
 * startup to prune orphaned allocations left by removed entries or crashed
 * restarts.
 */
export function collectRunnerPortLabels(): Set<string> {
  const validLabels = new Set<string>();
  for (const name of listRunnerConfigs()) {
    for (const lane of loadRunnerConfig(name)) {
      for (const entry of lane.entries) {
        validLabels.add(entryWindowName(lane.id, entry.id));
      }
    }
  }
  return validLabels;
}
