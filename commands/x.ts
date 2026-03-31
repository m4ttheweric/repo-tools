#!/usr/bin/env bun

/**
 * rt x — Generic script runner.
 *
 * Usage:
 *   rt x                   list saved scripts + run one
 *   rt x <name> [flags]    run a named script
 *   rt x create            interactive script wizard
 *   rt x edit [--script=n] open a script's JSON in $EDITOR
 *
 * Scripts are composed of setup → commands → teardown steps.
 * Any step can have a `flag` field so it only runs when that flag is passed.
 */

import { execSync, spawnSync } from "child_process";
import { existsSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { bold, cyan, dim, green, yellow, red, reset } from "../lib/tui.ts";
import { requireIdentity, getWorkspacePackages, pickRepoInteractive } from "../lib/repo.ts";
import {
  loadScript, saveScript, listScripts, filterSteps, isReservedName,
  resolveScriptPath,
  type RtScript, type StepDef, type Multiplexer,
} from "../lib/script-store.ts";
import { launch, type MuxCommand } from "../lib/multiplexer.ts";

// ─── Package manager detection ───────────────────────────────────────────────

function detectPackageManager(repoRoot: string): string {
  if (existsSync(join(repoRoot, "bun.lock")) || existsSync(join(repoRoot, "bun.lockb"))) return "bun";
  if (existsSync(join(repoRoot, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(repoRoot, "yarn.lock"))) return "yarn";
  return "npm";
}



// ─── Step execution ──────────────────────────────────────────────────────────

function stepBanner(num: number, total: number, label: string): void {
  console.log(`\n  ${bold}${cyan}[${num}/${total}]${reset} ${bold}${label}${reset}`);
}

function runSteps(steps: StepDef[], repoRoot: string, phase: string): boolean {
  if (steps.length === 0) return true;

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    const cwdHint = step.cwd ? ` ${dim}(${step.cwd})${reset}` : "";
    stepBanner(i + 1, steps.length, `${phase}: ${step.label}${cwdHint}`);

    const cwd = step.cwd ? join(repoRoot, step.cwd) : repoRoot;
    const result = spawnSync("sh", ["-c", step.command], {
      cwd,
      stdio: "inherit",
    });

    if (result.status !== 0) {
      console.log(`\n  ${red}${step.label} failed (exit ${result.status})${reset}\n`);
      return false;
    }
    console.log(`  ${green}✓ ${step.label}${reset}`);
  }
  return true;
}

// ─── Execute a script ────────────────────────────────────────────────────────

async function executeScript(
  script: RtScript,
  activeFlags: Set<string>,
  muxOverride: Multiplexer | undefined,
  repoRoot: string,
): Promise<void> {
  const mux = muxOverride ?? script.multiplexer ?? "concurrent";
  const setup = filterSteps(script.setup, activeFlags);
  const commands = filterSteps(script.commands, activeFlags);
  const teardown = filterSteps(script.teardown, activeFlags);

  // Write breadcrumb so the shell wrapper can cd after execution.
  // Single command with a cwd → resolve into that subdir; otherwise repo root.
  const targetCwd = commands.length === 1 && commands[0]!.cwd
    ? join(repoRoot, commands[0]!.cwd)
    : repoRoot;
  try {
    const rtDir = join(homedir(), ".rt");
    mkdirSync(rtDir, { recursive: true });
    writeFileSync(join(rtDir, ".last-cwd"), targetCwd);
  } catch { /* best-effort */ }

  console.log(`\n  ${bold}${cyan}rt x${reset} ${bold}${script.name}${reset}`);
  if (script.description) {
    console.log(`  ${dim}${script.description}${reset}`);
  }

  const flagList = [...activeFlags].filter((f) => f !== script.name);
  if (flagList.length > 0) {
    console.log(`  ${dim}flags: ${flagList.join(" ")}${reset}`);
  }

  // Setup
  if (setup.length > 0) {
    if (!runSteps(setup, repoRoot, "setup")) {
      process.exit(1);
    }
  }

  // Commands
  if (commands.length > 0) {
    const muxCommands: MuxCommand[] = commands.map((c) => ({
      label: c.label,
      command: c.command,
      cwd: c.cwd,
    }));

    console.log(`\n  ${bold}${cyan}launching${reset} ${dim}(${mux})${reset}`);
    const result = await launch(mux, muxCommands, repoRoot);

    // Teardown (always attempt, even after failure)
    if (teardown.length > 0) {
      console.log("");
      runSteps(teardown, repoRoot, "teardown");
    }

    process.exit(result.exitCode);
  } else {
    console.log(`\n  ${yellow}no commands to run${reset}\n`);
  }
}

// ─── Wizard: create a new script ─────────────────────────────────────────────

async function wizard(repoRoot: string, dataDir: string): Promise<void> {
  const {
    select, multiselect, confirm: inkConfirm, textInput,
    filterableMultiselect, filterableSelect,
  } = await import("../lib/rt-render.tsx");

  // ── Mutable draft state ────────────────────────────────────────────────────

  const draft = {
    name: "",
    description: "",
    commands: [] as StepDef[],
    setup: [] as StepDef[],
    teardown: [] as StepDef[],
    multiplexer: undefined as Multiplexer | undefined,
    scope: undefined as "team" | "user" | undefined,
  };

  // ── Live preview renderer ──────────────────────────────────────────────────

  function renderPreview(): void {
    console.clear();
    console.log(`  ${bold}${cyan}rt x create${reset} ${dim}— script wizard${reset}\n`);

    if (draft.name) {
      console.log(`  ${bold}${draft.name}${reset}${draft.description ? ` ${dim}— ${draft.description}${reset}` : ""}`);
    }

    // Commands
    if (draft.commands.length > 0) {
      console.log(`\n  ${cyan}commands:${reset}`);
      for (const c of draft.commands) {
        const flag = c.flag ? ` ${yellow}[${c.flag}]${reset}` : "";
        const cwd = c.cwd ? ` ${dim}(${c.cwd})${reset}` : "";
        console.log(`    ${green}✓${reset} ${c.label}${cwd}${flag}`);
      }
    }

    // Setup
    if (draft.setup.length > 0) {
      console.log(`\n  ${cyan}setup:${reset}`);
      for (const s of draft.setup) {
        const flag = s.flag ? ` ${yellow}[${s.flag}]${reset}` : "";
        console.log(`    ${green}✓${reset} ${s.label}${flag}`);
      }
    }

    // Teardown
    if (draft.teardown.length > 0) {
      console.log(`\n  ${cyan}teardown:${reset}`);
      for (const t of draft.teardown) {
        const flag = t.flag ? ` ${yellow}[${t.flag}]${reset}` : "";
        console.log(`    ${green}✓${reset} ${t.label}${flag}`);
      }
    }

    // Multiplexer & scope
    if (draft.multiplexer || draft.scope) {
      console.log("");
      if (draft.multiplexer) console.log(`  ${dim}multiplexer:${reset} ${draft.multiplexer}`);
      if (draft.scope) console.log(`  ${dim}scope:${reset} ${draft.scope}`);
    }

    console.log("");
  }

  // ── Script name ────────────────────────────────────────────────────────────

  renderPreview();
  draft.name = (await textInput({
    message: "Script name",
    placeholder: "dev",
  })).trim();

  if (!draft.name) {
    console.log(`\n  ${dim}cancelled${reset}\n`);
    return;
  }

  if (isReservedName(draft.name)) {
    console.log(`\n  ${red}"${draft.name}" is a reserved name${reset}\n`);
    return;
  }

  renderPreview();
  draft.description = (await textInput({
    message: "Description (optional)",
    placeholder: "start dev servers",
  })).trim();

  // ── Workspace package discovery ────────────────────────────────────────────

  const packages = getWorkspacePackages(repoRoot);
  const pm = detectPackageManager(repoRoot);

  const availableScripts: { label: string; value: string; hint: string }[] = [];
  for (const pkg of packages) {
    try {
      const pkgJson = JSON.parse(
        await Bun.file(join(repoRoot, pkg.path, "package.json")).text(),
      );
      const scripts = pkgJson.scripts ?? {};
      for (const [scriptName] of Object.entries(scripts)) {
        availableScripts.push({
          label: `${pkg.name} → ${scriptName}`,
          value: JSON.stringify({ pkg: pkg.name, script: scriptName, path: pkg.path }),
          hint: `${pm} run ${scriptName} (${pkg.path})`,
        });
      }
    } catch {
      /* skip packages without package.json or scripts */
    }
  }

  /**
   * Shared flow for collecting steps.
   * Offers: pick from workspace packages (fzf) or write a custom command.
   */
  async function collectSteps(
    phase: string,
    target: StepDef[],
    multiPick: boolean,
  ): Promise<void> {
    let addMore = true;

    while (addMore) {
      renderPreview();

      let source = "custom";
      if (availableScripts.length > 0) {
        source = await select({
          message: `${phase}: add from…`,
          options: [
            { label: "Workspace package scripts", value: "workspace", hint: "pick from package.json" },
            { label: "Custom command", value: "custom", hint: "type a shell command" },
            ...(target.length > 0 ? [{ label: "Done", value: "done", hint: `${target.length} added` }] : []),
          ],
        });
      }

      if (source === "done") break;

      if (source === "workspace") {
        if (multiPick) {
          let confirmed = false;
          while (!confirmed) {
            const selected = await filterableMultiselect({
              message: `Select ${phase.toLowerCase()} commands`,
              options: availableScripts,
            });

            if (selected.length === 0) break;

            const parsed = selected.map((val) => JSON.parse(val));

            renderPreview();
            console.log(`  ${bold}${cyan}selected:${reset}`);
            for (const p of parsed) {
              console.log(`    ${green}✓${reset} ${p.pkg} → ${p.script} ${dim}(${p.path})${reset}`);
            }
            console.log("");

            const ok = await inkConfirm({ message: "Looks good?", initialValue: true });

            if (ok) {
              const newSteps: StepDef[] = parsed.map((p: any) => ({
                label: `${p.pkg} → ${p.script}`,
                command: `${pm} run ${p.script}`,
                cwd: p.path,
              }));

              // Ask about flags
              renderPreview();
              const wantFlags = await inkConfirm({
                message: "Make any of these conditional (only run with a flag)?",
                initialValue: false,
              });

              if (wantFlags) {
                for (let i = 0; i < newSteps.length; i++) {
                  renderPreview();
                  const gate = await inkConfirm({
                    message: `Flag-gate "${newSteps[i]!.label}"?`,
                    initialValue: false,
                  });

                  if (gate) {
                    renderPreview();
                    const flagName = await textInput({
                      message: `Flag for "${newSteps[i]!.label}"`,
                      placeholder: "--storybook",
                    });
                    if (flagName.trim()) {
                      newSteps[i]!.flag = flagName.trim();
                    }
                  }
                }
              }

              target.push(...newSteps);
              confirmed = true;
            }
          }
        } else {
          const selected = await filterableSelect({
            message: `Pick a ${phase.toLowerCase()} script`,
            options: availableScripts,
          });

          if (!selected) break;

          const parsed = JSON.parse(selected);
          renderPreview();
          const flagInput = await textInput({
            message: "Only run with flag? (optional)",
            placeholder: "--clean",
          });

          const step: StepDef = {
            label: `${parsed.pkg} → ${parsed.script}`,
            command: `${pm} run ${parsed.script}`,
            cwd: parsed.path,
          };
          if (flagInput.trim()) step.flag = flagInput.trim();
          target.push(step);
        }
      } else {
        renderPreview();
        const label = await textInput({ message: "Label", placeholder: "backend" });
        const command = await textInput({ message: "Shell command", placeholder: `${pm} start` });
        const cwd = await textInput({ message: "Subdirectory (optional)", placeholder: "apps/backend" });
        const flagInput = await textInput({ message: "Only run with flag? (optional)", placeholder: "--clean" });

        const step: StepDef = { label, command };
        if (cwd.trim()) step.cwd = cwd.trim();
        if (flagInput.trim()) step.flag = flagInput.trim();
        target.push(step);
      }

      renderPreview();
      addMore = await inkConfirm({
        message: `Add another ${phase.toLowerCase()} step?`,
        initialValue: false,
      });
    }
  }

  // ── Commands ───────────────────────────────────────────────────────────────

  await collectSteps("Command", draft.commands, true);

  // ── Setup steps ────────────────────────────────────────────────────────────

  const hasTurbo = existsSync(join(repoRoot, "turbo.json"));
  if (hasTurbo && draft.commands.length > 0) {
    renderPreview();
    const wantBuildDeps = await inkConfirm({
      message: "Add turbo build-deps step? (builds dependencies for your selected packages)",
      initialValue: true,
    });

    if (wantBuildDeps) {
      // Group packages by their flag (or no flag)
      const byFlag = new Map<string, string[]>(); // flag → package names

      for (const cmd of draft.commands) {
        if (cmd.cwd) {
          try {
            const pkgJson = JSON.parse(
              await Bun.file(join(repoRoot, cmd.cwd, "package.json")).text(),
            );
            if (pkgJson.name) {
              const key = cmd.flag ?? "";
              if (!byFlag.has(key)) byFlag.set(key, []);
              byFlag.get(key)!.push(pkgJson.name);
            }
          } catch { /* skip */ }
        }
      }

      for (const [flag, pkgNames] of byFlag) {
        const filters = pkgNames
          .flatMap((name) => [`--filter=${name}...`, `--filter=!${name}`])
          .join(" ");
        const step: StepDef = {
          label: flag ? `build deps (${flag})` : "build deps",
          command: `${pm} turbo run build --output-logs=new-only ${filters}`,
        };
        if (flag) step.flag = flag;
        draft.setup.push(step);
      }
    }
  }

  renderPreview();
  const wantSetup = await inkConfirm({
    message: draft.setup.length > 0
      ? "Add more setup steps?"
      : "Add setup steps? (run before commands)",
    initialValue: false,
  });

  if (wantSetup) {
    await collectSteps("Setup", draft.setup, false);
  }

  // ── Teardown steps ─────────────────────────────────────────────────────────

  renderPreview();
  const wantTeardown = await inkConfirm({
    message: "Add teardown steps? (run after commands exit)",
    initialValue: false,
  });

  if (wantTeardown) {
    await collectSteps("Teardown", draft.teardown, false);
  }

  // ── Multiplexer ────────────────────────────────────────────────────────────

  if (draft.commands.filter((c) => !c.flag).length > 1) {
    renderPreview();
    draft.multiplexer = await select({
      message: "Multiplexer for concurrent commands",
      options: [
        { label: "zellij", value: "zellij", hint: "split panes in zellij" },
        { label: "tmux", value: "tmux", hint: "split panes in tmux" },
        { label: "concurrent", value: "concurrent", hint: "inline with prefixed output" },
      ],
    }) as Multiplexer;
  }

  // ── Scope ──────────────────────────────────────────────────────────────────

  renderPreview();
  draft.scope = await select({
    message: "Save scope",
    options: [
      { label: "team", value: "team", hint: ".rt/scripts/ — git-tracked, shared" },
      { label: "user", value: "user", hint: "~/.rt/<repo>/scripts/ — local only" },
    ],
  }) as "team" | "user";

  // ── Save ───────────────────────────────────────────────────────────────────

  const script: RtScript = {
    name: draft.name,
    description: draft.description || undefined,
    setup: draft.setup,
    commands: draft.commands,
    teardown: draft.teardown,
    multiplexer: draft.multiplexer,
  };

  const savedPath = saveScript(script, draft.scope!, repoRoot, dataDir);

  renderPreview();
  console.log(`  ${green}${bold}✓ saved${reset} ${dim}${savedPath}${reset}`);
  console.log(`  ${dim}run with: rt x ${draft.name}${reset}\n`);
}

// ─── Entry ───────────────────────────────────────────────────────────────────

export async function run(args: string[]): Promise<void> {

  // Parse args: first non-flag arg is the script name
  let scriptName: string | undefined;
  let muxOverride: Multiplexer | undefined;
  let pickRepo = false;
  const flags = new Set<string>();

  for (const arg of args) {
    if (arg.startsWith("--mux=")) {
      muxOverride = arg.slice(6) as Multiplexer;
    } else if (arg === "--pick") {
      pickRepo = true;
    } else if (arg.startsWith("-")) {
      flags.add(arg);
    } else if (!scriptName) {
      scriptName = arg;
    }
  }

  // --pick forces the interactive repo/worktree picker
  const identity = pickRepo
    ? await pickRepoInteractive()
    : await requireIdentity("rt x");
  const { repoRoot, dataDir } = identity;

  // ── rt x edit → open script JSON in editor ────────────────────────────────

  if (scriptName === "edit") {
    if (!process.stdin.isTTY) {
      console.log(`\n  ${red}edit requires an interactive terminal${reset}\n`);
      process.exit(1);
    }

    // Parse --script=<name> from flags
    let targetName: string | undefined;
    for (const f of flags) {
      if (f.startsWith("--script=")) {
        targetName = f.slice("--script=".length);
        break;
      }
    }

    // If no --script flag, show picker
    if (!targetName) {
      const entries = listScripts(repoRoot, dataDir);
      if (entries.length === 0) {
        console.log(`\n  ${yellow}no scripts to edit${reset}`);
        console.log(`  ${dim}create one: rt x create${reset}\n`);
        process.exit(1);
      }

      const { filterableSelect } = await import("../lib/rt-render.tsx");
      console.log(`\n  ${bold}${cyan}rt x edit${reset}\n`);
      targetName = await filterableSelect({
        message: "Select a script to edit",
        options: entries.map((e) => ({
          value: e.name,
          label: e.name,
          hint: `${e.script.description ?? ""} (${e.scope})`.trim(),
        })),
      });
    }

    const filePath = resolveScriptPath(targetName, repoRoot, dataDir);
    if (!filePath) {
      console.log(`\n  ${red}unknown script: ${targetName}${reset}`);
      const entries = listScripts(repoRoot, dataDir);
      if (entries.length > 0) {
        console.log(`  ${dim}available: ${entries.map((e) => e.name).join(", ")}${reset}`);
      }
      console.log(`  ${dim}create one: rt x create${reset}\n`);
      process.exit(1);
    }

    // Open in editor: $EDITOR → code → open (macOS)
    const editor = process.env.EDITOR || "code";
    try {
      execSync(`${editor} "${filePath}"`, { stdio: "inherit" });
      console.log(`\n  ${green}✓${reset} opened ${dim}${filePath}${reset}\n`);
    } catch {
      // Fallback to macOS `open`
      try {
        execSync(`open "${filePath}"`, { stdio: "inherit" });
        console.log(`\n  ${green}✓${reset} opened ${dim}${filePath}${reset}\n`);
      } catch {
        console.log(`\n  ${red}failed to open ${filePath}${reset}\n`);
        process.exit(1);
      }
    }
    return;
  }

  // ── rt x create → wizard ──────────────────────────────────────────────────

  if (scriptName === "create") {
    if (!process.stdin.isTTY) {
      console.log(`\n  ${red}wizard requires an interactive terminal${reset}\n`);
      process.exit(1);
    }
    await wizard(repoRoot, dataDir);
    return;
  }

  // ── rt x <name> → load and run ────────────────────────────────────────────

  if (scriptName) {
    // Try user/team scripts first
    let script = loadScript(scriptName, repoRoot, dataDir);

    // Fall back to built-ins
    if (!script) {

      console.log(`\n  ${red}unknown script: ${scriptName}${reset}`);
      const entries = listScripts(repoRoot, dataDir);
      if (entries.length > 0) {
        console.log(`  ${dim}available: ${entries.map((e) => e.name).join(", ")}${reset}`);
      }
      console.log(`  ${dim}create one: rt x create${reset}\n`);
      process.exit(1);
    }

    await executeScript(script, flags, muxOverride, repoRoot);
    return;
  }

  // ── rt x → interactive picker ──────────────────────────────────────────────

  if (!process.stdin.isTTY) {
    console.log(`\n  ${red}must be run in an interactive terminal${reset}\n`);
    process.exit(1);
  }

  const entries = listScripts(repoRoot, dataDir);
  const { select } = await import("../lib/rt-render.tsx");

  console.log(`\n  ${bold}${cyan}rt x${reset}\n`);

  const options = entries.map((e) => ({
    value: e.name,
    label: e.name,
    hint: `${e.script.description ?? ""} (${e.scope})`.trim(),
  }));



  options.push({
    value: "__edit__",
    label: "✏️  Edit a script",
    hint: "open script JSON in editor",
  });

  options.push({
    value: "__create__",
    label: "➕ Create new script",
    hint: "launch the wizard",
  });

  const selected = await select({
    message: "Select a script",
    options,
  });

  if (selected === "__edit__") {
    // Re-enter with "edit" as the subcommand
    return run(["edit"]);
  }

  if (selected === "__create__") {
    console.log("");
    await wizard(repoRoot, dataDir);
    return;
  }



  const script = loadScript(selected, repoRoot, dataDir);
  if (!script) {
    console.log(`\n  ${red}script not found: ${selected}${reset}\n`);
    process.exit(1);
  }

  await executeScript(script, flags, muxOverride, repoRoot);
}
