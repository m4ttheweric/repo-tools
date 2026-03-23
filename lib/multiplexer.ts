/**
 * Multiplexer abstraction for rt x.
 *
 * Launches concurrent commands in zellij, tmux, or inline (concurrent).
 * All implementations use process group tracking for robust cleanup.
 */

import { spawnSync, spawn, type ChildProcess } from "child_process";
import { writeFileSync } from "fs";
import { join } from "path";
import { bold, cyan, dim, green, red, reset, COLOR_PALETTE } from "./tui.ts";

import type { Multiplexer } from "./script-store.ts";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface MuxCommand {
  label: string;
  command: string;
  cwd?: string;
}

export interface MuxResult {
  exitCode: number;
}

// ─── Cleanup registry ────────────────────────────────────────────────────────

const trackedProcesses = new Set<ChildProcess>();
let cleanupRegistered = false;

function registerCleanup(): void {
  if (cleanupRegistered) return;
  cleanupRegistered = true;

  const cleanup = (signal?: string) => {
    // Kill all tracked child processes
    for (const child of trackedProcesses) {
      try {
        if (child.pid && !child.killed) {
          // Send SIGTERM to the process group (negative pid)
          process.kill(-child.pid, "SIGTERM");
        }
      } catch {
        /* already dead */
      }
    }

    // Grace period, then SIGKILL
    if (trackedProcesses.size > 0) {
      setTimeout(() => {
        for (const child of trackedProcesses) {
          try {
            if (child.pid && !child.killed) {
              process.kill(-child.pid, "SIGKILL");
            }
          } catch {
            /* already dead */
          }
        }
        trackedProcesses.clear();
        if (signal) process.exit(1);
      }, 3000);
    }
  };

  process.on("SIGINT", () => cleanup("SIGINT"));
  process.on("SIGTERM", () => cleanup("SIGTERM"));
  process.on("SIGHUP", () => cleanup("SIGHUP"));
  process.on("exit", () => cleanup());
}

function trackProcess(child: ChildProcess): void {
  registerCleanup();
  trackedProcesses.add(child);
  child.on("exit", () => trackedProcesses.delete(child));
}

// ─── Zellij ──────────────────────────────────────────────────────────────────

function launchZellij(commands: MuxCommand[], repoRoot: string): MuxResult {
  const panes = commands
    .map((cmd) => {
      const fullCmd = cmd.cwd
        ? `cd ${join(repoRoot, cmd.cwd)} && ${cmd.command}`
        : cmd.command;
      return `        pane command="sh" name="${cmd.label}" { args "-c" "${fullCmd}"; }`;
    })
    .join("\n");

  const layout = `layout {
    default_tab_template {
      pane size=1 borderless=true { plugin location="tab-bar"; }
      children
      pane size=2 borderless=true { plugin location="status-bar"; }
    }
    tab name="rt x" {
      pane split_direction="vertical" {
${panes}
      }
    }
  }`;

  const layoutPath = "/tmp/rt-x-layout.kdl";
  writeFileSync(layoutPath, layout);

  const result = spawnSync("zellij", ["--layout", layoutPath], {
    cwd: repoRoot,
    stdio: "inherit",
  });

  // Clean up zellij sessions to prevent orphaned processes
  try {
    spawnSync("zellij", ["kill-all-sessions", "--yes"], {
      stdio: "pipe",
      timeout: 5000,
    });
  } catch {
    /* best effort */
  }

  return { exitCode: result.status ?? 1 };
}

// ─── Tmux ────────────────────────────────────────────────────────────────────

function launchTmux(commands: MuxCommand[], repoRoot: string): MuxResult {
  const sessionName = `rt-x-${Date.now()}`;
  const first = commands[0]!;

  const firstCmd = first.cwd
    ? `cd ${join(repoRoot, first.cwd)} && ${first.command}`
    : first.command;

  // Create session with first command
  spawnSync("tmux", [
    "new-session", "-d", "-s", sessionName, "-c", repoRoot, firstCmd,
  ], { stdio: "pipe" });

  // Add remaining commands as split panes
  for (let i = 1; i < commands.length; i++) {
    const cmd = commands[i]!;
    const fullCmd = cmd.cwd
      ? `cd ${join(repoRoot, cmd.cwd)} && ${cmd.command}`
      : cmd.command;

    spawnSync("tmux", [
      "split-window", "-t", sessionName, "-h", "-c", repoRoot, fullCmd,
    ], { stdio: "pipe" });
  }

  // Even out the layout
  spawnSync("tmux", ["select-layout", "-t", sessionName, "even-horizontal"], {
    stdio: "pipe",
  });

  // Attach to the session
  const result = spawnSync("tmux", ["attach-session", "-t", sessionName], {
    cwd: repoRoot,
    stdio: "inherit",
  });

  // Kill the session on exit to clean up
  try {
    spawnSync("tmux", ["kill-session", "-t", sessionName], {
      stdio: "pipe",
      timeout: 5000,
    });
  } catch {
    /* best effort */
  }

  return { exitCode: result.status ?? 1 };
}

// ─── Concurrent (inline) ────────────────────────────────────────────────────

function launchConcurrent(commands: MuxCommand[], repoRoot: string): MuxResult {
  return new Promise<MuxResult>((resolve) => {
    const children: ChildProcess[] = [];
    let exitCount = 0;
    let maxExitCode = 0;

    for (let i = 0; i < commands.length; i++) {
      const cmd = commands[i]!;
      const color = COLOR_PALETTE[i % COLOR_PALETTE.length]!;
      const cwd = cmd.cwd ? join(repoRoot, cmd.cwd) : repoRoot;
      const prefix = `\x1b[${colorCode(color)}m[${cmd.label}]\x1b[0m `;

      const child = spawn("sh", ["-c", cmd.command], {
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });

      trackProcess(child);
      children.push(child);

      const prefixLine = (data: Buffer) => {
        const lines = data.toString().split("\n");
        for (const line of lines) {
          if (line) process.stdout.write(`${prefix}${line}\n`);
        }
      };

      child.stdout?.on("data", prefixLine);
      child.stderr?.on("data", prefixLine);

      child.on("exit", (code) => {
        exitCount++;
        if (code && code > maxExitCode) maxExitCode = code;
        if (exitCount === commands.length) {
          resolve({ exitCode: maxExitCode });
        }
      });
    }
  }) as unknown as MuxResult;
}

function colorCode(name: string): number {
  const map: Record<string, number> = {
    blue: 34, magenta: 35, cyan: 36, green: 32,
    yellow: 33, red: 31, white: 37,
  };
  return map[name] ?? 37;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Launch commands in the specified multiplexer.
 * For "concurrent" mode this returns a promise; for zellij/tmux it's synchronous.
 */
export function launch(
  mux: Multiplexer,
  commands: MuxCommand[],
  repoRoot: string,
): MuxResult | Promise<MuxResult> {
  if (commands.length === 0) {
    return { exitCode: 0 };
  }

  // Single command: just run it directly, no multiplexer needed
  if (commands.length === 1) {
    const cmd = commands[0]!;
    const cwd = cmd.cwd ? join(repoRoot, cmd.cwd) : repoRoot;
    const result = spawnSync("sh", ["-c", cmd.command], {
      cwd,
      stdio: "inherit",
    });
    return { exitCode: result.status ?? 1 };
  }

  switch (mux) {
    case "zellij":
      return launchZellij(commands, repoRoot);
    case "tmux":
      return launchTmux(commands, repoRoot);
    case "concurrent":
      return launchConcurrent(commands, repoRoot);
  }
}
