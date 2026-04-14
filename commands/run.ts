/**
 * rt run — Interactive script runner.
 *
 * Presents a picker chain: repo → worktree → package → script.
 * With --resolve-only, outputs RunResolveResult JSON to stdout and exits
 * without spawning anything. All picker UI output goes to stderr so the
 * JSON result is cleanly parseable.
 *
 * When context is resolved by the dispatcher (via --repo flag or cwd),
 * the repo and worktree steps are skipped and the command jumps straight
 * to package → script selection.
 *
 * Used by rt runner's [a] handler to add a new process to a lane.
 */

import { existsSync, readFileSync } from "fs";
import { execSync } from "child_process";
import { join, relative } from "path";
import type { CommandContext } from "../lib/command-tree.ts";
import { filterableSelect, BackNavigation } from "../lib/rt-render.tsx";
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
  // Check at repo root — that's where lockfiles live in monorepos
  let root = dir;
  try {
    root = execSync("git rev-parse --show-toplevel", { cwd: dir, encoding: "utf8", stdio: "pipe" }).trim();
  } catch { /* fallback to dir itself */ }

  if (existsSync(join(root, "bun.lockb")) || existsSync(join(root, "bun.lock"))) return "bun";
  if (existsSync(join(root, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(root, "yarn.lock"))) return "yarn";
  if (existsSync(join(root, "package-lock.json"))) return "npm";
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

export async function runCommand(args: string[], ctx: CommandContext): Promise<void> {
  const resolveOnly = args.includes("--resolve-only");

  let worktreePath: string;
  let worktreeBranch: string;

  if (ctx.identity) {
    // Dispatcher already resolved repo + worktree via --repo flag or cwd detection.
    // Jump straight to package → script selection.
    worktreePath = ctx.identity.repoRoot;
    try {
      worktreeBranch = execSync("git rev-parse --abbrev-ref HEAD", {
        cwd: worktreePath, encoding: "utf8", stdio: "pipe",
      }).trim();
    } catch {
      worktreeBranch = "";
    }
  } else {
    // ── Step 1: Pick repo ────────────────────────────────────────────────────
    const knownRepos = getKnownRepos();
    if (knownRepos.length === 0) {
      process.stderr.write("No known repos. Run rt from inside a git repo to register it.\n");
      process.exit(1);
    }

    let selectedRepo = knownRepos.length === 1 ? knownRepos[0]! : undefined;

    if (!selectedRepo) {
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

    // ── Step 2: Pick worktree ────────────────────────────────────────────────
    const worktrees = selectedRepo.worktrees.filter((wt) => existsSync(wt.path));
    if (worktrees.length === 0) {
      process.stderr.write(`No accessible worktrees for ${selectedRepo.repoName}.\n`);
      process.exit(1);
    }

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
  }

  // ── Step 3 + 4: Pick package → script (with back-navigation) ───────────────

  const packages = getWorkspacePackages(worktreePath);

  let packagePath: string;
  let packageLabel: string;
  let selectedScript: string;
  let skipCwdDetection = false;

  // Loop: back from script picker restarts at package picker
  packageLoop: while (true) {
    if (packages.length === 0) {
      packagePath = worktreePath;
      packageLabel = "root";
    } else if (packages.length === 1) {
      packagePath = join(worktreePath, packages[0]!.path);
      packageLabel = packages[0]!.name;
    } else {
      // ── CWD auto-detection ─────────────────────────────────────────────────
      // If the user is inside a known package directory, select it automatically.
      // Skipped when coming back from the script picker.
      const cwd = process.cwd();
      const cwdMatch = !skipCwdDetection
        ? packages
            .map((p) => ({ p, abs: join(worktreePath, p.path) }))
            .filter(({ abs }) => cwd === abs || cwd.startsWith(abs + "/"))
            .sort((a, b) => b.abs.length - a.abs.length) // deepest match wins
            [0]
        : undefined;

      if (cwdMatch) {
        packagePath = cwdMatch.abs;
        packageLabel = cwdMatch.p.name;
        process.stderr.write(`  ↳ package: ${packageLabel} (from cwd)\n`);
      } else {
        // ── Manual picker ────────────────────────────────────────────────────
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
          backLabel: "Switch worktree",
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
    }

    // ── Pick script ────────────────────────────────────────────────────────────

    const scripts = getPackageJsonScripts(packagePath);
    if (scripts.length === 0) {
      process.stderr.write(`No scripts found in ${packagePath}/package.json.\n`);
      process.exit(1);
    }

    if (scripts.length === 1) {
      selectedScript = scripts[0]!;
      break packageLoop;
    }

    let pkgScripts: Record<string, string> = {};
    try {
      const pkg = JSON.parse(readFileSync(join(packagePath, "package.json"), "utf8")) as { scripts?: Record<string, string> };
      pkgScripts = pkg.scripts ?? {};
    } catch { /* skip hints */ }

    // Back from script picker → restart at package picker (one level up)
    try {
      const chosen = await filterableSelect({
        message: "Select script",
        options: scripts.map((s) => ({
          value: s,
          label: s,
          hint: pkgScripts[s]?.slice(0, 60),
        })),
        stderr: true,
        backLabel: packages.length > 1 ? "Switch package" : undefined,
      });

      if (!chosen) { process.exit(1); }
      selectedScript = chosen;
      break packageLoop;
    } catch (err) {
      if (err instanceof BackNavigation) {
        // Go back one level: show the full package picker
        skipCwdDetection = true;
        process.stderr.write("\x1b[2J\x1b[H");
        process.stderr.write(`  ↳ back to package selection\n`);
        continue packageLoop;
      }
      throw err;
    }
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
    process.stdout.write(JSON.stringify(result) + "\n");
    return;
  }

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
