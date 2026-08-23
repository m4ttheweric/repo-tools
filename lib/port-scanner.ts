/**
 * Port scanner — discovers listening TCP ports and matches them to known repos/worktrees.
 *
 * Used by both the daemon (cached scan every 30s) and the CLI fallback (on-demand).
 * Scans via lsof, resolves process CWD, matches against the repo index and
 * worktree map, and filters out macOS GUI app processes.
 *
 * All subprocess work is async and batched (one ps/lsof call for every pid,
 * not one per pid) — the daemon runs this on a timer, and a synchronous scan
 * would freeze the event loop long enough to time out status polls.
 */

import { existsSync } from "fs";
import { homedir } from "os";
import { loadRepoIndex as loadRepoIndexFromStore } from "./repo-index.ts";
import { runCapture } from "./subprocess.ts";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface PortEntry {
  port: number;
  pid: number;
  command: string;
  cwd: string;
  /** Matched repo name (or null if unmatched) */
  repo: string | null;
  /** Matched worktree path (or null) */
  worktree: string | null;
  /** Worktree branch (or null) */
  branch: string | null;
  /** CWD relative to the worktree root (e.g. "apps/backend") */
  relativeDir: string;
  /** Process uptime string from ps */
  uptime: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Parse a ps `etime` string to milliseconds. ps emits the coarsest form that
 * fits: "MM:SS", "HH:MM:SS", or "DD-HH:MM:SS". Returns null for the scanner's
 * "unknown" placeholder and anything else unrecognized, so callers can tell
 * "not running long" from "we could not read the clock".
 */
export function parseEtimeMs(etime: string): number | null {
  const m = etime.trim().match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!m) return null;
  const [, days, hours, minutes, seconds] = m;
  return (
    (parseInt(days ?? "0", 10) * 86_400 +
      parseInt(hours ?? "0", 10) * 3_600 +
      parseInt(minutes!, 10) * 60 +
      parseInt(seconds!, 10)) * 1000
  );
}

/** Thin re-export so this module's existing callers keep working unchanged. */
export function loadRepoIndex(): Record<string, string> {
  return loadRepoIndexFromStore();
}

// ─── Pure parsers ────────────────────────────────────────────────────────────

export interface ListeningProcess {
  command: string;
  pid: number;
  port: number;
}

/** Parse `lsof -iTCP -sTCP:LISTEN -P -n` output, deduplicated by pid:port. */
export function parseListeningLsof(output: string): ListeningProcess[] {
  const lines = output.trim().split("\n").filter(Boolean);
  if (lines.length <= 1) return []; // header only

  const seen = new Set<string>();
  const results: ListeningProcess[] = [];
  for (const line of lines.slice(1)) {
    const parts = line.split(/\s+/);
    const command = parts[0] || "unknown";
    const pid = parseInt(parts[1] || "0", 10);
    if (!pid) continue;

    // Parse port — handles both IPv4 (*:3000) and IPv6 ([::1]:4001 (LISTEN))
    const portMatch = line.match(/:(\d+)\s+\(LISTEN\)/);
    if (!portMatch) continue;
    const port = parseInt(portMatch[1]!, 10);

    const key = `${pid}:${port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({ command, pid, port });
  }
  return results;
}

/**
 * Parse `ps -o pid=,<col>= -p ...` output into a pid → value map. The value
 * is everything after the pid, so columns with spaces (comm paths) survive.
 */
export function parsePidValueMap(output: string): Map<number, string> {
  const map = new Map<number, string>();
  for (const line of output.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(.*)/);
    if (!match) continue;
    map.set(parseInt(match[1]!, 10), match[2]!.trim());
  }
  return map;
}

/** Parse `lsof -Fpn` p/n field pairs into a pid → cwd map. */
export function parseCwdMap(output: string): Map<number, string> {
  const map = new Map<number, string>();
  let currentPid = 0;
  for (const line of output.split("\n")) {
    if (line.startsWith("p")) {
      currentPid = parseInt(line.slice(1), 10);
    } else if (line.startsWith("n/") && currentPid > 0) {
      map.set(currentPid, line.slice(1));
    }
  }
  return map;
}

/** Parse `git worktree list --porcelain` output into path/branch pairs. */
export function parseWorktreePorcelain(output: string): Array<{ path: string; branch: string }> {
  const results: Array<{ path: string; branch: string }> = [];
  let currentPath = "";
  let currentBranch = "";
  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (currentPath && currentBranch) {
        results.push({ path: currentPath, branch: currentBranch });
      }
      currentPath = line.replace("worktree ", "").trim();
      currentBranch = "";
    } else if (line.startsWith("branch ")) {
      currentBranch = line.replace("branch refs/heads/", "").trim();
    }
  }
  if (currentPath && currentBranch) {
    results.push({ path: currentPath, branch: currentBranch });
  }
  return results;
}

/**
 * Build a worktree map from the repo index: worktree path → { repo, branch }.
 * Repos are listed concurrently.
 */
export async function buildWorktreeMap(
  repos: Record<string, string>,
): Promise<Map<string, { repo: string; branch: string }>> {
  const perRepo = await Promise.all(
    Object.entries(repos)
      .filter(([, repoPath]) => existsSync(repoPath))
      .map(async ([repoName, repoPath]) => {
        const { stdout, exitCode } = await runCapture(
          ["git", "worktree", "list", "--porcelain"],
          { cwd: repoPath, timeoutMs: 5000 },
        );
        if (exitCode !== 0) return [];
        return parseWorktreePorcelain(stdout).map(
          (w) => [w.path, { repo: repoName, branch: w.branch }] as const,
        );
      }),
  );
  return new Map(perRepo.flat());
}

export function matchCwdToRepo(
  cwd: string,
  repos: Record<string, string>,
  worktreeMap: Map<string, { repo: string; branch: string }>,
): { repo: string | null; worktree: string | null; branch: string | null; relativeDir: string } {
  // Try worktree match first (more specific)
  for (const [wtPath, info] of worktreeMap) {
    if (cwd === wtPath || cwd.startsWith(wtPath + "/")) {
      const relativeDir = cwd === wtPath ? "." : cwd.slice(wtPath.length + 1);
      return { repo: info.repo, worktree: wtPath, branch: info.branch, relativeDir };
    }
  }

  // Fall back to repo root match
  for (const [repoName, repoPath] of Object.entries(repos)) {
    if (cwd === repoPath || cwd.startsWith(repoPath + "/")) {
      const relativeDir = cwd === repoPath ? "." : cwd.slice(repoPath.length + 1);
      return { repo: repoName, worktree: repoPath, branch: null, relativeDir };
    }
  }

  // Check if cwd is a close parent of any repo (max 2 levels above)
  let closestParent: { name: string; depth: number } | null = null;
  for (const [repoName, repoPath] of Object.entries(repos)) {
    if (repoPath.startsWith(cwd + "/")) {
      const depth = repoPath.slice(cwd.length + 1).split("/").length;
      if (depth <= 2 && (!closestParent || depth < closestParent.depth)) {
        closestParent = { name: repoName, depth };
      }
    }
  }
  if (closestParent) {
    return { repo: closestParent.name, worktree: null, branch: null, relativeDir: "(parent)" };
  }

  return { repo: null, worktree: null, branch: null, relativeDir: cwd };
}

// ─── Scanner ─────────────────────────────────────────────────────────────────

/**
 * Scan all listening TCP ports on the system, match against known repos/worktrees,
 * and return entries sorted by repo → worktree → port.
 *
 * Filters out macOS GUI app processes (Cursor, Zed, etc.) and only returns
 * ports whose process CWD matches a known repo.
 */
export async function scanListeningPorts(): Promise<PortEntry[]> {
  const repos = loadRepoIndex();
  if (Object.keys(repos).length === 0) return [];

  const [worktreeMap, listenersRes] = await Promise.all([
    buildWorktreeMap(repos),
    runCapture(["lsof", "-iTCP", "-sTCP:LISTEN", "-P", "-n"], { timeoutMs: 10_000 }),
  ]);

  const listeners = parseListeningLsof(listenersRes.stdout);
  if (listeners.length === 0) return [];

  const pidList = [...new Set(listeners.map((l) => l.pid))].join(",");
  const [commRes, etimeRes, cwdRes] = await Promise.all([
    runCapture(["ps", "-o", "pid=,comm=", "-p", pidList], { timeoutMs: 5000 }),
    runCapture(["ps", "-o", "pid=,etime=", "-p", pidList], { timeoutMs: 5000 }),
    runCapture(["lsof", "-a", "-p", pidList, "-d", "cwd", "-Fpn"], { timeoutMs: 10_000 }),
  ]);
  const commMap = parsePidValueMap(commRes.stdout);
  const etimeMap = parsePidValueMap(etimeRes.stdout);
  const cwdMap = parseCwdMap(cwdRes.stdout);

  const entries: PortEntry[] = [];
  for (const { command, pid, port } of listeners) {
    // Skip macOS GUI apps (Cursor, Zed, etc.) — they listen on ports for IPC
    if ((commMap.get(pid) ?? "").includes(".app/Contents/")) continue;

    const cwd = cwdMap.get(pid);
    if (!cwd) continue;

    const match = matchCwdToRepo(cwd, repos, worktreeMap);
    // Only include ports that match a known repo
    if (!match.repo) continue;

    entries.push({
      port,
      pid,
      command,
      cwd,
      repo: match.repo,
      worktree: match.worktree,
      branch: match.branch,
      relativeDir: match.relativeDir,
      uptime: etimeMap.get(pid) || "unknown",
    });
  }

  return entries.sort((a, b) => {
    // Sort by repo, then worktree, then port
    if (a.repo !== b.repo) return (a.repo || "").localeCompare(b.repo || "");
    if (a.worktree !== b.worktree) return (a.worktree || "").localeCompare(b.worktree || "");
    return a.port - b.port;
  });
}
