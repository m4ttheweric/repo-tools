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
import {
  loadRepoIndex,
  buildWorktreeMap,
  matchCwdToRepo,
  type PortEntry,
} from "../port-scanner.ts";

export interface SystemProcess {
  pid: number;
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
  isRunaway: boolean;
  runawayDurationMs: number | null;
  firstSeen: number;
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

export function parseProcessList(
  psOutput: string,
  repos: Record<string, string>,
  cwdMap: Map<number, string>,
): Omit<SystemProcess, "port" | "linearTicket" | "isRunaway" | "runawayDurationMs" | "firstSeen">[] {
  const worktreeMap = buildWorktreeMap(repos);
  const lines = psOutput.trim().split("\n");
  if (lines.length <= 1) return [];

  const results: Omit<SystemProcess, "port" | "linearTicket" | "isRunaway" | "runawayDurationMs" | "firstSeen">[] = [];

  for (const line of lines.slice(1)) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Parse: PID  %CPU  RSS  ELAPSED  COMM  ARGS...
    // Use fixed-position extraction since args can contain spaces
    const match = trimmed.match(/^(\d+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(.*)/);
    if (!match) continue;

    const pid = parseInt(match[1]!, 10);
    const cpuPercent = parseFloat(match[2]!);
    const rssKb = parseInt(match[3]!, 10);
    const uptime = match[4]!;
    const command = match[5]!;
    const fullCommand = match[6]!;

    // Filter .app bundle processes
    if (fullCommand.includes(".app/Contents/")) continue;

    const cwd = cwdMap.get(pid);
    if (!cwd) continue;

    const repoMatch = matchCwdToRepo(cwd, repos, worktreeMap);
    if (!repoMatch.repo) continue;

    results.push({
      pid,
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

function getAllRepoPids(repos: Record<string, string>): Map<number, string> {
  // Get all PIDs and their cwds via a single ps + lsof pass
  const cwdMap = new Map<number, string>();
  const repoPaths = Object.values(repos);
  if (repoPaths.length === 0) return cwdMap;

  try {
    // Get all non-kernel PIDs
    const psOut = execSync("ps -axo pid= 2>/dev/null", {
      encoding: "utf8", stdio: "pipe", timeout: 5000,
    });
    const pids = psOut.trim().split("\n").map(p => parseInt(p.trim(), 10)).filter(Boolean);

    // Batch lsof for cwds — one call for all PIDs is much faster than per-PID
    for (const pid of pids) {
      try {
        const out = execSync(`lsof -a -p ${pid} -d cwd -Fn 2>/dev/null`, {
          encoding: "utf8", stdio: "pipe", timeout: 2000,
        });
        for (const line of out.split("\n")) {
          if (line.startsWith("n") && line.length > 1 && line[1] === "/") {
            const cwd = line.slice(1);
            // Quick prefix check before adding to map
            if (repoPaths.some(rp => cwd === rp || cwd.startsWith(rp + "/"))) {
              cwdMap.set(pid, cwd);
            }
            break;
          }
        }
      } catch { /* pid died mid-scan, skip */ }
    }
  } catch { /* ps failed, return empty */ }

  return cwdMap;
}

export class SystemProcessScanner {
  private tracked = new Map<number, TrackedProcess>();
  private lastResult: SystemProcess[] = [];
  private config: Required<ScannerConfig>;

  constructor(config: ScannerConfig = {}) {
    this.config = {
      cpuThreshold: config.cpuThreshold ?? DEFAULT_CPU_THRESHOLD,
      sustainMs: config.sustainMs ?? DEFAULT_SUSTAIN_MS,
      graceMs: config.graceMs ?? DEFAULT_GRACE_MS,
    };
  }

  scan(portEntries: PortEntry[] = []): SystemProcess[] {
    const repos = loadRepoIndex();
    if (Object.keys(repos).length === 0) {
      this.lastResult = [];
      return [];
    }

    const cwdMap = getAllRepoPids(repos);
    if (cwdMap.size === 0) {
      this.lastResult = [];
      return [];
    }

    // Get CPU/memory for discovered PIDs
    const pidList = [...cwdMap.keys()].join(",");
    let psOutput: string;
    try {
      psOutput = execSync(
        `ps -p ${pidList} -o pid=,pcpu=,rss=,etime=,comm=,args= 2>/dev/null`,
        { encoding: "utf8", stdio: "pipe", timeout: 5000 },
      );
    } catch {
      this.lastResult = [];
      return [];
    }

    const parsed = parseProcessList(psOutput, repos, cwdMap);
    const now = Date.now();

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
}
