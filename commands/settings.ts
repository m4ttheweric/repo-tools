/**
 * rt settings — Configure API keys, team defaults, and repo data.
 *
 * Subcommands (registered in cli.ts as a branch node):
 *   settings linear token   — set Linear API key
 *   settings linear team    — set default Linear team
 *   settings gitlab token   — set GitLab personal access token
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { homedir } from "os";
import type { CommandContext } from "../lib/command-tree.ts";
import {
  rtDir,
  TRAY_APP_NAME, DEV_TRAY_APP_NAME, TRAY_APP_BUNDLE,
  trayAppPath, devTrayAppPath,
} from "../lib/rt-paths.ts";
import { DEV_MODE_TAG, installRtBinary } from "../lib/dev-mode.ts";
import { describeTuple, tupleWarning, type FlavorTuple } from "./daemon.ts";
import { RT_BUNDLE_PATH } from "../lib/bundle-layout.ts";
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
import {
  getKvValue,
  hasKvValue,
  importLegacyJsonFile,
  setKvValue,
} from "../lib/state/index.ts";

// ─── Linear token ────────────────────────────────────────────────────────────

export async function setLinearToken(): Promise<void> {
  const { textInput } = await import("../lib/rt-render.ts");
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
  const { textInput } = await import("../lib/rt-render.ts");
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
    const { textInput } = await import("../lib/rt-render.ts");
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

  const { filterableSelect } = await import("../lib/rt-render.ts");

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
  const { filterableMultiselect } = await import("../lib/rt-render.ts");

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

  // A resolver throw (unexpandable ${...} variable) must not block editing
  // the setting that would fix it — degrade to {} same as loadRunawayConfig.
  let stored: Record<string, number> | undefined;
  try {
    stored = getSetting<Record<string, number> | undefined>("rt.runaway").value;
  } catch { /* degrade below */ }
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
export const DEV_MODE_PRELOAD = join(rtDir(), "dev-restore-cwd.ts");

// kv row (ns='dev-mode', k='config') — see lib/state/db.ts's note on the kv
// table before touching this shape: rt-tray/Sources-daemon-shim/main.swift
// queries it directly over libsqlite3, before bun (and this module) exist.
// The shim ALSO falls back to reading devModeConfigPath() directly (read-
// only) when this row is absent — this module is the only thing that ever
// migrates/renames that legacy file, so an un-migrated machine (this row
// never written) still boots correctly until the next `enableDevMode()`
// call folds it in. See the shim's own "LEGACY FALLBACK" header comment.
const DEV_MODE_NS = "dev-mode";
const DEV_MODE_KEY = "config";

interface DevModeConfig {
  sourcePath?: string;
  bunPath?: string;
}

/** Retired storage location — kept only so a leftover pre-migration file can be imported once, then renamed out of the way. */
export function devModeConfigPath(): string {
  return join(rtDir(), "dev-mode.json");
}

function sanitizeDevModeConfig(raw: unknown): DevModeConfig {
  if (!raw || typeof raw !== "object") return {};
  const r = raw as Record<string, unknown>;
  const out: DevModeConfig = {};
  if (typeof r.sourcePath === "string") out.sourcePath = r.sourcePath;
  if (typeof r.bunPath === "string") out.bunPath = r.bunPath;
  return out;
}

export function readDevModeConfig(): DevModeConfig {
  if (hasKvValue(DEV_MODE_NS, DEV_MODE_KEY)) {
    return sanitizeDevModeConfig(getKvValue<unknown>(DEV_MODE_NS, DEV_MODE_KEY, {}));
  }

  const result = importLegacyJsonFile<DevModeConfig>(devModeConfigPath(), (json) => {
    const config = sanitizeDevModeConfig(json);
    setKvValue(DEV_MODE_NS, DEV_MODE_KEY, config);
    return config;
  }, { verifyPersisted: () => hasKvValue(DEV_MODE_NS, DEV_MODE_KEY) });
  return result.imported ? result.value! : {};
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
  return "bun"; // hope PATH resolves it at exec time — fine for the shell wrapper below (inherits PATH), never fine for the stored kv value (see bunPathForStorage)
}

/**
 * The Swift shim (rt-tray/Sources-daemon-shim/main.swift) never does shell
 * PATH resolution — it only ever `fileExists(atPath:)`s the exact string —
 * so a bare `"bun"` stored in the kv row would resolve against launchd's cwd
 * (`/`) and always stand down. `detectBunPath()`'s last resort ("hope PATH
 * resolves it") is a valid fallback for the shell wrapper it also feeds
 * (which does inherit PATH), but must never be persisted for the shim to
 * read: `undefined` here means "not configured", and the shim's own default
 * (`~/.bun/bin/bun`) takes over instead — strictly better than a value that
 * can never resolve.
 */
export function bunPathForStorage(detected: string): string | undefined {
  return detected.startsWith("/") ? detected : undefined;
}

export function enableDevMode(sourcePath: string): void {
  const bunPath = detectBunPath();

  // Save source + bun paths — also read by rt-daemon-shim inside mattstack.app.
  // readDevModeConfig() first folds in (and safely imports/renames) any
  // legacy dev-mode.json — a save reached without a prior load would
  // otherwise strand an unread legacy file the moment this write makes the
  // store non-empty (the same hazard saveRegistry/saveClaims guard against).
  readDevModeConfig();
  const storedBunPath = bunPathForStorage(bunPath);
  setKvValue(DEV_MODE_NS, DEV_MODE_KEY, storedBunPath ? { sourcePath, bunPath: storedBunPath } : { sourcePath });

  // Ensure rtDir()/~/.local/bin exist for the preload script + wrapper writes below.
  mkdirSync(rtDir(), { recursive: true });
  mkdirSync(`${Bun.env.HOME}/.local/bin`, { recursive: true });

  // Write wrapper script. Use the absolute bun path (not bare `bun`) and
  // prepend the common tool dirs to PATH so the wrapper works even when
  // launched without the user's interactive PATH — e.g. mattstack.app spawns
  // `rt daemon logs` under launchd, whose PATH is only
  // /usr/bin:/bin:/usr/sbin:/sbin. Without this, both `bun` (the wrapper's
  // own interpreter) and the tools cli.ts shells out to (logdy, lnav, bunx)
  // fail to resolve, so the log viewer never starts.
  writeFileSync(DEV_MODE_PRELOAD, renderDevModePreload());
  writeDevModeWrapperFile(renderDevModeWrapper(sourcePath, bunPath));
}

/**
 * Prod mode may have left a SYMLINK at DEV_MODE_WRAPPER (installRtBinary, ->
 * Contents/MacOS/rt inside the app bundle). writeFileSync opens-and-
 * truncates through a symlink, which would overwrite the bundle's real
 * binary instead of replacing the wrapper — corrupting the app's code
 * signature. Write to a sibling tmp file and rename over the destination
 * instead: rename always replaces the directory entry itself, never what it
 * points at.
 */
function writeDevModeWrapperFile(content: string): void {
  const tmp = `${DEV_MODE_WRAPPER}.new`;
  rmSync(tmp, { force: true });
  writeFileSync(tmp, content, { mode: 0o755 });
  renameSync(tmp, DEV_MODE_WRAPPER);
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
    `${DEV_MODE_TAG}`,
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
 * this machine is the one mattstack.app carries at Contents/MacOS/rt
 * (the daemon and the CLI are the same binary), so prod mode installs THAT
 * over the wrapper path: the app provides the binary.
 *
 * Throws when the prod app is absent: stranding the CLI with no rt on PATH is
 * worse than refusing the switch.
 */
function disableDevMode(exists: (path: string) => boolean = existsSync): void {
  const prodAppPath = trayAppPath(exists);
  const prodBinary = join(prodAppPath, RT_BUNDLE_PATH);
  if (!exists(prodBinary)) {
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
  // passing `exists` through keeps this resolution testable without ever
  // touching the real /Applications.
  const appPath = mode === "dev" ? devTrayAppPath(exists) : trayAppPath(exists);
  return {
    mode,
    name: mode === "dev" ? DEV_TRAY_APP_NAME : TRAY_APP_NAME,
    appPath,
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

async function handoffToFlavor(outgoing: FlavorInfo, incoming: FlavorInfo, target: "dev" | "prod"): Promise<void> {
  const { trayQuery } = await import("../lib/daemon-client.ts");
  const { TRAY_SOCK_PATH } = await import("../lib/daemon-config.ts");
  const outgoingLabel = launchdLabelFor(outgoing.mode);

  // 1. Retire the outgoing tray's own registrations (its daemon LaunchAgent
  // and its login item) before quitting it — TrayServer's /flavor/retire.
  const retire = await trayQuery("/flavor/retire", "POST");
  if (retire?.ok) {
    console.log(`  ${green}✓${reset} ${outgoing.name} retired its registrations`);
  } else {
    // Unreachable (retire never ran) and a reachable-but-{ok:false} reply both
    // leave the outgoing LaunchAgent registered — either way waitUntilGone
    // would poll a launchd label that was never booted out and time out, so
    // both share the direct bootout fallback.
    console.log(retire
      ? `  ${yellow}⚠${reset} flavor retire: ${(retire as any).error ?? "failed"}`
      : `  ${yellow}⚠${reset} flavor retire: ${outgoing.name} not reachable`);
    spawnSync("launchctl", ["bootout", `gui/${process.getuid?.() ?? 501}/${outgoingLabel}`], { stdio: "pipe", env: process.env });
    console.log(`  ${yellow}⚠${reset} booted out ${outgoingLabel} directly`);
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

  // Write the intended mode BEFORE launching the incoming bundle — its tray
  // reads this on first activation, and reading it before `open` means it
  // never sees a stale mode in the window between launch and this write.
  setSetting("mattstack.mode", target, "machine");

  // 4. Launch the incoming app.
  spawnSync("open", [incoming.appPath], { stdio: "pipe", env: process.env });
  console.log(`  ${green}✓${reset} launched ${incoming.appPath}`);
}

/**
 * deck's `isDevMode` cache refreshes every 2 seconds on its own, so this poke
 * only shortens that wait: it must never fail the toggle it rides along
 * with. Every failure path (missing/unparseable api.json, a non-2xx answer,
 * a network error, a timeout) degrades to a returned note instead of a throw.
 */
export async function pokeDeckReresolve(deps: {
  readApiFile?: () => string | null;
  fetchImpl?: typeof fetch;
} = {}): Promise<string> {
  const read = deps.readApiFile ?? (() => {
    try {
      return readFileSync(join(process.env.HOME ?? homedir(), ".mattstack", "deck", "api.json"), "utf8");
    } catch {
      return null;
    }
  });
  const doFetch = deps.fetchImpl ?? fetch;
  try {
    const raw = read();
    if (raw === null) return "deck not poked (no api.json); managed apps follow on their next resolve";
    const port = (JSON.parse(raw) as { port?: unknown }).port;
    if (typeof port !== "number") return "deck not poked (bad api.json); managed apps follow on their next resolve";
    const res = await doFetch(`http://127.0.0.1:${port}/api/v1/apps/managed/reresolve`, {
      method: "POST",
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return `deck answered ${res.status} on reresolve; managed apps follow on their next resolve`;
    const body = (await res.json()) as { restarted?: string[]; unchanged?: string[]; failed?: Array<{ name: string; error: string }> };
    const restarted = body.restarted ?? [];
    const failed = body.failed ?? [];
    const parts = [`${restarted.length} restarted`, `${(body.unchanged ?? []).length} unchanged`];
    if (failed.length) parts.push(`${failed.length} failed (${failed.map((f) => f.name).join(", ")})`);
    return `deck re-resolved managed apps: ${parts.join(", ")}`;
  } catch (e) {
    return `deck not poked (${(e as Error).message}); managed apps follow on their next resolve`;
  }
}

export type GuardVerdict = "noop" | "repair" | "switch";

/** "already in X mode" is earned only when every leg agrees; a serving daemon of the wrong flavor makes the toggle a repair even when the CLI already matches. */
export function devModeGuardVerdict(target: "dev" | "prod", t: FlavorTuple): GuardVerdict {
  if (target !== t.cliFlavor) return "switch";
  const daemonAgrees = t.daemon === null || t.daemon.flavor === target;
  const intentAgrees = t.intended.mode === target;
  return daemonAgrees && intentAgrees ? "noop" : "repair";
}

export function renderTupleReadout(t: FlavorTuple, json: boolean): string {
  if (json) return JSON.stringify(t);
  const lines = [
    `  intended: ${t.intended.mode} (${t.intended.provenance})`,
    `  cli:      ${t.cliFlavor}`,
    `  daemon:   ${t.daemon ? `${t.daemon.flavor} (pid ${t.daemon.pid})` : "not running"}`,
  ];
  const warning = tupleWarning(t);
  if (warning) lines.push(`  ⚠ ${warning}`);
  return lines.join("\n");
}

export async function toggleDevMode(args: string[], _ctx: CommandContext = {}, exists: (path: string) => boolean = existsSync): Promise<void> {
  const tuple = await describeTuple();
  const mode = tuple.cliFlavor;
  const sourcePath = detectSourcePath();
  const json = args.includes("--json");

  // Resolve target from args (a literal "dev"/"prod"; "--json" and anything
  // else fall through to undefined, same as the bare-invocation case).
  let target = args[0] as "dev" | "prod" | undefined;
  if (target !== "dev" && target !== "prod") target = undefined;

  if (!target) {
    // A TTY is needed only to PROMPT for a target — --json and a piped/
    // scripted caller both get the read-only tuple instead, undecorated so
    // --json output stays one parseable JSON line (the Swift tray parses
    // exactly this: `rt settings dev-mode --json`).
    if (!process.stdin.isTTY || json) {
      console.log(renderTupleReadout(tuple, json));
      return;
    }
  }

  // Show current state (human-facing paths only, below this point).
  console.log("");
  const modeLabel = mode === "dev"
    ? `${green}dev${reset}  ${dim}(local source)${reset}`
    : `${bold}prod${reset}  ${dim}(mattstack.app binary)${reset}`;
  console.log(`  ${bold}${cyan}rt dev mode${reset}  currently: ${modeLabel}`);
  if (mode === "dev" && sourcePath) {
    console.log(`  ${dim}source: ${sourcePath}${reset}`);
  }
  console.log("");

  if (!target) {
    const { select } = await import("../lib/rt-render.ts");
    target = await select({
      message: "Switch to",
      options: [
        { value: "dev",  label: "Dev",  hint: `mattstack-dev.app — daemon and CLI run from local source` },
        { value: "prod", label: "Prod", hint: "mattstack.app — daemon and CLI are its compiled binary" },
      ],
    }) as "dev" | "prod";
  }

  const verdict = devModeGuardVerdict(target, tuple);
  if (verdict === "noop") {
    console.log(`  ${dim}already in ${target} mode${reset}\n`);
    return;
  }

  const incoming = flavorFor(target, exists);
  // Only two flavors exist, so "the other one" is always the outgoing side —
  // NOT necessarily `mode` (the CLI's own flavor). A repair's whole point is
  // a half-state where the CLI already matches target but the wrong flavor's
  // daemon/tray is what's actually serving; quitting "mode" there would
  // pkill a name nothing is running under and leave the real offender alive.
  const outgoing = flavorFor(target === "dev" ? "prod" : "dev", exists);

  // 0. Precondition — the incoming flavor's bundle must exist on disk BEFORE
  // we touch the running flavor at all, so the toggle can never leave the
  // machine tray-less.
  if (!exists(incoming.appPath)) {
    console.log(`  ${red}✗${reset} ${incoming.appPath} not found`);
    console.log(`  ${dim}run: build.sh ${target === "dev" ? "dev" : "install"} first${reset}\n`);
    return;
  }

  if (target === "dev") {
    // Need a source path
    let resolvedPath = sourcePath;

    if (!resolvedPath) {
      const { textInput } = await import("../lib/rt-render.ts");
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

    await handoffToFlavor(outgoing, incoming, target);
    console.log(`  ${dim}${await pokeDeckReresolve()}${reset}`);

    console.log(`  ${dim}restart your terminal (or: source ${shellResult.rcPath ?? "~/.zshrc"}) to activate${reset}`);

  } else {
    disableDevMode(exists);
    console.log(`  ${green}✓${reset} CLI restored to prod mode  ${dim}(mattstack.app binary installed at ~/.local/bin/rt)${reset}`);

    await handoffToFlavor(outgoing, incoming, target);
    console.log(`  ${dim}${await pokeDeckReresolve()}${reset}`);
  }

  console.log("");
}

