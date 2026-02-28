#!/usr/bin/env bun
/**
 * Orchestrator for multi-worktree local development.
 *
 * 1. Reads DevConfig (just repoDir + optional proxy ports)
 * 2. Auto-detects all git worktrees
 * 3. Presents interactive checkbox to select which to run
 * 4. Persists selection for next run
 * 5. Generates a temp Tiltfile, spawns tilt + proxy
 *
 * Usage:
 *   bun run orchestrate.ts
 */

import { resolve, dirname, join } from "path";
import { tmpdir } from "os";
import { writeFileSync, readFileSync, unlinkSync } from "fs";
import { checkbox, confirm } from "@inquirer/prompts";
import {
  type DevConfig,
  type DetectedWorktree,
  type ResolvedWorktree,
  DEFAULT_PROXY_PORTS,
  detectWorktrees,
  resolveWorktrees,
  deriveProxyConfigs,
} from "./lib";
import { generateTiltfile } from "./tiltfile-template";

// ── Console helpers ─────────────────────────────────────────

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;

// ── Config ──────────────────────────────────────────────────

const configPath = resolve(dirname(import.meta.path), "dev-proxy.config.ts");
const { default: config } = (await import(configPath)) as {
  default: DevConfig;
};

const proxyPorts = {
  adjuster: config.proxy?.adjuster ?? DEFAULT_PROXY_PORTS.adjuster,
  frontend: config.proxy?.frontend ?? DEFAULT_PROXY_PORTS.frontend,
};

// ── Detect worktrees ────────────────────────────────────────

const allWorktrees = detectWorktrees(config.repoDir, config.ignore);

if (allWorktrees.length === 0) {
  console.error("  No git worktrees found. Is repoDir a git repository?");
  process.exit(1);
}

if (allWorktrees.length < 2) {
  console.error(
    '  Only one worktree found. Use "git worktree add" to create another.',
  );
  process.exit(1);
}

// ── Selection persistence ───────────────────────────────────

const SELECTION_FILE = resolve(
  dirname(import.meta.path),
  ".worktree-selection.json",
);

function loadSelection(): string[] | null {
  try {
    const raw = readFileSync(SELECTION_FILE, "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((s) => typeof s === "string")) {
      return parsed as string[];
    }
  } catch {
    /* no saved selection */
  }
  return null;
}

function saveSelection(dirs: string[]): void {
  writeFileSync(SELECTION_FILE, JSON.stringify(dirs, null, 2) + "\n");
}

// ── Interactive worktree selection ──────────────────────────

const saved = loadSelection();

const selected = await checkbox<DetectedWorktree>({
  message: "Select worktrees to run",
  choices: allWorktrees.map((wt) => {
    const name = wt.dir.split("/").pop() ?? wt.dir;
    return {
      name: `${name}  ${dim(wt.branch)}`,
      value: wt,
      checked: saved ? saved.includes(wt.dir) : true,
    };
  }),
  required: true,
  validate: (items) => items.length >= 2 || "Select at least 2 worktrees",
});

if (selected.length < 2) {
  console.error(`\n  ${yellow("Need at least 2 worktrees.")}\n`);
  process.exit(1);
}

saveSelection(selected.map((wt) => wt.dir));

const resolved = resolveWorktrees(selected);

// ── Port conflict check ─────────────────────────────────────

async function checkPort(port: number): Promise<void> {
  const result = Bun.spawnSync(["lsof", "-ti", `:${port}`]);
  const pids = new TextDecoder()
    .decode(result.stdout)
    .trim()
    .split("\n")
    .filter(Boolean);

  if (pids.length === 0) return;

  const nameResult = Bun.spawnSync(["lsof", "-i", `:${port}`, "-P", "-n"]);
  const info = new TextDecoder().decode(nameResult.stdout).trim();
  const processLine = info.split("\n").find((l) => l.includes("LISTEN"));
  const processName = processLine?.split(/\s+/)[0] ?? "unknown";

  const kill = await confirm({
    message: `Port ${port} is in use by ${processName} (pid ${pids.join(", ")}). Kill it?`,
    default: true,
  });

  if (kill) {
    for (const pid of pids) {
      process.kill(parseInt(pid), "SIGTERM");
    }
    console.log(`  ✓ Killed. Waiting for port to free up...`);
    await Bun.sleep(500);
  } else {
    console.log("  Aborted.");
    process.exit(0);
  }
}

const proxyDerived = deriveProxyConfigs(proxyPorts, resolved);
const TILT_DASHBOARD_BASE = 10350;

// Check proxy ports
await checkPort(proxyDerived.adjuster.port);
await checkPort(proxyDerived.frontend.port);

// Check tilt dashboard ports for orphaned processes from a previous run
for (let i = 0; i < resolved.length; i++) {
  await checkPort(TILT_DASHBOARD_BASE + i);
}

// ── Tilt helpers ────────────────────────────────────────────

function wtLabel(rw: ResolvedWorktree): string {
  return rw.path.split("/").filter(Boolean).pop() ?? rw.path;
}

// ── Write temp Tiltfile ─────────────────────────────────────

const tiltfilePath = join(tmpdir(), `dev-proxy-tiltfile-${process.pid}`);
writeFileSync(tiltfilePath, generateTiltfile());

// ── Build runtime config JSON for dev-proxy ─────────────────

const runtimeConfigJson = JSON.stringify({
  proxy: proxyPorts,
  worktrees: resolved.map((rw) => ({
    path: rw.path,
    dir: rw.dir,
    branch: rw.branch,
    ports: rw.ports,
  })),
});

// ── Spawn tilt processes ────────────────────────────────────

const children: Subprocess[] = [];

type Subprocess = ReturnType<typeof Bun.spawn>;

function spawnTilt(rw: ResolvedWorktree, index: number): Subprocess {
  const dashPort = TILT_DASHBOARD_BASE + index;

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    REPO_ROOT: rw.dir,
    PORT_BACKEND: String(rw.ports.backend),
    PORT_ADJUSTER: String(rw.ports.adjuster),
    PORT_FRONTEND: String(rw.ports.frontend),
  };

  const proc = Bun.spawn(
    ["tilt", "up", "-f", tiltfilePath, "--port", String(dashPort)],
    {
      cwd: rw.dir,
      env,
      stdout: "ignore",
      stderr: "ignore",
    },
  );

  return proc;
}

// ── Spawn proxy ─────────────────────────────────────────────

function spawnProxy(): Subprocess {
  const proxyScript = resolve(dirname(import.meta.path), "dev-proxy.ts");
  const proc = Bun.spawn(["bun", "run", proxyScript], {
    cwd: dirname(import.meta.path),
    env: {
      ...(process.env as Record<string, string>),
      DEV_PROXY_RUNTIME_CONFIG: runtimeConfigJson,
    },
    stdout: "inherit",
    stderr: "inherit",
  });
  return proc;
}

// ── Shutdown ────────────────────────────────────────────────

let shuttingDown = false;

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`\n  ${yellow("Shutting down...")}`);

  // Run tilt down for each worktree to cleanly tear down resources
  const tiltDownProcs = resolved.map((rw, i) => {
    const dashPort = TILT_DASHBOARD_BASE + i;
    return Bun.spawn(
      ["tilt", "down", "-f", tiltfilePath, "--port", String(dashPort)],
      {
        cwd: rw.dir,
        env: {
          ...(process.env as Record<string, string>),
          REPO_ROOT: rw.dir,
          PORT_BACKEND: String(rw.ports.backend),
          PORT_ADJUSTER: String(rw.ports.adjuster),
          PORT_FRONTEND: String(rw.ports.frontend),
        },
        stdout: "ignore",
        stderr: "ignore",
      },
    );
  });

  // Wait up to 5s for tilt down to finish
  await Promise.race([
    Promise.allSettled(tiltDownProcs.map((p) => p.exited)),
    Bun.sleep(5000),
  ]);

  // Kill any remaining children (proxy, lingering tilt)
  for (const child of children) {
    try {
      child.kill("SIGTERM");
    } catch {
      /* already exited */
    }
  }

  await Bun.sleep(500);

  for (const child of children) {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already exited */
    }
  }

  try {
    unlinkSync(tiltfilePath);
  } catch {
    /* already cleaned up */
  }

  console.log(`  ${green("Done.")}\n`);
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// ── Main ────────────────────────────────────────────────────

for (let i = 0; i < resolved.length; i++) {
  const proc = spawnTilt(resolved[i], i);
  children.push(proc);
}

const proxyProc = spawnProxy();
children.push(proxyProc);

const nameCol = Math.max(...resolved.map((rw) => wtLabel(rw).length)) + 2;

console.log(`
  ${bold("dev-proxy orchestrator")}
  ${dim("─".repeat(50))}
`);

for (let i = 0; i < resolved.length; i++) {
  const rw = resolved[i];
  const label = wtLabel(rw);
  const dashUrl = `http://localhost:${TILT_DASHBOARD_BASE + i}`;
  console.log(
    `  ${green("●")} ${bold(label.padEnd(nameCol))} ${dim(rw.branch)}`,
  );
  console.log(`    tilt  ${cyan(dashUrl)}`);
}

console.log(`\n  ${bold("Proxies:")}`);
console.log(
  `    adjuster  ${cyan(`http://localhost:${proxyDerived.adjuster.port}`)}`,
);
console.log(
  `    frontend  ${cyan(`http://localhost:${proxyDerived.frontend.port}`)}`,
);

console.log(`
  ${dim("─".repeat(50))}
  ${green("All processes running.")} Press Ctrl+C to stop.
`);

await new Promise(() => {});
