/**
 * rt run — Interactive script runner.
 *
 * Presents a picker chain: repo → worktree → package → script.
 * With --resolve-only, outputs RunResolveResult JSON to stdout and exits
 * without spawning anything. All picker UI output goes to stderr so the
 * JSON result is cleanly parseable.
 *
 * Used by rt runner's [a] handler to add a new process to a lane.
 */

import { existsSync, readFileSync } from "fs";
import { join, relative } from "path";
import type { CommandContext } from "../lib/command-tree.ts";
import { filterableSelect } from "../lib/rt-render.tsx";
import { getKnownRepos } from "../lib/repo-index.ts";
import { getWorkspacePackages } from "../lib/repo.ts";

export interface RunResolveResult {
  targetDir: string;
  pm: string;
  script: string;
  packageLabel: string;
  worktree: string;
  branch: string;
}

function detectPackageManager(dir: string): string {
  if (existsSync(join(dir, "bun.lockb")) || existsSync(join(dir, "bun.lock"))) return "bun";
  if (existsSync(join(dir, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(dir, "yarn.lock"))) return "yarn";
  return "npm";
}

function getPackageJsonScripts(dir: string): string[] {
  const pkgPath = join(dir, "package.json");
  if (!existsSync(pkgPath)) return [];
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { scripts?: Record<string, string> };
    return Object.keys(pkg.scripts ?? {});
  } catch {
    return [];
  }
}

export async function runCommand(args: string[], _ctx: CommandContext): Promise<void> {
  const resolveOnly = args.includes("--resolve-only");
  const repoFlag = args.find((a, i) => a === "--repo" && args[i + 1])
    ? args[args.indexOf("--repo") + 1]
    : undefined;

  // ── Step 1: Pick repo ──────────────────────────────────────────────────────

  const knownRepos = getKnownRepos();
  if (knownRepos.length === 0) {
    process.stderr.write("No known repos. Run rt from inside a git repo to register it.\n");
    process.exit(1);
  }

  let selectedRepo = repoFlag
    ? knownRepos.find((r) => r.repoName === repoFlag)
    : undefined;

  if (!selectedRepo) {
    if (knownRepos.length === 1) {
      selectedRepo = knownRepos[0]!;
    } else {
      const chosen = await filterableSelect({
        message: "Select repo",
        options: knownRepos.map((r) => ({
          value: r.repoName,
          label: r.repoName,
          hint: `${r.worktrees.length} worktrees`,
        })),
        stderr: true,
      });

      if (!chosen) { process.exit(1); }
      selectedRepo = knownRepos.find((r) => r.repoName === chosen)!;
    }
  }

  // ── Step 2: Pick worktree ──────────────────────────────────────────────────

  const worktrees = selectedRepo.worktrees.filter((wt) => existsSync(wt.path));
  if (worktrees.length === 0) {
    process.stderr.write(`No accessible worktrees for ${selectedRepo.repoName}.\n`);
    process.exit(1);
  }

  let worktreePath: string;
  let worktreeBranch: string;

  if (worktrees.length === 1) {
    worktreePath = worktrees[0]!.path;
    worktreeBranch = worktrees[0]!.branch;
  } else {
    const chosen = await filterableSelect({
      message: "Select worktree",
      options: worktrees.map((wt) => ({
        value: wt.path,
        label: wt.branch,
        hint: wt.path,
      })),
      stderr: true,
    });

    if (!chosen) { process.exit(1); }
    const wt = worktrees.find((w) => w.path === chosen)!;
    worktreePath = wt.path;
    worktreeBranch = wt.branch;
  }

  // ── Step 3: Pick package ───────────────────────────────────────────────────

  const packages = getWorkspacePackages(worktreePath);

  let packagePath: string;
  let packageLabel: string;

  if (packages.length === 0) {
    // Single-package repo — use root
    packagePath = worktreePath;
    packageLabel = ".";
  } else if (packages.length === 1) {
    packagePath = join(worktreePath, packages[0]!.path);
    packageLabel = packages[0]!.name;
  } else {
    // Include root as an option too
    const rootPkgJson = join(worktreePath, "package.json");
    const rootScripts = existsSync(rootPkgJson)
      ? Object.keys(
          (JSON.parse(readFileSync(rootPkgJson, "utf8")) as { scripts?: Record<string, string> }).scripts ?? {},
        )
      : [];

    const options = [
      ...(rootScripts.length > 0
        ? [{ value: worktreePath, label: "(root)", hint: "workspace root" }]
        : []),
      ...packages.map((p) => ({
        value: join(worktreePath, p.path),
        label: p.name,
        hint: p.path,
      })),
    ];

    const chosen = await filterableSelect({
      message: "Select package",
      options,
      stderr: true,
    });

    if (!chosen) { process.exit(1); }
    packagePath = chosen;
    if (chosen === worktreePath) {
      packageLabel = ".";
    } else {
      const pkg = packages.find((p) => join(worktreePath, p.path) === chosen);
      packageLabel = pkg?.name ?? relative(worktreePath, chosen);
    }
  }

  // ── Step 4: Pick script ────────────────────────────────────────────────────

  const scripts = getPackageJsonScripts(packagePath);
  if (scripts.length === 0) {
    process.stderr.write(`No scripts found in ${packagePath}/package.json.\n`);
    process.exit(1);
  }

  let selectedScript: string;

  if (scripts.length === 1) {
    selectedScript = scripts[0]!;
  } else {
    // Show script content as hint
    let pkgScripts: Record<string, string> = {};
    try {
      const pkg = JSON.parse(readFileSync(join(packagePath, "package.json"), "utf8")) as { scripts?: Record<string, string> };
      pkgScripts = pkg.scripts ?? {};
    } catch { /* skip hints */ }

    const chosen = await filterableSelect({
      message: "Select script",
      options: scripts.map((s) => ({
        value: s,
        label: s,
        hint: pkgScripts[s]?.slice(0, 60),
      })),
      stderr: true,
    });

    if (!chosen) { process.exit(1); }
    selectedScript = chosen;
  }

  // ── Build result ───────────────────────────────────────────────────────────

  const pm = detectPackageManager(packagePath);

  const result: RunResolveResult = {
    targetDir: packagePath,
    pm,
    script: selectedScript,
    packageLabel,
    worktree: worktreePath,
    branch: worktreeBranch,
  };

  if (resolveOnly) {
    // Write JSON to stdout; all picker output already went to stderr
    process.stdout.write(JSON.stringify(result) + "\n");
    return;
  }

  // Not --resolve-only: spawn the script
  const cmd = `${pm} run ${selectedScript}`;
  process.stderr.write(`\nRunning: ${cmd}\n`);
  process.stderr.write(`  in: ${packagePath}\n\n`);

  const proc = Bun.spawn(["bash", "-c", cmd], {
    cwd: packagePath,
    stdio: ["inherit", "inherit", "inherit"],
  });

  const exitCode = await proc.exited;
  process.exit(exitCode ?? 0);
}
