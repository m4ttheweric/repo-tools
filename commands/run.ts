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
import { bold, dim, reset, yellow, green } from "../lib/tui.ts";
import {
  isInsideHerdr,
  launchInHerdr,
  launchFallback,
  type LaunchItem,
} from "../lib/herdr-launch.ts";
import { interactive } from "../lib/ui/gate.ts";
import { findPreset, loadPresets, savePreset, type Preset } from "../lib/run-presets.ts";
import { deriveRepoIdentity } from "../lib/settings/identity.ts";
import { repoLabel } from "../lib/repo-arg.ts";
import { runPick } from "../lib/ui/pick.ts";
import type { PickAction, PickRow, PickSegment } from "../lib/ui/protocol.ts";
import { runSeededBoard, tmuxAvailable, type SeedEntry } from "./runner.ts";

const LAST_RUN_SENTINEL = "__rt:last-run__";
const LAUNCH_ALL_SENTINEL = "__rt:launch-all__";
const SAVE_PRESET_SENTINEL = "__rt:save-preset__";
const PRESET_PREFIX = "__rt:preset:";
const QUEUED_PREFIX = "__queued:";

/** A picker cancellation or dead end. rt run exits with `code`; the runner treats it as "nothing chosen". */
export class RunAborted extends Error {
  constructor(public readonly code: number, message = "") {
    super(message);
    this.name = "RunAborted";
  }
}

export type RunResolution =
  | { kind: "resolved"; result: RunResolveResult }
  | { kind: "launched" }
  | { kind: "cancelled"; code: number };

export interface RunResolveResult {
  targetDir: string;
  packageLabel: string;
  worktree: string;
  branch: string;
  commandTemplate: string;
  script: string;
}

// ─── Segment-form picker rows ────────────────────────────────────────────────
//
// NavOption (lib/navigate.ts's runNavPicker) only carries a flat label+hint
// per row, so it can't express a per-segment tone (the mint ✓, the lavender
// variation suffix) or a named group boundary tied to live data rather than a
// separator row. These builders and `runSegmentPicker` talk to the rt-ui pick
// verb directly for that reason; the values they carry and the branching on
// the result below are unchanged from the NavOption-based picker they replace.

function queueRow(qi: QueuedItem, index: number): PickRow {
  const left: PickSegment[] = [
    { text: "✓ ", tone: "mint" },
    { text: `${qi.packageLabel} › ${qi.script}` },
  ];
  if (qi.variationName) left.push({ text: ` (${qi.variationName})`, tone: "lav" });
  if (qi.packageRelPath !== ".") left.push({ text: `  ${qi.packageRelPath}`, tone: "dim" });
  return { value: `${QUEUED_PREFIX}${index}__`, left, group: "queue" };
}

function launchAllRow(queuedCount: number): PickRow {
  return {
    value: LAUNCH_ALL_SENTINEL,
    left: [
      { text: "Launch all", bold: true },
      { text: `  ${queuedCount} queued → runner board`, tone: "dim" },
    ],
    group: "queue",
  };
}

function savePresetRow(): PickRow {
  return {
    value: SAVE_PRESET_SENTINEL,
    left: [
      { text: "Save as preset…", bold: true },
      { text: "  save the current queue", tone: "dim" },
    ],
    group: "queue",
  };
}

function presetRow(p: Preset): PickRow {
  return {
    value: `${PRESET_PREFIX}${p.name}__`,
    left: [
      { text: p.name, bold: true },
      { text: `  ${p.entries.map((e) => `${e.packageLabel}:${e.script}`).join(" + ")}`, tone: "dim" },
    ],
    group: "presets",
  };
}

/** Bold label plus a dim hint -- the plain two-column look every simple row shares. `labelWidth` pads the label so hints align down a row group; omit it for a standalone row. */
function plainRow(entry: { value: string; label: string; hint?: string }, group?: string, labelWidth?: number): PickRow {
  const label = labelWidth != null ? entry.label.padEnd(labelWidth) : entry.label;
  const left: PickSegment[] = [{ text: label, bold: true }];
  if (entry.hint) left.push({ text: `  ${entry.hint}`, tone: "dim" });
  return { value: entry.value, left, ...(group ? { group } : {}) };
}

function lastRunRow(entry: RunHistoryEntry): PickRow {
  return {
    value: LAST_RUN_SENTINEL,
    left: [
      { text: `↻ ${entry.script}`, tone: "mint" },
      { text: `  last run · ${formatAge(entry.ts)}`, tone: "dim" },
    ],
  };
}

/** `key: label` header parts become global footer actions -- exit keys (ctrl-up plus every expectKey) close the picker with that key as the action id; any other header part is a label-only action. Mirrors runNavPicker's own headerParts translation (lib/pick-wrappers.ts), which NavOption-based call sites get for free but a raw `rows` request has to build itself. */
function footerActions(headerParts: string[], expectKeys: string[]): PickAction[] {
  const exitKeys = new Set<string>(["ctrl-up", ...expectKeys]);
  const headerLabels = new Map(
    headerParts.map((part) => {
      const sep = part.indexOf(": ");
      return sep < 0 ? ([part, part] as const) : ([part.slice(0, sep), part.slice(sep + 2)] as const);
    }),
  );
  const actions: PickAction[] = [];
  for (const key of exitKeys) {
    actions.push({ id: key, label: headerLabels.get(key) ?? key, key, scope: "global", event: false });
  }
  for (const [key, label] of headerLabels) {
    if (exitKeys.has(key)) continue;
    actions.push({ id: key, label, key, scope: "global" });
  }
  return actions;
}

interface SegmentPickResult {
  value: string | null;
  /** "" for a plain accept, otherwise the exit key pressed (ctrl-up, tab, alt-enter, ctrl-x, ...). */
  key: string;
  query: string;
}

/** Runs a picker from pre-built rows and returns the same {value, key, query} triple runNavPicker returns, or null on cancel. */
async function runSegmentPicker(opts: {
  message: string;
  rows: PickRow[];
  headerParts: string[];
  expectKeys?: string[];
  resumeValue?: string;
  breadcrumb?: string[];
}): Promise<SegmentPickResult | null> {
  const handle = runPick({
    message: opts.message,
    rows: opts.rows,
    actions: footerActions(opts.headerParts, opts.expectKeys ?? []),
    ...(opts.resumeValue ? { resumeValue: opts.resumeValue } : {}),
    ...(opts.breadcrumb ? { breadcrumb: opts.breadcrumb } : {}),
  });
  const result = await handle.result;

  if (result.action === "cancel" || result.action === "esc") return null;
  const key = result.action === "select" || result.action === "enter" ? "" : result.action;
  return { value: result.value ?? null, key, query: result.query };
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

/** The shape savePreset/saveVariation both return — structurally, not by import, so either fits. */
type SaveOutcome =
  | { ok: true }
  | { ok: false; reason: "no-identity" }
  | { ok: false; reason: "write-failed"; message: string };

/**
 * Prints the truth about a save: a checkmark only when it actually landed,
 * one honest line otherwise. `savePreset`/`saveVariation` no-op or refuse
 * rather than throw (best-effort I/O), so this is the only place that ever
 * tells the user whether their save happened.
 */
function reportSave(kind: string, label: string, result: SaveOutcome, repoLabel: string): void {
  if (result.ok) {
    process.stderr.write(`  ${green}✓${reset} ${dim}saved ${kind} "${label}"${reset}\n`);
    return;
  }
  const detail = result.reason === "no-identity"
    ? `no repo identity for ${repoLabel}; pin one with \`rt settings set rt.repoIdentityOverrides\``
    : result.message;
  process.stderr.write(`  ${yellow}⚠${reset} ${dim}not saved — ${detail}${reset}\n`);
}

export const __test__ = {
  reportSave,
  queueRow,
  launchAllRow,
  savePresetRow,
  presetRow,
  plainRow,
  lastRunRow,
  footerActions,
};

/**
 * Package → script → variations picker loop.
 *
 * Returns null when the user backs out of the package picker (ctrl-up).
 * Returns ScriptSelection when a script (or variation) is selected.
 * Returns QUEUE_LAUNCHED when the user built a multi-pick queue and launched it.
 */
async function selectPackageAndScript(
  worktreePath: string,
  // The serialized identity (run_history's store key), NOT the raw
  // `repoIdentity` local below (settings-section key for presets/variations)
  // — the two are different string forms for the same repo.
  repoName: string | undefined,
  ctx: CommandContext,
  contextLabel?: string,
  queue?: QueuedItem[],
): Promise<ScriptSelection | typeof QUEUE_LAUNCHED | null> {
  const { runNavPicker } = await import("../lib/navigate.ts");
  const packages = getWorkspacePackages(worktreePath);
  const label = contextLabel ? `${contextLabel}` : "";
  const breadcrumb = label ? ["rt", "run", label] : ["rt", "run"];
  const derivedIdentity = await deriveRepoIdentity(worktreePath);
  const repoIdentity = derivedIdentity.kind === "remote" ? derivedIdentity.id : null;
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
        const rootScripts = getPackageJsonScripts(worktreePath);

        // ── Rows, in board order: queue (✓ items, Launch all, Save as
        // preset…) → presets → packages. Each is a real named group. ────────
        const rows: PickRow[] = [];

        if (q.length > 0) {
          q.forEach((qi, i) => rows.push(queueRow(qi, i)));
          rows.push(launchAllRow(q.length));
          if (q.length >= 2) rows.push(savePresetRow());
        }

        // ── Saved presets (shown above packages, only outside an active queue) ──
        const presets = q.length === 0 ? loadPresets(repoIdentity) : [];
        presets.forEach((p) => rows.push(presetRow(p)));

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
        const packageLabelWidth = packageOptions.reduce((w, o) => Math.max(w, o.label.length), 0);
        packageOptions.forEach((entry) => rows.push(plainRow(entry, "packages", packageLabelWidth)));

        const queueHeaderParts = q.length > 0
          ? [
              "enter: select",
              "ctrl-x: dequeue",
              "esc: quit",
            ]
          : [
              "enter: select",
              "ctrl-up: back",
              "esc: quit",
            ];

        // Cursor lands on Launch all with 2+ queued (the likely next action),
        // or the first package with exactly 1 queued (inviting a second pick)
        // -- same target rows the old index math landed on, by value instead.
        const resumeValue = q.length >= 2
          ? LAUNCH_ALL_SENTINEL
          : q.length === 1
            ? packageOptions[0]?.value
            : undefined;

        const pkgResult = await runSegmentPicker({
          rows,
          message: label ? `Select package — ${label}` : "Select package",
          headerParts: queueHeaderParts,
          expectKeys: q.length > 0 ? ["ctrl-x"] : [],
          resumeValue,
          breadcrumb,
        });

        if (!pkgResult) throw new RunAborted(1);
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
        if (val.startsWith(QUEUED_PREFIX)) {
          cameFromScript = true;
          continue;
        }

        // Launch all
        if (val === LAUNCH_ALL_SENTINEL) {
          return QUEUE_LAUNCHED;
        }

        // Saved preset selected — resolve against this worktree and launch
        if (val.startsWith(PRESET_PREFIX)) {
          const presetName = val.slice(PRESET_PREFIX.length, -2); // strip prefix + trailing "__"
          const preset = findPreset(repoIdentity, presetName);
          if (preset) {
            await launchPreset(preset, worktreePath, ctx);
            return QUEUE_LAUNCHED; // signal "already launched" — q is empty, launchQueue() is a no-op
          }
          cameFromScript = true;
          continue;
        }

        // Save as preset, then ask whether to run it now
        if (val === SAVE_PRESET_SENTINEL) {
          const { confirm, textInput } = await import("../lib/rt-render.ts");
          const name = await textInput({
            message: "Preset name",
            placeholder: "e.g. backend-lite",
            stderr: true,
          });
          if (name) {
            const result = savePreset(repoIdentity, {
              name,
              entries: q.map((qi) => ({
                packageRelPath: qi.packageRelPath,
                packageLabel: qi.packageLabel,
                script: qi.script,
                variationName: qi.variationName,
                command: qi.variationName ? qi.command : undefined,
              })),
            });
            reportSave("preset", name, result, label || worktreePath);
            process.stderr.write("\n");
            const runNow = await confirm({
              message: `Run "${name}" now?`,
              initialValue: true,
              stderr: true,
            });
            if (runNow) return QUEUE_LAUNCHED;
          }
          // User cancelled name or declined to run -- back to picker
          cameFromScript = true;
          continue;
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
      throw new RunAborted(1);
    }

    if (scripts.length === 1) {
      const only = scripts[0]!;
      // With a queue active, returning would discard the queued items (the
      // caller only launches the queue on QUEUE_LAUNCHED) — queue it instead.
      if (q.length > 0) {
        q.push({
          packageRelPath: packagePath === worktreePath ? "." : relative(worktreePath, packagePath),
          packagePath,
          packageLabel,
          script: only,
          command: `${detectPackageManager(packagePath)} run ${only}`,
        });
        process.stderr.write(`  ${green}+${reset} ${dim}queued: ${packageLabel} > ${only}${reset}\n`);
        cameFromScript = true;
        continue;
      }
      return {
        packagePath,
        packageLabel,
        selectedScript: only,
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
    if (repoName) {
      lastRun = readRunHistory(repoName).find(
        (e) => e.cwd === packagePath && scripts.includes(e.script),
      );
    }

    const scriptRows: PickRow[] = [];
    if (lastRun) scriptRows.push(lastRunRow(lastRun));
    scripts.forEach((s) => scriptRows.push(plainRow({ value: s, label: s, hint: pkgScripts[s]?.slice(0, 60) })));

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

    const scriptResult = await runSegmentPicker({
      rows: scriptRows,
      message: label
        ? `Select script — ${label} · ${packageLabel === "." ? "root" : packageLabel}`
        : "Select script",
      headerParts: scriptHeaderParts,
      expectKeys: ["alt-enter", "tab"],
      breadcrumb,
    });

    if (!scriptResult) throw new RunAborted(1);

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
      const existing = loadVariations(repoIdentity)[variationKey(worktreePath, packagePath, scriptName)] ?? [];

      const ADD_SENTINEL = "__rt:add-variation__";

      const varHeaderParts = q.length > 0
        ? ["enter: queue", "tab: queue", "ctrl-up: back"]
        : ["enter: run", "tab: queue", "ctrl-up: back"];

      while (true) {
        const varResult = await runNavPicker({
          options: [
            ...existing.map((v) => ({
              value: v.command,
              label: v.name,
              hint: v.command.slice(0, 60),
            })),
            { value: ADD_SENTINEL, label: "+ Add variation…", hint: "" },
          ],
          message: `Variation for "${scriptName}"`,
          headerParts: varHeaderParts,
          expectKeys: ["tab"],
        });

        if (!varResult) throw new RunAborted(1);
        if (varResult.key === "ctrl-up") break; // back to script picker

        if (varResult.value === ADD_SENTINEL) {
          const { textInput } = await import("../lib/rt-render.ts");
          const name = await textInput({
            message: "Variation name",
            placeholder: "e.g. with debug",
            stderr: true,
          });
          if (!name) throw new RunAborted(1);

          const baseCmd = `${pm} run ${scriptName}`;
          const command = await textInput({
            message: "Command",
            defaultValue: baseCmd,
            stderr: true,
          });
          if (!command) throw new RunAborted(1);

          reportSave(
            "variation",
            name,
            saveVariation(repoIdentity, worktreePath, packagePath, scriptName, { name, command }),
            label || worktreePath,
          );

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
    // Re-resolve against the launch worktree (like launchPreset does) — the
    // queue can be carried across a worktree switch, and qi.packagePath still
    // points into the worktree where the item was queued.
    const cwd = join(worktreePath, qi.packageRelPath);
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

/** Maps a saved preset's entries to runner seed rows, resolved against `worktreePath`. Pure (no spawning), so it stays directly testable. */
export function presetToSeed(preset: Preset, worktreePath: string): SeedEntry[] {
  return preset.entries.map((e) => ({
    name: `${e.script}${e.variationName ? ` (${e.variationName})` : ""}`,
    command: e.command ?? `${detectPackageManager(join(worktreePath, e.packageRelPath))} run ${e.script}`,
    cwd: join(worktreePath, e.packageRelPath),
    pkg: e.packageLabel,
    repo: basename(worktreePath),
  }));
}

/** Resolve a saved preset's entries against the current worktree and open a seeded runner board (or run them in place when herdr isn't available). Exported for direct testing, same as presetToSeed. */
export async function launchPreset(preset: Preset, worktreePath: string, ctx: CommandContext): Promise<void> {
  if (interactive() && tmuxAvailable()) {
    const seed = presetToSeed(preset, worktreePath);
    await runSeededBoard(seed, ctx);
  } else {
    // The board never opens on this path, so the echo is the only cue of what launched.
    process.stderr.write(`\n  preset ${bold}${preset.name}${reset}\n\n`);
    const items: LaunchItem[] = preset.entries.map((e) => ({
      label: `${e.packageLabel} → ${e.script}${e.variationName ? ` (${e.variationName})` : ""}`,
      command: e.command ?? `${detectPackageManager(join(worktreePath, e.packageRelPath))} run ${e.script}`,
      cwd: join(worktreePath, e.packageRelPath),
    }));
    launchFallback(items);
  }
}

// ─── Entry ──────────────────────────────────────────────────────────────────

export async function resolveRun(
  args: string[],
  ctx: CommandContext,
): Promise<RunResolution> {
  try {
    // Definite-assignment asserted: every path to the build-result section
    // assigns both (resolved-context branch or picker loops), but tsc can't
    // follow the labeled `break repoLoop` flow.
    let worktreePath!: string;
    let worktreeBranch!: string;
    let repoName: string | undefined;
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
      // The serialized identity, not the display name — this flows into
      // selectPackageAndScript purely as the run_history store key.
      repoName = ctx.identity!.identity;

      // ── Preset direct invoke: `rt run <preset-name>` ──────────────────────
      const presetArg = args.find((a) => !a.startsWith("-") && a !== "again");
      if (presetArg) {
        const derivedIdentity = await deriveRepoIdentity(worktreePath);
        const preset = findPreset(derivedIdentity.kind === "remote" ? derivedIdentity.id : null, presetArg);
        if (preset) {
          await launchPreset(preset, worktreePath, ctx);
          return { kind: "launched" };
        }
      }

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
      const sel = await selectPackageAndScript(worktreePath, repoName, ctx, ctxLabel, queue);
      if (sel === QUEUE_LAUNCHED) {
        // Queue was built and user chose "Launch all" -- launch and exit
        await launchQueue(queue, worktreePath);
        return { kind: "launched" };
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
        throw new RunAborted(1);
      }

      // If we fell through from a resolved context, start at the worktree
      // picker for that repo rather than re-asking which repo. The index keys
      // KnownRepo.repoName holds are serialized identities now, so the match is
      // against ctx.identity.identity — matching the display name here finds
      // nothing and, with one known repo, exits instead of re-showing a picker.
      const resolvedIdentity = ctx.identity?.identity;
      let selectedRepo: KnownRepo | undefined = resolvedIdentity
        ? knownRepos.find((r) => r.repoName === resolvedIdentity)
        : knownRepos.length === 1
          ? knownRepos[0]!
          : undefined;

      repoLoop: while (true) {
        // ── Repo picker ─────────────────────────────────────────────────────
        if (!selectedRepo) {
          if (knownRepos.length === 1) throw new RunAborted(0); // back-propagated past last level
          const { runNavPicker } = await import("../lib/navigate.ts");
          const repoResult = await runNavPicker({
            options: knownRepos.map((r) => ({
              value: r.repoName,
              label: repoLabel(r.repoName),
              hint: `${r.worktrees.length} worktrees`,
            })),
            message: "Select repo",
            headerParts: ["enter: select", "esc: quit"],
          });
          if (!repoResult) throw new RunAborted(1);
          // ctrl-up here is "back" with nowhere left to go, exactly like the
          // single-repo case above. Without this the key falls through and
          // selects whatever row the cursor was on, so with more than one known
          // repo there is no way out of Select repo <-> Select package.
          if (repoResult.key === "ctrl-up") throw new RunAborted(0);
          selectedRepo = knownRepos.find((r) => r.repoName === repoResult.value)!;
        }

        const worktrees = selectedRepo.worktrees.filter((wt) =>
          existsSync(wt.path),
        );
        if (worktrees.length === 0) {
          process.stderr.write(
            `No accessible worktrees for ${repoLabel(selectedRepo.repoName)}.\n`,
          );
          throw new RunAborted(1);
        }

        worktreeLoop: while (true) {
          // ── Worktree picker ──────────────────────────────────────────────
          if (worktrees.length === 1) {
            worktreePath = worktrees[0]!.path;
            worktreeBranch = worktrees[0]!.branch;
          } else {
            const { enrichBranches, formatBranchSegments } = await import("../lib/enrich.ts");
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
            const wtResult = await runSegmentPicker({
              rows: enriched.map((eb) => {
                const { left, right } = formatBranchSegments(eb);
                return { value: eb.path, left, right };
              }),
              message: `${repoLabel(selectedRepo.repoName)} worktrees`,
              headerParts: [
                "enter: select",
                "ctrl-up: back to repo",
                "esc: quit",
              ],
              breadcrumb: ["rt", "run", repoLabel(selectedRepo.repoName)],
            });
            if (!wtResult) throw new RunAborted(1);
            if (wtResult.key === "ctrl-up") {
              process.stderr.write("\x1b[2J\x1b[H");
              selectedRepo = undefined;
              break worktreeLoop;
            }
            const wt = worktrees.find((w) => w.path === wtResult.value)!;
            worktreePath = wt.path;
            worktreeBranch = wt.branch;
          }

          // KnownRepo.repoName is the repo-index key, itself the serialized
          // identity — already the correct run_history store key.
          repoName = selectedRepo.repoName;

          // ── Package + script ────────────────────────────────────────────
          while (true) {
            const wtCtx = worktrees.length > 1
              ? `${repoLabel(selectedRepo.repoName)} / ${basename(worktreePath)}`
              : repoLabel(selectedRepo.repoName);
            const sel = await selectPackageAndScript(worktreePath, repoName, ctx, wtCtx, queue);
            if (sel === QUEUE_LAUNCHED) {
              await launchQueue(queue, worktreePath);
              return { kind: "launched" };
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
      script: selectedScript,
    };

    return { kind: "resolved", result };
  } catch (e) {
    if (e instanceof RunAborted) return { kind: "cancelled", code: e.code };
    throw e;
  }
}

export async function runCommand(
  args: string[],
  ctx: CommandContext,
): Promise<void> {
  const resolveOnly = args.includes("--resolve-only");

  // Best-effort: ensure the shell history hook is installed so up-arrow
  // replays the actual command instead of "rt run".
  try { ensureHistoryHook(); } catch { /* don't block on setup */ }

  const res = await resolveRun(args, ctx);
  if (res.kind === "launched") return;
  if (res.kind === "cancelled") process.exit(res.code);
  const result = res.result;

  if (resolveOnly) {
    process.stdout.write(JSON.stringify(result) + "\n");
    return;
  }

  const packagePath = result.targetDir;
  const packageLabel = result.packageLabel;
  const worktreePath = result.worktree;
  const worktreeBranch = result.branch;
  const selectedScript = result.script;
  const cmd = result.commandTemplate;

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
    appendRunHistory(ctx.identity.identity, {
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
 * No repo/worktree resolution step. Reads every known repo's run history,
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

  const { filterableSelect } = await import("../lib/pick-wrappers.ts");
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

  const { entry, repoName } = picked;

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

  // Survive TTY Ctrl-C so the post-exit history append below actually runs
  // (same as runCommand — SIGINT goes to the whole foreground process group).
  process.on("SIGINT", () => {});

  const proc = Bun.spawn([SHELL, "-c", entry.cmd], {
    cwd: entry.cwd,
    stdio: ["inherit", "inherit", "inherit"],
  });

  const exitCode = await proc.exited;

  appendRunHistory(repoName, {
    ...entry,
    ts: new Date().toISOString(),
    exit: typeof exitCode === "number" ? exitCode : null,
  });

  process.exit(exitCode ?? 0);
}

interface TaggedEntry {
  entry: RunHistoryEntry;
  /** KnownRepo.repoName — the repo-index key, i.e. the serialized identity, not a display name. */
  repoName: string;
}

function loadAllRunHistory(): { entries: TaggedEntry[]; totalRepos: number } {
  const repos = getKnownRepos();
  const all: TaggedEntry[] = [];
  for (const repo of repos) {
    // repo.repoName IS the identity already (the repo index keys on it) —
    // readRunHistory's argument and run_history's `repo` column agree.
    for (const entry of readRunHistory(repo.repoName)) {
      all.push({ entry, repoName: repo.repoName });
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
