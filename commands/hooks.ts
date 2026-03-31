#!/usr/bin/env bun

/**
 * rt hooks — Toggle husky git hooks on/off.
 *
 * Uses core.hooksPath to redirect git hooks to shim scripts in ~/.rt/<repo>/hooks/.
 * Shims check ~/.rt/<repo>/hooks.json and delegate to the real .husky/ scripts.
 * Works with ALL git clients (Cursor, VS Code, GitHub Desktop, terminal).
 * Cross-worktree (all worktrees share the same git config).
 *
 * Usage:
 *   rt hooks              interactive toggle
 *   rt hooks off           disable all hooks
 *   rt hooks on            re-enable all hooks
 *   rt hooks pre-push off  disable a specific hook
 *   rt hooks pre-push on   enable a specific hook
 *   rt hooks status        show current state
 */

import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync, chmodSync, statSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";
import { bold, cyan, dim, green, yellow, red, reset } from "../lib/tui.ts";
import type { CommandContext } from "../lib/command-tree.ts";

// ─── Types ───────────────────────────────────────────────────────────────────

interface HooksConfig {
  enabled: boolean;
  hooks: Record<string, boolean>;
}

// ─── Hook detection ──────────────────────────────────────────────────────────

function discoverHooks(repoRoot: string): string[] {
  const huskyDir = join(repoRoot, ".husky");
  if (!existsSync(huskyDir)) return [];

  return readdirSync(huskyDir)
    .filter((f) => {
      if (f === "_" || f.startsWith(".")) return false;
      const fullPath = join(huskyDir, f);
      const stat = statSync(fullPath);
      return stat.isFile();
    })
    .sort();
}

// ─── Config persistence ─────────────────────────────────────────────────────

function hooksConfigPath(dataDir: string): string {
  return join(dataDir, "hooks.json");
}

function loadHooksConfig(dataDir: string, discoveredHooks: string[]): HooksConfig {
  const configPath = hooksConfigPath(dataDir);
  try {
    const raw = JSON.parse(readFileSync(configPath, "utf8"));
    const hooks: Record<string, boolean> = {};
    for (const hook of discoveredHooks) {
      hooks[hook] = raw.hooks?.[hook] ?? true;
    }
    return { enabled: raw.enabled ?? true, hooks };
  } catch {
    const hooks: Record<string, boolean> = {};
    for (const hook of discoveredHooks) {
      hooks[hook] = true;
    }
    return { enabled: true, hooks };
  }
}

function saveHooksConfig(dataDir: string, config: HooksConfig): void {
  writeFileSync(hooksConfigPath(dataDir), JSON.stringify(config, null, 2));
}

// ─── Shim generation ─────────────────────────────────────────────────────────

/**
 * Generate shim scripts in ~/.rt/<repo>/hooks/ that:
 * 1. Check hooks.json for enabled/disabled state
 * 2. If disabled → exit 0 (skip)
 * 3. If enabled or config missing → delegate to the real .husky/ hook (fail-safe)
 */
function generateShims(dataDir: string, discoveredHooks: string[]): void {
  const hooksDir = join(dataDir, "hooks");
  mkdirSync(hooksDir, { recursive: true });

  const configFile = hooksConfigPath(dataDir);

  for (const hookName of discoveredHooks) {
    const shimPath = join(hooksDir, hookName);
    const shim = `#!/bin/bash
# rt hook shim — checks ~/.rt config before running the real hook
# Fail-safe: if config is missing or unreadable, the real hook runs

HOOKS_CONFIG="${configFile}"
HOOK_NAME="${hookName}"

if [ -f "$HOOKS_CONFIG" ]; then
  # Check global kill switch
  global_enabled=$(grep -o '"enabled"[[:space:]]*:[[:space:]]*[a-z]*' "$HOOKS_CONFIG" 2>/dev/null | head -1 | grep -o '[a-z]*$')
  if [ "$global_enabled" = "false" ]; then
    exit 0
  fi

  # Check per-hook toggle
  hook_enabled=$(grep -o "\\"$HOOK_NAME\\"[[:space:]]*:[[:space:]]*[a-z]*" "$HOOKS_CONFIG" 2>/dev/null | head -1 | grep -o '[a-z]*$')
  if [ "$hook_enabled" = "false" ]; then
    exit 0
  fi
fi

# Delegate to the real hook (fail-safe: always run if we get here)
REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
REAL_HOOK="$REPO_ROOT/.husky/$HOOK_NAME"

if [ -x "$REAL_HOOK" ]; then
  exec "$REAL_HOOK" "$@"
fi
`;
    writeFileSync(shimPath, shim, { mode: 0o755 });
  }

  // Also copy the husky helper directory if it exists
  // (some hooks source .husky/_/husky.sh)
}

/**
 * Set core.hooksPath to our shims directory.
 * This affects all worktrees since it modifies the shared .git/config.
 */
function setHooksPath(repoRoot: string, dataDir: string): void {
  const hooksDir = join(dataDir, "hooks");
  try {
    execSync(`git config core.hooksPath "${hooksDir}"`, {
      cwd: repoRoot,
      stdio: "pipe",
    });
  } catch {
    // Fall back to direct file edit if git CLI unavailable
    console.log(`  ${yellow}warning: could not set core.hooksPath${reset}`);
  }
}

/**
 * Restore core.hooksPath to .husky (the default).
 */
function restoreHooksPath(repoRoot: string): void {
  try {
    execSync('git config core.hooksPath ".husky"', {
      cwd: repoRoot,
      stdio: "pipe",
    });
  } catch { /* ignore */ }
}

// ─── Display ─────────────────────────────────────────────────────────────────

function showStatus(config: HooksConfig, repoName: string): void {
  console.log("");
  console.log(`  ${bold}${cyan}rt hooks${reset}  ${dim}(${repoName})${reset}`);
  console.log("");

  if (!config.enabled) {
    console.log(`  ${red}${bold}⏸ all hooks disabled${reset}`);
    console.log("");
    for (const [hook, enabled] of Object.entries(config.hooks)) {
      console.log(`  ${dim}  ${hook}  ${enabled ? "enabled" : "disabled"} (overridden by global off)${reset}`);
    }
  } else {
    console.log(`  ${green}${bold}▶ hooks active${reset}`);
    console.log("");
    for (const [hook, enabled] of Object.entries(config.hooks)) {
      if (enabled) {
        console.log(`  ${green}✓${reset} ${hook}`);
      } else {
        console.log(`  ${red}✗${reset} ${hook}  ${dim}disabled${reset}`);
      }
    }
  }
  console.log("");
}

// ─── Entry ───────────────────────────────────────────────────────────────────

export async function toggleHooks(args: string[], ctx: CommandContext): Promise<void> {
  const { repoName, repoRoot, dataDir } = ctx.identity!;
  const discoveredHooks = discoverHooks(repoRoot);

  if (discoveredHooks.length === 0) {
    console.log(`\n  ${yellow}no husky hooks found in .husky/${reset}\n`);
    process.exit(1);
  }

  const config = loadHooksConfig(dataDir, discoveredHooks);

  // Always regenerate shims and ensure hooksPath is set
  generateShims(dataDir, discoveredHooks);
  setHooksPath(repoRoot, dataDir);

  // Notify daemon to watch this repo's .git/config (best-effort, no-op if daemon not running)
  import("../lib/daemon-client.ts")
    .then(({ daemonQuery }) => daemonQuery("hooks:watch", { repo: repoName }))
    .catch(() => {});

  const sub = args[0];

  // ── rt hooks off ──────────────────────────────────────────────────────────

  if (sub === "off") {
    config.enabled = false;
    saveHooksConfig(dataDir, config);
    console.log(`\n  ${red}${bold}⏸ all hooks disabled${reset} ${dim}(${repoName})${reset}`);
    console.log(`  ${dim}applies to terminal, Cursor, GitHub Desktop — all git clients${reset}\n`);
    return;
  }

  // ── rt hooks on ───────────────────────────────────────────────────────────

  if (sub === "on") {
    config.enabled = true;
    // Also re-enable all individual hooks
    for (const hook of discoveredHooks) {
      config.hooks[hook] = true;
    }
    saveHooksConfig(dataDir, config);
    console.log(`\n  ${green}${bold}▶ all hooks re-enabled${reset} ${dim}(${repoName})${reset}\n`);
    return;
  }

  // ── rt hooks status ───────────────────────────────────────────────────────

  if (sub === "status") {
    showStatus(config, repoName);
    return;
  }

  // ── rt hooks <hook-name> off/on ───────────────────────────────────────────

  if (sub && args[1] && (args[1] === "off" || args[1] === "on")) {
    const hookName = sub;
    const action = args[1];

    if (!(hookName in config.hooks)) {
      console.log(`\n  ${red}unknown hook: ${hookName}${reset}`);
      console.log(`  ${dim}available: ${Object.keys(config.hooks).join(", ")}${reset}\n`);
      process.exit(1);
    }

    config.hooks[hookName] = action === "on";
    saveHooksConfig(dataDir, config);

    if (action === "off") {
      console.log(`\n  ${red}✗${reset} ${hookName} ${dim}disabled${reset} ${dim}(${repoName})${reset}\n`);
    } else {
      console.log(`\n  ${green}✓${reset} ${hookName} ${dim}enabled${reset} ${dim}(${repoName})${reset}\n`);
    }
    return;
  }

  // ── rt hooks (interactive) ────────────────────────────────────────────────

  if (!process.stdin.isTTY) {
    showStatus(config, repoName);
    return;
  }

  const { confirm: inkConfirm, multiselect } = await import("../lib/rt-render.tsx");

  console.log(`\n  ${bold}${cyan}rt hooks${reset}  ${dim}(${repoName})${reset}\n`);

  const globalToggle = await inkConfirm({
    message: config.enabled ? "Hooks are ON globally. Keep enabled?" : "Hooks are OFF globally. Re-enable?",
    initialValue: config.enabled,
  });

  config.enabled = globalToggle;

  if (config.enabled && discoveredHooks.length > 0) {
    const disabledHooks = await multiselect({
      message: "Select hooks to disable",
      options: discoveredHooks.map((hook) => ({
        value: hook,
        label: hook,
      })),
      initialValues: discoveredHooks.filter((h) => !config.hooks[h]),
    });

    for (const hook of discoveredHooks) {
      config.hooks[hook] = !disabledHooks.includes(hook);
    }
  }

  saveHooksConfig(dataDir, config);

  if (!config.enabled) {
    console.log(`\n  ${red}all hooks disabled${reset}\n`);
  } else {
    const disabledList = Object.entries(config.hooks)
      .filter(([_, v]) => !v)
      .map(([k]) => k);
    if (disabledList.length > 0) {
      console.log(`\n  ${disabledList.length} hook${disabledList.length > 1 ? "s" : ""} disabled: ${disabledList.join(", ")}\n`);
    } else {
      console.log(`\n  ${green}all hooks enabled${reset}\n`);
    }
  }
}
