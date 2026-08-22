/**
 * tools-group validators — provisioned tools (herdr, claude, fast-browser),
 * bundled-but-optional ones (editor, Chrome, Mission Control), team-declared
 * tools from pack requirements.jsonc, and per-pack `pack.*` install rows.
 *
 * RULING R1 (canInstall deadlock): a `pack.<pack>` row is satisfiable only by
 * Install itself (the plugins.install step) — never by a user action outside
 * setup — so it is emitted required:false with a real optionalNote here; a
 * later composePlan(mode) does the id-keyed post-pass that flips it to
 * required:true once `setup status` runs post-install. Every other row in
 * this group has a user-doable remedy (sign in, brew install, download,
 * flip a setting) and is required exactly per the table below.
 */

import { resolveTool } from "../../deps/resolve.ts";
import { detectEditors } from "../../editors.ts";
import { row, type Action, type Row } from "../contract.ts";
import type { Probes } from "../probes.ts";
import type { PackRequirements, ToolRequirement } from "../requirements.ts";
import { atLeast } from "../semver.ts";

const HERDR_FLOOR = "0.7.5";
const CHROME_PATHS = (home: string): string[] => ["/Applications/Google Chrome.app", `${home}/Applications/Google Chrome.app`];

const CLAUDE_SIGNIN_STEPS: Action = { type: "steps", label: "Show steps…", steps: ["Open a terminal", "Run: claude", "Follow the sign-in prompt"] };
const FAST_BROWSER_EXTENSION_STEPS: Action = {
  type: "steps",
  label: "Show steps…",
  steps: ["Open chrome://extensions", "Turn on Developer mode", "Load unpacked → ~/.fast-browser/extension/current/unpacked"],
};
const CHROME_DOWNLOAD_ACTION: Action = { type: "open-url", label: "Download", url: "https://www.google.com/chrome/" };
const MISSION_CONTROL_SETTINGS_ACTION: Action = { type: "open-settings", label: "Open Keyboard Settings…", target: "keyboard" };

// ─── injectable seams ─────────────────────────────────────────────────────────

export interface ToolsSeams {
  resolveTool: typeof resolveTool;
  detectEditors: typeof detectEditors;
}

const REAL_SEAMS: ToolsSeams = { resolveTool, detectEditors };

// ─── shared helpers ────────────────────────────────────────────────────────

/** First dotted-numeric run anywhere in `--version`-style stdout ("herdr 0.8.0", "git version 2.43.0", "v0.8.0" all yield "0.8.0"); falls back to the trimmed stdout when nothing numeric is found, so a floor compare against it fails closed (never "ready" from unparseable output). */
function extractVersion(stdout: string): string {
  const trimmed = stdout.trim();
  const match = trimmed.match(/[0-9]+(?:\.[0-9]+)*/);
  return match ? match[0] : trimmed;
}

function provisionedInstallAction(tool: string, hasBrew: boolean): Action {
  return { type: "install", label: "Install", tool, via: hasBrew ? "brew" : "vendor" };
}

// ─── tool.herdr ────────────────────────────────────────────────────────────

async function herdrRow(p: Probes, opts: { hasBrew: boolean }): Promise<Row> {
  const base = { id: "tool.herdr", kind: "tool" as const, title: "herdr", why: "Drives Herdr panes for remote-control and multi-agent workflows.", required: true };

  const versionRes = await p.exec(["herdr", "--version"]);
  if (versionRes.code === 127) return row({ ...base, status: "missing", detail: "herdr not found", action: provisionedInstallAction("herdr", opts.hasBrew) });
  if (versionRes.code !== 0) return row({ ...base, status: "error", detail: `could not run herdr (exit ${versionRes.code})` });

  const version = extractVersion(versionRes.stdout);
  if (!atLeast(version, HERDR_FLOOR)) return row({ ...base, status: "invalid", detail: `herdr ${version} < ${HERDR_FLOOR}` });

  const integrationRes = await p.exec(["herdr", "integration", "status"]);
  const claudeIntegrated = integrationRes.stdout.toLowerCase().includes("claude");
  if (!claudeIntegrated) {
    return row({
      ...base,
      status: "needs-you",
      detail: `herdr ${version}, Claude integration not installed`,
      action: { type: "run", label: "Install integration", verb: ["tools", "setup", "herdr"] },
    });
  }
  return row({ ...base, status: "ready", detail: `herdr ${version}, Claude integration installed` });
}

// ─── tool.claude ───────────────────────────────────────────────────────────

async function claudeRow(p: Probes, opts: { hasBrew: boolean }): Promise<Row> {
  const base = { id: "tool.claude", kind: "tool" as const, title: "Claude Code", why: "Runs the agent sessions rt drives and hands work off to.", required: true };

  const versionRes = await p.exec(["claude", "--version"]);
  if (versionRes.code === 127) return row({ ...base, status: "missing", detail: "claude not found", action: provisionedInstallAction("claude", opts.hasBrew) });
  if (versionRes.code !== 0) return row({ ...base, status: "error", detail: `could not run claude (exit ${versionRes.code})` });
  const version = extractVersion(versionRes.stdout);

  const authRes = await p.exec(["claude", "auth", "status"]);
  if (authRes.code === 0) return row({ ...base, status: "ready", detail: `${version}, signed in` });
  if (authRes.stderr.toLowerCase().includes("unknown")) return row({ ...base, status: "ready", detail: "installed (sign-in not checked)" });
  return row({ ...base, status: "needs-you", detail: "sign in: run claude once", action: CLAUDE_SIGNIN_STEPS });
}

// ─── tool.fast-browser ─────────────────────────────────────────────────────

interface FastBrowserDoctor {
  runtime?: { ok?: boolean };
  extension?: { loaded?: boolean };
  pairing?: { ok?: boolean };
}

async function fastBrowserRow(p: Probes, seams: ToolsSeams): Promise<Row> {
  const base = { id: "tool.fast-browser", kind: "tool" as const, title: "Fast Browser", why: "Backs rt's macro-first browser automation.", required: true };

  const resolved = seams.resolveTool(p, "fast-browser");
  if (!resolved.exec) return row({ ...base, status: "missing", detail: "fast-browser not found", action: { type: "link-bundled", label: "Use mattstack's", tool: "fast-browser" } });

  const res = await p.exec([...resolved.exec, "doctor", "--json"]);
  let doctor: FastBrowserDoctor | null = null;
  if (res.code === 0) {
    try {
      doctor = JSON.parse(res.stdout) as FastBrowserDoctor;
    } catch {
      doctor = null;
    }
  }
  if (!doctor) {
    const head = res.stderr.trim().split("\n")[0] || `exit ${res.code}`;
    return row({ ...base, status: "error", detail: `fast-browser doctor failed: ${head}` });
  }

  const runtimeOk = doctor.runtime?.ok === true;
  const extensionLoaded = doctor.extension?.loaded === true;
  if (runtimeOk && extensionLoaded) return row({ ...base, status: "ready", detail: "runtime ok, extension loaded" });
  if (!extensionLoaded) return row({ ...base, status: "needs-you", detail: "Chrome extension not loaded", action: FAST_BROWSER_EXTENSION_STEPS });
  return row({ ...base, status: "needs-you", detail: "runtime not ready", action: FAST_BROWSER_EXTENSION_STEPS });
}

// ─── tool.editor ───────────────────────────────────────────────────────────

function editorRow(seams: ToolsSeams): Row {
  const base = {
    id: "tool.editor",
    kind: "tool" as const,
    title: "Editor",
    why: "Lets rt open the rt-context extension and hand files off to an editor.",
    required: false,
    optionalNote: "Works without this; rt just won't have an editor to open files in.",
  };
  const editors = seams.detectEditors();
  if (editors.length === 0) return row({ ...base, status: "skipped", detail: "no editor found (works without this)" });
  return row({ ...base, status: "ready", detail: editors.map((e) => e.name).join(", ") });
}

// ─── tool.chrome / tool.chrome-signin ──────────────────────────────────────

function chromeRow(p: Probes, reqs: PackRequirements[]): Row {
  const required = reqs.some((r) => r.chrome?.required === true);
  const base = {
    id: "tool.chrome",
    kind: "tool" as const,
    title: "Google Chrome",
    why: "Fast Browser and any Chrome-based pack tools drive Chrome directly.",
    required,
    ...(required ? {} : { optionalNote: "Works without this unless your pack declares chrome.required." }),
  };
  const found = CHROME_PATHS(p.home).some((path) => p.exists(path));
  if (found) return row({ ...base, status: "ready", detail: "Google Chrome installed" });
  return row({ ...base, status: "missing", detail: "Google Chrome not found", action: CHROME_DOWNLOAD_ACTION });
}

/** Not directly probeable (which Chrome profile is signed in isn't observable from disk) — surfaced only when a pack declares chrome.signedIntoApp, always as a manual confirm. */
function chromeSigninRow(reqs: PackRequirements[]): Row | null {
  const declaring = reqs.find((r) => r.chrome?.signedIntoApp);
  if (!declaring) return null;
  const profile = declaring.chrome!.signedIntoApp!;
  return row({
    id: "tool.chrome-signin",
    kind: "tool" as const,
    title: "Chrome sign-in",
    why: `${declaring.pack} needs Chrome signed into ${profile}.`,
    required: false,
    optionalNote: "Can't be checked automatically — confirm by hand.",
    status: "needs-you",
    detail: `Confirm Chrome is signed into ${profile}`,
    action: { type: "steps", label: "Show steps…", steps: ["Open Chrome", "Click your profile picture (top right)", `Confirm you're signed into ${profile}`] },
  });
}

// ─── tool.mission-control ──────────────────────────────────────────────────

/** `defaults read` old-style plist text has "enabled" as the key's first field in practice, so it's read straight off the tail of "32 = {" rather than brace-matching the whole (possibly deeply nested) value. */
function missionControlBoundToControlUp(stdout: string): boolean {
  const keyIndex = stdout.search(/(^|[\s{;])"?32"?\s*=\s*\{/m);
  if (keyIndex === -1) return false;
  const window = stdout.slice(keyIndex, keyIndex + 400);
  const enabledMatch = window.match(/enabled\s*=\s*(\d)/);
  return enabledMatch?.[1] === "1";
}

async function missionControlRow(p: Probes): Promise<Row> {
  const base = {
    id: "tool.mission-control",
    kind: "tool" as const,
    title: "Mission Control shortcut",
    why: "rt's nav picker uses Control+Up, which macOS binds to Mission Control by default.",
    required: false,
    optionalNote: "Works without this; only matters if Control+Up doesn't reach rt's nav picker.",
  };
  const res = await p.exec(["defaults", "read", "com.apple.symbolichotkeys", "AppleSymbolicHotKeys"]);
  if (res.code !== 0) return row({ ...base, status: "skipped", detail: "could not read Keyboard shortcut settings" });

  if (missionControlBoundToControlUp(res.stdout)) {
    return row({ ...base, status: "needs-you", detail: "Control+Up is bound to Mission Control (rt nav uses it)", action: MISSION_CONTROL_SETTINGS_ACTION });
  }
  return row({ ...base, status: "ready", detail: "Control+Up is free for rt's nav picker" });
}

// ─── tool.<name> — team-declared tools from pack requirements.jsonc ────────

/** First occurrence wins across packs — two packs declaring the same tool name collapse to one row rather than one per pack. */
function dedupeTeamTools(reqs: PackRequirements[]): ToolRequirement[] {
  const seen = new Map<string, ToolRequirement>();
  for (const req of reqs) {
    for (const tool of req.tools) {
      if (!seen.has(tool.name)) seen.set(tool.name, tool);
    }
  }
  return [...seen.values()];
}

async function teamToolRow(p: Probes, req: ToolRequirement, hasBrew: boolean): Promise<Row> {
  const base = { id: `tool.${req.name}`, kind: "tool" as const, title: req.name, why: req.why, required: !req.optional };

  const res = await p.exec([req.name, "--version"]);
  if (res.code === 127) {
    let action: Action;
    if (req.install?.brew && hasBrew) action = { type: "install", label: "Install", tool: req.name, via: "brew" };
    else if (req.install?.url) action = { type: "open-url", label: "Download", url: req.install.url };
    else action = { type: "steps", label: "Show steps…", steps: [`Install ${req.name}`, "Then re-run rt setup status"] };
    return row({ ...base, status: "missing", detail: `${req.name} not found`, action });
  }
  if (res.code !== 0) return row({ ...base, status: "error", detail: `could not run ${req.name} (exit ${res.code})` });

  const version = extractVersion(res.stdout);
  if (req.floor && !atLeast(version, req.floor)) return row({ ...base, status: "invalid", detail: `${req.name} ${version} < ${req.floor}` });
  return row({ ...base, status: "ready", detail: `${req.name} ${version}` });
}

// ─── pack.<pack> ────────────────────────────────────────────────────────────

function packRow(req: PackRequirements, pluginList: { code: number; stdout: string }): Row {
  const base = {
    id: `pack.${req.pack}`,
    kind: "tool" as const,
    title: req.pack,
    why: `Installed by Install for the ${req.pack} pack.`,
    required: false,
    optionalNote: "Installed by Install (plugins.install).",
  };
  if (pluginList.code === 127) return row({ ...base, status: "skipped", detail: "claude not installed" });
  if (pluginList.code !== 0) return row({ ...base, status: "skipped", detail: "claude plugin list failed" });
  if (pluginList.stdout.includes(`${req.pack}@`)) return row({ ...base, status: "ready", detail: "installed" });
  return row({ ...base, status: "missing", detail: "installed by Install (plugins.install)" });
}

// ─── entry point ────────────────────────────────────────────────────────────

export async function toolRows(p: Probes, reqs: PackRequirements[], opts: { hasBrew: boolean }, seams: ToolsSeams = REAL_SEAMS): Promise<Row[]> {
  const rows: Row[] = [
    await herdrRow(p, opts),
    await claudeRow(p, opts),
    await fastBrowserRow(p, seams),
    editorRow(seams),
    chromeRow(p, reqs),
  ];

  const chromeSignin = chromeSigninRow(reqs);
  if (chromeSignin) rows.push(chromeSignin);

  rows.push(await missionControlRow(p));

  for (const tool of dedupeTeamTools(reqs)) rows.push(await teamToolRow(p, tool, opts.hasBrew));

  const pluginList = await p.exec(["claude", "plugin", "list"]);
  for (const req of reqs) rows.push(packRow(req, pluginList));

  return rows;
}
