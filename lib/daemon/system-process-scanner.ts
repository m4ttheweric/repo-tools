/**
 * System process scanner — discovers all processes whose cwd is inside a
 * tracked repo, samples CPU/memory, and maintains a rolling history window
 * for runaway detection.
 *
 * Unlike port-scanner.ts (which only looks at processes with a listening
 * port), this scans ALL processes system-wide and filters down to those
 * rooted in a tracked repo — catching build daemons, watchers, and other
 * non-listening processes that can still run away with CPU/memory.
 */

import { lazyChildLogger } from "./../daemon-logger.ts";
import { runCapture } from "../subprocess.ts";

const log = lazyChildLogger("process-scan");
import { homedir } from "os";
import { getSetting } from "../settings/resolve.ts";
import {
  loadRepoIndex,
  buildWorktreeMap,
  matchCwdToRepo,
  type PortEntry,
} from "../port-scanner.ts";

export interface SystemProcess {
  pid: number;
  ppid: number;
  command: string;
  fullCommand: string;
  cpuPercent: number;
  rssKb: number;
  uptime: string;
  cwd: string;
  repo: string;
  worktree: string | null;
  branch: string | null;
  relativeDir: string;
  port: number | null;
  linearTicket: string | null;
  /** Reconstructed package-script invocation ("pnpm start:lite:watch") from
   *  the process env; null when not launched via a package-manager script. */
  packageScript: string | null;
  isRunaway: boolean;
  runawayDurationMs: number | null;
  firstSeen: number;
  children?: SystemProcess[];
  /** Pids collapsed into this row (chain root → leaf) when single-child
   *  chains are flattened for display; absent on unflattened rows. */
  chainPids?: number[];
}

/**
 * A discovered process before runaway/tracking state is applied. `scan` and
 * `refresh` each finalize these into a full `SystemProcess` differently.
 */
type GatheredProcess = Omit<
  SystemProcess,
  "isRunaway" | "runawayDurationMs" | "firstSeen" | "children"
>;

interface ProcessSample {
  pid: number;
  cpuPercent: number;
  rssKb: number;
  uptime: string;
  command: string;
  fullCommand: string;
}

interface TrackedProcess {
  pid: number;
  firstSeen: number;
  samples: number[]; // rolling CPU% samples
  runawayStartedAt: number | null;
  runawayNotified: boolean;
}

const DEFAULT_CPU_THRESHOLD = 80;
const DEFAULT_SUSTAIN_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_GRACE_MS = 2 * 60 * 1000; // 2 minutes
const MAX_SAMPLES = 60; // 10 minutes at 10s intervals

export interface ScannerConfig {
  cpuThreshold?: number;
  sustainMs?: number;
  graceMs?: number;
}

/** A resolver throw (unexpandable ${...} variable) degrades to {} — the same
    "use the DEFAULT_* constants" fallback a missing/corrupt file gave today. */
export function loadRunawayConfig(): ScannerConfig {
  try {
    const raw = getSetting<ScannerConfig | undefined>("rt.runaway").value;
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

export function parseProcessList(
  psOutput: string,
  repos: Record<string, string>,
  cwdMap: Map<number, string>,
  worktreeMap: Map<string, { repo: string; branch: string }> = new Map(),
): Omit<SystemProcess, "port" | "linearTicket" | "packageScript" | "isRunaway" | "runawayDurationMs" | "firstSeen" | "children">[] {
  // No positional header skip: the daemon's `ps -o pid=,...` output is
  // headerless, so dropping the first line would drop a real process. A
  // header line (from `ps` without `=`) fails the pid regex and is skipped.
  const results: Omit<SystemProcess, "port" | "linearTicket" | "packageScript" | "isRunaway" | "runawayDurationMs" | "firstSeen" | "children">[] = [];

  for (const line of psOutput.trim().split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Parse: PID  PPID  %CPU  RSS  ELAPSED  COMM  ARGS...
    const match = trimmed.match(/^(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.*)/);
    if (!match) continue;

    const pid = parseInt(match[1]!, 10);
    const ppid = parseInt(match[2]!, 10);
    const cpuPercent = parseFloat(match[3]!);
    const rssKb = parseInt(match[4]!, 10);
    const uptime = match[5]!;
    const command = match[6]!;
    const fullCommand = match[7]!;

    // Filter .app bundle processes
    if (fullCommand.includes(".app/Contents/")) continue;

    // Filter shells: check both comm and fullCommand since macOS truncates comm at ~16 chars
    if (command.startsWith("-")) continue;
    const shellBins = ["zsh", "bash", "fish", "sh"];
    const fullArgv0 = fullCommand.split(" ")[0] ?? "";
    const fullBase = fullArgv0.split("/").pop() ?? "";
    const isShell = shellBins.includes(command) || shellBins.includes(fullBase);
    if (isShell && cpuPercent === 0) continue;

    const cwd = cwdMap.get(pid);
    if (!cwd) continue;

    const repoMatch = matchCwdToRepo(cwd, repos, worktreeMap);
    if (!repoMatch.repo) continue;

    results.push({
      pid,
      ppid,
      command,
      fullCommand,
      cpuPercent,
      rssKb,
      uptime,
      cwd,
      repo: repoMatch.repo,
      worktree: repoMatch.worktree,
      branch: repoMatch.branch,
      relativeDir: repoMatch.relativeDir,
    });
  }

  return results;
}

/**
 * Parse `lsof -d cwd -Fpn` output into a pid → cwd map, keeping only cwds
 * inside a tracked path (repo root or worktree) or a close parent of one.
 * Output looks like: p1234\nn/Users/matt/repos/foo\np5678\nn/other/path\n
 */
export function parseLsofCwdMap(
  lsofOutput: string,
  trackedPaths: string[],
): Map<number, string> {
  const cwdMap = new Map<number, string>();
  let currentPid = 0;
  for (const line of lsofOutput.split("\n")) {
    if (line.startsWith("p")) {
      currentPid = parseInt(line.slice(1), 10);
    } else if (line.startsWith("n") && currentPid > 0) {
      const cwd = line.slice(1);
      if (trackedPaths.some(tp => cwd === tp || cwd.startsWith(tp + "/"))) {
        cwdMap.set(currentPid, cwd);
      } else if (trackedPaths.some(tp =>
        tp.startsWith(cwd + "/") && tp.slice(cwd.length + 1).split("/").length <= 2
      )) {
        cwdMap.set(currentPid, cwd);
      }
    }
  }
  return cwdMap;
}

/**
 * Parse `ps eww -o pid=,command=` output (argv + environment per line) into a
 * pid → "pm script" map, e.g. "pnpm start:lite:watch". Only the two npm_* vars
 * are extracted — the raw lines carry the full env (secrets included) and must
 * never leave this function. Requires BOTH vars: without the pair we can't
 * honestly reconstruct what was typed, so the pid is omitted.
 */
export function parsePackageScripts(psEwwOutput: string): Map<number, string> {
  const scripts = new Map<number, string>();
  for (const line of psEwwOutput.split("\n")) {
    const pidMatch = line.match(/^\s*(\d+)\s/);
    if (!pidMatch) continue;
    const agent = line.match(/\bnpm_config_user_agent=(\S+)/)?.[1];
    const script = line.match(/\bnpm_lifecycle_event=(\S+)/)?.[1];
    if (!agent || !script) continue;
    const pm = agent.split("/")[0];
    if (!pm) continue;
    scripts.set(parseInt(pidMatch[1]!, 10), `${pm} ${script}`);
  }
  return scripts;
}

async function getPackageScripts(pidList: string): Promise<Map<number, string>> {
  const { stdout, exitCode } = await runCapture(
    ["ps", "eww", "-o", "pid=,command=", "-p", pidList],
    { timeoutMs: 5000 },
  );
  if (exitCode !== 0 && !stdout) {
    log.warn({ exitCode }, "ps eww scan failed; package scripts unavailable");
    return new Map();
  }
  return parsePackageScripts(stdout);
}

async function getAllRepoPids(trackedPaths: string[]): Promise<Map<number, string> | null> {
  if (trackedPaths.length === 0) return new Map();

  // Single lsof call to get cwds for ALL processes at once.
  // -d cwd selects only the cwd file descriptor, -Fpn emits pid + name fields.
  const { stdout, exitCode } = await runCapture(
    ["lsof", "-d", "cwd", "-Fpn"],
    { timeoutMs: 10_000 },
  );
  if (exitCode !== 0 && !stdout) {
    // null (not an empty Map) so callers can tell "lsof failed" apart from
    // "genuinely no tracked-cwd processes" and preserve runaway state instead
    // of pruning every tracked pid on a transient scan failure.
    log.warn({ exitCode }, "lsof scan failed; preserving prior process state");
    return null;
  }
  return parseLsofCwdMap(stdout, trackedPaths);
}

export class SystemProcessScanner {
  private tracked = new Map<number, TrackedProcess>();
  private lastResult: SystemProcess[] = [];
  private config: Required<ScannerConfig>;
  private lastScanAt: number | null = null;

  constructor(config: ScannerConfig = {}) {
    const storeConfig = loadRunawayConfig();
    const merged = { ...storeConfig, ...config };
    this.config = {
      cpuThreshold: merged.cpuThreshold ?? DEFAULT_CPU_THRESHOLD,
      sustainMs: merged.sustainMs ?? DEFAULT_SUSTAIN_MS,
      graceMs: merged.graceMs ?? DEFAULT_GRACE_MS,
    };
  }

  /**
   * Full scan: discover processes AND update the runaway sample window.
   * Runs on the daemon's fixed 10s background timer — the runaway math
   * (samplesNeeded = sustainMs / 10s) assumes that cadence, so ONLY this
   * path may feed samples. On-demand reads use `refresh` instead.
   */
  async scan(portEntries: PortEntry[] = []): Promise<SystemProcess[]> {
    const gathered = await this.gather(portEntries);
    if (gathered === null) return this.lastResult; // failed tick: preserve tracked/lastResult/lastScanAt
    try {
      const now = Date.now();

      const currentPids = new Set<number>();
      const results: SystemProcess[] = [];

      for (const proc of gathered) {
        currentPids.add(proc.pid);

        let track = this.tracked.get(proc.pid);
        if (!track) {
          track = {
            pid: proc.pid,
            firstSeen: now,
            samples: [],
            runawayStartedAt: null,
            runawayNotified: false,
          };
          this.tracked.set(proc.pid, track);
        }

        // Rolling CPU sample window
        track.samples.push(proc.cpuPercent);
        if (track.samples.length > MAX_SAMPLES) {
          track.samples.shift();
        }

        // Runaway detection
        const age = now - track.firstSeen;
        let isRunaway = false;
        let runawayDurationMs: number | null = null;

        if (age > this.config.graceMs) {
          // Count consecutive recent samples above threshold
          const samplesNeeded = Math.ceil(this.config.sustainMs / 10_000);
          const recent = track.samples.slice(-samplesNeeded);
          const allAbove = recent.length >= samplesNeeded &&
            recent.every(s => s >= this.config.cpuThreshold);

          if (allAbove) {
            if (!track.runawayStartedAt) {
              track.runawayStartedAt = now;
            }
            isRunaway = true;
            runawayDurationMs = now - track.runawayStartedAt;
          } else {
            track.runawayStartedAt = null;
          }
        }

        results.push({
          ...proc,
          isRunaway,
          runawayDurationMs,
          firstSeen: track.firstSeen,
        });
      }

      // Prune dead PIDs
      for (const pid of this.tracked.keys()) {
        if (!currentPids.has(pid)) {
          this.tracked.delete(pid);
        }
      }

      this.lastResult = results;
      return results;
    } finally {
      // Even a zero-result scan is a completed scan — consumers use this to
      // tell "no processes" apart from "haven't looked yet".
      this.lastScanAt = Date.now();
    }
  }

  /**
   * On-demand refresh for the tray panel: re-discovers the process list so a
   * poll sees current reality (new/dead processes) WITHOUT touching the
   * runaway sample window. Runaway flags are carried forward from the last
   * full `scan`, so badges persist but faster polling can't trip a premature
   * alert. Also advances `lastScanAt` so freshness checks see the update.
   */
  async refresh(portEntries: PortEntry[] = []): Promise<SystemProcess[]> {
    const gathered = await this.gather(portEntries);
    if (gathered === null) return this.lastResult; // failed tick: preserve tracked/lastResult/lastScanAt
    try {
      const prev = new Map(this.lastResult.map(p => [p.pid, p]));
      const results = gathered.map<SystemProcess>(proc => {
        const before = prev.get(proc.pid);
        return {
          ...proc,
          isRunaway: before?.isRunaway ?? false,
          runawayDurationMs: before?.runawayDurationMs ?? null,
          firstSeen: before?.firstSeen ?? this.tracked.get(proc.pid)?.firstSeen ?? Date.now(),
        };
      });
      this.lastResult = results;
      return results;
    } finally {
      this.lastScanAt = Date.now();
    }
  }

  /**
   * Discovery half of a scan: find every process rooted in a tracked repo and
   * decorate it with port + package-script, but no runaway/tracking state.
   * Shared by `scan` (adds tracking) and `refresh` (carries flags forward).
   */
  protected async gather(portEntries: PortEntry[]): Promise<GatheredProcess[] | null> {
    const repos = loadRepoIndex();
    if (Object.keys(repos).length === 0) return [];

    // Include worktree paths in the lsof pre-filter: worktrees often live as
    // siblings of the registered repo root, so filtering on roots alone would
    // drop their processes before matchCwdToRepo ever sees them.
    const worktreeMap = await buildWorktreeMap(repos);
    const trackedPaths = [...new Set([...Object.values(repos), ...worktreeMap.keys()])];
    const cwdMap = await getAllRepoPids(trackedPaths);
    if (cwdMap === null) return null; // lsof failed
    if (cwdMap.size === 0) return []; // genuinely no tracked-cwd processes

    // Get CPU/memory for discovered PIDs
    const pidList = [...cwdMap.keys()].join(",");
    const psRes = await runCapture(
      ["ps", "-p", pidList, "-o", "pid=,ppid=,pcpu=,rss=,etime=,comm=,args="],
      { timeoutMs: 5000 },
    );
    if (psRes.exitCode !== 0 && !psRes.stdout) return null; // ps failed
    if (!psRes.stdout) return [];

    const parsed = parseProcessList(psRes.stdout, repos, cwdMap, worktreeMap);

    const packageScripts = parsed.length > 0
      ? await getPackageScripts(parsed.map(p => p.pid).join(","))
      : new Map<number, string>();

    // Build port lookup by PID
    const portByPid = new Map<number, number>();
    for (const pe of portEntries) {
      portByPid.set(pe.pid, pe.port);
    }

    return parsed.map(proc => ({
      ...proc,
      port: portByPid.get(proc.pid) ?? null,
      linearTicket: null, // enriched by handler with branch cache data
      packageScript: packageScripts.get(proc.pid) ?? null,
    }));
  }

  /** Ms since the last `scan`/`refresh` completed; Infinity if never. */
  msSinceLastScan(): number {
    return this.lastScanAt === null ? Infinity : Date.now() - this.lastScanAt;
  }

  getProcesses(): SystemProcess[] {
    return this.lastResult;
  }

  getRunawayProcesses(): SystemProcess[] {
    return this.lastResult.filter(p => p.isRunaway);
  }

  getTracked(pid: number): TrackedProcess | undefined {
    return this.tracked.get(pid);
  }

  isRunawayNotified(pid: number): boolean {
    return this.tracked.get(pid)?.runawayNotified ?? false;
  }

  markRunawayNotified(pid: number): void {
    const track = this.tracked.get(pid);
    if (track) track.runawayNotified = true;
  }

  clearRunawayNotified(pid: number): void {
    const track = this.tracked.get(pid);
    if (track) track.runawayNotified = false;
  }

  get hasCompletedScan(): boolean {
    return this.lastScanAt !== null;
  }
}
