#!/usr/bin/env bun

/**
 * rt dev — Dev workflow composer.
 *
 * Pick apps → sequential setup → concurrent dev servers.
 * Config-driven setup steps and clean mode from ~/.rt/<repo>/config.json.
 * Supports saved presets and --clean CLI flag.
 */

import { execSync, spawnSync } from "child_process";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import {
  bold, cyan, dim, green, yellow, red, reset, white,
  COLOR_PALETTE,
} from "../lib/tui.ts";
import {
  requireIdentity, loadOrCreateRepoConfig, getWorkspacePackages,
  type RepoConfig, type SetupStep,
} from "../lib/repo.ts";

// ─── Types ───────────────────────────────────────────────────────────────────

interface AppInfo {
  name: string;
  path: string;
  pkgName: string;
}

interface Preset {
  apps: string[];
  setup: Record<string, boolean>;
  clean: boolean;
}

type PresetsFile = Record<string, Preset>;

// ─── App discovery ───────────────────────────────────────────────────────────

function discoverApps(repoRoot: string): AppInfo[] {
  return getWorkspacePackages(repoRoot)
    .filter((p) => p.path.startsWith("apps/"))
    .map((p) => ({
      name: p.path.split("/").pop() || p.name,
      path: p.path,
      pkgName: p.name,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

// ─── Presets ─────────────────────────────────────────────────────────────────

function presetsPath(dataDir: string): string {
  return join(dataDir, "presets.json");
}

function loadPresets(dataDir: string): PresetsFile {
  try {
    return JSON.parse(readFileSync(presetsPath(dataDir), "utf8"));
  } catch {
    return {};
  }
}

function savePreset(dataDir: string, name: string, preset: Preset): void {
  const presets = loadPresets(dataDir);
  presets[name] = preset;
  writeFileSync(presetsPath(dataDir), JSON.stringify(presets, null, 2));
}

// ─── Interactive picker (Ink-based) ─────────────────────────────────────────

/** Validates preset apps against discovered apps, exits if none match. */
function validatePreset(preset: Preset, apps: AppInfo[]): string[] {
  const validApps = preset.apps.filter((a: string) => apps.some((app) => app.name === a));
  if (validApps.length === 0) {
    console.log(`\n  ${red}no valid apps in preset${reset}\n`);
    process.exit(1);
  }
  return validApps;
}

async function interactivePick(
  apps: AppInfo[],
  config: RepoConfig,
  repoName: string,
  initialClean: boolean,
): Promise<{ apps: string[]; setup: Record<string, boolean>; clean: boolean; presetName?: string }> {
  const { multiselect, confirm: inkConfirm, textInput } = await import("../lib/rt-render.tsx");

  // Step 1: Pick apps
  const selectedApps = await multiselect({
    message: "Select apps to start",
    options: apps.map((app) => ({
      value: app.name,
      label: app.name,
      hint: app.pkgName,
    })),
  });

  if (selectedApps.length === 0) {
    console.log(`\n  ${dim}no apps selected${reset}\n`);
    process.exit(0);
  }

  // Step 2: Setup step toggles
  const setupToggles: Record<string, boolean> = {};
  for (const s of config.setup) {
    setupToggles[s.label] = await inkConfirm({
      message: `Run setup step: ${s.label}?`,
      initialValue: true,
    });
  }

  // Step 3: Clean toggle
  let clean = initialClean;
  if (!initialClean && config.clean.length > 0) {
    clean = await inkConfirm({
      message: "Run clean commands before start?",
      initialValue: false,
    });
  }

  // Step 4: Optional preset save
  const wantSave = await inkConfirm({
    message: "Save as preset for next time?",
    initialValue: false,
  });

  let presetName: string | undefined;
  if (wantSave) {
    presetName = await textInput({
      message: "Preset name",
      placeholder: selectedApps.join("-"),
    });
    if (!presetName.trim()) presetName = undefined;
  }

  return {
    apps: selectedApps,
    setup: setupToggles,
    clean,
    presetName,
  };
}

// ─── Execute workflow ────────────────────────────────────────────────────────

function step(num: number, total: number, label: string): void {
  console.log(`\n  ${bold}${cyan}[${num}/${total}]${reset} ${bold}${label}${reset}`);
}

function executeWorkflow(
  repoRoot: string,
  config: RepoConfig,
  selection: { apps: string[]; setup: Record<string, boolean>; clean: boolean },
  dataDir: string,
  repoName: string,
  presetNameToSave?: string,
): void {
  // Save preset if requested
  if (presetNameToSave) {
    savePreset(dataDir, presetNameToSave, {
      apps: selection.apps,
      setup: selection.setup,
      clean: selection.clean,
    });
    console.log(`\n  ${green}${bold}✓ saved preset:${reset} ${presetNameToSave}`);
    console.log(`  ${dim}run with: rt dev ${presetNameToSave}${reset}`);
  }

  const activeSetupSteps = config.setup.filter((s) => selection.setup[s.label]);
  const totalSteps = activeSetupSteps.length + (selection.clean ? 1 : 0) + 1;
  let currentStep = 0;

  // Clean mode: run clean commands
  if (selection.clean && config.clean.length > 0) {
    currentStep++;
    step(currentStep, totalSteps, "Cleaning caches");
    for (const cmd of config.clean) {
      try {
        execSync(cmd, { cwd: repoRoot, stdio: "inherit" });
      } catch {
        console.log(`  ${yellow}warning: clean command failed: ${cmd}${reset}`);
      }
    }
    console.log(`  ${green}✓ Caches cleaned${reset}`);
  }

  // Run configured setup steps
  for (const setupStep of activeSetupSteps) {
    currentStep++;
    const cwdHint = setupStep.cwd ? ` ${dim}(${setupStep.cwd})${reset}` : "";
    step(currentStep, totalSteps, `${setupStep.label}${cwdHint}`);
    const stepCwd = setupStep.cwd ? join(repoRoot, setupStep.cwd) : repoRoot;

    if (setupStep.command === "auto") {
      // Auto-wired turbo build for selected app dependencies
      const buildFilters: string[] = [];
      for (const app of selection.apps) {
        buildFilters.push(`--filter=@assured/${app}...`);
        buildFilters.push(`--filter=!@assured/${app}`);
      }
      const result = spawnSync(
        "pnpm",
        ["turbo", "run", "build", "--output-logs=new-only", ...buildFilters],
        { cwd: repoRoot, stdio: "inherit" },
      );
      if (result.status !== 0) {
        console.log(`\n  ${red}build failed${reset}\n`);
        process.exit(1);
      }
    } else {
      const result = spawnSync("sh", ["-c", setupStep.command], {
        cwd: stepCwd,
        stdio: "inherit",
      });
      if (result.status !== 0) {
        console.log(`\n  ${red}${setupStep.label} failed${reset}\n`);
        process.exit(1);
      }
    }
    console.log(`  ${green}✓ ${setupStep.label} done${reset}`);
  }

  // Start apps in zellij split panes
  currentStep++;
  step(currentStep, totalSteps, "Launching zellij");

  const startScript = config.startScript;

  // Generate zellij KDL layout
  const panes = selection.apps
    .map((app) => {
      const cmd = `TURBO_HASH=1 pnpm --filter ${app} ${startScript}`;
      return `        pane command="sh" name="${app}" { args "-c" "${cmd}"; }`;
    })
    .join("\n");

  const layout = `layout {
    default_tab_template {
      pane size=1 borderless=true { plugin location="tab-bar"; }
      children
      pane size=2 borderless=true { plugin location="status-bar"; }
    }
    tab name="rt dev" {
      pane split_direction="vertical" {
${panes}
      }
    }
  }`;

  const layoutPath = "/tmp/rt-dev-layout.kdl";
  writeFileSync(layoutPath, layout);

  const result = spawnSync("zellij", ["--layout", layoutPath], {
    cwd: repoRoot,
    stdio: "inherit",
  });

  process.exit(result.status || 0);
}

// ─── Entry ───────────────────────────────────────────────────────────────────

export async function run(args: string[]): Promise<void> {
  const identity = await requireIdentity("rt dev");

  const { repoName, repoRoot, dataDir } = identity;
  const config = await loadOrCreateRepoConfig(dataDir, repoRoot, repoName);
  const apps = discoverApps(repoRoot);

  if (apps.length === 0) {
    console.log(`\n  ${yellow}no apps found in workspace${reset}\n`);
    process.exit(1);
  }

  // Parse args
  let cleanFlag = false;
  let presetName: string | undefined;

  for (const arg of args) {
    if (arg === "--clean" || arg === "-c") {
      cleanFlag = true;
    } else if (!arg.startsWith("-")) {
      presetName = arg;
    }
  }

  // Explicit preset name passed as arg
  if (presetName) {
    const presets = loadPresets(dataDir);
    const preset = presets[presetName];
    if (preset) {
      console.log(`\n  ${bold}${cyan}rt dev${reset} ${dim}preset: ${presetName}${reset}`);
      const validApps = validatePreset(preset, apps);
      executeWorkflow(repoRoot, config, {
        ...preset,
        apps: validApps,
        clean: preset.clean || cleanFlag,
      }, dataDir, repoName);
      return;
    } else {
      console.log(`\n  ${yellow}unknown preset: ${presetName}${reset}`);
      const available = Object.keys(presets);
      if (available.length > 0) {
        console.log(`  ${dim}available: ${available.join(", ")}${reset}`);
      }
      console.log("");
      process.exit(1);
    }
  }

  // No preset arg — show preset picker if presets exist
  if (!process.stdin.isTTY) {
    console.log(`\n  ${red}must be run in an interactive terminal${reset}\n`);
    process.exit(1);
  }

  const presets = loadPresets(dataDir);
  const presetNames = Object.keys(presets);

  if (presetNames.length > 0) {
    const { select } = await import("../lib/rt-render.tsx");
    console.log(`\n  ${bold}${cyan}rt dev${reset} ${dim}(${repoName})${reset}\n`);

    const presetOptions = presetNames.map((name) => {
      const preset = presets[name]!;
      return {
        value: name,
        label: name,
        hint: `${preset.apps.join(", ")}${preset.clean ? " (clean)" : ""}`,
      };
    });

    const selected = await select({
      message: "Select a preset or create a new one",
      options: [
        ...presetOptions,
        { value: "__new__", label: "➕ Create new preset", hint: "pick apps interactively" },
      ],
    });

    if (selected !== "__new__") {
      const preset = presets[selected]!;
      const validApps = validatePreset(preset, apps);
      executeWorkflow(repoRoot, config, {
        ...preset,
        apps: validApps,
        clean: preset.clean || cleanFlag,
      }, dataDir, repoName);
      return;
    }
    // Fall through to interactive picker for "create new"
    console.log("");
  }

  const selection = await interactivePick(apps, config, repoName, cleanFlag);
  executeWorkflow(repoRoot, config, selection, dataDir, repoName, selection.presetName);
}

