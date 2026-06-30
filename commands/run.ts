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

import { existsSync, readFileSync, writeFileSync } from "fs";
import { execSync } from "child_process";
import { join, relative, basename } from "path";

const SHELL = process.env.SHELL ?? "bash";
import type { CommandContext } from "../lib/command-tree.ts";
import {
  filterableSelect,
  textInput,
} from "../lib/rt-render.tsx";
import { getKnownRepos } from "../lib/repo-index.ts";
import { rtDir } from "../lib/rt-paths.ts";
import { ensureHistoryHook } from "../lib/shell-integration.ts";
import { getWorkspacePackages, type KnownRepo } from "../lib/repo.ts";
import {
  appendRunHistory,
  readRunHistory,
  type RunHistoryEntry,
} from "../lib/run-history.ts";
import {
  loadVariations,
  saveVariation,
  variationKey,
  type Variation,
} from "../lib/variations.ts";
import { bold, dim, reset, yellow, green, magenta } from "../lib/tui.ts";
import { T, toAnsiFg } from "../lib/tui/palette.ts";
import {
  isInsideHerdr,
  launchInHerdr,
  launchFallback,
  type LaunchItem,
} from "../lib/herdr-launch.ts";
import { savePreset } from "../lib/run-presets.ts";

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

// ─── Package + script helper ────────────────────────────────────────────────

interface ScriptSelection {
  packagePath: string;
  packageLabel: string;
  selectedScript: string;
  customCommand: string | undefined;
}

interface QueuedItem {
  packageRelPath: string;
  packagePath: string;
  packageLabel: string;
  script: string;
  command: string;
  variationName?: string;
}

/** Sentinel returned when the picker loop built and launched a queue. */
const QUEUE_LAUNCHED = Symbol("queue-launched");

/**
 * Package → script → variations picker loop.
 *
 * Returns null when the user backs out of the package picker (ctrl-up).
 * Returns ScriptSelection when a script (or variation) is selected.
 * Returns QUEUE_LAUNCHED when the user built a multi-pick queue and launched it.
 */
async function selectPackageAndScript(
  worktreePath: string,
  dataDir: string | undefined,
  contextLabel?: string,
  queue?: QueuedItem[],
): Promise<ScriptSelection | typeof QUEUE_LAUNCHED | null> {
  const { runNavPicker } = await import("../lib/navigate.ts");
  const packages = getWorkspacePackages(worktreePath);
  const label = contextLabel ? `${contextLabel}` : "";
  let cameFromScript = false;
  const q: QueuedItem[] = queue ?? [];

  while (true) {
    let packagePath: string;
    let packageLabel: string;

    // ── Package selection ──────────────────────────────────────────────────

    if (packages.length === 0) {
      packagePath = worktreePath;
      packageLabel = "root";
    } else if (packages.length === 1) {
      packagePath = join(worktreePath, packages[0]!.path);
      packageLabel = packages[0]!.name;
    } else {
      // CWD auto-detection — skipped when coming back from script picker or when queue active
      const cwd = process.cwd();
      const cwdMatch =
        !cameFromScript && q.length === 0
          ? packages
              .map((p) => ({ p, abs: join(worktreePath, p.path) }))
              .filter(({ abs }) => cwd === abs || cwd.startsWith(abs + "/"))
              .sort((a, b) => b.abs.length - a.abs.length)[0]
          : undefined;

      if (cwdMatch) {
        packagePath = cwdMatch.abs;
        packageLabel = cwdMatch.p.name;
        process.stderr.write(`  ↳ package: ${packageLabel} (from cwd)\n`);
      } else {
        // Manual package picker
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

        // ── Queue display options (prepended when queue is active) ─────────
        const LAUNCH_ALL_SENTINEL = "__rt:launch-all__";
        const SAVE_PRESET_SENTINEL = "__rt:save-preset__";
        const QUEUED_PREFIX = "__queued:";

        const queueOptions: Array<{ value: string; label: string; hint: string; color?: string }> = [];
        if (q.length > 0) {
          for (let i = 0; i < q.length; i++) {
            const qi = q[i]!;
            const varSuffix = qi.variationName ? ` ${magenta}(${qi.variationName})${reset}` : "";
            queueOptions.push({
              value: `${QUEUED_PREFIX}${i}__`,
              label: `${green}✓${reset} ${qi.packageLabel} > ${qi.script}${varSuffix}`,
              hint: "",
            });
          }
          queueOptions.push({ value: "__rt:sep1__", label: "──────────────", hint: "" });
          queueOptions.push({
            value: LAUNCH_ALL_SENTINEL,
            label: `Launch all (${q.length} queued)`,
            hint: "",
            color: toAnsiFg(T.mint),
          });
        }

        const packageOptions = [
          ...(rootScripts.length > 0
            ? [
                {
                  value: worktreePath,
                  label: "(root)",
                  hint: "workspace root",
                },
              ]
            : []),
          ...packages.map((p) => ({
            value: join(worktreePath, p.path),
            label: p.name,
            hint: p.path,
          })),
        ];

        const presetOption = q.length >= 2
          ? [
              { value: "__rt:sep2__", label: "──────────────", hint: "" },
              { value: SAVE_PRESET_SENTINEL, label: "Save as preset...", hint: "" },
            ]
          : [];

        const queueHeaderParts = q.length > 0
          ? [
              "enter: select",
              "ctrl-x: dequeue last",
              "ctrl-up: back to worktree",
              "esc: cancel",
            ]
          : [
              "enter: select",
              "ctrl-up: back to worktree",
              "esc: cancel",
            ];

        const pkgResult = await runNavPicker({
          options: [...queueOptions, ...packageOptions, ...presetOption],
          message: label ? `Select package — ${label}` : "Select package",
          headerParts: queueHeaderParts,
          expectKeys: q.length > 0 ? ["ctrl-x"] : [],
        });

        if (!pkgResult) process.exit(1);
        if (pkgResult.key === "ctrl-up") return null; // back to worktree

        // ── ctrl-x: dequeue last item ──────────────────────────────────────
        if (pkgResult.key === "ctrl-x" && q.length > 0) {
          const removed = q.pop()!;
          process.stderr.write(`  ${dim}dequeued: ${removed.packageLabel} > ${removed.script}${reset}\n`);
          cameFromScript = true; // re-show picker
          continue;
        }

        // ── Sentinel handling ──────────────────────────────────────────────
        const val = pkgResult.value ?? "";

        // Queued item rows are display-only -- re-show picker
        if (val.startsWith(QUEUED_PREFIX) || val === "__rt:sep1__" || val === "__rt:sep2__") {
          cameFromScript = true;
          continue;
        }

        // Launch all
        if (val === LAUNCH_ALL_SENTINEL) {
          return QUEUE_LAUNCHED;
        }

        // Save as preset then launch
        if (val === SAVE_PRESET_SENTINEL && dataDir) {
          const name = await textInput({
            message: "Preset name",
            placeholder: "e.g. backend-lite",
            stderr: true,
          });
          if (name) {
            savePreset(dataDir, {
              name,
              entries: q.map((qi) => ({
                packageRelPath: qi.packageRelPath,
                packageLabel: qi.packageLabel,
                script: qi.script,
                variationName: qi.variationName,
                command: qi.variationName ? qi.command : undefined,
              })),
            });
            process.stderr.write(`  ${green}✓${reset} ${dim}saved preset "${name}"${reset}\n`);
          }
          return QUEUE_LAUNCHED;
        }

        packagePath = pkgResult.value!;
        if (packagePath === worktreePath) {
          packageLabel = ".";
        } else {
          const pkg = packages.find(
            (p) => join(worktreePath, p.path) === packagePath,
          );
          packageLabel = pkg?.name ?? relative(worktreePath, packagePath);
        }
      }
    }

    cameFromScript = false;

    // ── Script selection ───────────────────────────────────────────────────

    const scripts = getPackageJsonScripts(packagePath);
    if (scripts.length === 0) {
      process.stderr.write(
        `No scripts found in ${packagePath}/package.json.\n`,
      );
      process.exit(1);
    }

    if (scripts.length === 1) {
      return {
        packagePath,
        packageLabel,
        selectedScript: scripts[0]!,
        customCommand: undefined,
      };
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

    // Last-run sentinel
    let lastRun: RunHistoryEntry | undefined;
    if (dataDir) {
      lastRun = readRunHistory(dataDir).find(
        (e) => e.cwd === packagePath && scripts.includes(e.script),
      );
    }

    const sentinelOption = lastRun
      ? [
          {
            value: LAST_RUN_SENTINEL,
            label: `↻ ${lastRun.script}`,
            hint: `last run · ${formatAge(lastRun.ts)}`,
            color: toAnsiFg(T.mint),
          },
        ]
      : [];

    const scriptHeaderParts = q.length > 0
      ? [
          "enter: queue",
          "tab: queue",
          "alt-enter: variations",
          "ctrl-up: back",
        ]
      : [
          "enter: run",
          "tab: queue",
          "alt-enter: variations",
          "ctrl-up: back",
        ];

    const scriptResult = await runNavPicker({
      options: [
        ...sentinelOption,
        ...scripts.map((s) => ({
          value: s,
          label: s,
          hint: pkgScripts[s]?.slice(0, 60),
        })),
      ],
      message: label
        ? `Select script — ${label} · ${packageLabel === "." ? "root" : packageLabel}`
        : "Select script",
      headerParts: scriptHeaderParts,
      expectKeys: ["alt-enter", "tab"],
    });

    if (!scriptResult) process.exit(1);

    const scriptName =
      scriptResult.value === LAST_RUN_SENTINEL
        ? lastRun!.script
        : scriptResult.value!;

    if (scriptResult.key === "ctrl-up") {
      if (packages.length > 1) {
        cameFromScript = true;
        continue; // back to package section
      }
      return null; // back to caller (ascends via path in outer loop)
    }

    // ── Helper: build a QueuedItem for the current selection ─────────────
    const pm = detectPackageManager(packagePath);
    const pkgRelPath = packagePath === worktreePath ? "." : relative(worktreePath, packagePath);

    const enqueue = (cmd: string, variationName?: string): void => {
      q.push({
        packageRelPath: pkgRelPath,
        packagePath,
        packageLabel,
        script: scriptName,
        command: cmd,
        variationName,
      });
      const varSuffix = variationName ? ` (${variationName})` : "";
      process.stderr.write(`  ${green}+${reset} ${dim}queued: ${packageLabel} > ${scriptName}${varSuffix}${reset}\n`);
    };

    // ── Tab key or Enter-with-queue: queue the base script ──────────────
    if (scriptResult.key === "tab" || (scriptResult.key === "" && q.length > 0)) {
      enqueue(`${pm} run ${scriptName}`);
      cameFromScript = true;
      continue; // bounce to package picker
    }

    if (scriptResult.key === "alt-enter") {
      // ── Variations sub-picker ────────────────────────────────────────────
      const existing = dataDir
        ? (loadVariations(dataDir)[variationKey(worktreePath, packagePath, scriptName)] ?? [])
        : [];

      const ADD_SENTINEL = "__rt:add-variation__";

      const varHeaderParts = q.length > 0
        ? ["enter: queue", "tab: queue", "ctrl-up: back to scripts", "esc: cancel"]
        : ["enter: select", "tab: queue", "ctrl-up: back to scripts", "esc: cancel"];

      while (true) {
        const varResult = await runNavPicker({
          options: [
            ...existing.map((v) => ({
              value: v.command,
              label: v.name,
              hint: v.command.slice(0, 60),
            })),
            { value: ADD_SENTINEL, label: "+ Add variation...", hint: "" },
          ],
          message: `Variation for "${scriptName}"`,
          headerParts: varHeaderParts,
          expectKeys: ["tab"],
        });

        if (!varResult) process.exit(1);
        if (varResult.key === "ctrl-up") break; // back to script picker

        if (varResult.value === ADD_SENTINEL) {
          const name = await textInput({
            message: "Variation name",
            placeholder: "e.g. with debug",
            stderr: true,
          });
          if (!name) process.exit(1);

          const baseCmd = `${pm} run ${scriptName}`;
          const command = await textInput({
            message: "Command",
            defaultValue: baseCmd,
            stderr: true,
          });
          if (!command) process.exit(1);

          if (dataDir) {
            saveVariation(dataDir, worktreePath, packagePath, scriptName, { name, command });
          }

          // Tab or Enter-with-queue: queue the new variation
          if (varResult.key === "tab" || q.length > 0) {
            enqueue(command, name);
            cameFromScript = true;
            break; // back to packages
          }

          return {
            packagePath,
            packageLabel,
            selectedScript: scriptName,
            customCommand: command,
          };
        }

        // Existing variation selected
        const varName = existing.find((v) => v.command === varResult.value)?.name;

        // Tab or Enter-with-queue: queue the variation
        if (varResult.key === "tab" || q.length > 0) {
          enqueue(varResult.value!, varName);
          cameFromScript = true;
          break; // back to packages
        }

        return {
          packagePath,
          packageLabel,
          selectedScript: scriptName,
          customCommand: varResult.value!,
        };
      }

      // Back from variations → re-show script picker (skip package)
      continue;
    }

    // Normal Enter with empty queue — run the base command (unchanged solo behavior)
    return {
      packagePath,
      packageLabel,
      selectedScript: scriptName,
      customCommand: undefined,
    };
  }
}

// ─── Queue launch ──────────────────────────────────────────────────────────

async function launchQueue(
  queue: QueuedItem[],
  worktreePath: string,
): Promise<void> {
  if (queue.length === 0) return;

  const items: LaunchItem[] = queue.map((qi) => {
    const cwd = qi.packagePath;
    const varSuffix = qi.variationName ? ` (${qi.variationName})` : "";
    return {
      label: `${qi.packageLabel} > ${qi.script}${varSuffix}`,
      command: qi.command,
      cwd,
    };
  });

  process.stderr.write(`\n`);
  if (isInsideHerdr()) {
    await launchInHerdr(items);
  } else {
    launchFallback(items);
  }
}

// ─── Entry ──────────────────────────────────────────────────────────────────

export async function runCommand(
  args: string[],
  ctx: CommandContext,
): Promise<void> {
  const resolveOnly = args.includes("--resolve-only");

  // Best-effort: ensure the shell history hook is installed so up-arrow
  // replays the actual command instead of "rt run".
  try { ensureHistoryHook(); } catch { /* don't block on setup */ }

  let worktreePath: string;
  let worktreeBranch: string;
  let dataDir: string | undefined;
  let packagePath = "";
  let packageLabel = "";
  let selectedScript = "";
  let customCommand: string | undefined;
  const queue: QueuedItem[] = [];

  // If the dispatcher resolved a worktree, try that first.  On ctrl-up
  // from the package picker, fall through to the full picker chain so
  // the user can choose a different worktree.
  let useResolved = !!ctx.identity;
  if (useResolved) {
    worktreePath = ctx.identity!.repoRoot;
    dataDir = ctx.identity!.dataDir;
    try {
      worktreeBranch = execSync("git rev-parse --abbrev-ref HEAD", {
        cwd: worktreePath,
        encoding: "utf8",
        stdio: "pipe",
      }).trim();
    } catch {
      worktreeBranch = "";
    }

    const ctxLabel = `${ctx.identity!.repoName} / ${basename(worktreePath)}`;
    const sel = await selectPackageAndScript(worktreePath, dataDir, ctxLabel, queue);
    if (sel === QUEUE_LAUNCHED) {
      // Queue was built and user chose "Launch all" -- launch and exit
      await launchQueue(queue, worktreePath);
      return;
    }
    if (sel) {
      packagePath = sel.packagePath;
      packageLabel = sel.packageLabel;
      selectedScript = sel.selectedScript;
      customCommand = sel.customCommand;
    } else {
      // User backed out — fall through to full picker chain
      useResolved = false;
    }
  }

  if (!useResolved) {
    // ── Full picker chain: repo → worktree → package → script ──────────────
    const knownRepos = getKnownRepos();
    if (knownRepos.length === 0) {
      process.stderr.write(
        "No known repos. Run rt from inside a git repo to register it.\n",
      );
      process.exit(1);
    }

    // If we fell through from a resolved context, start at the worktree
    // picker for that repo rather than re-asking which repo.
    const resolvedRepoName = ctx.identity?.repoName;
    let selectedRepo: KnownRepo | undefined = resolvedRepoName
      ? knownRepos.find((r) => r.repoName === resolvedRepoName)
      : knownRepos.length === 1
        ? knownRepos[0]!
        : undefined;

    repoLoop: while (true) {
      // ── Repo picker ─────────────────────────────────────────────────────
      if (!selectedRepo) {
        if (knownRepos.length === 1) process.exit(0); // back-propagated past last level
        const { runNavPicker } = await import("../lib/navigate.ts");
        const repoResult = await runNavPicker({
          options: knownRepos.map((r) => ({
            value: r.repoName,
            label: r.repoName,
            hint: `${r.worktrees.length} worktrees`,
          })),
          message: "Select repo",
          headerParts: ["enter: select", "esc: cancel"],
        });
        if (!repoResult) process.exit(1);
        selectedRepo = knownRepos.find((r) => r.repoName === repoResult.value)!;
      }

      const worktrees = selectedRepo.worktrees.filter((wt) =>
        existsSync(wt.path),
      );
      if (worktrees.length === 0) {
        process.stderr.write(
          `No accessible worktrees for ${selectedRepo.repoName}.\n`,
        );
        process.exit(1);
      }

      worktreeLoop: while (true) {
        // ── Worktree picker ──────────────────────────────────────────────
        if (worktrees.length === 1) {
          worktreePath = worktrees[0]!.path;
          worktreeBranch = worktrees[0]!.branch;
        } else {
          const { runNavPicker } = await import("../lib/navigate.ts");
          const { enrichBranches, formatBranchLabel } = await import("../lib/enrich.ts");
          let remoteUrl: string | undefined;
          try {
            remoteUrl = execSync("git config --get remote.origin.url", {
              cwd: worktrees[0]!.path, encoding: "utf8", stdio: "pipe",
            }).trim();
          } catch { /* no remote */ }
          const enriched = await enrichBranches(
            worktrees.map((wt) => ({ path: wt.path, branch: wt.branch })),
            remoteUrl,
          );
          const wtResult = await runNavPicker({
            options: enriched.map((eb) => ({
              value: eb.path,
              label: formatBranchLabel(eb),
              hint: "",
            })),
            message: `${selectedRepo.repoName} worktrees`,
            headerParts: [
              "enter: select",
              "ctrl-up: back to repo",
              "esc: cancel",
            ],
          });
          if (!wtResult) process.exit(1);
          if (wtResult.key === "ctrl-up") {
            process.stderr.write("\x1b[2J\x1b[H");
            selectedRepo = undefined;
            break worktreeLoop;
          }
          const wt = worktrees.find((w) => w.path === wtResult.value)!;
          worktreePath = wt.path;
          worktreeBranch = wt.branch;
        }

        dataDir = selectedRepo.dataDir;

        // ── Package + script ────────────────────────────────────────────
        while (true) {
          const wtCtx = worktrees.length > 1
            ? `${selectedRepo.repoName} / ${basename(worktreePath)}`
            : selectedRepo.repoName;
          const sel = await selectPackageAndScript(worktreePath, dataDir, wtCtx, queue);
          if (sel === QUEUE_LAUNCHED) {
            await launchQueue(queue, worktreePath);
            return;
          }
          if (!sel) {
            process.stderr.write("\x1b[2J\x1b[H");
            if (worktrees.length > 1) break; // re-show worktree picker
            // Only 1 worktree — propagate up to repo
            selectedRepo = undefined;
            break worktreeLoop;
          }
          packagePath = sel.packagePath;
          packageLabel = sel.packageLabel;
          selectedScript = sel.selectedScript;
          customCommand = sel.customCommand;
          break repoLoop; // exit all loops → run command
        }
      }
    }
  }

  // ── Build result ───────────────────────────────────────────────────────────

  const pm = detectPackageManager(packagePath);

  const result: RunResolveResult = {
    targetDir: packagePath,
    packageLabel,
    worktree: worktreePath,
    branch: worktreeBranch,
    commandTemplate: customCommand ?? `${pm} run ${selectedScript}`,
  };

  if (resolveOnly) {
    process.stdout.write(JSON.stringify(result) + "\n");
    return;
  }

  const cmd = customCommand ?? `${pm} run ${selectedScript}`;
  process.stderr.write(`\nRunning: ${cmd}\n`);
  process.stderr.write(`  in: ${packagePath}\n\n`);

  // Write the resolved command so a shell precmd hook can inject it into
  // shell history — pressing up arrow replays e.g. "cd packages/web && npm run test"
  // instead of "rt run".  Include a cd prefix when the target dir differs from CWD.
  try {
    const cwd = process.cwd();
    const shellCmd =
      packagePath === cwd
        ? cmd
        : (() => {
            const rel = relative(cwd, packagePath);
            // Use relative when it's a clean subdirectory path; absolute otherwise.
            const cdTarget = rel && !rel.startsWith("..") ? rel : packagePath;
            return `(cd ${cdTarget} && ${cmd})`;
          })();
    writeFileSync(join(rtDir(), "last-run-command"), shellCmd + "\n");
  } catch { /* best-effort */ }

  // Survive TTY Ctrl-C so the post-exit history append below actually runs.
  // SIGINT is delivered to the whole foreground process group; the child gets
  // it independently and exits — we just need the parent not to die first.
  process.on("SIGINT", () => {});

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

  // Write the resolved command so a shell precmd hook can inject it into
  // shell history — pressing up arrow replays the actual command.
  try {
    const cwd = process.cwd();
    const shellCmd =
      entry.cwd === cwd
        ? entry.cmd
        : (() => {
            const rel = relative(cwd, entry.cwd);
            const cdTarget = rel && !rel.startsWith("..") ? rel : entry.cwd;
            return `(cd ${cdTarget} && ${entry.cmd})`;
          })();
    writeFileSync(join(rtDir(), "last-run-command"), shellCmd + "\n");
  } catch { /* best-effort */ }

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
  // Prefer worktree name over repo name when they differ (e.g. "acme-wktree-2").
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
