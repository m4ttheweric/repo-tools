#!/usr/bin/env bun

/**
 * rt hooks — Toggle husky git hooks on/off.
 *
 * Uses core.hooksPath to redirect git hooks to shim scripts in ~/.mattstack/rt/repos/<repo>/hooks/.
 * Shims grep ~/.mattstack/rt/repos/<repo>/hooks.json and delegate to the real .husky/ scripts —
 * that file must stay a zero-spawn `grep` target because a git hook runs on
 * EVERY git operation and cannot pay a second process's startup cost, so it
 * can never read the jsonc settings resolver directly.
 *
 * The settings key `rt.hooks` is nonetheless the AUTHORITATIVE human intent
 * (ownership latch: unowned repos still read/write hooks.json as before;
 * once anything lands in the store for a repo, the store wins). hooks.json
 * is then a DERIVED CACHE of whatever the store currently resolves to for
 * that repo — regenerated at every seam that can change the resolved value
 * (`rt hooks on/off/<name>`), at the `rt settings set rt.hooks ... --repo`
 * seam (commands/settings-keys.ts), AND on `rt hooks status` (including the
 * non-TTY fallback) — status is the natural place a human notices the cache
 * disagrees with the store, so it self-heals on inspect rather than just
 * reporting the mismatch. Mirrors lib/repo-index.ts's `writeRepoIndexCompat`
 * pattern throughout: independent try/catch, best-effort, and the file is
 * never renamed or unlinked out from under the shim.
 *
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
import { identityFromRemote } from "../lib/settings/identity.ts";
import { getSetting } from "../lib/settings/resolve.ts";
import { setSetting } from "../lib/settings/write.ts";
import type { SettingScope } from "../lib/settings/registry.ts";

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

const SETTING_KEY = "rt.hooks";

/** The scope `rt hooks on/off/<name> on|off` writes into once the store owns the key: enablement is a per-checkout toggle, not something to sync across machines by default. */
const HOOKS_WRITE_SCOPE: SettingScope = "machine";

function hooksConfigPath(dataDir: string): string {
  return join(dataDir, "hooks.json");
}

let warnedHooksStoreProbe = false;

/**
 * Ownership-latch probe: `undefined` means the store does not own `rt.hooks`
 * for this repo — the caller falls back to the legacy file. A probe failure
 * (thrown by getSetting) counts as unowned too, with ONE warning across the
 * process that never echoes the store's value.
 */
function probeHooksStore(repoIdentity: string | null): Partial<HooksConfig> | undefined {
  if (!repoIdentity) return undefined;
  try {
    return getSetting<Partial<HooksConfig>>(SETTING_KEY, { repoIdentity }).value;
  } catch (err) {
    if (!warnedHooksStoreProbe) {
      warnedHooksStoreProbe = true;
      console.warn(`rt: ignoring "${SETTING_KEY}" — ${(err as Error).message}`);
    }
    return undefined;
  }
}

/** Raw legacy hooks.json, or null when missing/unreadable/malformed — never throws. */
function readLegacyRaw(dataDir: string): { enabled?: boolean; hooks?: Record<string, boolean> } | null {
  try {
    return JSON.parse(readFileSync(hooksConfigPath(dataDir), "utf8"));
  } catch {
    return null;
  }
}

/**
 * The resolved config, store-owned winning per field (including per-hook-name
 * entries inside the nested `hooks` map — each defaults to enabled when the
 * store carries no entry for it, same default the legacy file always used)
 * over the legacy file when the store doesn't own the key yet. This is BOTH
 * the read path for the interactive toggle UI AND the value written into
 * hooks.json as its derived-cache content.
 */
function loadHooksConfig(dataDir: string, discoveredHooks: string[], repoIdentity: string | null): HooksConfig {
  const declared = probeHooksStore(repoIdentity);
  if (declared !== undefined) {
    const hooks: Record<string, boolean> = {};
    for (const hook of discoveredHooks) hooks[hook] = declared.hooks?.[hook] !== false;
    return { enabled: declared.enabled !== false, hooks };
  }

  const raw = readLegacyRaw(dataDir);
  const hooks: Record<string, boolean> = {};
  for (const hook of discoveredHooks) hooks[hook] = raw?.hooks?.[hook] ?? true;
  return { enabled: raw?.enabled ?? true, hooks };
}

/**
 * Rewrites hooks.json to match whatever `rt.hooks` currently resolves to for
 * this repo — the derived-cache refresh. Independent try/catch, best-effort:
 * a cache write failing must never fail the store write that triggered it
 * (mirrors `writeRepoIndexCompat`). No-ops (returns false) when the repo has
 * no `.husky/` at all — nothing to cache. Never deletes or renames
 * hooks.json; a repo that never declares hooks just never gets one. Returns
 * whether it actually wrote, so a caller reporting to a human (the
 * `rt settings set --repo` seam) never claims success it didn't verify.
 */
export function regenerateHooksCache(repoRoot: string, dataDir: string, repoIdentity: string | null): boolean {
  try {
    const discoveredHooks = discoverHooks(repoRoot);
    if (discoveredHooks.length === 0) return false;
    const config = loadHooksConfig(dataDir, discoveredHooks, repoIdentity);
    mkdirSync(dataDir, { recursive: true }); // a settings-set --repo seam can reach this before toggleHooks ever has
    writeFileSync(hooksConfigPath(dataDir), JSON.stringify(config, null, 2));
    return true;
  } catch {
    // best-effort — see module doc
    return false;
  }
}

/**
 * `rt hooks status` looks read-only but must still self-heal a stale cache —
 * it's the natural place a human notices the git shim disagrees with what
 * this command just told them, and the guidance in commands/settings-keys.ts
 * points a failed `rt settings set --repo` write here to "fix" it. Wrapped in
 * its own try/catch (on top of regenerateHooksCache's own) because a
 * status-display command must never throw or change its exit code over a
 * cache write it wasn't asked to perform.
 */
function refreshHooksCacheBestEffort(repoRoot: string, dataDir: string, repoIdentity: string | null): void {
  try {
    regenerateHooksCache(repoRoot, dataDir, repoIdentity);
  } catch {
    // best-effort — see module doc
  }
}

/**
 * Where a write lands: the legacy file stays authoritative only while BOTH
 * it already exists AND the store doesn't own the key yet — once anything
 * lands in a store rung for this repo, hooks.json is a cache and every write
 * must go through the store (checking `existsSync` alone would be wrong the
 * moment the file exists purely as a regenerated cache). ENOENT with an
 * unowned key also routes to the store: file-authority is meaningless with
 * no file, so there's nothing to bootstrap a fresh legacy file from.
 *
 * `repoRoot` is needed only to regenerate the cache after a store write —
 * `discoverHooks` reads `.husky/` there.
 */
function saveHooksConfig(repoRoot: string, dataDir: string, config: HooksConfig, repoIdentity: string | null): void {
  const legacyPath = hooksConfigPath(dataDir);
  const storeOwnsIt = probeHooksStore(repoIdentity) !== undefined;

  if (existsSync(legacyPath) && !storeOwnsIt) {
    writeFileSync(legacyPath, JSON.stringify(config, null, 2));
    return;
  }

  if (repoIdentity) {
    try {
      setSetting(SETTING_KEY, config, HOOKS_WRITE_SCOPE, { repoIdentity });
      regenerateHooksCache(repoRoot, dataDir, repoIdentity);
      return;
    } catch (err) {
      console.warn(`rt: could not write "${SETTING_KEY}" to the settings store — ${(err as Error).message}`);
    }
  }

  // No repoIdentity reachable (local-only remote) — the store is unreachable
  // regardless of ownership, so the legacy file is the only option.
  writeFileSync(legacyPath, JSON.stringify(config, null, 2));
}

// ─── Shim generation ─────────────────────────────────────────────────────────

/**
 * Generate shim scripts in ~/.mattstack/rt/repos/<repo>/hooks/ that:
 * 1. Check hooks.json for enabled/disabled state
 * 2. If disabled → exit 0 (skip)
 * 3. If enabled or config missing → delegate to the real .husky/ hook (fail-safe)
 */
function generateShims(dataDir: string, discoveredHooks: string[]): void {
  const hooksDir = join(dataDir, "hooks");
  mkdirSync(hooksDir, { recursive: true });

  const configFile = hooksConfigPath(dataDir);

  // Always include pre-commit so the on-deck guard runs even if the repo
  // has no .husky/pre-commit of its own.
  const hookNames = [...new Set(["pre-commit", ...discoveredHooks])];

  for (const hookName of hookNames) {
    const shimPath = join(hooksDir, hookName);

    const onDeckGuard = hookName === "pre-commit" ? `
# On-deck guard: block commits on on-deck/* branches.
CURRENT_BRANCH=$(git symbolic-ref --short HEAD 2>/dev/null)
if [[ "$CURRENT_BRANCH" == on-deck/* ]]; then
  echo "rt: commits are not allowed on on-deck branches (on \\"$CURRENT_BRANCH\\")"
  echo "rt: switch to a feature branch before committing"
  exit 1
fi
` : "";

    const shim = `#!/bin/bash
# rt hook shim — checks ~/.mattstack/rt config before running the real hook
# Fail-safe: if config is missing or unreadable, the real hook runs
${onDeckGuard}
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

// ─── Display ─────────────────────────────────────────────────────────────────

function showStatus(config: HooksConfig, repoName: string): void {

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
  const { repoName, repoRoot, dataDir, remoteUrl } = ctx.identity!;
  const discoveredHooks = discoverHooks(repoRoot);

  if (discoveredHooks.length === 0) {
    console.log(`\n  ${yellow}no husky hooks found in .husky/${reset}\n`);
    process.exit(1);
  }

  const derivedIdentity = remoteUrl ? identityFromRemote(remoteUrl) : null;
  const repoIdentity = derivedIdentity && derivedIdentity.kind === "remote" ? derivedIdentity.id : null;
  const config = loadHooksConfig(dataDir, discoveredHooks, repoIdentity);

  // Always regenerate shims and ensure hooksPath is set
  generateShims(dataDir, discoveredHooks);
  setHooksPath(repoRoot, dataDir);

  // Notify daemon to watch this repo's .git/config (best-effort, no-op if daemon not running).
  // The daemon's repo index is identity-keyed — send the serialized identity, not repoName's display form.
  import("../lib/daemon-client.ts")
    .then(({ daemonQuery }) => daemonQuery("hooks:watch", { repo: ctx.identity!.identity }))
    .catch(() => {});

  const sub = args[0];

  // ── rt hooks off ──────────────────────────────────────────────────────────

  if (sub === "off") {
    config.enabled = false;
    saveHooksConfig(repoRoot, dataDir, config, repoIdentity);
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
    saveHooksConfig(repoRoot, dataDir, config, repoIdentity);
    console.log(`\n  ${green}${bold}▶ all hooks re-enabled${reset} ${dim}(${repoName})${reset}\n`);
    return;
  }

  // ── rt hooks status ───────────────────────────────────────────────────────

  if (sub === "status") {
    refreshHooksCacheBestEffort(repoRoot, dataDir, repoIdentity);
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
    saveHooksConfig(repoRoot, dataDir, config, repoIdentity);

    if (action === "off") {
      console.log(`\n  ${red}✗${reset} ${hookName} ${dim}disabled${reset} ${dim}(${repoName})${reset}\n`);
    } else {
      console.log(`\n  ${green}✓${reset} ${hookName} ${dim}enabled${reset} ${dim}(${repoName})${reset}\n`);
    }
    return;
  }

  // ── rt hooks (interactive) ────────────────────────────────────────────────

  if (!process.stdin.isTTY) {
    refreshHooksCacheBestEffort(repoRoot, dataDir, repoIdentity);
    showStatus(config, repoName);
    return;
  }

  const { confirm: inkConfirm, multiselect } = await import("../lib/rt-render.tsx");

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

  saveHooksConfig(repoRoot, dataDir, config, repoIdentity);

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

// ─── Exported for tests ──────────────────────────────────────────────────────

export { discoverHooks, loadHooksConfig, saveHooksConfig, generateShims, hooksConfigPath, type HooksConfig };
