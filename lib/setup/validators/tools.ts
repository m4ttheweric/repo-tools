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
import { BASE_PLUGINS } from "../base-plugins.ts";
import { row, type Action, type Row } from "../contract.ts";
import { integrationDef } from "../integrations.ts";
import { callableBySkills, claudeJsonPath, linearServerNames, nameTaken, readClaudeConfig } from "../linear-mcp.ts";
import type { ExecResult, Probes } from "../probes.ts";
import type { PackRequirements, ToolRequirement } from "../requirements.ts";
import { atLeast } from "../semver.ts";
import { deployedProxyVersion, pinnedPortlessVersion, PORTLESS_LAUNCHD_PLIST, PROXY_VERSION_PATH, proxyCaIsTrusted, proxyPredatesMattstack } from "../steps/services.ts";
import { isValidBrewFormula } from "../tools-install.ts";
import type { SecretPresence } from "./accounts.ts";

const HERDR_FLOOR = "0.7.5";
/** Every exec in this module is bounded — a hung team-declared `--version`, or a wedged herdr/claude/fast-browser subprocess, must surface as "error" (124), never hang `rt setup plan` forever. */
const PROBE_TIMEOUT_MS = 5000;
const CHROME_PATHS = (home: string): string[] => ["/Applications/Google Chrome.app", `${home}/Applications/Google Chrome.app`];

const CLAUDE_SIGNIN_STEPS: Action = { type: "steps", label: "Show steps…", steps: ["Open a terminal", "Run: claude", "Follow the sign-in prompt"] };
/** Signing in is interactive and happens after Install; only the claude binary itself gates Install. */
const SIGNIN_LATER = { required: false, optionalNote: "Sign in after Install: run claude once." };
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

/** Narrows past "parses as JSON" to "has fields worth dereferencing" — an array and null both pass typeof "object" in JS. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  // Install's own herdr.integration step adds this; only the binary gates Install.
  return row({
    ...base,
    required: false,
    optionalNote: "Installed by Install (herdr.integration).",
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
    return row({ ...base, ...SIGNIN_LATER, status: "needs-you", detail: "sign in: run claude once", action: CLAUDE_SIGNIN_STEPS });
  }

  // An older `claude` with no `auth status` subcommand answers something
  // containing "unknown" — sign-in genuinely could not be checked, which
  // must never read as "ready": this row is required:true and feeds
  // canInstall, so a guessed ready would unlock Install against a claude
  // that may not be signed in. "needs-you" with the same remedy as an
  // explicit not-signed-in gives a real next step instead of a dead end.
  const sniff = `${authRes.stdout} ${authRes.stderr}`.toLowerCase();
  if (sniff.includes("unknown")) {
    return row({ ...base, ...SIGNIN_LATER, status: "needs-you", detail: `claude ${version} installed, sign-in could not be checked — confirm you're signed in`, action: CLAUDE_SIGNIN_STEPS });
  }

  if (authRes.code !== 0) return row({ ...base, ...SIGNIN_LATER, status: "needs-you", detail: "sign in: run claude once", action: CLAUDE_SIGNIN_STEPS });
  return row({ ...base, status: "error", detail: "claude auth status returned an unexpected response" });
}

// ─── tool.fast-browser / tool.fast-browser-extension ───────────────────────

interface FastBrowserCheck {
  id: string;
  status: string;
  message?: string;
  remediation?: string | null;
}

/** The real envelope from `fast-browser doctor --json`: a flat `checks` array keyed by id, not the nested `{runtime, extension, pairing}` shape this used to declare (which no installed fast-browser has ever produced). */
interface FastBrowserDoctor {
  schemaVersion?: number;
  ok?: boolean;
  profile?: string;
  checks?: FastBrowserCheck[];
}

/** A well-formed-JSON-but-wrong-shape check must fail this before checkState ever dereferences it. */
function isValidDoctorCheck(value: unknown): value is FastBrowserCheck {
  return isPlainObject(value) && typeof value.id === "string";
}

/**
 * The parse boundary for `fast-browser doctor --json`: a payload whose
 * `checks` is present but isn't an array of id-bearing objects (older/newer
 * schema, a wrong CLI on the same name, a truncated print) is rejected here
 * as null, the same as unparsable JSON, so no later `.checks.find` can ever
 * run against a non-array.
 */
function parseFastBrowserDoctor(stdout: string): FastBrowserDoctor | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) return null;
  if (parsed.checks !== undefined && !(Array.isArray(parsed.checks) && parsed.checks.every(isValidDoctorCheck))) return null;
  return parsed as FastBrowserDoctor;
}

type CheckState = "pass" | "fail" | "absent";

/** Absent (an id doctor's schema doesn't carry, older or newer than this build expects) is its own state, never folded into "fail": a check rt cannot find is not a check that failed. */
function checkState(doctor: FastBrowserDoctor | null, id: string): CheckState {
  const found = doctor?.checks?.find((c) => c.id === id);
  if (!found) return "absent";
  return found.status === "pass" ? "pass" : "fail";
}

interface FastBrowserProbe {
  resolvable: boolean;
  doctor: FastBrowserDoctor | null;
  /** Set only when fast-browser resolved but its report could not be read. */
  failure: string | null;
}

/** One `doctor` run feeds both rows: they read different fields of the same report, and a second spawn would double the bounded wait on every plan. */
async function probeFastBrowser(p: Probes, seams: ToolsSeams): Promise<FastBrowserProbe> {
  const resolved = seams.resolveTool(p, "fast-browser");
  if (!resolved.exec) return { resolvable: false, doctor: null, failure: null };

  const res = await exec(p, [...resolved.exec, "doctor", "--json"]);
  if (res.code === 124) return { resolvable: true, doctor: null, failure: "fast-browser doctor timed out" };

  // `doctor` is a health check: it commonly exits non-zero BECAUSE it found a
  // problem, while still printing its JSON report, so a parseable, well-shaped
  // payload is honored regardless of exit code.
  if (res.stdout.trim() !== "") {
    const doctor = parseFastBrowserDoctor(res.stdout);
    if (doctor) return { resolvable: true, doctor, failure: null };
  }
  const head = res.stderr.trim().split("\n")[0] || `exit ${res.code}`;
  return { resolvable: true, doctor: null, failure: `fast-browser doctor failed: ${head}` };
}

const FAST_BROWSER_SETUP_ACTION: Action = { type: "run", label: "Run setup", verb: ["tools", "setup", "fast-browser"] };

/**
 * Everything past the binary is created by the `fastbrowser.setup` Install
 * step, so none of it may gate Install: before Install neither the runtime nor
 * the extension directory exists, and no action on this screen can create
 * them. Same shape as herdrRow above, and the same ruling: binaries gate,
 * follow-ups don't.
 */
const FASTBROWSER_SETUP_NOTE = "Installed by Install (fastbrowser.setup).";

function fastBrowserRow(probe: FastBrowserProbe): Row {
  const base = { id: "tool.fast-browser", kind: "tool" as const, title: "Fast Browser", why: "Backs rt's macro-first browser automation.", required: true, recheck: "on-activate" as const };
  if (!probe.resolvable) return row({ ...base, status: "missing", detail: "fast-browser not found", action: { type: "link-bundled", label: "Use mattstack's", tool: "fast-browser" } });

  const pending = { required: false, optionalNote: FASTBROWSER_SETUP_NOTE };
  if (probe.failure) return row({ ...base, ...pending, status: "error", detail: probe.failure });

  const runtime = checkState(probe.doctor, "runtime-checksum");
  if (runtime === "pass") return row({ ...base, status: "ready", detail: "runtime ok" });
  if (runtime === "absent") return row({ ...base, ...pending, status: "error", detail: "fast-browser doctor report has no runtime-checksum check" });
  return row({ ...base, ...pending, status: "needs-you", detail: "runtime not ready", action: FAST_BROWSER_SETUP_ACTION });
}

const PAIRING_STEPS = [
  "Click the Fast Browser icon in Chrome and copy its reconnect token",
  "Run: fast-browser configure --connection auto, then paste the token into the Keychain prompt",
  "Run: fast-browser doctor",
];
const FAST_BROWSER_LOAD_STEPS: Action = {
  type: "steps",
  label: "Show steps…",
  steps: ["Open chrome://extensions", "Turn on Developer mode", "Load unpacked → ~/.fast-browser/extension/current/unpacked", ...PAIRING_STEPS],
};
const FAST_BROWSER_PAIR_STEPS: Action = { type: "steps", label: "Show steps…", steps: PAIRING_STEPS };

/**
 * Never gates Install in any Chrome state. Loading an unpacked extension is a
 * Chrome step rt cannot perform: fast-browser ships no CRX and has no Web
 * Store listing, and Chrome's unattended paths accept neither an unpacked
 * directory nor a signing key rt holds. The Done screen names it instead.
 */
function fastBrowserExtensionRow(p: Probes, probe: FastBrowserProbe): Row {
  const base = {
    id: "tool.fast-browser-extension",
    kind: "tool" as const,
    title: "Fast Browser extension",
    why: "Fast Browser drives your real Chrome session through this extension.",
    required: false,
    optionalNote: "You load this into Chrome yourself; Install cannot do it for you.",
    recheck: "on-activate" as const,
  };

  if (!CHROME_PATHS(p.home).some((path) => p.exists(path))) return row({ ...base, status: "skipped", detail: "no Google Chrome to load it into" });
  // tool.fast-browser already reports an unreadable doctor; repeating it here
  // would be two rows for one fact.
  if (!probe.doctor) return row({ ...base, status: "skipped", detail: "fast-browser doctor could not be read (see Fast Browser)" });

  const extension = checkState(probe.doctor, "extension-loaded");
  if (extension === "absent") return row({ ...base, status: "error", detail: "fast-browser doctor report has no extension-loaded check" });
  if (extension === "fail") return row({ ...base, status: "needs-you", detail: "not loaded in Chrome", action: FAST_BROWSER_LOAD_STEPS });

  // Trust doctor's own pairing check rather than a separate rule: pairing
  // passes whenever the connection mode isn't auto, and manual is the
  // documented default, so a loaded-but-unpaired manual-mode machine is not
  // an outstanding step.
  const pairing = checkState(probe.doctor, "pairing");
  if (pairing === "absent") return row({ ...base, status: "error", detail: "fast-browser doctor report has no pairing check" });
  if (pairing === "fail") return row({ ...base, status: "needs-you", detail: "loaded but not paired", action: FAST_BROWSER_PAIR_STEPS });
  return row({ ...base, status: "ready", detail: "loaded and paired" });
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
  const brew = req.install?.brew;
  // Tap syntax (owner/tap/formula) or anything else outside a bare formula
  // name never becomes a one-click Install button — matches installTool's
  // own refusal, so the row and the action it offers agree.
  if (brew && hasBrew && isValidBrewFormula(brew)) return { type: "install", label: verb, tool: req.name, via: "brew" };
  if (req.install?.url) return { type: "open-url", label: "Download", url: req.install.url };
  if (brew && !isValidBrewFormula(brew)) {
    return { type: "steps", label: "Show steps…", steps: [`This pack's install.brew ("${brew}") isn't a plain formula name — rt won't auto-run it`, `brew install ${brew}`, "Then re-run rt setup status"] };
  }
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

/** One entry of `claude plugin list --json`; only the fields this module reads. The real listing carries more (version, scope, installPath, installedAt, lastUpdated, mcpServers) that nothing here needs. */
interface PluginListEntry {
  id: string;
  enabled: boolean;
}

/** True only for an element this module can safely read `.id` off; `enabled` is normalized by the caller rather than checked here, since a missing or non-boolean one is not a shape violation. */
function isPluginListElement(value: unknown): value is { id: string; enabled?: unknown } {
  return isPlainObject(value) && typeof value.id === "string";
}

/**
 * `claude plugin list` (no flag) prints a chevron glyph before each name,
 * never the bare id, so a human-format scrape can never match `BASE_PLUGINS`.
 * The parsed `id` field is the only reliable match surface.
 *
 * The parse boundary: any element missing a string `id` rejects the whole
 * payload as null (same as unparsable JSON), rather than dropping just that
 * element — a schema violation anywhere means the payload's shape can't be
 * trusted, so the honest answer is "could not be read", not a silently
 * incomplete list. A missing or non-boolean `enabled` is not such a
 * violation: it already drives the disabled-vs-ready split, so it is
 * normalized to `false` here rather than rejecting the payload over it.
 */
function parsePluginList(stdout: string): PluginListEntry[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const entries: PluginListEntry[] = [];
  for (const item of parsed) {
    if (!isPluginListElement(item)) return null;
    entries.push({ id: item.id, enabled: item.enabled === true });
  }
  return entries;
}

const INSTALL_PLUGINS_ACTION: Action = { type: "run", label: "Install plugins", verb: ["setup", "pack"] };
const ENABLE_PLUGINS_ACTION: Action = { type: "run", label: "Enable plugins", verb: ["setup", "pack"] };

/** Shared with plan.ts's install-satisfied flip so the two never drift apart into two different wordings for the same fact. */
export const INSTALLED_BY_INSTALL_NOTE = "Installed by Install (plugins.install).";

/** RULING R-T8-L1b: a malformed pack (readPackRequirements/parseRequirements set `.error`) surfaces as an honest error row here — the one row this module always emits per pack — rather than being silently dropped. */
function packRow(req: PackRequirements, pluginList: ExecResult): Row {
  const base = {
    id: `pack.${req.pack}`,
    kind: "tool" as const,
    title: req.pack,
    why: `Installed by Install for the ${req.pack} pack.`,
    required: false,
    optionalNote: INSTALLED_BY_INSTALL_NOTE,
  };
  if (req.error) return row({ ...base, status: "error", detail: req.error });

  if (pluginList.code === 127) return row({ ...base, status: "skipped", detail: "claude not installed" });
  if (pluginList.code === 124) return row({ ...base, status: "error", detail: "claude plugin list timed out" });
  // Any other non-zero (corrupt config, a permissions error, a crashed CLI)
  // is a real failure this module could not determine past — "skipped"
  // reads as "nothing to check here", which a genuine failure is not.
  if (pluginList.code !== 0) return row({ ...base, status: "error", detail: `claude plugin list failed (exit ${pluginList.code})` });

  const entries = parsePluginList(pluginList.stdout);
  if (!entries) return row({ ...base, status: "error", detail: "claude plugin list --json output could not be read" });
  if (entries.some((e) => typeof e.id === "string" && e.id.startsWith(`${req.pack}@`))) return row({ ...base, status: "ready", detail: "installed" });
  return row({ ...base, status: "missing", detail: "installed by Install (plugins.install)" });
}

// ─── tool.plugins ───────────────────────────────────────────────────────────

/** Exactly the classification packRow uses, so the two rows never disagree about what a `claude plugin list --json` result means. */
function pluginsRow(pluginList: ExecResult): Row {
  const base = {
    id: "tool.plugins",
    kind: "tool" as const,
    title: "Claude plugins",
    why: "rt's skills, Fast Browser's and rt chat's all reach Claude Code as marketplace plugins.",
    required: false,
    optionalNote: INSTALLED_BY_INSTALL_NOTE,
  };
  if (pluginList.code === 127) return row({ ...base, status: "skipped", detail: "claude not installed" });
  if (pluginList.code === 124) return row({ ...base, status: "error", detail: "claude plugin list timed out" });
  if (pluginList.code !== 0) return row({ ...base, status: "error", detail: `claude plugin list failed (exit ${pluginList.code})` });

  const entries = parsePluginList(pluginList.stdout);
  if (!entries) return row({ ...base, status: "error", detail: "claude plugin list --json output could not be read" });

  const byId = new Map(entries.map((e) => [e.id, e]));
  const absent = BASE_PLUGINS.filter((id) => !byId.has(id));
  if (absent.length > 0) return row({ ...base, status: "missing", detail: `not installed: ${absent.join(", ")}`, action: INSTALL_PLUGINS_ACTION });

  // `plugins.install` only enables a plugin best-effort, and disabling one is
  // a deliberate user choice rather than a broken install: needs-you (not
  // invalid) so verify names it and nags without going critical.
  const disabled = BASE_PLUGINS.filter((id) => byId.get(id)!.enabled !== true);
  if (disabled.length > 0) return row({ ...base, status: "needs-you", detail: `disabled: ${disabled.join(", ")}`, action: ENABLE_PLUGINS_ACTION });

  return row({ ...base, status: "ready", detail: `${BASE_PLUGINS.length} plugins installed` });
}

// ─── tool.proxy ─────────────────────────────────────────────────────────────

/** Every remedy this row offers runs the same step, which reads the same three facts this row does and decides from them whether to install, update, or only trust (lib/setup/steps/services.ts). A remedy that named a different route could disagree with the row that offered it. `--only`, never `--from`, which would also run the fourteen steps after it (down to `snapshot.push`) for a button that says "Trust certificate". */
function reRunProxyInstallAction(label: string): Action {
  return { type: "run", label, verb: ["setup", "apply", "--only", "proxy.install"] };
}

async function proxyRow(p: Probes): Promise<Row> {
  const base = {
    id: "tool.proxy",
    kind: "tool" as const,
    title: "Local proxy",
    why: "Serves apps on .localhost/.mattstack domains instead of raw ports.",
    required: false,
    optionalNote: "Works without this; apps serve on their ports meanwhile.",
    recheck: "on-activate" as const,
  };
  if (!p.exists(PORTLESS_LAUNCHD_PLIST)) return row({ ...base, status: "missing", detail: "not installed", action: reRunProxyInstallAction("Install proxy") });

  // A plist with no VERSION beside it is the machine deck's own README
  // produces (`portless service install`), not a broken install: the same
  // remedy adopts it, because the helper replaces whatever daemon is running.
  if (proxyPredatesMattstack(p)) {
    return row({ ...base, status: "needs-you", detail: "An existing portless install predates mattstack; Update proxy adopts it", action: reRunProxyInstallAction("Update proxy") });
  }

  const deployedVersion = deployedProxyVersion(p);
  if (deployedVersion === null) return row({ ...base, status: "error", detail: `${PROXY_VERSION_PATH} could not be read` });

  const pinned = pinnedPortlessVersion(p);
  if (!pinned) return row({ ...base, status: "error", detail: "bundle's deps.lock has no pinned portless version" });
  if (deployedVersion !== pinned) {
    return row({ ...base, status: "needs-you", detail: `proxy runs portless ${deployedVersion}, bundle pins ${pinned}`, action: reRunProxyInstallAction("Update proxy") });
  }

  // The right version, running, but untrusted: macOS gates the trust write
  // behind its own uncacheable authorization, so an install where the user
  // declined that second dialog lands here. The proxy serves either way; only
  // browser trust is missing, which is why this is needs-you and not an error.
  if (!(await proxyCaIsTrusted(p))) {
    return row({ ...base, status: "needs-you", detail: "Browsers will warn until the proxy certificate is trusted", action: reRunProxyInstallAction("Trust certificate") });
  }
  return row({ ...base, status: "ready", detail: `portless ${deployedVersion}` });
}

// ─── tool.linear-mcp ────────────────────────────────────────────────────────

const CONNECT_LINEAR_ACTION: Action = { type: "connect", label: "Connect Linear", integration: "linear", fields: integrationDef("linear").fields };

/** Wiring only: the credential itself is `account.linear`'s job, which validates this same secret against api.linear.app. Two probes of one key is one probe too many, and two rows that can disagree. */
async function linearMcpRow(p: Probes, secrets: SecretPresence): Promise<Row> {
  const base = {
    id: "tool.linear-mcp",
    kind: "tool" as const,
    title: "Linear MCP",
    why: "Skills that read and update Linear tickets reach them through this MCP server.",
    required: false,
    optionalNote: "Installed by Install (linear.mcp).",
  };
  const path = claudeJsonPath(p);
  const read = readClaudeConfig(p, path);
  if (!read.ok && read.reason === "unparsable") return row({ ...base, status: "error", detail: `${path} is not valid JSON` });
  if (!read.ok && read.reason === "unreadable") return row({ ...base, status: "error", detail: `${path} could not be read` });

  const config = read.ok ? read.config : {};
  if (callableBySkills(config)) return row({ ...base, status: "ready", detail: "linear" });
  if (nameTaken(config)) return row({ ...base, status: "needs-you", detail: "a server named linear is not a Linear MCP" });

  // Every remaining state depends on the key, because Install skips without
  // one: a row promising Install will act, on a machine where it would not,
  // leaves the user with no next step anywhere. The seam throwing (a locked
  // keychain, a bad recipient, a corrupt sops file) degrades this row alone;
  // uncaught it would take the whole tools group down with it.
  let hasKey: boolean;
  try {
    hasKey = (await secrets.has("rt", "linearApiKey")) !== null;
  } catch (err) {
    return row({ ...base, status: "error", detail: err instanceof Error ? err.message : String(err) });
  }

  const others = linearServerNames(config);
  if (others.length > 0) {
    const present = `Linear MCP present as ${others.join(", ")}`;
    return hasKey
      ? row({ ...base, status: "missing", detail: `${present}; skills call mcp__linear__*` })
      : row({ ...base, status: "needs-you", detail: `${present}; connect Linear so Install can add linear`, action: CONNECT_LINEAR_ACTION });
  }

  if (!hasKey) return row({ ...base, status: "needs-you", detail: "no Linear account connected", action: CONNECT_LINEAR_ACTION });
  return row({ ...base, status: "missing", detail: "installed by Install (linear.mcp)" });
}

// ─── entry point ────────────────────────────────────────────────────────────

export async function toolRows(p: Probes, reqs: PackRequirements[], opts: { hasBrew: boolean; secrets: SecretPresence }, seams: ToolsSeams = REAL_SEAMS): Promise<Row[]> {
  const fastBrowser = await probeFastBrowser(p, seams);
  const rows: Row[] = [
    await herdrRow(p, opts),
    await claudeRow(p, opts),
    fastBrowserRow(fastBrowser),
    fastBrowserExtensionRow(p, fastBrowser),
    editorRow(seams),
    chromeRow(p, reqs),
  ];

  const chromeSignin = chromeSigninRow(reqs);
  if (chromeSignin) rows.push(chromeSignin);

  rows.push(await missionControlRow(p));
  rows.push(await proxyRow(p));

  for (const tool of dedupeTeamTools(reqs)) rows.push(await teamToolRow(p, tool, opts.hasBrew));

  // One listing feeds tool.plugins and every pack row; tool.plugins is
  // unconditional, so there is no longer a case where nothing needs it.
  const pluginList = await exec(p, ["claude", "plugin", "list", "--json"]);
  rows.push(pluginsRow(pluginList));
  for (const req of reqs) rows.push(packRow(req, pluginList));

  rows.push(await linearMcpRow(p, opts.secrets));

  return rows;
}
