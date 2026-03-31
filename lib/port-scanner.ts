/**
 * Port scanner — discovers listening TCP ports and matches them to known repos/worktrees.
 *
 * Used by both the daemon (cached scan every 30s) and the CLI fallback (on-demand).
 * Scans via lsof, resolves process CWD, matches against the repo index and
 * worktree map, and filters out macOS GUI app processes.
 */

import { execSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

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

const REPOS_JSON_PATH = join(homedir(), ".rt", "repos.json");

export function loadRepoIndex(): Record<string, string> {
  try {
    return JSON.parse(readFileSync(REPOS_JSON_PATH, "utf8"));
  } catch {
    return {};
  }
}

/**
 * Check if a PID belongs to a macOS .app bundle (Cursor, Zed, GitHub Desktop, etc.).
 * GUI apps listen on ports for IPC but aren't dev servers we care about.
 */
function isAppBundleProcess(pid: number): boolean {
  try {
    const comm = execSync(`ps -p ${pid} -o comm= 2>/dev/null`, {
      encoding: "utf8", stdio: "pipe", timeout: 2000,
    }).trim();
    return comm.includes(".app/Contents/");
  } catch {
    return false;
  }
}

function getProcessCwd(pid: number): string | null {
  try {
    const output = execSync(`lsof -a -p ${pid} -d cwd -Fn 2>/dev/null`, {
      encoding: "utf8", stdio: "pipe", timeout: 3000,
    });
    for (const line of output.split("\n")) {
      if (line.startsWith("n") && line.length > 1 && line[1] === "/") {
        return line.slice(1);
      }
    }
    return null;
  } catch {
    return null;
  }
}

function getProcessUptime(pid: number): string {
  try {
    return execSync(`ps -p ${pid} -o etime= 2>/dev/null`, {
      encoding: "utf8", stdio: "pipe", timeout: 2000,
    }).trim() || "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Build a worktree map from the repo index: worktree path → { repo, branch }.
 */
export function buildWorktreeMap(
  repos: Record<string, string>,
): Map<string, { repo: string; branch: string }> {
  const map = new Map<string, { repo: string; branch: string }>();
  for (const [repoName, repoPath] of Object.entries(repos)) {
    if (!existsSync(repoPath)) continue;
    try {
      const output = execSync("git worktree list --porcelain", {
        cwd: repoPath, encoding: "utf8", stdio: "pipe", timeout: 5000,
      });
      let currentPath = "";
      let currentBranch = "";
      for (const line of output.split("\n")) {
        if (line.startsWith("worktree ")) {
          if (currentPath && currentBranch) {
            map.set(currentPath, { repo: repoName, branch: currentBranch });
          }
          currentPath = line.replace("worktree ", "").trim();
          currentBranch = "";
        } else if (line.startsWith("branch ")) {
          currentBranch = line.replace("branch refs/heads/", "").trim();
        }
      }
      if (currentPath && currentBranch) {
        map.set(currentPath, { repo: repoName, branch: currentBranch });
      }
    } catch { /* skip repos that error */ }
  }
  return map;
}

function matchCwdToRepo(
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
export function scanListeningPorts(): PortEntry[] {
  const repos = loadRepoIndex();
  if (Object.keys(repos).length === 0) return [];

  const worktreeMap = buildWorktreeMap(repos);

  // Get all listening TCP ports
  let lsofOutput: string;
  try {
    lsofOutput = execSync("lsof -iTCP -sTCP:LISTEN -P -n 2>/dev/null", {
      encoding: "utf8", stdio: "pipe", timeout: 10000,
    });
  } catch {
    return [];
  }

  const lines = lsofOutput.trim().split("\n").filter(Boolean);
  if (lines.length <= 1) return []; // header only

  // Deduplicate by PID+port, cache app-bundle checks by PID
  const seen = new Set<string>();
  const appBundlePids = new Map<number, boolean>();
  const entries: PortEntry[] = [];

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

    // Skip macOS GUI apps (Cursor, Zed, etc.) — they listen on ports for IPC
    if (!appBundlePids.has(pid)) {
      appBundlePids.set(pid, isAppBundleProcess(pid));
    }
    if (appBundlePids.get(pid)) continue;

    // Resolve CWD and match to repo
    const cwd = getProcessCwd(pid);
    if (!cwd) continue;

    const match = matchCwdToRepo(cwd, repos, worktreeMap);
    // Only include ports that match a known repo
    if (!match.repo) continue;

    const uptime = getProcessUptime(pid);

    entries.push({
      port,
      pid,
      command,
      cwd,
      repo: match.repo,
      worktree: match.worktree,
      branch: match.branch,
      relativeDir: match.relativeDir,
      uptime,
    });
  }

  return entries.sort((a, b) => {
    // Sort by repo, then worktree, then port
    if (a.repo !== b.repo) return (a.repo || "").localeCompare(b.repo || "");
    if (a.worktree !== b.worktree) return (a.worktree || "").localeCompare(b.worktree || "");
    return a.port - b.port;
  });
}
