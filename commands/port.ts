/**
 * rt port — Zero-config port scanner + killer.
 *
 * Usage:
 *   rt port          show all listening ports for known repos (daemon-first)
 *   rt port scan     same as bare `rt port`
 *   rt port kill     interactive kill picker
 *   rt port 8080     ad-hoc kill processes on port 8080
 *
 * Queries the daemon's cached port scan for instant results.
 * Falls back to direct lsof scan when daemon is not running.
 */

import { execSync } from "child_process";
import { bold, cyan, dim, green, yellow, red, reset } from "../lib/tui.ts";
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

// ─── Types ───────────────────────────────────────────────────────────────────

interface PortEntry {
  port: number;
  pid: number;
  command: string;
  cwd: string;
  repo: string | null;
  worktree: string | null;
  branch: string | null;
  relativeDir: string;
  uptime: string;
}

// ─── Direct scanner (fallback when daemon is not running) ────────────────────

function directScan(): PortEntry[] {
  // Load repo index
  const reposJsonPath = join(homedir(), ".rt", "repos.json");
  let repos: Record<string, string> = {};
  try {
    repos = JSON.parse(readFileSync(reposJsonPath, "utf8"));
  } catch {
    return [];
  }

  if (Object.keys(repos).length === 0) return [];

  // Build worktree map
  const worktreeMap = new Map<string, { repo: string; branch: string }>();
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
            worktreeMap.set(currentPath, { repo: repoName, branch: currentBranch });
          }
          currentPath = line.replace("worktree ", "").trim();
          currentBranch = "";
        } else if (line.startsWith("branch ")) {
          currentBranch = line.replace("branch refs/heads/", "").trim();
        }
      }
      if (currentPath && currentBranch) {
        worktreeMap.set(currentPath, { repo: repoName, branch: currentBranch });
      }
    } catch { /* skip */ }
  }

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
  if (lines.length <= 1) return [];

  const seen = new Set<string>();
  const appBundlePids = new Map<number, boolean>();
  const entries: PortEntry[] = [];

  for (const line of lines.slice(1)) {
    const parts = line.split(/\s+/);
    const command = parts[0] || "unknown";
    const pid = parseInt(parts[1] || "0", 10);
    if (!pid) continue;

    // Parse port from NAME column — handles both IPv4 (*:3000) and IPv6 ([::1]:4001 (LISTEN))
    const portMatch = line.match(/:(\d+)\s+\(LISTEN\)/);
    if (!portMatch) continue;
    const port = parseInt(portMatch[1]!, 10);

    const key = `${pid}:${port}`;
    if (seen.has(key)) continue;
    seen.add(key);

    // Skip macOS GUI apps (Cursor, Zed, etc.) — they listen on ports for IPC
    if (!appBundlePids.has(pid)) {
      try {
        const comm = execSync(`ps -p ${pid} -o comm= 2>/dev/null`, {
          encoding: "utf8", stdio: "pipe", timeout: 2000,
        }).trim();
        appBundlePids.set(pid, comm.includes(".app/Contents/"));
      } catch {
        appBundlePids.set(pid, false);
      }
    }
    if (appBundlePids.get(pid)) continue;

    // Resolve CWD
    let cwd: string | null = null;
    try {
      const cwdOutput = execSync(`lsof -a -p ${pid} -d cwd -Fn 2>/dev/null`, {
        encoding: "utf8", stdio: "pipe", timeout: 3000,
      });
      for (const l of cwdOutput.split("\n")) {
        if (l.startsWith("n") && l.length > 1 && l[1] === "/") {
          cwd = l.slice(1);
          break;
        }
      }
    } catch { /* skip */ }
    if (!cwd) continue;

    // Match to repo/worktree
    let repo: string | null = null;
    let worktree: string | null = null;
    let branch: string | null = null;
    let relativeDir = cwd;

    for (const [wtPath, info] of worktreeMap) {
      if (cwd === wtPath || cwd.startsWith(wtPath + "/")) {
        repo = info.repo;
        worktree = wtPath;
        branch = info.branch;
        relativeDir = cwd === wtPath ? "." : cwd.slice(wtPath.length + 1);
        break;
      }
    }

    if (!repo) {
      for (const [repoName, repoPath] of Object.entries(repos)) {
        if (cwd === repoPath || cwd.startsWith(repoPath + "/")) {
          repo = repoName;
          worktree = repoPath;
          relativeDir = cwd === repoPath ? "." : cwd.slice(repoPath.length + 1);
          break;
        }
      }
    }

    if (!repo) continue;

    let uptime = "unknown";
    try {
      uptime = execSync(`ps -p ${pid} -o etime= 2>/dev/null`, {
        encoding: "utf8", stdio: "pipe", timeout: 2000,
      }).trim() || "unknown";
    } catch { /* skip */ }

    entries.push({ port, pid, command, cwd, repo, worktree, branch, relativeDir, uptime });
  }

  return entries.sort((a, b) => {
    if (a.repo !== b.repo) return (a.repo || "").localeCompare(b.repo || "");
    if (a.worktree !== b.worktree) return (a.worktree || "").localeCompare(b.worktree || "");
    return a.port - b.port;
  });
}

// ─── Fetch port data (daemon-first, fallback to direct scan) ─────────────────

async function getPortData(): Promise<{ entries: PortEntry[]; source: "daemon" | "direct" }> {
  const { daemonQuery } = await import("../lib/daemon-client.ts");
  const result = await daemonQuery("ports");

  if (result?.ok && result.data?.ports) {
    return { entries: result.data.ports as PortEntry[], source: "daemon" };
  }

  // Fallback to direct scan
  console.log(`  ${dim}(daemon not available, scanning directly...)${reset}`);
  return { entries: directScan(), source: "direct" };
}

// ─── Display ─────────────────────────────────────────────────────────────────

function formatUptime(etime: string): string {
  // ps etime format: [[dd-]hh:]mm:ss
  const trimmed = etime.trim();
  if (!trimmed || trimmed === "unknown") return "?";

  // Parse into a human-friendly string
  const parts = trimmed.split(/[-:]/);
  if (parts.length === 2) {
    const mins = parseInt(parts[0]!, 10);
    if (mins === 0) return `${parts[1]}s`;
    return `${mins}m`;
  }
  if (parts.length === 3) {
    if (trimmed.includes("-")) {
      // dd-hh:mm
      return `${parts[0]}d`;
    }
    const hours = parseInt(parts[0]!, 10);
    const mins = parseInt(parts[1]!, 10);
    if (hours === 0) return `${mins}m`;
    return `${hours}h${mins > 0 ? `${mins}m` : ""}`;
  }
  if (parts.length === 4) {
    // dd-hh:mm:ss
    return `${parts[0]}d`;
  }
  return trimmed;
}

function displayPorts(entries: PortEntry[]): void {
  if (entries.length === 0) {
    console.log(`\n  ${green}${bold}✓ no listening ports for known repos${reset}\n`);
    return;
  }

  // Group by repo → worktree
  const grouped = new Map<string, Map<string, PortEntry[]>>();
  for (const entry of entries) {
    const repoKey = entry.repo || "unknown";
    if (!grouped.has(repoKey)) grouped.set(repoKey, new Map());
    const wtKey = entry.worktree || "unknown";
    const wtMap = grouped.get(repoKey)!;
    if (!wtMap.has(wtKey)) wtMap.set(wtKey, []);
    wtMap.get(wtKey)!.push(entry);
  }

  console.log("");
  for (const [repoName, worktrees] of grouped) {
    console.log(`  ${bold}${cyan}${repoName}${reset}`);

    for (const [_wtPath, ports] of worktrees) {
      const branchName = ports[0]?.branch;
      if (branchName) {
        console.log(`    ${dim}${branchName}${reset}`);
      }

      for (const p of ports) {
        const portStr = `:${p.port}`.padEnd(7);
        const dirStr = p.relativeDir.padEnd(20);
        const cmdStr = p.command.padEnd(8);
        const uptimeStr = formatUptime(p.uptime);
        console.log(`      ${yellow}${portStr}${reset} ${dirStr} ${dim}${cmdStr}${reset} ${dim}(${uptimeStr})${reset}`);
      }
    }
    console.log("");
  }
}

// ─── Entry ───────────────────────────────────────────────────────────────────

export async function portScanner(args: string[]): Promise<void> {
  // Ad-hoc kill mode: rt port 8080
  if (args.length > 0 && /^\d+$/.test(args[0] || "")) {
    const port = parseInt(args[0]!, 10);
    try {
      const output = execSync(`lsof -i :${port} -P -n 2>/dev/null`, {
        encoding: "utf8", stdio: "pipe",
      });
      const lines = output.trim().split("\n").filter(Boolean);
      if (lines.length <= 1) {
        console.log(`\n  ${dim}no processes on port ${port}${reset}\n`);
        return;
      }
      const pids = new Set<string>();
      for (const line of lines.slice(1)) {
        const pid = line.split(/\s+/)[1];
        if (pid) pids.add(pid);
      }
      for (const pid of pids) {
        try {
          execSync(`kill -9 ${pid}`);
          console.log(`  ${green}killed${reset} pid ${pid} on :${port}`);
        } catch {
          console.log(`  ${red}failed to kill${reset} pid ${pid}`);
        }
      }
    } catch {
      console.log(`\n  ${dim}no processes on port ${port}${reset}\n`);
    }
    return;
  }

  // Subcommand: rt port kill → jump to interactive kill picker
  if (args[0] === "kill") {
    return portKillPicker(args.slice(1));
  }

  // Default: scan and display
  const { entries } = await getPortData();

  if (entries.length === 0) {
    console.log(`\n  ${green}${bold}✓ no listening ports for known repos${reset}\n`);
    return;
  }

  // Non-TTY: print and exit
  if (!process.stdin.isTTY) {
    displayPorts(entries);
    return;
  }

  // TTY: display then offer kill picker
  displayPorts(entries);

  const { filterableMultiselect } = await import("../lib/rt-render.tsx");

  const selectedPids = await filterableMultiselect({
    message: "Select processes to kill (or esc to exit)",
    options: entries.map((p) => {
      const uptimeStr = formatUptime(p.uptime);
      return {
        value: String(p.pid),
        label: `${yellow}:${p.port}${reset}  ${p.relativeDir}  ${dim}${p.command}${reset}`,
        hint: `${p.repo}${p.branch ? ` \u00b7 ${p.branch}` : ""} \u00b7 ${uptimeStr}`,
      };
    }),
  });

  if (selectedPids.length === 0) {
    console.log(`\n  ${dim}nothing selected${reset}\n`);
    return;
  }

  console.log("");
  for (const pid of selectedPids) {
    const entry = entries.find((p) => String(p.pid) === pid);
    if (!entry) continue;
    try {
      execSync(`kill -9 ${pid}`);
      console.log(`  ${green}killed${reset} ${entry.command} (pid ${pid}) on :${entry.port}`);
    } catch {
      console.log(`  ${red}failed to kill${reset} pid ${pid}`);
    }
  }
  console.log("");
}

async function portKillPicker(args: string[]): Promise<void> {
  // rt port kill 8080 → ad-hoc
  if (args.length > 0 && /^\d+$/.test(args[0] || "")) {
    return portScanner(args);
  }

  const { entries } = await getPortData();

  if (entries.length === 0) {
    console.log(`\n  ${green}${bold}✓ no listening ports for known repos${reset}\n`);
    return;
  }

  if (!process.stdin.isTTY) {
    displayPorts(entries);
    return;
  }

  const { filterableMultiselect } = await import("../lib/rt-render.tsx");

  const selectedPids = await filterableMultiselect({
    message: "Select processes to kill (or esc to exit)",
    options: entries.map((p) => {
      const uptimeStr = formatUptime(p.uptime);
      return {
        value: String(p.pid),
        label: `${yellow}:${p.port}${reset}  ${p.relativeDir}  ${dim}${p.command}${reset}`,
        hint: `${p.repo}${p.branch ? ` \u00b7 ${p.branch}` : ""} \u00b7 ${uptimeStr}`,
      };
    }),
  });

  if (selectedPids.length === 0) {
    console.log(`\n  ${dim}nothing selected${reset}\n`);
    return;
  }

  console.log("");
  for (const pid of selectedPids) {
    const entry = entries.find((p) => String(p.pid) === pid);
    if (!entry) continue;
    try {
      execSync(`kill -9 ${pid}`);
      console.log(`  ${green}killed${reset} ${entry.command} (pid ${pid}) on :${entry.port}`);
    } catch {
      console.log(`  ${red}failed to kill${reset} pid ${pid}`);
    }
  }
  console.log("");
}

