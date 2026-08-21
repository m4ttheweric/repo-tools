/**
 * rt settings — Configure API keys, team defaults, and repo data.
 *
 * Subcommands (registered in cli.ts as a branch node):
 *   settings linear token   — set Linear API key
 *   settings linear team    — set default Linear team
 *   settings gitlab token   — set GitLab personal access token
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { homedir } from "os";
import {
  rtDir,
  TRAY_APP_NAME, DEV_TRAY_APP_NAME, TRAY_APP_BUNDLE, DEV_TRAY_APP_BUNDLE,
  trayAppPath, devTrayAppPath, installedTrayAppPath,
} from "../lib/rt-paths.ts";
import { currentMode, installRtBinary } from "../lib/dev-mode.ts";
import { spawnSync } from "child_process";
import { bold, cyan, dim, green, red, reset, yellow } from "../lib/tui.ts";
import {
  loadSecrets,
  saveSecret,
  fetchTeams,
  saveTeamConfig,
} from "../lib/linear.ts";
import {
  loadNotificationPrefs,
  saveNotificationPrefs,
  NOTIFICATION_TYPES,
} from "../lib/notifier.ts";
import { installShellIntegration } from "../lib/shell-integration.ts";
import { getSetting } from "../lib/settings/resolve.ts";
import { setSetting } from "../lib/settings/write.ts";

// ─── Linear token ────────────────────────────────────────────────────────────

export async function setLinearToken(): Promise<void> {
  const { textInput } = await import("../lib/rt-render.tsx");
  const secrets = await loadSecrets();

  // try scopes the prompt only — a failed *save* must surface as an error,
  // not masquerade as "keeping existing key".
  let linearKey: string;
  try {
    linearKey = await textInput({
      message: "Linear API key (lin_api_...)",
      placeholder: secrets.linearApiKey
        ? "••• (already set, leave empty to keep)"
        : "lin_api_...",
    });
  } catch {
    if (secrets.linearApiKey) {
      console.log(`  ${dim}keeping existing Linear API key${reset}`);
    }
    return;
  }

  if (!linearKey.trim()) {
    if (secrets.linearApiKey) {
      console.log(`  ${dim}keeping existing Linear API key${reset}`);
    } else {
      console.log(`  ${yellow}no key entered${reset}`);
    }
    return;
  }

  try {
    await saveSecret("linearApiKey", linearKey.trim());
  } catch (err) {
    console.log(`\n  ${red}✗ failed to save Linear API key: ${err instanceof Error ? err.message : String(err)}${reset}\n`);
    process.exit(1);
  }
  console.log(`\n  ${green}✓${reset} Linear API key saved\n`);
}

// ─── GitLab token ────────────────────────────────────────────────────────────

export async function setGitlabToken(): Promise<void> {
  const { textInput } = await import("../lib/rt-render.tsx");
  const secrets = await loadSecrets();

  // try scopes the prompt only — a failed *save* must surface as an error,
  // not masquerade as "keeping existing token".
  let gitlabToken: string;
  try {
    gitlabToken = await textInput({
      message: "GitLab personal access token",
      placeholder: secrets.gitlabToken
        ? "••• (already set, leave empty to keep)"
        : "glpat-...",
    });
  } catch {
    if (secrets.gitlabToken) {
      console.log(`  ${dim}keeping existing GitLab token${reset}`);
    }
    return;
  }

  if (!gitlabToken.trim()) {
    if (secrets.gitlabToken) {
      console.log(`  ${dim}keeping existing GitLab token${reset}`);
    } else {
      console.log(`  ${yellow}no token entered${reset}`);
    }
    return;
  }

  try {
    await saveSecret("gitlabToken", gitlabToken.trim());
  } catch (err) {
    console.log(`\n  ${red}✗ failed to save GitLab token: ${err instanceof Error ? err.message : String(err)}${reset}\n`);
    process.exit(1);
  }
  console.log(`\n  ${green}✓${reset} GitLab token saved\n`);
}

// ─── StrongDM email ──────────────────────────────────────────────────────────

export async function setSdmEmail(args: string[]): Promise<void> {
  const secrets = await loadSecrets();
  const fromArgs = args.find(a => !a.startsWith("--"))?.trim();

  let email: string;
  if (fromArgs) {
    email = fromArgs;
  } else if (!process.stdin.isTTY) {
    console.log(`\n  ${red}✗ no email given and no terminal to prompt in${reset}`);
    console.log(`  ${dim}usage: rt sdm set-email <email>${reset}\n`);
    process.exitCode = 1;
    return;
  } else {
    const { textInput } = await import("../lib/rt-render.tsx");
    try {
      email = await textInput({
        message: "StrongDM account email",
        placeholder: secrets.sdmEmail
          ? "••• (already set, leave empty to keep)"
          : "you@example.com",
      });
    } catch {
      if (secrets.sdmEmail) {
        console.log(`  ${dim}keeping existing StrongDM email${reset}`);
      }
      return;
    }
  }

  if (!email.trim()) {
    if (secrets.sdmEmail) {
      console.log(`  ${dim}keeping existing StrongDM email${reset}`);
    } else {
      console.log(`  ${yellow}no email entered${reset}`);
    }
    return;
  }

  try {
    await saveSecret("sdmEmail", email.trim());
  } catch (err) {
    console.log(`\n  ${red}✗ failed to save StrongDM email: ${err instanceof Error ? err.message : String(err)}${reset}\n`);
    process.exit(1);
  }
  console.log(`\n  ${green}✓${reset} StrongDM email saved\n`);
}

// ─── Linear team ─────────────────────────────────────────────────────────────

export async function setLinearTeam(): Promise<void> {
  const secrets = await loadSecrets();
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

  await saveTeamConfig(team.id, team.key);
  return { teamId: team.id, teamKey: team.key };
}

// ─── Notification preferences ────────────────────────────────────────────────

export async function configureNotifications(): Promise<void> {
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

// ─── Runaway process detection thresholds ────────────────────────────────────

export async function configureRunaway(args: string[]): Promise<void> {
  const field = args[0];
  const value = args[1];

  const stored = getSetting<Record<string, number> | undefined>("rt.runaway").value;
  const config: Record<string, number> = stored ? { ...stored } : {};

  if (!field) {
    console.log(`\n  ${bold}Runaway process detection${reset}\n`);
    console.log(`  ${dim}cpu-threshold${reset}  ${config.cpuThreshold ?? 80}%`);
    console.log(`  ${dim}sustain-min${reset}    ${(config.sustainMs ?? 300_000) / 60_000} minutes`);
    console.log(`  ${dim}grace-min${reset}      ${(config.graceMs ?? 120_000) / 60_000} minutes`);
    console.log(`\n  ${dim}usage: rt settings runaway <field> <value>${reset}\n`);
    return;
  }

  if (!value) {
    console.log(`  ${red}missing value${reset}`);
    return;
  }

  const num = parseFloat(value);
  if (isNaN(num)) {
    console.log(`  ${red}value must be a number${reset}`);
    return;
  }

  switch (field) {
    case "cpu-threshold":
      config.cpuThreshold = num;
      break;
    case "sustain-min":
      config.sustainMs = num * 60_000;
      break;
    case "grace-min":
      config.graceMs = num * 60_000;
      break;
    default:
      console.log(`  ${red}unknown field: ${field}${reset}`);
      console.log(`  ${dim}fields: cpu-threshold, sustain-min, grace-min${reset}`);
      return;
  }

  setSetting("rt.runaway", config, "machine");
  console.log(`  ${green}✓${reset} saved`);
  console.log(`  ${dim}restart daemon to apply: rt daemon restart${reset}`);
}

// ─── Test push notification ──────────────────────────────────────────────────

export async function sendTestPushNotification(): Promise<void> {
  const { TRAY_SOCK_PATH } = await import("../lib/daemon-config.ts");

  if (!existsSync(TRAY_SOCK_PATH)) {
    console.log(`\n  ${yellow}⚠${reset}  rt tray is not running`);
    console.log(`     ${dim}(no socket at ~/.mattstack/rt/tray.sock — start the tray app first)${reset}\n`);
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
const DEV_MODE_CONFIG  = join(rtDir(), "dev-mode.json");
export const DEV_MODE_PRELOAD = join(rtDir(), "dev-restore-cwd.ts");

function readDevModeConfig(): { sourcePath?: string; bunPath?: string } {
  try {
    return JSON.parse(readFileSync(DEV_MODE_CONFIG, "utf8"));
  } catch {
    return {};
  }
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

  // Save source + bun paths — also read by rt-daemon-shim inside mattstack.app
  mkdirSync(rtDir(), { recursive: true });
  writeFileSync(DEV_MODE_CONFIG, JSON.stringify({ sourcePath, bunPath }, null, 2));

  // Ensure ~/.local/bin exists
  mkdirSync(`${Bun.env.HOME}/.local/bin`, { recursive: true });

  // Write wrapper script. Use the absolute bun path (not bare `bun`) and
  // prepend the common tool dirs to PATH so the wrapper works even when
  // launched without the user's interactive PATH — e.g. mattstack.app spawns
  // `rt daemon logs` under launchd, whose PATH is only
  // /usr/bin:/bin:/usr/sbin:/sbin. Without this, both `bun` (the wrapper's
  // own interpreter) and the tools cli.ts shells out to (logdy, lnav, bunx)
  // fail to resolve, so the log viewer never starts.
  writeFileSync(DEV_MODE_PRELOAD, renderDevModePreload());
  writeFileSync(DEV_MODE_WRAPPER, renderDevModeWrapper(sourcePath, bunPath), { mode: 0o755 });
}

// Bun transpiles with the tsconfig found in the *cwd*, so running rt from a
// repo whose tsconfig sets jsxImportSource (e.g. hono/jsx) breaks every .tsx
// file in rt with "Cannot find module '<source>/jsx-dev-runtime'". The wrapper
// used --tsconfig-override to pin rt's own tsconfig, but that flag trips a bun
// fd-bookkeeping bug that makes every rt command trail an "Internal error:
// directory mismatch" line on exit (https://github.com/oven-sh/bun/issues/22023,
// still present in 1.3.14). Instead: cd into the source repo so bun resolves
// rt's tsconfig naturally, and restore the user's launch cwd via a --preload
// script, which runs after bun fixes its transpiler config at startup but
// before any other module loads.
export function renderDevModeWrapper(sourcePath: string, bunPath: string): string {
  const bunDir = dirname(bunPath);
  return [
    `#!/bin/zsh`,
    `export PATH="${bunDir}:/opt/homebrew/bin:/usr/local/bin:$PATH"`,
    `export RT_LAUNCH_CWD="$PWD"`,
    `cd "${sourcePath}" || { echo "rt: dev-mode source checkout missing: ${sourcePath}" >&2; exit 1; }`,
    `exec "${bunPath}" run --preload="${DEV_MODE_PRELOAD}" "${sourcePath}/cli.ts" "$@"`,
  ].join("\n") + "\n";
}

export function renderDevModePreload(): string {
  return [
    `// Written by \`rt settings dev-mode\` (commands/settings.ts, RT-25).`,
    `// The dev wrapper cds into the rt source repo before exec'ing bun; this`,
    `// puts the process back in the directory the user launched from.`,
    `const launchCwd = process.env.RT_LAUNCH_CWD;`,
    `if (launchCwd) {`,
    `  try {`,
    `    process.chdir(launchCwd);`,
    `    process.env.PWD = launchCwd;`,
    `  } catch {`,
    `    // Launch dir vanished; keep running from the source repo.`,
    `  }`,
    `  delete process.env.RT_LAUNCH_CWD;`,
    `}`,
    `export {};`,
  ].join("\n") + "\n";
}

/**
 * Leaving dev mode must leave a WORKING `rt` behind. The only compiled rt on
 * this machine is the one mattstack.app carries at Contents/MacOS/rt-daemon
 * (the daemon and the CLI are the same binary), so prod mode installs THAT
 * over the wrapper path: the app provides the binary.
 *
 * Throws when the prod app is absent: stranding the CLI with no rt on PATH is
 * worse than refusing the switch.
 */
function disableDevMode(exists: (path: string) => boolean = existsSync): void {
  const prodAppPath = installedTrayAppPath(TRAY_APP_BUNDLE, exists) ?? trayAppPath();
  const prodBinary = join(prodAppPath, "Contents", "MacOS", "rt-daemon");
  if (!existsSync(prodBinary)) {
    throw new Error(
      `cannot switch to prod: ${TRAY_APP_BUNDLE} is not installed, so there is no compiled rt to install at ${DEV_MODE_WRAPPER}. Install the app first (rt --post-install), then retry.`,
    );
  }

  installRtBinary(prodBinary);

  if (existsSync(DEV_MODE_PRELOAD)) {
    rmSync(DEV_MODE_PRELOAD);
  }
}

// ─── Flavor handoff (MAT-383 §3) ─────────────────────────────────────────────
//
// `rt settings dev-mode on|off` is a handoff between two independently
// registered tray apps (mattstack.app / mattstack-dev.app), not a binary
// swap: (0) the incoming flavor's bundle must exist on disk BEFORE the
// running flavor is touched at all; (1) the outgoing tray gives up its own
// daemon LaunchAgent + login-item registrations via POST /flavor/retire;
// (2) the outgoing tray is quit by ITS OWN flavor names (never the incoming
// flavor's); (3) we poll until it is actually gone — a CONNECT-probe of the
// shared tray socket (a pkill'd tray leaks the socket file, so existence
// alone would lie) plus `launchctl list` on its own label; (4) the incoming
// app is launched. Never mutates a bundle in place.

interface FlavorInfo {
  mode: "dev" | "prod";
  /** CFBundleExecutable AND osascript display name — build.sh templates them identically. */
  name: string;
  appPath: string;
}

function flavorFor(mode: "dev" | "prod", exists: (path: string) => boolean = existsSync): FlavorInfo {
  const bundle = mode === "dev" ? DEV_TRAY_APP_BUNDLE : TRAY_APP_BUNDLE;
  const fixedFallback = mode === "dev" ? devTrayAppPath() : trayAppPath();
  return {
    mode,
    name: mode === "dev" ? DEV_TRAY_APP_NAME : TRAY_APP_NAME,
    // Wherever it's ACTUALLY installed (/Applications, ~/Applications, or the
    // machine setting); falls back to the conventional ~/Applications
    // location so a genuinely-missing bundle still fails existsSync with a
    // sensible path in the error message, rather than null.
    appPath: installedTrayAppPath(bundle, exists) ?? fixedFallback,
  };
}

function launchdLabelFor(mode: "dev" | "prod"): string {
  return mode === "dev" ? "com.mattstack.daemon.dev" : "com.mattstack.daemon";
}

const HANDOFF_POLL_TIMEOUT_MS = 3_000;
const HANDOFF_POLL_INTERVAL_MS = 75;

/** CONNECT-probe, not file existence — a pkill'd tray leaks the socket file. */
async function traySocketIsLive(sockPath: string): Promise<boolean> {
  if (!existsSync(sockPath)) return false;
  try {
    const response = await fetch("http://localhost/health", {
      unix: sockPath,
      method: "GET",
      signal: AbortSignal.timeout(500),
    } as any);
    return response.status > 0;
  } catch {
    return false; // connection refused / socket gone / timed out
  }
}

function launchdStillRegistered(label: string): boolean {
  // env explicitly forwarded: Bun resolves a bare command against the
  // process-start PATH snapshot unless an env is passed, so a runtime PATH
  // fake (tests) would otherwise be silently ignored.
  const result = spawnSync("launchctl", ["list", label], { encoding: "utf8", stdio: "pipe", env: process.env });
  if (result.error || result.status !== 0) return false;
  const out = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  return !out.includes("Could not find");
}

/** Bounded poll: both the socket AND the outgoing launchd label must clear. */
async function waitUntilGone(sockPath: string, outgoingLabel: string): Promise<boolean> {
  const deadline = Date.now() + HANDOFF_POLL_TIMEOUT_MS;
  for (;;) {
    const gone = !(await traySocketIsLive(sockPath)) && !launchdStillRegistered(outgoingLabel);
    if (gone) return true;
    if (Date.now() >= deadline) return false;
    await Bun.sleep(HANDOFF_POLL_INTERVAL_MS);
  }
}

async function handoffToFlavor(outgoing: FlavorInfo, incoming: FlavorInfo): Promise<void> {
  const { trayQuery } = await import("../lib/daemon-client.ts");
  const { TRAY_SOCK_PATH } = await import("../lib/daemon-config.ts");
  const outgoingLabel = launchdLabelFor(outgoing.mode);

  // 1. Retire the outgoing tray's own registrations (its daemon LaunchAgent
  // and its login item) before quitting it — TrayServer's /flavor/retire.
  const retire = await trayQuery("/flavor/retire", "POST");
  if (retire?.ok) {
    console.log(`  ${green}✓${reset} ${outgoing.name} retired its registrations`);
  } else {
    console.log(`  ${yellow}⚠${reset} flavor retire: ${retire ? ((retire as any).error ?? "failed") : `${outgoing.name} not reachable`}`);
  }

  // 2. Quit the outgoing tray by ITS OWN flavor's names. env forwarded
  // explicitly for the same reason as launchdStillRegistered above.
  spawnSync("osascript", ["-e", `tell application "${outgoing.name}" to quit`], { stdio: "pipe", timeout: 3_000, env: process.env });
  spawnSync("pkill", ["-x", outgoing.name], { stdio: "pipe", env: process.env });

  // 3. Poll until the outgoing pair is actually gone — required because the
  // incoming tray's ping-then-exit socket guard would otherwise see the
  // dying socket and abort its own startup.
  const gone = await waitUntilGone(TRAY_SOCK_PATH, outgoingLabel);
  console.log(gone
    ? `  ${green}✓${reset} ${outgoing.name} quit`
    : `  ${yellow}⚠${reset} ${outgoing.name} did not fully quit — launching ${incoming.name} anyway`);

  // 4. Launch the incoming app.
  spawnSync("open", [incoming.appPath], { stdio: "pipe", env: process.env });
  console.log(`  ${green}✓${reset} launched ${incoming.appPath}`);
}

export async function toggleDevMode(args: string[], exists: (path: string) => boolean = existsSync): Promise<void> {
  const { select } = await import("../lib/rt-render.tsx");

  const mode = currentMode();
  const sourcePath = detectSourcePath();

  // Show current state
  console.log("");
  const modeLabel = mode === "dev"
    ? `${green}dev${reset}  ${dim}(local source)${reset}`
    : `${bold}prod${reset}  ${dim}(mattstack.app binary)${reset}`;
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
        { value: "dev",  label: "Dev",  hint: `mattstack-dev.app — daemon and CLI run from local source` },
        { value: "prod", label: "Prod", hint: "mattstack.app — daemon and CLI are its compiled binary" },
      ],
    }) as "dev" | "prod";
  }

  if (target === mode) {
    console.log(`  ${dim}already in ${mode} mode${reset}\n`);
    return;
  }

  const incoming = flavorFor(target, exists);

  // 0. Precondition — the incoming flavor's bundle must exist on disk BEFORE
  // we touch the running flavor at all, so the toggle can never leave the
  // machine tray-less.
  if (!existsSync(incoming.appPath)) {
    console.log(`  ${red}✗${reset} ${incoming.appPath} not found`);
    console.log(`  ${dim}run: build.sh ${target === "dev" ? "dev" : "install"} first${reset}\n`);
    return;
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

    console.log(`  ${green}✓${reset} CLI switched to dev mode`);
    console.log(`  ${dim}wrapper → ${DEV_MODE_WRAPPER}${reset}`);
    console.log(`  ${dim}source  → ${resolvedPath}${reset}`);

    await handoffToFlavor(flavorFor(mode, exists), incoming);

    console.log(`  ${dim}restart your terminal (or: source ${shellResult.rcPath ?? "~/.zshrc"}) to activate${reset}`);

  } else {
    disableDevMode(exists);
    console.log(`  ${green}✓${reset} CLI restored to prod mode  ${dim}(mattstack.app binary installed at ~/.local/bin/rt)${reset}`);

    await handoffToFlavor(flavorFor(mode, exists), incoming);
  }

  console.log("");
}

// ─── LLM setup ───────────────────────────────────────────────────────────────

export async function configureLlm(): Promise<void> {
  const { select } = await import("../lib/rt-render.tsx");
  const {
    listOllamaModels,
    loadLlmConfig,
    saveLlmConfig,
    llmPrompt,
  } = await import("../lib/llm.ts");

  const config = loadLlmConfig();

  // Step 1: Verify Ollama is reachable and list models
  console.log(`\n  ${dim}checking Ollama at ${config.url}…${reset}`);

  let models: Array<{ name: string; size: string }>;
  try {
    models = await listOllamaModels(config.url);
  } catch (err) {
    console.log(`\n  ${red}✗${reset} cannot reach Ollama at ${config.url}`);
    console.log(`  ${dim}make sure Ollama is running (ollama serve)${reset}\n`);
    return;
  }

  if (models.length === 0) {
    console.log(`\n  ${yellow}!${reset} no models found`);
    console.log(`  ${dim}pull one first: ollama pull qwen3:4b${reset}\n`);
    return;
  }

  // Step 2: Pick a model
  const currentModel = config.model;
  const options = models.map(m => ({
    value: m.name,
    label: `${m.name}  ${dim}(${m.size})${reset}`,
    hint: m.name === currentModel ? "current" : "",
  }));

  const selected = await select({
    message: "Select LLM model",
    options,
  });

  if (!selected) return;

  saveLlmConfig({ model: selected });

  // Step 3: Offer test prompt
  console.log(`  ${green}✓${reset} model set to ${bold}${selected}${reset}`);

  try {
    const test = await select({
      message: "Send a test prompt?",
      options: [
        { value: "yes", label: "Yes, test the model", hint: "sends a quick hello" },
        { value: "no",  label: "Skip", hint: "" },
      ],
    });
    if (test === "yes") {
      console.log(`\n  ${dim}testing…${reset}`);
      const response = await llmPrompt(
        "You are a helpful assistant. Reply concisely.",
        "Say hello and confirm you are working.",
      );
      console.log(`  ${green}✓${reset} response: ${dim}${response.slice(0, 120)}${reset}\n`);
    }
  } catch (err) {
    console.log(`  ${yellow}!${reset} test failed: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}
