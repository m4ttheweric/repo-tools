/**
 * Worktree command discovery + launched-process identity.
 *
 * The dashboard launches package scripts directly (no rt runner dependency),
 * so the daemon needs to (a) tell a consumer which scripts a worktree exposes
 * and (b) mint a stable id for a launched command.
 */

import { existsSync, readFileSync } from "fs";
import { basename, join } from "path";
import { execSync } from "child_process";
import { getWorkspacePackages } from "../repo.ts";

export interface PackageScript {
  name: string;
  cmd: string;
}

/** A package within a worktree and the scripts it can run. */
export interface WorktreePackage {
  /** package.json `name`, or the directory name. */
  name: string;
  /** Absolute directory — the cwd a launched script runs in. */
  dir: string;
  scripts: PackageScript[];
}

/** Read package.json `scripts` for a directory, sorted by name. [] on any miss. */
export function readPackageScripts(dir: string): PackageScript[] {
  const pkgPath = join(dir, "package.json");
  if (!existsSync(pkgPath)) return [];
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    const scripts = pkg?.scripts;
    if (!scripts || typeof scripts !== "object") return [];
    return Object.entries(scripts)
      .map(([name, cmd]) => ({ name, cmd: String(cmd) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

function packageName(dir: string): string {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    if (pkg?.name) return String(pkg.name);
  } catch { /* fall through */ }
  return basename(dir);
}

/**
 * Discover every runnable package in a worktree — the root plus all workspace
 * packages (reusing rt's monorepo-aware getWorkspacePackages) — each with its
 * scripts. Packages without scripts are omitted. Sorted root-first, then by dir.
 */
export function discoverWorktreeCommands(worktreePath: string): WorktreePackage[] {
  const dirs = [worktreePath, ...getWorkspacePackages(worktreePath).map((p) => join(worktreePath, p.path))];
  const seen = new Set<string>();
  const out: WorktreePackage[] = [];
  for (const dir of dirs) {
    if (seen.has(dir)) continue;
    seen.add(dir);
    const scripts = readPackageScripts(dir);
    if (scripts.length === 0) continue;
    out.push({ name: packageName(dir), dir, scripts });
  }
  return out;
}

/**
 * Detect the package manager for a directory by its lockfile, checked at the
 * git root (where lockfiles live in monorepos). Falls back to npm.
 */
export function detectPackageManager(dir: string): string {
  let root = dir;
  try {
    root = execSync("git rev-parse --show-toplevel", { cwd: dir, encoding: "utf8", stdio: "pipe" }).trim();
  } catch { /* not a git repo — use dir */ }
  if (existsSync(join(root, "bun.lockb")) || existsSync(join(root, "bun.lock"))) return "bun";
  if (existsSync(join(root, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(root, "yarn.lock"))) return "yarn";
  if (existsSync(join(root, "package-lock.json"))) return "npm";
  return "npm";
}

/** The command that runs a named package script through its package manager. */
export function buildRunCommand(pm: string, script: string): string {
  return `${pm} run ${script}`;
}

/** Stable id for a command launched in a worktree, e.g. "assured-wktree-2:dev". */
export function deriveProcessId(cwd: string, label: string): string {
  const base = cwd.replace(/\/+$/, "").split("/").pop() || "process";
  const slug = label.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `${base}:${slug}`;
}
