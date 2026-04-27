/**
 * rt settings — Configure API keys, team defaults, and repo data.
 *
 * Subcommands (registered in cli.ts as a branch node):
 *   settings linear token   — set Linear API key
 *   settings linear team    — set default Linear team
 *   settings gitlab token   — set GitLab personal access token
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { spawnSync } from "child_process";
import { bold, cyan, dim, green, red, reset, yellow } from "../lib/tui.ts";
import {
  loadSecrets,
  saveSecret,
  fetchTeams,
  getTeamConfig,
  saveTeamConfig,
} from "../lib/linear.ts";
import {
  loadNotificationPrefs,
  saveNotificationPrefs,
  NOTIFICATION_TYPES,
} from "../lib/notifier.ts";
import { installShellIntegration } from "../lib/shell-integration.ts";

// ─── Linear token ────────────────────────────────────────────────────────────

export async function setLinearToken(): Promise<void> {
  const { textInput } = await import("../lib/rt-render.tsx");
  const secrets = loadSecrets();

  try {
    const linearKey = await textInput({
      message: "Linear API key (lin_api_...)",
      placeholder: secrets.linearApiKey
        ? "••• (already set, leave empty to keep)"
        : "lin_api_...",
    });

    if (!linearKey.trim()) {
      if (secrets.linearApiKey) {
        console.log(`  ${dim}keeping existing Linear API key${reset}`);
      } else {
        console.log(`  ${yellow}no key entered${reset}`);
      }
      return;
    }

    saveSecret("linearApiKey", linearKey.trim());
    console.log(`\n  ${green}✓${reset} Linear API key saved\n`);
  } catch {
    if (secrets.linearApiKey) {
      console.log(`  ${dim}keeping existing Linear API key${reset}`);
    }
  }
}

// ─── GitLab token ────────────────────────────────────────────────────────────

export async function setGitlabToken(): Promise<void> {
  const { textInput } = await import("../lib/rt-render.tsx");
  const secrets = loadSecrets();

  try {
    const gitlabToken = await textInput({
      message: "GitLab personal access token",
      placeholder: secrets.gitlabToken
        ? "••• (already set, leave empty to keep)"
        : "glpat-...",
    });

    if (!gitlabToken.trim()) {
      if (secrets.gitlabToken) {
        console.log(`  ${dim}keeping existing GitLab token${reset}`);
      } else {
        console.log(`  ${yellow}no token entered${reset}`);
      }
      return;
    }

    saveSecret("gitlabToken", gitlabToken.trim());
    console.log(`\n  ${green}✓${reset} GitLab token saved\n`);
  } catch {
    if (secrets.gitlabToken) {
      console.log(`  ${dim}keeping existing GitLab token${reset}`);
    }
  }
}

// ─── Linear team ─────────────────────────────────────────────────────────────

export async function setLinearTeam(): Promise<void> {
  const secrets = loadSecrets();
  if (!secrets.linearApiKey) {
    console.log(`\n  ${yellow}Linear API key not configured${reset}`);
    console.log(`  ${dim}run: rt settings linear token${reset}\n`);
    return;
  }

  const result = await pickAndSaveTeam(secrets.linearApiKey);
  if (result) {
    console.log(`\n  ${green}✓${reset} default team set to ${bold}${result.teamKey}${reset}\n`);
  }
}

async function pickAndSaveTeam(apiKey: string): Promise<{ teamId: string; teamKey: string } | null> {
  console.log(`\n  ${dim}fetching teams…${reset}`);
  const teams = await fetchTeams(apiKey);

  if (teams.length === 0) {
    console.log(`  ${red}✗${reset} no teams found\n`);
    return null;
  }

  const { filterableSelect } = await import("../lib/rt-render.tsx");

  const selectedId = await filterableSelect({
    message: "Select your team",
    options: teams.map((t) => ({
      value: t.id,
      label: `${t.key}  ${t.name}`,
      hint: "",
    })),
  });

  if (!selectedId) return null;

  const team = teams.find((t) => t.id === selectedId);
  if (!team) return null;

  saveTeamConfig(team.id, team.key);
  return { teamId: team.id, teamKey: team.key };
}

// ─── Notification preferences ────────────────────────────────────────────────

export async function configureNotifications(): Promise<void> {
  const { execSync } = await import("child_process");
  const { filterableMultiselect } = await import("../lib/rt-render.tsx");

  const prefs = loadNotificationPrefs();

  const options = NOTIFICATION_TYPES.map((t) => ({
    value: t.key,
    label: t.label,
    hint: t.description,
  }));

  const enabledKeys = NOTIFICATION_TYPES
    .filter((t) => prefs[t.key] !== false)
    .map((t) => t.key);

  const selected = await filterableMultiselect({
    message: "Notifications",
    options,
    initialValues: enabledKeys,
  });

  if (selected === null) {
    console.log(`\n  ${dim}cancelled — no changes${reset}\n`);
    return;
  }

  // Build new prefs: selected = enabled, unselected = disabled
  const newPrefs: Record<string, boolean> = {};
  for (const t of NOTIFICATION_TYPES) {
    newPrefs[t.key] = selected.includes(t.key);
  }

  saveNotificationPrefs(newPrefs);

  const enabledCount = selected.length;
  const totalCount = NOTIFICATION_TYPES.length;
  console.log(`\n  ${green}✓${reset} ${enabledCount}/${totalCount} notification types enabled`);

  console.log("");
}

// ─── Test push notification ──────────────────────────────────────────────────

export async function sendTestPushNotification(): Promise<void> {
  const { TRAY_SOCK_PATH } = await import("../lib/daemon-config.ts");

  if (!existsSync(TRAY_SOCK_PATH)) {
    console.log(`\n  ${yellow}⚠${reset}  rt tray is not running`);
    console.log(`     ${dim}(no socket at ~/.rt/tray.sock — start the tray app first)${reset}\n`);
    return;
  }

  const event = {
    id: crypto.randomUUID(),
    title: "rt test notification",
    message: "If you see this, the tray is wired up correctly.",
    category: "test",
    timestamp: Date.now(),
  };

  try {
    const response = await fetch("http://localhost/notify", {
      unix: TRAY_SOCK_PATH,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(2000),
    } as any);

    if (response.ok) {
      console.log(`\n  ${green}✓${reset} Test push sent to rt tray\n`);
    } else {
      console.log(`\n  ${red}✗${reset} rt tray returned HTTP ${response.status}\n`);
    }
  } catch (e) {
    console.log(`\n  ${red}✗${reset} Failed to reach rt tray: ${(e as Error).message}\n`);
  }
}

// ─── Dev mode toggle ─────────────────────────────────────────────────────────

const DEV_MODE_WRAPPER = `${Bun.env.HOME}/.local/bin/rt`;
const DEV_MODE_CONFIG  = `${Bun.env.HOME}/.rt/dev-mode.json`;

// Paths inside rt-tray.app that participate in the daemon-binary swap.
const RT_TRAY_APP          = `${Bun.env.HOME}/Applications/rt-tray.app`;
const DAEMON_LIVE_PATH     = `${RT_TRAY_APP}/Contents/MacOS/rt-daemon`;
const DAEMON_REAL_BACKUP   = `${RT_TRAY_APP}/Contents/MacOS/rt-daemon.real`;
const DAEMON_SHIM_PATH     = `${RT_TRAY_APP}/Contents/MacOS/rt-daemon-shim`;

function readDevModeConfig(): { sourcePath?: string; bunPath?: string } {
  try {
    return JSON.parse(readFileSync(DEV_MODE_CONFIG, "utf8"));
  } catch {
    return {};
  }
}

function currentMode(): "dev" | "prod" {
  return existsSync(DEV_MODE_WRAPPER) ? "dev" : "prod";
}

function detectSourcePath(): string | null {
  // When running from source (bun run cli.ts), import.meta.dir is the repo root
  const dir = import.meta.dir;
  if (dir && !dir.includes("/opt/homebrew") && !dir.includes("/usr/local") && !dir.startsWith("/$bunfs")) {
    // Walk up one level if we're in a subdirectory (e.g. commands/)
    const candidate = dir.endsWith("/commands") ? dir.replace(/\/commands$/, "") : dir;
    if (existsSync(`${candidate}/cli.ts`)) return candidate;
  }
  // Prefer saved config
  const saved = readDevModeConfig().sourcePath;
  if (saved && existsSync(`${saved}/cli.ts`)) return saved;

  // Fall back to common checkout locations
  const home = Bun.env.HOME!;
  for (const guess of [
    `${home}/Documents/GitHub/repo-tools`,
    `${home}/GitHub/repo-tools`,
    `${home}/code/repo-tools`,
    `${home}/src/repo-tools`,
    `${home}/repos/repo-tools`,
  ]) {
    if (existsSync(`${guess}/cli.ts`)) return guess;
  }
  return null;
}

function detectBunPath(): string {
  const which = spawnSync("command", ["-v", "bun"], { shell: true, encoding: "utf8" });
  const found = which.stdout?.trim();
  if (found && existsSync(found)) return found;
  // Fallbacks for common install locations
  for (const p of [`${Bun.env.HOME}/.bun/bin/bun`, "/opt/homebrew/bin/bun", "/usr/local/bin/bun"]) {
    if (existsSync(p)) return p;
  }
  return "bun"; // hope PATH resolves it at exec time
}

function enableDevMode(sourcePath: string): void {
  const bunPath = detectBunPath();

  // Save source + bun paths — also read by rt-daemon-shim inside rt-tray.app
  mkdirSync(`${Bun.env.HOME}/.rt`, { recursive: true });
  writeFileSync(DEV_MODE_CONFIG, JSON.stringify({ sourcePath, bunPath }, null, 2));

  // Ensure ~/.local/bin exists
  mkdirSync(`${Bun.env.HOME}/.local/bin`, { recursive: true });

  // Write wrapper script
  const wrapper = [
    `#!/bin/zsh`,
    `exec bun run "${sourcePath}/cli.ts" "$@"`,
  ].join("\n") + "\n";
  writeFileSync(DEV_MODE_WRAPPER, wrapper, { mode: 0o755 });
}

function disableDevMode(): void {
  if (existsSync(DEV_MODE_WRAPPER)) {
    rmSync(DEV_MODE_WRAPPER);
  }
}

// ─── Daemon binary swap ──────────────────────────────────────────────────────
//
// dev  → swap the real compiled daemon out for rt-daemon-shim (signed with the
//        same Team ID), which execs `bun run lib/daemon.ts`. LWCR accepts it
//        because the signature Team ID matches rt-tray.app; TCC inherits
//        because the binary still lives inside the bundle.
// prod → restore the compiled daemon from the .real backup.

type DaemonSwapResult =
  | { status: "swapped" }
  | { status: "already" }
  | { status: "unavailable"; reason: string };

function swapDaemonToShim(): DaemonSwapResult {
  if (!existsSync(DAEMON_SHIM_PATH)) {
    return {
      status: "unavailable",
      reason: "rt-daemon-shim not found in rt-tray.app — rebuild rt-tray (build.sh install) to enable dev-mode daemon swap",
    };
  }
  if (existsSync(DAEMON_REAL_BACKUP)) {
    return { status: "already" }; // already swapped previously
  }
  renameSync(DAEMON_LIVE_PATH, DAEMON_REAL_BACKUP);
  // Hard-link (not rename) — we want to keep the shim in its canonical slot too
  // so repeated toggles don't need rt-tray rebuilds.
  spawnSync("cp", ["-c", DAEMON_SHIM_PATH, DAEMON_LIVE_PATH]); // APFS clone
  return { status: "swapped" };
}

function swapDaemonToReal(): DaemonSwapResult {
  if (!existsSync(DAEMON_REAL_BACKUP)) {
    return { status: "already" };
  }
  if (existsSync(DAEMON_LIVE_PATH)) {
    rmSync(DAEMON_LIVE_PATH);
  }
  renameSync(DAEMON_REAL_BACKUP, DAEMON_LIVE_PATH);
  return { status: "swapped" };
}

/**
 * After swapping the daemon binary on disk, launchd caches a Launch With
 * Code Requirements (LWCR) entry that pins the binary's hash at registration
 * time. Neither `launchctl bootout` nor `SMAppService.agent.unregister()` +
 * `.register()` reliably forces a refresh — BTM retains the cached LWCR and
 * reuses it on re-register. The job then crash-loops with EX_CONFIG (78)
 * and launchd reports "needs LWCR update".
 *
 * The only thing that does reliably force a refresh is toggling the app's
 * Login Item registration (what System Settings → Login Items does). That
 * calls `SMAppService.mainApp.unregister()` + `.register()` — the parent-
 * app-level cycle cascades to all embedded agents with fresh LWCR reads.
 *
 * We delegate to rt-tray via `/login-item/reset` because SMAppService is
 * app-context only; the rt CLI can't call it directly.
 */
async function reregisterDaemon(): Promise<{ ok: boolean; err?: string; status?: string }> {
  const { trayQuery } = await import("../lib/daemon-client.ts");
  const result = await trayQuery("/login-item/reset", "POST");
  if (!result) {
    return { ok: false, err: "rt-tray not reachable" };
  }
  if (!result.ok) {
    return { ok: false, err: (result as any).error ?? "unknown tray error" };
  }
  return { ok: true, status: (result as any).status };
}

export async function toggleDevMode(args: string[]): Promise<void> {
  const { select } = await import("../lib/rt-render.tsx");

  const mode = currentMode();
  const sourcePath = detectSourcePath();

  // Show current state
  console.log("");
  const modeLabel = mode === "dev"
    ? `${green}dev${reset}  ${dim}(local source)${reset}`
    : `${bold}prod${reset}  ${dim}(Homebrew binary)${reset}`;
  console.log(`  ${bold}${cyan}rt dev mode${reset}  currently: ${modeLabel}`);
  if (mode === "dev" && sourcePath) {
    console.log(`  ${dim}source: ${sourcePath}${reset}`);
  }
  console.log("");

  // Resolve target from args or picker
  let target = args[0] as "dev" | "prod" | undefined;

  if (target !== "dev" && target !== "prod") {
    target = await select({
      message: "Switch to",
      options: [
        { value: "dev",  label: "Dev",  hint: `bun run cli.ts — uses local source` },
        { value: "prod", label: "Prod", hint: "Homebrew binary — uses installed release" },
      ],
    }) as "dev" | "prod";
  }

  if (target === "dev") {
    // Need a source path
    let resolvedPath = sourcePath;

    if (!resolvedPath) {
      const { textInput } = await import("../lib/rt-render.tsx");
      const defaultGuess = `${Bun.env.HOME}/Documents/GitHub/repo-tools`;
      const entered = await textInput({
        message: "Path to repo-tools source directory",
        defaultValue: defaultGuess,
      });
      const path = entered?.trim();
      if (!path) {
        console.log(`  ${red}✗${reset} no path entered\n`);
        return;
      }
      if (!existsSync(`${path}/cli.ts`)) {
        console.log(`  ${red}✗${reset} cli.ts not found at: ${path}\n`);
        return;
      }
      resolvedPath = path;
    }

    enableDevMode(resolvedPath!);

    // Ensure shell integration exists (idempotent — handles zsh/bash/fish)
    const shellResult = installShellIntegration();
    if (shellResult.written) {
      console.log(`  ${green}✓${reset} added shell integration to ${shellResult.rcPath}`);
    }

    console.log(`  ${green}✓${reset} dev mode enabled`);
    console.log(`  ${dim}wrapper → ${DEV_MODE_WRAPPER}${reset}`);
    console.log(`  ${dim}source  → ${resolvedPath}${reset}`);

    // Swap daemon binary so launchd runs from source too
    const swap = swapDaemonToShim();
    if (swap.status === "swapped") {
      console.log(`  ${green}✓${reset} daemon binary swapped to shim  ${dim}(re-registering…)${reset}`);
      const reg = await reregisterDaemon();
      if (reg.ok) {
        if (reg.status === "requiresApproval") {
          console.log(`  ${yellow}⚠${reset} rt-tray needs re-approval after reset`);
          console.log(`  ${dim}  Opening System Settings → Login Items…${reset}`);
          spawnSync("open", ["x-apple.systempreferences:com.apple.LoginItems-Settings.extension"]);
        } else {
          console.log(`  ${green}✓${reset} daemon re-registered — running ${reg.status ?? "enabled"}`);
        }
      } else {
        console.log(`  ${yellow}⚠${reset} daemon re-register failed: ${reg.err}`);
        console.log(`  ${dim}  fix manually: System Settings → General → Login Items & Extensions${reset}`);
        console.log(`  ${dim}  → toggle rt-tray off/on (forces a fresh LWCR read)${reset}`);
      }
    } else if (swap.status === "already") {
      console.log(`  ${dim}daemon already running as shim${reset}`);
    } else {
      console.log(`  ${yellow}⚠${reset} ${swap.reason}`);
      console.log(`  ${dim}  CLI is in dev mode; daemon still runs the compiled binary${reset}`);
    }

    console.log(`  ${dim}restart your terminal (or: source ${shellResult.rcPath ?? "~/.zshrc"}) to activate${reset}`);

  } else {
    disableDevMode();
    console.log(`  ${green}✓${reset} CLI restored to prod mode  ${dim}(Homebrew binary is now active)${reset}`);

    const swap = swapDaemonToReal();
    if (swap.status === "swapped") {
      console.log(`  ${green}✓${reset} daemon binary restored  ${dim}(re-registering…)${reset}`);
      const reg = await reregisterDaemon();
      if (reg.ok) {
        console.log(`  ${green}✓${reset} daemon re-registered — running compiled binary`);
      } else {
        console.log(`  ${yellow}⚠${reset} daemon re-register failed: ${reg.err}`);
        console.log(`  ${dim}  fix manually: System Settings → General → Login Items & Extensions${reset}`);
        console.log(`  ${dim}  → toggle rt-tray off/on (forces a fresh LWCR read)${reset}`);
      }
    } else {
      console.log(`  ${dim}daemon already running compiled binary${reset}`);
    }
  }

  console.log("");
}
