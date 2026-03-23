#!/usr/bin/env bun

/**
 * rt kill-port — Kill orphaned processes on known ports.
 *
 * Scans ports defined in ~/.rt/<repo>/config.json with a small range
 * to catch auto-bumped instances. Interactive TUI for selecting processes to kill.
 */

import { execSync } from "child_process";
import { bold, cyan, dim, green, yellow, red, reset } from "../lib/tui.ts";
import { getRepoIdentity, loadRepoConfig } from "../lib/repo.ts";

// ─── Types ───────────────────────────────────────────────────────────────────

interface ProcessInfo {
  command: string;
  pid: string;
  user: string;
  port: number;
}

const PORT_RANGE = 5;

// ─── Port scanning ──────────────────────────────────────────────────────────

function getProcessesOnPort(port: number): ProcessInfo[] {
  try {
    const output = execSync(`lsof -i :${port} -P -n 2>/dev/null`, {
      encoding: "utf8",
      stdio: "pipe",
    });
    const lines = output.trim().split("\n").filter(Boolean);
    if (lines.length <= 1) return [];

    return lines.slice(1).map((line) => {
      const parts = line.split(/\s+/);
      return {
        command: parts[0] || "unknown",
        pid: parts[1] || "0",
        user: parts[2] || "unknown",
        port,
      };
    });
  } catch {
    return [];
  }
}

function timeRunning(pid: string): string {
  try {
    const output = execSync(`ps -p ${pid} -o etime= 2>/dev/null`, {
      encoding: "utf8",
      stdio: "pipe",
    }).trim();
    return output || "unknown";
  } catch {
    return "unknown";
  }
}

// ─── Entry ───────────────────────────────────────────────────────────────────

export async function run(args: string[]): Promise<void> {
  // Ad-hoc mode: rt kill-port 8080
  if (args.length > 0 && /^\d+$/.test(args[0] || "")) {
    const port = parseInt(args[0]!, 10);
    const procs = getProcessesOnPort(port);
    if (procs.length === 0) {
      console.log(`\n  ${dim}no processes on port ${port}${reset}\n`);
      return;
    }
    for (const proc of procs) {
      try {
        execSync(`kill -9 ${proc.pid}`);
        console.log(`  ${green}killed${reset} ${proc.command} (pid ${proc.pid}) on :${port}`);
      } catch {
        console.log(`  ${red}failed to kill${reset} pid ${proc.pid}`);
      }
    }
    return;
  }

  const identity = getRepoIdentity();
  let repoName: string;
  let ports: Record<string, number>;

  if (identity) {
    repoName = identity.repoName;
    const config = loadRepoConfig(identity.dataDir);
    ports = config.ports;
  } else {
    repoName = "all repos";
    ports = {};
    const { getKnownRepos } = await import("../lib/repo.ts");
    const repos = getKnownRepos();
    for (const repo of repos) {
      const config = loadRepoConfig(repo.dataDir);
      for (const [name, port] of Object.entries(config.ports)) {
        ports[`${repo.repoName}/${name}`] = port;
      }
    }
  }

  if (Object.keys(ports).length === 0) {
    console.log(`\n  ${yellow}no known ports configured${reset}`);
    if (identity) {
      console.log(`  ${dim}add ports to ~/.rt/${identity.repoName}/config.json${reset}`);
    } else {
      console.log(`  ${dim}run rt from inside a git repo first to register it${reset}`);
    }
    console.log("");
    process.exit(1);
  }

  console.log(`\n  ${dim}scanning known ports...${reset}`);

  const flatProcesses: { label: string; proc: ProcessInfo; bumped: boolean }[] = [];

  for (const [name, basePort] of Object.entries(ports)) {
    const found: { proc: ProcessInfo; bumped: boolean }[] = [];

    for (let offset = 0; offset <= PORT_RANGE; offset++) {
      const port = basePort + offset;
      const procs = getProcessesOnPort(port);
      for (const proc of procs) {
        if (!found.some((f) => f.proc.pid === proc.pid)) {
          found.push({ proc, bumped: offset > 0 });
        }
      }
    }

    if (found.length > 0) {
      for (const f of found) {
        flatProcesses.push({ label: `● ${name}`, ...f });
      }
    }
  }

  if (flatProcesses.length === 0) {
    console.log(`\n  ${green}${bold}✓ all ports clear${reset}\n`);
    return;
  }

  if (!process.stdin.isTTY) {
    for (const { label, proc } of flatProcesses) {
      console.log(`  ${label}  :${proc.port}  ${proc.command} (pid ${proc.pid})`);
    }
    return;
  }

  console.log(`\n  ${bold}${cyan}rt kill-port${reset}  ${dim}(${repoName})${reset}\n`);

  const { multiselect } = await import("../lib/rt-render.tsx");

  const selectedPids = await multiselect({
    message: "Select processes to kill",
    options: flatProcesses.map(({ label, proc, bumped }) => {
      const portStr = bumped ? `[bumped] :${proc.port}` : `:${proc.port}`;
      const elapsed = timeRunning(proc.pid);
      return {
        value: proc.pid,
        label: `${label}  ${portStr}  ${proc.command} (pid ${proc.pid})`,
        hint: `started ${elapsed} ago`,
      };
    }),
  });

  if (selectedPids.length === 0) {
    console.log(`\n  ${dim}nothing selected${reset}\n`);
    return;
  }

  console.log("");
  for (const pid of selectedPids) {
    const proc = flatProcesses.find((f) => f.proc.pid === pid);
    if (!proc) continue;
    try {
      execSync(`kill -9 ${pid}`);
      console.log(`  ${green}killed${reset} ${proc.proc.command} (pid ${pid}) on :${proc.proc.port}`);
    } catch {
      console.log(`  ${red}failed to kill${reset} pid ${pid}`);
    }
  }
  console.log("");
}
