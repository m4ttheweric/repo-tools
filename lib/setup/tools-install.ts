/**
 * `rt tools install|setup` — what the plan's `{type:"install", tool, via}`
 * rows spawn when a user clicks Install, and what a "run this setup verb"
 * row spawns for a tool that owns its own post-install wiring (herdr's
 * Claude integration, fast-browser's runtime, the editor extension).
 *
 * Every exec here is bounded and re-probed: an installer's exit code alone
 * is never trusted as proof the tool now works (brew/vendor can exit 0 on a
 * broken shim), and apple-clt's `xcode-select --install` triggers an
 * asynchronous OS dialog that can never be waited on — this never reports
 * more than "the dialog was triggered."
 */

import { dirname, join } from "path";
import { link, type LinkOutcome } from "../deps/links.ts";
import { appBundlePath, bundledToolExec, resolveTool } from "../deps/resolve.ts";
import { detectEditors, type DetectedEditor } from "../editors.ts";
import { UserActionableError } from "./errors.ts";
import type { Probes } from "./probes.ts";
import type { PackRequirements } from "./requirements.ts";
import { updateSetupState } from "./state.ts";

/**
 * URLs only — never a shell command. R-T21-a: nothing in this file ever
 * splices a URL into an `sh -c` string; `runVendorInstaller` fetches the URL
 * to a fixed local path via argv-only `curl`, then runs that local path as
 * its own argv step. R-T21-b: this table is rt's OWN short, hardcoded list —
 * a team-declared `install.url` from a pack's requirements.jsonc is never
 * looked up here and never auto-executed (see the `manual-install-required`
 * refusal in installTool).
 */
export const VENDOR_INSTALLERS: Record<string, string> = {
  herdr: "https://herdr.dev/install.sh",
  claude: "https://claude.ai/install.sh",
};

/** The only hosts a hardcoded VENDOR_INSTALLERS entry may point at — closes the door on a future entry (or a typo) silently widening what rt will fetch-and-run. */
const VENDOR_ALLOWED_HOSTS = new Set(["herdr.dev", "claude.ai"]);

export const BREW_FORMULAE: Record<string, string> = { herdr: "herdr", claude: "claude-code" };

/**
 * A team-declared `install.brew` runs as `brew install <formula>` — tap
 * syntax (`owner/tap/formula`) taps an arbitrary GitHub repo and evaluates
 * its Ruby, the same escalation R-T21-b closed for `install.url`. Only a
 * bare homebrew-core formula name is eligible for the one-click Install
 * button; anything else falls through to a shown-not-run remedy.
 */
const BARE_FORMULA_RE = /^[a-z0-9][a-z0-9@+._-]*$/;
export function isValidBrewFormula(formula: string): boolean {
  return BARE_FORMULA_RE.test(formula);
}

/** A team-declared `--version`/probe must never hang `rt tools install` forever. */
const PROBE_TIMEOUT_MS = 5000;
/** brew/vendor installs (and the vendor download step) are slow and network-bound; bounded, never run in tests. */
const INSTALL_TIMEOUT_MS = 5 * 60_000;
const EXTENSION_INSTALL_TIMEOUT_MS = 30_000;

// ─── injectable seams ──────────────────────────────────────────────────────

export interface ToolsInstallSeams {
  resolveTool: typeof resolveTool;
  bundledToolExec: typeof bundledToolExec;
  link: typeof link;
  detectEditors: typeof detectEditors;
  findVsix: (p: Pick<Probes, "exists" | "home">) => string | null;
}

/** `<appPath>/Contents/Resources/rt-context.vsix` first (the bundle rt runs from), else next to the running binary — mirrors commands/post-install.ts's own findVsix(). */
function realFindVsix(p: Pick<Probes, "exists" | "home">): string | null {
  const appPath = appBundlePath(p);
  if (appPath) {
    const bundled = join(appPath, "Contents", "Resources", "rt-context.vsix");
    if (p.exists(bundled)) return bundled;
  }
  const besideBinary = join(dirname(process.execPath), "rt-context.vsix");
  return p.exists(besideBinary) ? besideBinary : null;
}

const REAL_SEAMS: ToolsInstallSeams = { resolveTool, bundledToolExec, link, detectEditors, findVsix: realFindVsix };

// ─── installTool ───────────────────────────────────────────────────────────

export type InstallVia = "brew" | "vendor" | "apple-clt" | "bundled-link";
export interface InstallResult {
  via: InstallVia;
  ok: boolean;
  detail: string;
}

function firstLine(s: string): string {
  return s.trim().split("\n")[0] ?? "";
}

/** softwareupdate only lists Command Line Tools while this marker exists — the same trigger Homebrew and MDM tooling use. Best-effort removed afterwards; a stale marker only costs an extra listing. */
const CLT_ON_DEMAND_MARKER = "/tmp/.com.apple.dt.CommandLineTools.installondemand.in-progress";
const CLT_LIST_TIMEOUT_MS = 120_000;
const CLT_INSTALL_TIMEOUT_MS = 45 * 60_000;

/**
 * The newest CLT label wins — softwareupdate lists one label per available
 * version, oldest first. Verified against a real macOS 26 catalog: the
 * modern form is "Command Line Tools for Xcode 26.6-26.6" (space before
 * the version, then a -version suffix); older macOS used
 * "Command Line Tools for Xcode-14.3". Match both.
 */
export function parseCltLabel(listOutput: string): string | null {
  const labels = [...listOutput.matchAll(/^\s*\*?\s*Label:\s*(Command Line Tools for Xcode[ -][\d.]+(?:-[\d.]+)?)\s*$/gm)].map((m) => m[1]!);
  if (labels.length === 0) return null;
  // Catalog order is not version order (observed 26.6 before 26.5 on a real
  // guest) — sort by the numeric version in the label and take the newest.
  const version = (label: string) => label.match(/([\d.]+)$/)?.[1] ?? "0";
  return labels.sort((a, b) => version(a).localeCompare(version(b), undefined, { numeric: true })).at(-1)!;
}

/**
 * The slick path: install CLT entirely headlessly via softwareupdate — no
 * Apple dialog, no Safari, no "now wait and re-run". Falls back to
 * triggering the classic `xcode-select --install` dialog when the catalog
 * has no CLT label or the install fails (e.g. softwareupdate refuses
 * without root); either way the caller polls `git --version` back to green.
 */
async function installAppleClt(p: Probes): Promise<InstallResult> {
  const already = await p.exec(["xcode-select", "-p"], { timeoutMs: PROBE_TIMEOUT_MS });
  if (already.code === 0) {
    const git = await p.exec(["git", "--version"], { timeoutMs: PROBE_TIMEOUT_MS });
    if (git.code === 0) return { via: "apple-clt", ok: true, detail: "Command Line Tools already installed" };
  }

  // touch is best-effort: a marker left root-owned by an earlier trigger
  // still does its job, and the failed touch must not abort the flow.
  await p.exec(["touch", CLT_ON_DEMAND_MARKER], { timeoutMs: PROBE_TIMEOUT_MS });
  try {
    // A freshly-poked catalog can need one scan cycle before it exposes the
    // CLT labels (observed on a real macOS 26 guest: first -l empty, second
    // listed them) — retry briefly rather than concluding "no label".
    let label: string | null = null;
    for (let attempt = 0; attempt < 3 && !label; attempt++) {
      if (attempt > 0) await p.exec(["sleep", "10"], { timeoutMs: 15_000 });
      const list = await p.exec(["softwareupdate", "-l"], { timeoutMs: CLT_LIST_TIMEOUT_MS });
      label = list.code === 0 ? parseCltLabel(list.stdout) : null;
    }
    if (label) {
      const install = await p.exec(["softwareupdate", "-i", label], { timeoutMs: CLT_INSTALL_TIMEOUT_MS });
      const git = await p.exec(["git", "--version"], { timeoutMs: PROBE_TIMEOUT_MS });
      if (install.code === 0 && git.code === 0) {
        return { via: "apple-clt", ok: true, detail: `installed "${label}" headlessly — ${git.stdout.trim()}` };
      }
    }
  } finally {
    await p.exec(["rm", "-f", CLT_ON_DEMAND_MARKER], { timeoutMs: PROBE_TIMEOUT_MS }).catch(() => {});
  }

  const res = await p.exec(["xcode-select", "--install"], { timeoutMs: PROBE_TIMEOUT_MS });
  if (res.code === 124) return { via: "apple-clt", ok: false, detail: "xcode-select --install timed out" };
  if (res.code === 0) {
    // ok means "verified installed" (the headless path proves it with a git
    // re-probe); a triggered dialog is progress, not completion.
    return { via: "apple-clt", ok: false, detail: "triggered the Command Line Tools install dialog — complete it, then re-run rt setup status" };
  }
  const combined = `${res.stdout} ${res.stderr}`.toLowerCase();
  if (res.code === 1 && combined.includes("already installed")) {
    return { via: "apple-clt", ok: true, detail: "Command Line Tools already installed" };
  }
  return { via: "apple-clt", ok: false, detail: `xcode-select --install failed (exit ${res.code}): ${firstLine(res.stderr || res.stdout)}` };
}

function linkOutcomeDetail(outcome: LinkOutcome): string {
  return outcome.ok ? (outcome.state === "already" ? `already linked at ${outcome.path}` : `linked at ${outcome.path}`) : outcome.detail;
}

export async function installTool(p: Probes, tool: string, reqs: PackRequirements[], seams: ToolsInstallSeams = REAL_SEAMS): Promise<InstallResult> {
  if (tool === "apple-clt") return installAppleClt(p);

  const bundled = seams.bundledToolExec(p, tool);
  if (bundled) {
    const outcome = seams.link(p, tool);
    return { via: "bundled-link", ok: outcome.ok, detail: linkOutcomeDetail(outcome) };
  }

  const teamTool = reqs.flatMap((r) => r.tools).find((t) => t.name === tool);
  const teamBrew = teamTool?.install?.brew;
  const teamBrewValid = teamBrew !== undefined && isValidBrewFormula(teamBrew);

  const brewCheck = await p.exec(["brew", "--version"], { timeoutMs: PROBE_TIMEOUT_MS });
  const formula = BREW_FORMULAE[tool] ?? (teamBrewValid ? teamBrew : undefined);
  if (brewCheck.code === 0 && formula) {
    return runInstallerAndVerify(p, tool, "brew", ["brew", "install", formula], `brew install ${formula}`, `installed via brew (${formula})`);
  }

  const hardcodedUrl = VENDOR_INSTALLERS[tool];
  if (hardcodedUrl) return runVendorInstaller(p, tool, hardcodedUrl);

  // R-T21-b: a team pack's install.url is free-form text authored by
  // whoever wrote that team's requirements.jsonc — the same trust boundary
  // as the invite-pointer RCE earlier in this lane. rt shows it (this is
  // exactly what teamToolRemedyAction's open-url row already does); it never
  // auto-executes it. installTool must match that row, not exceed it.
  if (teamTool?.install?.url) {
    throw new UserActionableError(
      "manual-install-required",
      `${tool} declares an install URL from a team pack — rt never auto-runs a team-authored install script; install it yourself: ${teamTool.install.url}`,
    );
  }

  // A team-declared install.brew rt won't auto-run (tap syntax, a path, or
  // anything else outside a bare formula name) is shown the same way, never
  // silently dropped and never auto-executed — same trust boundary as above.
  if (teamBrew !== undefined && !teamBrewValid) {
    throw new UserActionableError(
      "manual-install-required",
      `${tool} declares install.brew "${teamBrew}" from a team pack — rt only auto-runs a bare formula name; install it yourself: brew install ${teamBrew}`,
    );
  }

  throw new UserActionableError("no-installer", `no install method known for ${tool}`);
}

/**
 * Runs the installer argv, then re-probes `<tool> --version` before
 * reporting success — an installer's own exit code is never sufficient
 * proof by itself (brew/vendor can exit 0 over a broken shim).
 */
async function runInstallerAndVerify(p: Probes, tool: string, via: "brew" | "vendor", argv: string[], label: string, successDetail: string): Promise<InstallResult> {
  const res = await p.exec(argv, { timeoutMs: INSTALL_TIMEOUT_MS });
  if (res.code === 124) return { via, ok: false, detail: `${label} timed out` };
  if (res.code !== 0) return { via, ok: false, detail: `${label} failed (exit ${res.code}): ${firstLine(res.stderr || res.stdout)}` };

  const verify = await p.exec([tool, "--version"], { timeoutMs: PROBE_TIMEOUT_MS });
  if (verify.code !== 0) {
    return { via, ok: false, detail: `${label} exited 0 but "${tool} --version" still fails (exit ${verify.code}) — not claiming success` };
  }
  return { via, ok: true, detail: successDetail };
}

/** Rejects anything but https on one of the known vendor hosts — a hardcoded VENDOR_INSTALLERS entry only, never a team-declared URL (see installTool). */
function validateVendorUrl(url: string): { ok: true } | { ok: false; detail: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, detail: `install URL is not a valid URL: ${url}` };
  }
  if (parsed.protocol !== "https:") return { ok: false, detail: `install URL must be https, got "${parsed.protocol}" (${url})` };
  if (!VENDOR_ALLOWED_HOSTS.has(parsed.hostname)) return { ok: false, detail: `install URL host "${parsed.hostname}" is not on the known vendor host list` };
  return { ok: true };
}

/** A fixed, rt-owned local path per tool — never derived from anything the URL or its response controls. */
function vendorDownloadPath(p: Pick<Probes, "env">, tool: string): string {
  return join(p.env.TMPDIR ?? "/tmp", "rt-vendor-install", `${tool}.sh`);
}

/**
 * R-T21-a: the URL is passed as its own argv element to `curl`, never
 * spliced into a shell string. R-T21-b: only ever called with a
 * VENDOR_INSTALLERS entry (rt's own short hardcoded list) — a team-declared
 * URL never reaches here. Fetch, then run the fetched file as its own argv
 * step (`["sh", path]` — a script FILE argument, not a `-c` command string)
 * — no pipe-to-shell anywhere in the sequence.
 */
async function runVendorInstaller(p: Probes, tool: string, url: string): Promise<InstallResult> {
  const validated = validateVendorUrl(url);
  if (!validated.ok) return { via: "vendor", ok: false, detail: validated.detail };

  const path = vendorDownloadPath(p, tool);
  p.mkdirp(dirname(path));

  const fetchRes = await p.exec(["curl", "-fsSL", url, "-o", path], { timeoutMs: INSTALL_TIMEOUT_MS });
  if (fetchRes.code === 124) return { via: "vendor", ok: false, detail: "install script download timed out" };
  if (fetchRes.code !== 0) return { via: "vendor", ok: false, detail: `install script download failed (exit ${fetchRes.code}): ${firstLine(fetchRes.stderr || fetchRes.stdout)}` };

  return runInstallerAndVerify(p, tool, "vendor", ["sh", path], "install script", "installed via vendor script");
}

// ─── setupTool ───────────────────────────────────────────────────────────

export interface SetupResult {
  ok: boolean;
  detail: string;
}

async function setupFastBrowser(p: Probes, seams: ToolsInstallSeams): Promise<SetupResult> {
  const resolved = seams.resolveTool(p, "fast-browser");
  if (!resolved.exec) throw new UserActionableError("tool-missing", "fast-browser is not resolvable (not bundled, no user copy on PATH)");

  // Non-interactive setup refuses to guess a host even when only one is detected.
  const res = await p.exec([...resolved.exec, "setup", "--host", "claude"], { timeoutMs: INSTALL_TIMEOUT_MS });
  if (res.code === 124) return { ok: false, detail: "fast-browser setup timed out" };
  if (res.code !== 0) return { ok: false, detail: `fast-browser setup failed (exit ${res.code}): ${firstLine(res.stderr || res.stdout)}` };
  return { ok: true, detail: "fast-browser setup complete" };
}

async function setupHerdr(p: Probes, configDirs: string[]): Promise<SetupResult> {
  const results: { dir: string; ok: boolean; detail: string }[] = [];
  for (const dir of configDirs) {
    const res = await p.exec(["herdr", "integration", "install", "claude"], { env: { CLAUDE_CONFIG_DIR: dir }, timeoutMs: INSTALL_TIMEOUT_MS });
    if (res.code === 124) results.push({ dir, ok: false, detail: "timed out" });
    else if (res.code !== 0) results.push({ dir, ok: false, detail: `exit ${res.code}` });
    else results.push({ dir, ok: true, detail: "ok" });
  }
  const ok = results.length > 0 && results.every((r) => r.ok);
  const detail = results.map((r) => `${r.dir}: ${r.detail}`).join("; ") || "no config dirs to set up";
  return { ok, detail };
}

/** Exported so a caller classifying `SetupResult.detail` (extension.install's apply step) matches against the same value this emits, rather than a copy of the prose. */
export const VSIX_NOT_FOUND_DETAIL = "rt-context.vsix not found — expected in the app bundle or next to the binary";
export const NO_EDITORS_DETAIL = "no compatible editors found";

async function setupExtension(p: Probes, seams: ToolsInstallSeams): Promise<SetupResult> {
  const vsix = seams.findVsix(p);
  if (!vsix) return { ok: false, detail: VSIX_NOT_FOUND_DETAIL };

  const editors: DetectedEditor[] = seams.detectEditors();
  if (editors.length === 0) return { ok: false, detail: NO_EDITORS_DETAIL };

  const installed: string[] = [];
  const failed: string[] = [];
  for (const editor of editors) {
    const res = await p.exec([editor.cliPath, "--install-extension", vsix, "--force"], { timeoutMs: EXTENSION_INSTALL_TIMEOUT_MS });
    if (res.code === 0) installed.push(editor.name);
    else failed.push(`${editor.name} (exit ${res.code})`);
  }

  // Only what actually verified installed goes into setup-state — a failed
  // editor must never be recorded as if it succeeded.
  if (installed.length > 0) {
    updateSetupState(p, (s) => ({ ...s, extensionEditors: [...s.extensionEditors, ...installed] }));
  }

  const ok = installed.length > 0 && failed.length === 0;
  const detail = failed.length === 0 ? `installed into ${installed.join(", ")}` : `installed into ${installed.join(", ") || "(none)"}; failed: ${failed.join(", ")}`;
  return { ok, detail };
}

export async function setupTool(p: Probes, tool: string, opts: { configDirs: string[] }, seams: ToolsInstallSeams = REAL_SEAMS): Promise<SetupResult> {
  if (tool === "fast-browser") return setupFastBrowser(p, seams);
  if (tool === "herdr") return setupHerdr(p, opts.configDirs);
  if (tool === "extension") return setupExtension(p, seams);
  throw new UserActionableError("unknown-tool-setup", `no setup routine for "${tool}"`);
}

// ─── claudeConfigDirs ──────────────────────────────────────────────────────

/** [CLAUDE_CONFIG_DIR env ?? ~/.claude, ...extra], deduped. */
export function claudeConfigDirs(p: Pick<Probes, "env" | "home">, extra: string[]): string[] {
  const base = p.env.CLAUDE_CONFIG_DIR ?? join(p.home, ".claude");
  return [...new Set([base, ...extra])];
}
