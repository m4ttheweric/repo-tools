/**
 * rt port — Zero-config port scanner + killer.
 *
 * Usage:
 *   rt port          show all listening ports for known repos (daemon-first)
 *   rt port kill     interactive kill picker
 *   rt port 8080     ad-hoc kill processes on port 8080
 *
 * Queries the daemon's cached port scan for instant results.
 * Falls back to direct lsof scan when daemon is not running.
 */

import { execSync } from "child_process";
import { bold, cyan, dim, green, yellow, red, reset } from "../lib/tui.ts";
import { scanListeningPorts, type PortEntry } from "../lib/port-scanner.ts";

// ─── Data fetching ───────────────────────────────────────────────────────────

async function getPortData(): Promise<{ entries: PortEntry[]; source: "daemon" | "direct" }> {
  const { daemonQuery } = await import("../lib/daemon-client.ts");
  const result = await daemonQuery("ports");

  if (result?.ok && result.data?.ports) {
    return { entries: result.data.ports as PortEntry[], source: "daemon" };
  }

  // Fallback to direct scan
  console.log(`  ${dim}(daemon not available, scanning directly...)${reset}`);
  return { entries: scanListeningPorts(), source: "direct" };
}

// ─── Display ─────────────────────────────────────────────────────────────────

/**
 * Build a human-readable path starting from the worktree/repo folder name.
 * e.g. "my-repo-wktree-2/apps/adjuster" or "my-repo/."
 */
function folderPath(entry: PortEntry): string {
  const { basename } = require("path") as typeof import("path");
  const wtName = entry.worktree ? basename(entry.worktree) : (entry.repo ?? "unknown");
  return entry.relativeDir && entry.relativeDir !== "." ? `${wtName}/${entry.relativeDir}` : wtName;
}

function formatUptime(etime: string): string {
  const trimmed = etime.trim();
  if (!trimmed || trimmed === "unknown") return "?";

  const parts = trimmed.split(/[-:]/);
  if (parts.length === 2) {
    const mins = parseInt(parts[0]!, 10);
    if (mins === 0) return `${parts[1]}s`;
    return `${mins}m`;
  }
  if (parts.length === 3) {
    if (trimmed.includes("-")) return `${parts[0]}d`;
    const hours = parseInt(parts[0]!, 10);
    const mins = parseInt(parts[1]!, 10);
    if (hours === 0) return `${mins}m`;
    return `${hours}h${mins > 0 ? `${mins}m` : ""}`;
  }
  if (parts.length === 4) return `${parts[0]}d`;
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
        const dirStr = folderPath(p).padEnd(30);
        const cmdStr = p.command.padEnd(8);
        const uptimeStr = formatUptime(p.uptime);
        console.log(`      ${yellow}${portStr}${reset} ${dirStr} ${dim}${cmdStr}${reset} ${dim}(${uptimeStr})${reset}`);
      }
    }
    console.log("");
  }
}

// ─── Kill helpers ────────────────────────────────────────────────────────────

function killByPort(port: number): void {
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
}

async function showKillPicker(entries: PortEntry[]): Promise<void> {
  const { filterableMultiselect } = await import("../lib/rt-render.tsx");

  const selectedPids = await filterableMultiselect({
    message: "Select processes to kill (or esc to exit)",
    options: entries.map((p) => {
      const uptimeStr = formatUptime(p.uptime);
      return {
        value: String(p.pid),
        label: `${yellow}:${p.port}${reset}  ${folderPath(p)}  ${dim}${p.command}${reset}`,
        hint: `${p.repo}${p.branch ? ` \u00b7 ${p.branch}` : ""} \u00b7 ${uptimeStr}`,
      };
    }),
  });

  if (!selectedPids || selectedPids.length === 0) {
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

// ─── Entry ───────────────────────────────────────────────────────────────────

export async function portScanner(args: string[]): Promise<void> {
  // Ad-hoc kill mode: rt port 8080
  if (args.length > 0 && /^\d+$/.test(args[0] || "")) {
    return killByPort(parseInt(args[0]!, 10));
  }

  // Subcommand: rt port kill → jump to interactive kill picker
  if (args[0] === "kill") {
    const killArgs = args.slice(1);
    if (killArgs.length > 0 && /^\d+$/.test(killArgs[0] || "")) {
      return killByPort(parseInt(killArgs[0]!, 10));
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
    return showKillPicker(entries);
  }

  // Default: scan and display
  const { entries } = await getPortData();

  if (entries.length === 0) {
    console.log(`\n  ${green}${bold}✓ no listening ports for known repos${reset}\n`);
    return;
  }

  // Non-TTY: print table and exit
  if (!process.stdin.isTTY) {
    displayPorts(entries);
    return;
  }

  // TTY: interactive kill picker (already shows port info in options)
  await showKillPicker(entries);
}
