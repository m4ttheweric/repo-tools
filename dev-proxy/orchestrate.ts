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
import { checkbox, confirm } from "@inquirer/prompts";
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
import { TiltClient, type TiltResource } from "@tilt-launcher/sdk";

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

// ── Selection (multi-worktree) or auto-run (single) ─────────

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

let selected: DetectedWorktree[];

if (allWorktrees.length === 1) {
  // B6: single worktree — skip selection, run tilt directly (no proxy needed)
  selected = allWorktrees;
  console.log(
    `\n  ${dim("Single worktree detected — running directly (no proxy).")}`,
  );
} else {
  const saved = loadSelection();

  selected = await checkbox<DetectedWorktree>({
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
    validate: (items) => items.length >= 1 || "Select at least 1 worktree",
  });

  if (selected.length === 0) {
    die("No worktrees selected");
  }

  saveSelection(selected.map((wt) => wt.dir));
}

const resolved = resolveWorktrees(selected, appNames);

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

  const kill = await confirm({
    message: `${portDesc} is in use by ${processName} (pid ${pids.join(", ")}). Kill it?`,
    default: true,
  });

  if (kill) {
    for (const pid of pids) {
      try {
        process.kill(parseInt(pid), "SIGTERM");
      } catch {
        /* process already exited */
      }
    }
    console.log(`  ✓ Killed. Waiting for port to free up...`);
    await Bun.sleep(500);
  } else {
    console.log("  Aborted.");
    process.exit(0);
  }
}

const proxyConfigs = deriveProxyConfigs(config.apps, resolved);
const TILT_DASHBOARD_BASE = 10350;

// Check proxy ports (B8: with labels)
for (const [name, pc] of proxyConfigs) {
  await checkPort(pc.port, `${name} proxy`);
}

// Check tilt dashboard ports
for (let i = 0; i < resolved.length; i++) {
  const wtName = resolved[i].path.split("/").filter(Boolean).pop() ?? "unknown";
  await checkPort(TILT_DASHBOARD_BASE + i, `tilt dashboard: ${wtName}`);
}

// ── Tilt helpers ────────────────────────────────────────────

function wtLabel(rw: ResolvedWorktree): string {
  return rw.path.split("/").filter(Boolean).pop() ?? rw.path;
}

// ── Write temp Tiltfile ─────────────────────────────────────

const resources = flattenResources(config);
const configResourceNames = new Set(proxyConfigs.keys());
const tiltfilePath = join(tmpdir(), `dev-proxy-tiltfile-${process.pid}`);
writeFileSync(
  tiltfilePath,
  generateTiltfile(resources, appNames),
);

// ── Build runtime config JSON for dev-proxy ─────────────────

const runtimeConfigJson = JSON.stringify({
  apps: config.apps,
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
  // Parcel's static-files-copy plugin uses npm_package_json to resolve project
  // root, which causes it to look for static/ in the dev-proxy dir.
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

// ── Live status tracking ────────────────────────────────────

const tiltClients: TiltClient[] = [];
const stopWatchers: Array<() => void> = [];

/** Per-worktree resource snapshots, filtered to config resources only */
const resourceSnapshots = new Map<number, TiltResource[]>();

function filterConfigResources(tiltResources: TiltResource[]): TiltResource[] {
  return tiltResources.filter((r) => configResourceNames.has(r.name));
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
let spinnerFrame = 0;
let dashboardLines = 0;
let spinnerInterval: ReturnType<typeof setInterval> | null = null;

function spin(): string {
  return cyan(SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length]);
}

function resourceIcon(r: TiltResource): string {
  if (r.runtimeStatus === "error") return red("✗");
  if (r.runtimeStatus === "ok" && r.lastBuildError) return yellow("⚠");
  if (r.runtimeStatus === "ok") return green("✓");
  if (r.runtimeStatus === "pending") return spin();
  if (r.isDisabled) return dim("○");
  return dim("·");
}

function resourceDetail(r: TiltResource): string {
  if (r.runtimeStatus === "error") return red(r.lastBuildError ? truncate(r.lastBuildError, 60) : "error");
  if (r.runtimeStatus === "ok" && r.lastBuildError) return yellow(truncate(r.lastBuildError, 60));
  if (r.runtimeStatus === "pending" && r.waitingOn?.length) return dim(`waiting: ${r.waitingOn.join(", ")}`);
  if (r.runtimeStatus === "pending") return dim("pending");
  if (r.runtimeStatus === "ok") return "";
  if (r.isDisabled) return dim("disabled");
  return "";
}

function truncate(s: string, max: number): string {
  const line = s.split("\n")[0].trim();
  return line.length > max ? line.slice(0, max - 1) + "…" : line;
}

/** Returns true if any worktree is still loading or has pending resources */
function needsAnimation(): boolean {
  if (resourceSnapshots.size < resolved.length) return true;
  return [...resourceSnapshots.values()].some(
    (resources) => resources.some((r) => r.runtimeStatus === "pending"),
  );
}

function renderDashboard(): void {
  // Move cursor up to overwrite previous dashboard
  if (dashboardLines > 0) {
    process.stdout.write(`\x1b[${dashboardLines}A\x1b[J`);
  }

  const lines: string[] = [];
  const nameCol = Math.max(...resolved.map((rw) => wtLabel(rw).length)) + 2;

  for (let i = 0; i < resolved.length; i++) {
    const rw = resolved[i];
    const label = wtLabel(rw).padEnd(nameCol);
    const tiltUrl = `http://localhost:${TILT_DASHBOARD_BASE + i}`;
    lines.push(`  ${green("●")} ${bold(label)} ${dim(rw.branch.padEnd(30))} ${dim("tilt")} ${cyan(tiltUrl)}`);

    const resources = resourceSnapshots.get(i);
    if (resources && resources.length > 0) {
      for (const r of resources) {
        const icon = resourceIcon(r);
        const detail = resourceDetail(r);
        lines.push(detail ? `    ${icon} ${r.name}  ${detail}` : `    ${icon} ${r.name}`);
      }
    } else {
      lines.push(`    ${spin()} ${dim("connecting to tilt…")}`);
    }
    lines.push("");
  }

  if (hasProxy) {
    lines.push(`  ${bold("Proxies:")}`);
    for (const [name, pc] of proxyConfigs) {
      lines.push(`    ${name.padEnd(10)} ${cyan(`http://localhost:${pc.port}`)}`);
    }
    lines.push("");
  }

  const allConnected = resolved.every((_, i) => resourceSnapshots.has(i));
  const allHealthy = allConnected && [...resourceSnapshots.values()].every(
    (resources) => resources.every((r) => r.runtimeStatus === "ok" || r.runtimeStatus === "not_applicable" || r.isDisabled),
  );
  const hasErrors = [...resourceSnapshots.values()].some(
    (resources) => resources.some((r) => r.runtimeStatus === "error" || (r.runtimeStatus === "ok" && r.lastBuildError)),
  );

  if (allHealthy) {
    lines.push(`  ${green("All services healthy.")} ${dim("Ctrl+C to stop.")}`);
  } else if (hasErrors) {
    lines.push(`  ${yellow("Some services have errors.")} ${dim("Ctrl+C to stop.")}`);
  } else {
    lines.push(`  ${dim("Ctrl+C to stop.")}`);
  }

  process.stdout.write(lines.join("\n") + "\n");
  dashboardLines = lines.length;

  // Start/stop animation based on whether anything is still loading
  if (needsAnimation() && !spinnerInterval) {
    spinnerInterval = setInterval(() => {
      spinnerFrame++;
      renderDashboard();
    }, 80);
  } else if (!needsAnimation() && spinnerInterval) {
    clearInterval(spinnerInterval);
    spinnerInterval = null;
  }
}

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`\n  ${yellow("Shutting down...")}`);

  // Run tilt down for each worktree to cleanly tear down resources
  const tiltDownProcs = resolved.map((rw, i) => {
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

  // Close TiltClient watchers
  for (const stop of stopWatchers) {
    try { stop(); } catch { /* already closed */ }
  }
  for (const client of tiltClients) {
    try { client.close(); } catch { /* already closed */ }
  }

  if (spinnerInterval) clearInterval(spinnerInterval);
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

// B9: only spawn proxy if there are proxied apps AND multiple worktrees
const hasProxy = proxyConfigs.size > 0 && resolved.length > 1;
if (hasProxy) {
  const proxyProc = spawnProxy();
  children.push(proxyProc);
}

// Initial render
console.log(`\n  ${bold("dev-proxy orchestrator")}\n`);
renderDashboard();

// ── Connect TiltClients for live status ─────────────────────

async function connectTiltWatcher(worktreeIndex: number): Promise<void> {
  const port = TILT_DASHBOARD_BASE + worktreeIndex;
  const client = new TiltClient(port);
  tiltClients.push(client);

  // Wait for tilt to become reachable
  let attempts = 0;
  while (attempts < 60 && !shuttingDown) {
    if (await client.isReachable()) break;
    await Bun.sleep(2000);
    attempts++;
  }

  if (shuttingDown) return;

  try {
    // Initial fetch
    const resources = await client.getResources();
    resourceSnapshots.set(worktreeIndex, filterConfigResources(resources));
    renderDashboard();
  } catch {
    // Tilt may have crashed — already handled by B7
  }

  if (shuttingDown) return;

  // Start WebSocket watch for live updates, fall back to polling
  try {
    const stop = await client.watch((event) => {
      if (event.resources.length > 0) {
        // Merge: update existing resources by name, keep ones not in this event
        const incoming = filterConfigResources(event.resources);
        if (incoming.length > 0) {
          const existing = resourceSnapshots.get(worktreeIndex) ?? [];
          const merged = new Map(existing.map((r) => [r.name, r]));
          for (const r of incoming) merged.set(r.name, r);
          resourceSnapshots.set(worktreeIndex, [...merged.values()]);
        }
        if (!shuttingDown) renderDashboard();
      }
    });
    stopWatchers.push(stop);
  } catch {
    // WebSocket failed — fall back to SDK polling every 5s
    const poll = setInterval(async () => {
      if (shuttingDown) { clearInterval(poll); return; }
      try {
        const resources = await client.getResources();
        resourceSnapshots.set(worktreeIndex, filterConfigResources(resources));
        renderDashboard();
      } catch { /* tilt may be restarting */ }
    }, 5000);
    stopWatchers.push(() => clearInterval(poll));
  }
}

// Start watchers in parallel
for (let i = 0; i < resolved.length; i++) {
  connectTiltWatcher(i);
}

await new Promise(() => {});
