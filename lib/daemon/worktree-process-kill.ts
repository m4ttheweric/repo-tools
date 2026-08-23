/**
 * Kill the workload processes rooted in a worktree — dev servers, watchers,
 * compilers — when the worktree is parked and its feature is done.
 *
 * Deliberately spares AI agent sessions (claude, codex, …) and everything
 * they spawned: agents are cleaned up through their own lifecycle (herdr),
 * never SIGKILL. Shells and .app bundle processes are spared for the same
 * reason the system scanner ignores them — they're the user's, not workload.
 *
 * Kill semantics mirror the tray's: SIGTERM the whole set immediately, then
 * escalate survivors to SIGKILL after 5s. The escalation timer never blocks
 * the caller — parking proceeds while stragglers wind down.
 */

import { execSync } from "child_process";

import { lazyChildLogger } from "../daemon-logger.ts";
import { parseLsofCwdMap, parsePackageScripts } from "./system-process-scanner.ts";

const log = lazyChildLogger("worktree-kill");

const ESCALATE_AFTER_MS = 5_000;

const SHELL_BINS = new Set(["zsh", "bash", "fish", "sh"]);
const INTERPRETER_BINS = new Set(["node", "bun", "deno", "python", "python3"]);
const DEFAULT_AI_AGENT_NAMES = new Set([
  "claude", "codex", "gemini", "aider", "cursor-agent", "copilot",
]);

export interface KillCandidate {
  pid: number;
  ppid: number;
  command: string;
  fullCommand: string;
}

export interface KillTargetOptions {
  /** Extra binary names to protect, in addition to the built-in AI agents. */
  aiAgentNames?: string[];
  /** Pids to protect (with their descendants), e.g. the calling CLI process. */
  protectedPids?: number[];
}

function basename(path: string): string {
  return path.split("/").pop() ?? path;
}

/** The names a process answers to: comm, argv0 basename, and — when argv0 is
 *  an interpreter — the basename of the script it runs. */
function processNames(proc: KillCandidate): string[] {
  const argv = proc.fullCommand.split(" ");
  const names = [proc.command, basename(argv[0] ?? "")];
  if (INTERPRETER_BINS.has(names[1]!) && argv[1]) {
    names.push(basename(argv[1]));
  }
  return names;
}

/**
 * Pids belonging to AI agent sessions (claude, codex, …) plus everything they
 * spawned, following live ppid links. Once an agent exits its orphans get
 * reparented to pid 1, so leftovers from dead sessions are no longer covered.
 */
export function agentSessionPids(
  rows: KillCandidate[],
  opts: KillTargetOptions = {},
): Set<number> {
  const aiNames = new Set([...DEFAULT_AI_AGENT_NAMES, ...(opts.aiAgentNames ?? [])]);

  // Roots of protection: AI agent processes and explicitly protected pids.
  const protectedRoots = new Set(opts.protectedPids ?? []);
  for (const proc of rows) {
    if (processNames(proc).some(n => aiNames.has(n))) {
      protectedRoots.add(proc.pid);
    }
  }

  // Extend protection to every descendant so we never yank a subprocess out
  // from under a live agent mid-task.
  const childrenByPpid = new Map<number, number[]>();
  for (const proc of rows) {
    const siblings = childrenByPpid.get(proc.ppid) ?? [];
    siblings.push(proc.pid);
    childrenByPpid.set(proc.ppid, siblings);
  }
  const protectedPids = new Set<number>();
  const queue = [...protectedRoots];
  while (queue.length > 0) {
    const pid = queue.pop()!;
    if (protectedPids.has(pid)) continue;
    protectedPids.add(pid);
    queue.push(...(childrenByPpid.get(pid) ?? []));
  }
  return protectedPids;
}

export function selectKillTargets(
  rows: KillCandidate[],
  opts: KillTargetOptions = {},
): KillCandidate[] {
  const protectedPids = agentSessionPids(rows, opts);

  return rows.filter(proc => {
    if (protectedPids.has(proc.pid)) return false;
    if (proc.fullCommand.includes(".app/Contents/")) return false;
    if (SHELL_BINS.has(proc.command) || SHELL_BINS.has(basename(proc.fullCommand.split(" ")[0] ?? ""))) return false;
    return true;
  });
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export interface WorktreeKillResult {
  terminated: { pid: number; label: string }[];
}

/**
 * Find and terminate the workload processes whose cwd is inside the worktree.
 * Discovery is done fresh (not from the scanner's 10s-old snapshot) so we act
 * on ground truth at park time.
 */
export function killWorktreeProcesses(worktreePath: string): WorktreeKillResult {
  let lsofOut: string;
  try {
    lsofOut = execSync("lsof -d cwd -Fpn 2>/dev/null", {
      encoding: "utf8", stdio: "pipe", timeout: 10000,
    });
  } catch (err) {
    log.warn({ err, worktreePath }, "lsof failed; skipping worktree process kill");
    return { terminated: [] };
  }

  const cwdMap = parseLsofCwdMap(lsofOut, [worktreePath]);
  // Drop close-parent matches (parseLsofCwdMap keeps them for scanner display;
  // a process merely *above* the worktree must not be killed).
  for (const [pid, cwd] of cwdMap) {
    if (cwd !== worktreePath && !cwd.startsWith(worktreePath + "/")) cwdMap.delete(pid);
  }
  if (cwdMap.size === 0) return { terminated: [] };

  const pidList = [...cwdMap.keys()].join(",");
  const rows: KillCandidate[] = [];
  try {
    const psOut = execSync(`ps -p ${pidList} -o pid=,ppid=,comm=,args= 2>/dev/null`, {
      encoding: "utf8", stdio: "pipe", timeout: 5000,
    });
    for (const line of psOut.split("\n")) {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)/);
      if (!match) continue;
      rows.push({
        pid: parseInt(match[1]!, 10),
        ppid: parseInt(match[2]!, 10),
        command: basename(match[3]!),
        fullCommand: match[4]!,
      });
    }
  } catch (err) {
    log.warn({ err, worktreePath }, "ps failed; skipping worktree process kill");
    return { terminated: [] };
  }

  const targets = selectKillTargets(rows, {
    protectedPids: [process.pid, process.ppid],
  });
  if (targets.length === 0) return { terminated: [] };

  // Label with the package-script invocation when known — that's the name the
  // developer recognizes ("pnpm start:lite:watch", not "node").
  let scripts = new Map<number, string>();
  try {
    const ewwOut = execSync(`ps eww -o pid=,command= -p ${targets.map(t => t.pid).join(",")} 2>/dev/null`, {
      encoding: "utf8", stdio: "pipe", timeout: 5000, maxBuffer: 32 * 1024 * 1024,
    });
    scripts = parsePackageScripts(ewwOut);
  } catch { /* labels fall back to comm */ }

  const terminated: { pid: number; label: string }[] = [];
  for (const target of targets) {
    try {
      process.kill(target.pid, "SIGTERM");
      terminated.push({ pid: target.pid, label: scripts.get(target.pid) ?? target.command });
    } catch { /* already gone */ }
  }

  if (terminated.length > 0) {
    log.info(
      { worktreePath, terminated },
      `terminated ${terminated.length} worktree process(es): ${terminated.map(t => t.label).join(", ")}`,
    );

    const timer = setTimeout(() => {
      const survivors = terminated.filter(t => isAlive(t.pid));
      for (const survivor of survivors) {
        try { process.kill(survivor.pid, "SIGKILL"); } catch { /* raced exit */ }
      }
      if (survivors.length > 0) {
        log.warn({ worktreePath, survivors }, `escalated ${survivors.length} survivor(s) to SIGKILL`);
      }
    }, ESCALATE_AFTER_MS);
    timer.unref?.();
  }

  return { terminated };
}
