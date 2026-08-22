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
 *
 * RULING R-T8-L1a: every team-declared tool row is id'd `tool.team.<name>`
 * (not `tool.<name>`) — a pack declaring "herdr" or "chrome" as a tool must
 * never collide with this file's own built-in row ids.
 */

import { resolveTool } from "../../deps/resolve.ts";
import { detectEditors } from "../../editors.ts";
import { row, type Action, type Row } from "../contract.ts";
import type { ExecResult, Probes } from "../probes.ts";
import type { PackRequirements, ToolRequirement } from "../requirements.ts";
import { atLeast } from "../semver.ts";

const HERDR_FLOOR = "0.7.5";
/** Every exec in this module is bounded — a hung team-declared `--version`, or a wedged herdr/claude/fast-browser subprocess, must surface as "error" (124), never hang `rt setup plan` forever. */
const PROBE_TIMEOUT_MS = 5000;
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

/**
 * A real version, preferred over a bare number — "2026-08-22 build 1.2.3"
 * must yield "1.2.3", not the leading date's "2026" (the date has no dots,
 * so the dotted match skips past it to the actual version). Falls back to
 * the first bare number, then the trimmed stdout, so an unparseable input
 * still fails a floor compare closed rather than throwing.
 */
export function extractVersion(stdout: string): string {
  const trimmed = stdout.trim();
  const semverLike = trimmed.match(/[0-9]+\.[0-9]+(?:\.[0-9]+)*/);
  if (semverLike) return semverLike[0];
  const bare = trimmed.match(/[0-9]+/);
  return bare ? bare[0] : trimmed;
}

function provisionedInstallAction(tool: string, hasBrew: boolean, label: "Install" | "Upgrade" = "Install"): Action {
  return { type: "install", label, tool, via: hasBrew ? "brew" : "vendor" };
}

function exec(p: Probes, argv: string[]): Promise<ExecResult> {
  return p.exec(argv, { timeoutMs: PROBE_TIMEOUT_MS });
}

// ─── tool.herdr ────────────────────────────────────────────────────────────

/**
 * `herdr integration status` prints one line per KNOWN integration whether
 * installed or not — "claude: not installed (...)" contains the substring
 * "claude" too, so a bare `.includes("claude")` is always true. The actual
 * signal is the claude line's state word, which this parses out.
 */
function parseHerdrClaudeState(stdout: string): { known: boolean; installed: boolean; state: string } {
  const m = stdout.match(/^\s*claude:\s*([^\n(]+)/m);
  if (!m) return { known: false, installed: false, state: "" };
  const state = m[1]!.trim();
  return { known: true, installed: state.toLowerCase().startsWith("current"), state };
}

async function herdrRow(p: Probes, opts: { hasBrew: boolean }): Promise<Row> {
  const base = { id: "tool.herdr", kind: "tool" as const, title: "herdr", why: "Drives Herdr panes for remote-control and multi-agent workflows.", required: true };

  const versionRes = await exec(p, ["herdr", "--version"]);
  if (versionRes.code === 127) return row({ ...base, status: "missing", detail: "herdr not found", action: provisionedInstallAction("herdr", opts.hasBrew) });
  if (versionRes.code === 124) return row({ ...base, status: "error", detail: "herdr --version timed out" });
  if (versionRes.code !== 0) return row({ ...base, status: "error", detail: `could not run herdr (exit ${versionRes.code})` });

  const version = extractVersion(versionRes.stdout);
  if (!atLeast(version, HERDR_FLOOR)) {
    return row({ ...base, status: "invalid", detail: `herdr ${version} < ${HERDR_FLOOR}`, action: provisionedInstallAction("herdr", opts.hasBrew, "Upgrade") });
  }

  const integrationRes = await exec(p, ["herdr", "integration", "status"]);
  if (integrationRes.code === 124) return row({ ...base, status: "error", detail: "herdr integration status timed out" });
  if (integrationRes.code !== 0) return row({ ...base, status: "error", detail: `could not check herdr integration status (exit ${integrationRes.code})` });

  const claude = parseHerdrClaudeState(integrationRes.stdout);
  if (!claude.known) return row({ ...base, status: "error", detail: "could not determine herdr's Claude integration status" });
  if (claude.installed) return row({ ...base, status: "ready", detail: `herdr ${version}, Claude integration installed` });
  return row({
    ...base,
    status: "needs-you",
    detail: `herdr ${version}, Claude integration ${claude.state}`,
    action: { type: "run", label: "Install integration", verb: ["tools", "setup", "herdr"] },
  });
}

// ─── tool.claude ───────────────────────────────────────────────────────────

async function claudeRow(p: Probes, opts: { hasBrew: boolean }): Promise<Row> {
  const base = { id: "tool.claude", kind: "tool" as const, title: "Claude Code", why: "Runs the agent sessions rt drives and hands work off to.", required: true, recheck: "on-activate" as const };

  const versionRes = await exec(p, ["claude", "--version"]);
  if (versionRes.code === 127) return row({ ...base, status: "missing", detail: "claude not found", action: provisionedInstallAction("claude", opts.hasBrew) });
  if (versionRes.code === 124) return row({ ...base, status: "error", detail: "claude --version timed out" });
  if (versionRes.code !== 0) return row({ ...base, status: "error", detail: `could not run claude (exit ${versionRes.code})` });
  const version = extractVersion(versionRes.stdout);

  const authRes = await exec(p, ["claude", "auth", "status"]);
  if (authRes.code === 124) return row({ ...base, status: "error", detail: "claude auth status timed out" });

  // `claude auth status` exits 0 whether signed in or not — the JSON payload
  // is the actual signal, so it's checked before the exit code means anything.
  let authState: { loggedIn?: unknown } | null = null;
  try {
    authState = JSON.parse(authRes.stdout) as { loggedIn?: unknown };
  } catch {
    authState = null;
  }
  if (authState && typeof authState.loggedIn === "boolean") {
    if (authState.loggedIn) return row({ ...base, status: "ready", detail: `claude ${version}, signed in` });
    return row({ ...base, status: "needs-you", detail: "sign in: run claude once", action: CLAUDE_SIGNIN_STEPS });
  }

  const sniff = `${authRes.stdout} ${authRes.stderr}`.toLowerCase();
  if (sniff.includes("unknown")) return row({ ...base, status: "ready", detail: "installed (sign-in not checked)" });

  if (authRes.code !== 0) return row({ ...base, status: "needs-you", detail: "sign in: run claude once", action: CLAUDE_SIGNIN_STEPS });
  return row({ ...base, status: "error", detail: "claude auth status returned an unexpected response" });
}

// ─── tool.fast-browser ─────────────────────────────────────────────────────

interface FastBrowserDoctor {
  runtime?: { ok?: boolean };
  extension?: { loaded?: boolean };
  pairing?: { ok?: boolean };
}

async function fastBrowserRow(p: Probes, seams: ToolsSeams): Promise<Row> {
  const base = { id: "tool.fast-browser", kind: "tool" as const, title: "Fast Browser", why: "Backs rt's macro-first browser automation.", required: true, recheck: "on-activate" as const };

  const resolved = seams.resolveTool(p, "fast-browser");
  if (!resolved.exec) return row({ ...base, status: "missing", detail: "fast-browser not found", action: { type: "link-bundled", label: "Use mattstack's", tool: "fast-browser" } });

  const res = await exec(p, [...resolved.exec, "doctor", "--json"]);
  if (res.code === 124) return row({ ...base, status: "error", detail: "fast-browser doctor timed out" });

  // `doctor` is a health check: it commonly exits non-zero BECAUSE it found a
  // problem, while still printing its JSON report — so a parseable payload
  // is honored regardless of exit code, and only a genuinely empty/garbled
  // response falls through to "error".
  let doctor: FastBrowserDoctor | null = null;
  if (res.stdout.trim() !== "") {
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
    recheck: "on-activate" as const,
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
    recheck: "on-activate" as const,
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
    recheck: "on-activate",
    status: "needs-you",
    detail: `Confirm Chrome is signed into ${profile}`,
    action: { type: "steps", label: "Show steps…", steps: ["Open Chrome", "Click your profile picture (top right)", `Confirm you're signed into ${profile}`] },
  });
}

// ─── tool.mission-control ──────────────────────────────────────────────────

/**
 * RULING R-T8-L1c: an ABSENT "32" key means macOS's factory-default binding
 * (Control+Up → Mission Control) is in effect — i.e. the conflict EXISTS —
 * so absence reads as "not unbound", never as "free". The capture stops at
 * the entry's own first "}" (its "enabled" field precedes any nested
 * "value = {...}" sub-dict in real `defaults read` output), which both
 * finds "enabled" and guarantees the match can never bleed into a
 * neighbouring key's dict.
 */
function missionControlUnbound(stdout: string): boolean {
  const m = stdout.match(/(^|[\s{;])"?32"?\s*=\s*\{([^}]*)\}/m);
  if (!m) return false;
  const enabledMatch = m[2]!.match(/enabled\s*=\s*(\d)/);
  if (!enabledMatch) return false;
  return enabledMatch[1] === "0";
}

async function missionControlRow(p: Probes): Promise<Row> {
  const base = {
    id: "tool.mission-control",
    kind: "tool" as const,
    title: "Mission Control shortcut",
    why: "rt's nav picker uses Control+Up, which macOS binds to Mission Control by default.",
    required: false,
    optionalNote: "Works without this; only matters if Control+Up doesn't reach rt's nav picker.",
    recheck: "on-activate" as const,
  };
  const res = await exec(p, ["defaults", "read", "com.apple.symbolichotkeys", "AppleSymbolicHotKeys"]);
  if (res.code === 124) return row({ ...base, status: "error", detail: "defaults read timed out" });
  if (res.code !== 0) return row({ ...base, status: "skipped", detail: "could not read Keyboard shortcut settings" });

  if (missionControlUnbound(res.stdout)) return row({ ...base, status: "ready", detail: "Control+Up is free for rt's nav picker" });
  return row({ ...base, status: "needs-you", detail: "Control+Up is bound to Mission Control (rt nav uses it)", action: MISSION_CONTROL_SETTINGS_ACTION });
}

// ─── tool.team.<name> — team-declared tools from pack requirements.jsonc ───

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

function teamToolRemedyAction(req: ToolRequirement, hasBrew: boolean, verb: "Install" | "Upgrade"): Action {
  if (req.install?.brew && hasBrew) return { type: "install", label: verb, tool: req.name, via: "brew" };
  if (req.install?.url) return { type: "open-url", label: "Download", url: req.install.url };
  const step = verb === "Upgrade" && req.floor ? `Upgrade ${req.name} to ${req.floor}+` : `Install ${req.name}`;
  return { type: "steps", label: "Show steps…", steps: [step, "Then re-run rt setup status"] };
}

async function teamToolRow(p: Probes, req: ToolRequirement, hasBrew: boolean): Promise<Row> {
  const base = {
    id: `tool.team.${req.name}`,
    kind: "tool" as const,
    title: req.name,
    why: req.why,
    required: !req.optional,
    ...(req.optional ? { optionalNote: `Works without this. ${req.why}` } : {}),
  };

  const res = await exec(p, [req.name, "--version"]);
  if (res.code === 127) return row({ ...base, status: "missing", detail: `${req.name} not found`, action: teamToolRemedyAction(req, hasBrew, "Install") });
  if (res.code === 124) return row({ ...base, status: "error", detail: `${req.name} --version timed out` });
  if (res.code !== 0) return row({ ...base, status: "error", detail: `could not run ${req.name} (exit ${res.code})` });

  const version = extractVersion(res.stdout);
  if (req.floor && !atLeast(version, req.floor)) {
    return row({ ...base, status: "invalid", detail: `${req.name} ${version} < ${req.floor}`, action: teamToolRemedyAction(req, hasBrew, "Upgrade") });
  }
  return row({ ...base, status: "ready", detail: `${req.name} ${version}` });
}

// ─── pack.<pack> ────────────────────────────────────────────────────────────

/** Anchored at the entry's own start (start of line, optional leading whitespace) so a pack named "view" can never match inside "claimview@assured". */
function pluginListHasPack(stdout: string, pack: string): boolean {
  const needle = `${pack}@`;
  return stdout.split("\n").some((line) => line.trim().startsWith(needle));
}

/** RULING R-T8-L1b: a malformed pack (readPackRequirements/parseRequirements set `.error`) surfaces as an honest error row here — the one row this module always emits per pack — rather than being silently dropped. */
function packRow(req: PackRequirements, pluginList: ExecResult): Row {
  const base = {
    id: `pack.${req.pack}`,
    kind: "tool" as const,
    title: req.pack,
    why: `Installed by Install for the ${req.pack} pack.`,
    required: false,
    optionalNote: "Installed by Install (plugins.install).",
  };
  if (req.error) return row({ ...base, status: "error", detail: req.error });

  if (pluginList.code === 127) return row({ ...base, status: "skipped", detail: "claude not installed" });
  if (pluginList.code === 124) return row({ ...base, status: "error", detail: "claude plugin list timed out" });
  if (pluginList.code !== 0) return row({ ...base, status: "skipped", detail: `claude plugin list failed (exit ${pluginList.code})` });
  if (pluginListHasPack(pluginList.stdout, req.pack)) return row({ ...base, status: "ready", detail: "installed" });
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

  // No point spawning (or waiting on) `claude plugin list` when there are no
  // pack rows to check it against.
  if (reqs.length > 0) {
    const pluginList = await exec(p, ["claude", "plugin", "list"]);
    for (const req of reqs) rows.push(packRow(req, pluginList));
  }

  return rows;
}
