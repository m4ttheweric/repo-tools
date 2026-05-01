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
import { join, relative, basename } from "path";

const SHELL = process.env.SHELL ?? "bash";
import type { CommandContext } from "../lib/command-tree.ts";
import { filterableSelect, BackNavigation } from "../lib/rt-render.tsx";
import { getKnownRepos } from "../lib/repo-index.ts";
import { getWorkspacePackages } from "../lib/repo.ts";
import {
  appendRunHistory,
  readRunHistory,
  type RunHistoryEntry,
} from "../lib/run-history.ts";
import { bold, dim, reset, yellow } from "../lib/tui.ts";
import { T, toAnsiFg } from "../lib/tui/palette.ts";

const LAST_RUN_SENTINEL = "__rt:last-run__";

export interface RunResolveResult {
  targetDir: string;
  packageLabel: string;
  worktree: string;
  branch: string;
  commandTemplate: string;
}

function detectPackageManager(dir: string): string {
  // Check at repo root — that's where lockfiles live in monorepos
  let root = dir;
  try {
    root = execSync("git rev-parse --show-toplevel", {
      cwd: dir,
      encoding: "utf8",
      stdio: "pipe",
    }).trim();
  } catch {
    /* fallback to dir itself */
  }

  if (existsSync(join(root, "bun.lockb")) || existsSync(join(root, "bun.lock")))
    return "bun";
  if (existsSync(join(root, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(root, "yarn.lock"))) return "yarn";
  if (existsSync(join(root, "package-lock.json"))) return "npm";
  return "npm";
}

function getPackageJsonScripts(dir: string): string[] {
  const pkgPath = join(dir, "package.json");
  if (!existsSync(pkgPath)) return [];
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
      scripts?: Record<string, string>;
    };
    return Object.keys(pkg.scripts ?? {});
  } catch {
    return [];
  }
}

export async function runCommand(
  args: string[],
  ctx: CommandContext,
): Promise<void> {
  const resolveOnly = args.includes("--resolve-only");

  let worktreePath: string;
  let worktreeBranch: string;

  if (ctx.identity) {
    // Dispatcher already resolved repo + worktree via --repo flag or cwd detection.
    // Jump straight to package → script selection.
    worktreePath = ctx.identity.repoRoot;
    try {
      worktreeBranch = execSync("git rev-parse --abbrev-ref HEAD", {
        cwd: worktreePath,
        encoding: "utf8",
        stdio: "pipe",
      }).trim();
    } catch {
      worktreeBranch = "";
    }
  } else {
    // ── Step 1: Pick repo ────────────────────────────────────────────────────
    const knownRepos = getKnownRepos();
    if (knownRepos.length === 0) {
      process.stderr.write(
        "No known repos. Run rt from inside a git repo to register it.\n",
      );
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

      if (!chosen) {
        process.exit(1);
      }
      selectedRepo = knownRepos.find((r) => r.repoName === chosen)!;
    }

    // ── Step 2: Pick worktree ────────────────────────────────────────────────
    const worktrees = selectedRepo.worktrees.filter((wt) =>
      existsSync(wt.path),
    );
    if (worktrees.length === 0) {
      process.stderr.write(
        `No accessible worktrees for ${selectedRepo.repoName}.\n`,
      );
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

      if (!chosen) {
        process.exit(1);
      }
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
            .sort((a, b) => b.abs.length - a.abs.length)[0] // deepest match wins
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
              (
                JSON.parse(readFileSync(rootPkgJson, "utf8")) as {
                  scripts?: Record<string, string>;
                }
              ).scripts ?? {},
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
        if (!chosen) {
          process.exit(1);
        }
        packagePath = chosen;
        if (chosen === worktreePath) {
          packageLabel = ".";
        } else {
          const pkg = packages.find(
            (p) => join(worktreePath, p.path) === chosen,
          );
          packageLabel = pkg?.name ?? relative(worktreePath, chosen);
        }
      }
    }

    // ── Pick script ────────────────────────────────────────────────────────────

    const scripts = getPackageJsonScripts(packagePath);
    if (scripts.length === 0) {
      process.stderr.write(
        `No scripts found in ${packagePath}/package.json.\n`,
      );
      process.exit(1);
    }

    if (scripts.length === 1) {
      selectedScript = scripts[0]!;
      break packageLoop;
    }

    let pkgScripts: Record<string, string> = {};
    try {
      const pkg = JSON.parse(
        readFileSync(join(packagePath, "package.json"), "utf8"),
      ) as { scripts?: Record<string, string> };
      pkgScripts = pkg.scripts ?? {};
    } catch {
      /* skip hints */
    }

    // Last-run sentinel: most recent history entry whose recorded cwd equals
    // the package we're about to run in, with the script still present.
    let lastRun: RunHistoryEntry | undefined;
    if (ctx.identity) {
      lastRun = readRunHistory(ctx.identity.dataDir).find(
        (e) => e.cwd === packagePath && scripts.includes(e.script),
      );
    }

    const sentinelOption = lastRun
      ? [
          {
            value: LAST_RUN_SENTINEL,
            // ▎ leading bar anchors the eye; ↻ tells the user this is a re-run.
            label: `↻ ${lastRun.script}`,
            hint: `last run · ${formatAge(lastRun.ts)}`,
            // Brand pink — same hue as the picker's border. Reads as "part
            // of the picker chrome" rather than a free-floating chunk.
            color: toAnsiFg(T.mint),
          },
        ]
      : [];

    // Back from script picker → restart at package picker (one level up)
    try {
      const chosen = await filterableSelect({
        message: "Select script",
        options: [
          ...sentinelOption,
          ...scripts.map((s) => ({
            value: s,
            label: s,
            hint: pkgScripts[s]?.slice(0, 60),
          })),
        ],
        stderr: true,
        backLabel: packages.length > 1 ? "Switch package" : undefined,
      });

      if (!chosen) {
        process.exit(1);
      }
      selectedScript = chosen === LAST_RUN_SENTINEL ? lastRun!.script : chosen;
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
    packageLabel,
    worktree: worktreePath,
    branch: worktreeBranch,
    commandTemplate: `${pm} run ${selectedScript}`,
  };

  if (resolveOnly) {
    process.stdout.write(JSON.stringify(result) + "\n");
    return;
  }

  const cmd = `${pm} run ${selectedScript}`;
  process.stderr.write(`\nRunning: ${cmd}\n`);
  process.stderr.write(`  in: ${packagePath}\n\n`);

  const proc = Bun.spawn([SHELL, "-c", cmd], {
    cwd: packagePath,
    stdio: ["inherit", "inherit", "inherit"],
  });

  const exitCode = await proc.exited;

  // Record to per-repo run history for rt run again / rt no-arg Recent.
  if (ctx.identity) {
    appendRunHistory(ctx.identity.dataDir, {
      ts: new Date().toISOString(),
      cmd,
      cwd: packagePath,
      worktree: worktreePath,
      branch: worktreeBranch,
      pkg: packageLabel,
      script: selectedScript,
      exit: typeof exitCode === "number" ? exitCode : null,
    });
  }

  process.exit(exitCode ?? 0);
}

// ─── rt run again ──────────────────────────────────────────────────────────

/**
 * rt run again — flat fzf picker of recently-run scripts across all known repos.
 *
 * No repo/worktree resolution step. Reads every known repo's run-history.jsonl,
 * merges newest-first, and shows one flat list. The hint tells you where each
 * entry would run; selecting one executes it at the recorded cwd.
 */
export async function runAgainCommand(
  _args: string[],
  _ctx: CommandContext,
): Promise<void> {
  const { entries, totalRepos } = loadAllRunHistory();
  if (entries.length === 0) {
    process.stderr.write(
      `\n  ${dim}No run history yet${totalRepos > 0 ? "" : " — no repos registered"}.${reset}\n`,
    );
    process.stderr.write(
      `  ${dim}Run ${reset}${bold}rt run${reset}${dim} from a repo first — entries will show up here.${reset}\n\n`,
    );
    process.exit(0);
  }

  const chosen = await filterableSelect({
    message: "Recent runs",
    options: entries.map((tagged) => ({
      value: taggedId(tagged),
      label: tagged.entry.cmd,
      hint: formatFlatHint(tagged),
    })),
    stderr: true,
  });

  if (!chosen) process.exit(0);

  const picked = entries.find((t) => taggedId(t) === chosen);
  if (!picked) process.exit(1);

  const { entry, dataDir } = picked;

  if (!existsSync(entry.cwd)) {
    process.stderr.write(
      `\n  ${yellow}skipping — directory no longer exists:${reset} ${entry.cwd}\n\n`,
    );
    process.exit(1);
  }

  process.stderr.write(`\nRunning: ${entry.cmd}\n`);
  process.stderr.write(`  in: ${entry.cwd}\n\n`);

  const proc = Bun.spawn([SHELL, "-c", entry.cmd], {
    cwd: entry.cwd,
    stdio: ["inherit", "inherit", "inherit"],
  });

  const exitCode = await proc.exited;

  appendRunHistory(dataDir, {
    ...entry,
    ts: new Date().toISOString(),
    exit: typeof exitCode === "number" ? exitCode : null,
  });

  process.exit(exitCode ?? 0);
}

interface TaggedEntry {
  entry: RunHistoryEntry;
  repoName: string;
  /** dataDir the entry was read from — used for re-logging on replay. */
  dataDir: string;
}

function loadAllRunHistory(): { entries: TaggedEntry[]; totalRepos: number } {
  const repos = getKnownRepos();
  const all: TaggedEntry[] = [];
  for (const repo of repos) {
    for (const entry of readRunHistory(repo.dataDir)) {
      all.push({ entry, repoName: repo.repoName, dataDir: repo.dataDir });
    }
  }
  all.sort((a, b) =>
    a.entry.ts < b.entry.ts ? 1 : a.entry.ts > b.entry.ts ? -1 : 0,
  );

  // Dedupe by (cmd, cwd) — keep newest. Because `all` is sorted newest-first,
  // the first occurrence of any (cmd, cwd) pair is the one we keep.
  const seen = new Set<string>();
  const deduped: TaggedEntry[] = [];
  for (const t of all) {
    const key = `${t.entry.cmd}\x00${t.entry.cwd}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(t);
  }
  return { entries: deduped, totalRepos: repos.length };
}

function taggedId(t: TaggedEntry): string {
  return `${t.entry.ts}|${t.entry.cwd}|${t.entry.cmd}`;
}

function formatFlatHint(t: TaggedEntry): string {
  const { entry, repoName } = t;
  const age = formatAge(entry.ts);
  const worktreeName = entry.worktree ? basename(entry.worktree) : "";
  // Prefer worktree name over repo name when they differ (e.g. "assured-wktree-2").
  const where = worktreeName || repoName;
  const sub =
    entry.pkg && entry.pkg !== "." && entry.pkg !== "root"
      ? ` · ${entry.pkg}`
      : "";
  const exit =
    entry.exit == null || entry.exit === 0 ? "" : ` · exit ${entry.exit}`;
  return `${age} · ${where}${sub}${exit}`;
}

function formatAge(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  if (Number.isNaN(ms)) return "—";
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}
