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

import { execSync } from "child_process";
import { getDaemonLogger } from "./../daemon-logger.ts";

const log = (await getDaemonLogger()).childLogger("process-scan");
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
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

const RUNAWAY_CONFIG_PATH = join(homedir(), ".rt", "runaway-config.json");

export function loadRunawayConfig(): ScannerConfig {
  try {
    if (!existsSync(RUNAWAY_CONFIG_PATH)) return {};
    return JSON.parse(readFileSync(RUNAWAY_CONFIG_PATH, "utf8"));
  } catch {
    return {};
  }
}

export function parseProcessList(
  psOutput: string,
  repos: Record<string, string>,
  cwdMap: Map<number, string>,
  worktreeMap: Map<string, { repo: string; branch: string }> = buildWorktreeMap(repos),
): Omit<SystemProcess, "port" | "linearTicket" | "packageScript" | "isRunaway" | "runawayDurationMs" | "firstSeen" | "children">[] {
  const lines = psOutput.trim().split("\n");
  if (lines.length <= 1) return [];

  const results: Omit<SystemProcess, "port" | "linearTicket" | "packageScript" | "isRunaway" | "runawayDurationMs" | "firstSeen" | "children">[] = [];

  for (const line of lines.slice(1)) {
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

function getPackageScripts(pidList: string): Map<number, string> {
  try {
    const out = execSync(`ps eww -o pid=,command= -p ${pidList} 2>/dev/null`, {
      encoding: "utf8", stdio: "pipe", timeout: 5000, maxBuffer: 32 * 1024 * 1024,
    });
    return parsePackageScripts(out);
  } catch (err) {
    log.warn({ err }, "ps eww scan failed; package scripts unavailable");
    return new Map();
  }
}

function getAllRepoPids(trackedPaths: string[]): Map<number, string> {
  if (trackedPaths.length === 0) return new Map();

  try {
    // Single lsof call to get cwds for ALL processes at once.
    // -d cwd selects only the cwd file descriptor, -Fpn emits pid + name fields.
    const out = execSync("lsof -d cwd -Fpn 2>/dev/null", {
      encoding: "utf8", stdio: "pipe", timeout: 10000,
    });
    return parseLsofCwdMap(out, trackedPaths);
  } catch (err) {
    log.warn({ err }, "lsof scan failed; returning empty cwd map");
    return new Map();
  }
}

export class SystemProcessScanner {
  private tracked = new Map<number, TrackedProcess>();
  private lastResult: SystemProcess[] = [];
  private config: Required<ScannerConfig>;
  private lastScanAt: number | null = null;

  constructor(config: ScannerConfig = {}) {
    const diskConfig = loadRunawayConfig();
    const merged = { ...diskConfig, ...config };
    this.config = {
      cpuThreshold: merged.cpuThreshold ?? DEFAULT_CPU_THRESHOLD,
      sustainMs: merged.sustainMs ?? DEFAULT_SUSTAIN_MS,
      graceMs: merged.graceMs ?? DEFAULT_GRACE_MS,
    };
  }

  scan(portEntries: PortEntry[] = []): SystemProcess[] {
    try {
      return this.doScan(portEntries);
    } finally {
      // Even a zero-result scan is a completed scan — consumers use this to
      // tell "no processes" apart from "haven't looked yet".
      this.lastScanAt = Date.now();
    }
  }

  private doScan(portEntries: PortEntry[]): SystemProcess[] {
    const repos = loadRepoIndex();
    if (Object.keys(repos).length === 0) {
      this.lastResult = [];
      return [];
    }

    // Include worktree paths in the lsof pre-filter: worktrees often live as
    // siblings of the registered repo root, so filtering on roots alone would
    // drop their processes before matchCwdToRepo ever sees them.
    const worktreeMap = buildWorktreeMap(repos);
    const trackedPaths = [...new Set([...Object.values(repos), ...worktreeMap.keys()])];
    const cwdMap = getAllRepoPids(trackedPaths);
    if (cwdMap.size === 0) {
      this.lastResult = [];
      return [];
    }

    // Get CPU/memory for discovered PIDs
    const pidList = [...cwdMap.keys()].join(",");
    let psOutput: string;
    try {
      psOutput = execSync(
        `ps -p ${pidList} -o pid=,ppid=,pcpu=,rss=,etime=,comm=,args= 2>/dev/null`,
        { encoding: "utf8", stdio: "pipe", timeout: 5000 },
      );
    } catch {
      this.lastResult = [];
      return [];
    }

    const parsed = parseProcessList(psOutput, repos, cwdMap, worktreeMap);
    const now = Date.now();

    const packageScripts = parsed.length > 0
      ? getPackageScripts(parsed.map(p => p.pid).join(","))
      : new Map<number, string>();

    // Build port lookup by PID
    const portByPid = new Map<number, number>();
    for (const pe of portEntries) {
      portByPid.set(pe.pid, pe.port);
    }

    // Update tracking and build result
    const currentPids = new Set<number>();
    const results: SystemProcess[] = [];

    for (const proc of parsed) {
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
        port: portByPid.get(proc.pid) ?? null,
        linearTicket: null, // enriched by handler with branch cache data
        packageScript: packageScripts.get(proc.pid) ?? null,
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
