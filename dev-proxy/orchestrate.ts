#!/usr/bin/env bun
/**
 * Orchestrator for multi-worktree local development.
 *
 * 1. Reads DevConfig (grouped setup/apps/tools sections)
 * 2. Auto-detects all git worktrees
 * 3. Presents interactive checkbox to select which to run (≥2 worktrees)
 *    — or runs directly for single-worktree repos
 * 4. Persists selection for next run
 * 5. Generates a temp Tiltfile, spawns tilt + proxy
 *
 * Usage:
 *   bun run orchestrate.ts
 */

import { resolve, dirname, join } from "path";
import { tmpdir, platform } from "os";
import { writeFileSync, readFileSync, unlinkSync, existsSync } from "fs";
import {
  type DevConfig,
  type DetectedWorktree,
  type ResolvedWorktree,
  ConfigError,
  validateConfig,
  detectWorktrees,
  resolveWorktrees,
  deriveProxyConfigs,
  flattenResources,
} from "./lib";
import { generateTiltfile } from "./tiltfile-template";

// ── Console helpers ─────────────────────────────────────────

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;

function die(headline: string, hint?: string): never {
  console.error(`\n  ${red("✗")} ${bold(headline)}`);
  if (hint) console.error(`    ${dim(hint)}`);
  console.error();
  process.exit(1);
}

// ── Config ──────────────────────────────────────────────────

const configPath = resolve(dirname(import.meta.path), "dev-proxy.config.ts");

if (!existsSync(configPath)) {
  die(
    "Config file not found",
    "Run: cp dev-proxy.config.example.ts dev-proxy.config.ts",
  );
}

let config: DevConfig;
try {
  const mod = (await import(configPath)) as { default: DevConfig };
  config = mod.default;
} catch (e) {
  if (e instanceof ConfigError) {
    die(e.headline, e.hint);
  }
  die(
    "Failed to load config",
    e instanceof Error ? e.message : String(e),
  );
}

try {
  validateConfig(config);
} catch (e) {
  if (e instanceof ConfigError) {
    die(e.headline, e.hint ?? "Fix in dev-proxy.config.ts");
  }
  throw e;
}

// B5: check tilt is installed
const tiltCheck = Bun.spawnSync(["which", "tilt"]);
if (tiltCheck.exitCode !== 0) {
  die(
    "tilt is not installed",
    "Install it: https://docs.tilt.dev/install.html",
  );
}

const appNames = config.apps.map((a) => a.name);

// ── Detect worktrees ────────────────────────────────────────

const allWorktrees = detectWorktrees(config.repoDir, config.ignore);

if (allWorktrees.length === 0) {
  die(
    "No git worktrees found",
    `Is ${config.repoDir} a git repository?`,
  );
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

// ── Port conflict check ─────────────────────────────────────

// B10: cross-platform port check — lsof is macOS/Linux only
const canCheckPorts = platform() === "darwin" || platform() === "linux";

async function checkPort(port: number, label?: string): Promise<void> {
  if (!canCheckPorts) return;

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

  // B8: include label for port context
  const portDesc = label ? `Port ${port} (${label})` : `Port ${port}`;

  // Auto-kill for now (TODO: ConfirmPrompt component)
  for (const pid of pids) {
    try {
      process.kill(parseInt(pid), "SIGTERM");
    } catch {
      /* process already exited */
    }
  }
  await Bun.sleep(500);
}

// ── Tilt helpers ────────────────────────────────────────────

function wtLabel(rw: ResolvedWorktree): string {
  return rw.path.split("/").filter(Boolean).pop() ?? rw.path;
}

const TILT_DASHBOARD_BASE = 10350;

// ── Process management (Bun land) ──────────────────────────

let shuttingDown = false;
let cleanupDashboard: (() => void) | null = null;
let tiltfilePath = "";
let activeResolved: ResolvedWorktree[] = [];
const children: Subprocess[] = [];

type Subprocess = ReturnType<typeof Bun.spawn>;

function spawnTilt(rw: ResolvedWorktree, index: number): Subprocess {
  const dashPort = TILT_DASHBOARD_BASE + index;

  // Clean PATH: bun prepends local node_modules/.bin entries which leak into
  // Tilt child processes and can confuse tools like Parcel about project root.
  const devProxyDir = dirname(import.meta.path);
  const cleanPath = (process.env.PATH ?? "")
    .split(":")
    .filter((p) => !p.startsWith(devProxyDir))
    .join(":");

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    PATH: cleanPath,
    PWD: rw.dir,
    REPO_ROOT: rw.dir,
  };

  // Set PORT_<NAME> env vars dynamically from resolved ports
  for (const [name, port] of Object.entries(rw.ports)) {
    env[`PORT_${name.toUpperCase()}`] = String(port);
  }

  // Remove env vars from `bun run` / npm that leak the orchestrator's context.
  delete env.OLDPWD;
  delete env.INIT_CWD;
  for (const key of Object.keys(env)) {
    if (key.startsWith("npm_")) delete env[key];
  }

  const proc = Bun.spawn(
    ["tilt", "up", "-f", tiltfilePath, "--port", String(dashPort)],
    {
      cwd: rw.dir,
      env,
      stdout: "ignore",
      stderr: "ignore",
    },
  );

  // B7: detect early tilt crash
  const label = wtLabel(rw);
  proc.exited.then((code) => {
    if (!shuttingDown && code !== 0) {
      console.error(
        `\n  ${red("✗")} ${bold(`Tilt exited for ${label}`)} ${dim(`(exit code ${code})`)}`,
      );
      console.error(`    ${dim(`Check: tilt up -f ${tiltfilePath} --port ${dashPort}`)}`);
    }
  });

  return proc;
}

function spawnProxy(runtimeConfigJson: string): Subprocess {
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

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;

  // Run tilt down for each worktree to cleanly tear down resources
  const tiltDownProcs = activeResolved.map((rw, i) => {
    const dashPort = TILT_DASHBOARD_BASE + i;
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      REPO_ROOT: rw.dir,
    };
    for (const [name, port] of Object.entries(rw.ports)) {
      env[`PORT_${name.toUpperCase()}`] = String(port);
    }
    return Bun.spawn(
      ["tilt", "down", "-f", tiltfilePath, "--port", String(dashPort)],
      {
        cwd: rw.dir,
        env,
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

  for (const child of children) {
    try { child.kill("SIGTERM"); } catch { /* already exited */ }
  }
  await Bun.sleep(500);
  for (const child of children) {
    try { child.kill("SIGKILL"); } catch { /* already exited */ }
  }

  try { unlinkSync(tiltfilePath); } catch { /* already cleaned up */ }
  cleanupDashboard?.();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// ── Render unified Ink app ──────────────────────────────────

import { render } from "ink";
import { createElement } from "react";
import { App } from "./ui/App.tsx";
import type { DashboardProps } from "./ui/Dashboard.tsx";

const { waitUntilExit } = render(
  createElement(App, {
    allWorktrees,
    savedSelection: loadSelection(),
    onSelected: async (selected: DetectedWorktree[]): Promise<DashboardProps> => {
      // Persist selection
      saveSelection(selected.map((wt) => wt.dir));

      // Resolve worktrees and derive configs
      const resolved = resolveWorktrees(selected, appNames);
      activeResolved = resolved;
      const proxyConfigs = deriveProxyConfigs(config.apps, resolved);

      // Write Tiltfile
      const resources = flattenResources(config);
      const configResourceNames = new Set(proxyConfigs.keys());
      tiltfilePath = join(tmpdir(), `dev-proxy-tiltfile-${process.pid}`);
      writeFileSync(tiltfilePath, generateTiltfile(resources, appNames));

      // Check ports
      for (const [name, pc] of proxyConfigs) {
        await checkPort(pc.port, `${name} proxy`);
      }
      for (let i = 0; i < resolved.length; i++) {
        const wtName = resolved[i].path.split("/").filter(Boolean).pop() ?? "unknown";
        await checkPort(TILT_DASHBOARD_BASE + i, `tilt dashboard: ${wtName}`);
      }

      // Spawn tilt processes
      for (let i = 0; i < resolved.length; i++) {
        children.push(spawnTilt(resolved[i], i));
      }

      // Spawn proxy if multiple worktrees with proxied apps
      const hasProxy = proxyConfigs.size > 0 && resolved.length > 1;
      if (hasProxy) {
        const runtimeConfigJson = JSON.stringify({
          apps: config.apps,
          worktrees: resolved.map((rw) => ({
            path: rw.path, dir: rw.dir, branch: rw.branch, ports: rw.ports,
          })),
        });
        children.push(spawnProxy(runtimeConfigJson));
      }

      // Return dashboard props
      return {
        resolved,
        proxyConfigs,
        tiltBasePort: TILT_DASHBOARD_BASE,
        configResourceNames,
        onShutdownReady: (cleanup: () => void) => {
          cleanupDashboard = cleanup;
        },
      };
    },
  }),
);

await waitUntilExit();

