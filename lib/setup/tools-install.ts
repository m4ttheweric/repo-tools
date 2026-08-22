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

export const VENDOR_INSTALLERS: Record<string, string[]> = {
  herdr: ["sh", "-c", "curl -fsSL https://herdr.dev/install.sh | sh"],
  claude: ["sh", "-c", "curl -fsSL https://claude.ai/install.sh | bash"],
};

export const BREW_FORMULAE: Record<string, string> = { herdr: "herdr", claude: "claude-code" };

/** A team-declared `--version`/probe must never hang `rt tools install` forever. */
const PROBE_TIMEOUT_MS = 5000;
/** brew/vendor installs are slow and network-bound; bounded, never run in tests. */
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

async function installAppleClt(p: Probes): Promise<InstallResult> {
  const res = await p.exec(["xcode-select", "--install"], { timeoutMs: PROBE_TIMEOUT_MS });
  if (res.code === 124) return { via: "apple-clt", ok: false, detail: "xcode-select --install timed out" };
  if (res.code === 0) {
    return { via: "apple-clt", ok: true, detail: "triggered the Command Line Tools install dialog — complete it, then re-run rt setup status" };
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

  const brewCheck = await p.exec(["brew", "--version"], { timeoutMs: PROBE_TIMEOUT_MS });
  const formula = BREW_FORMULAE[tool] ?? teamTool?.install?.brew;
  if (brewCheck.code === 0 && formula) {
    return runInstallerAndVerify(p, tool, "brew", ["brew", "install", formula], `brew install ${formula}`, `installed via brew (${formula})`);
  }

  const url = teamTool?.install?.url;
  const vendorArgv = VENDOR_INSTALLERS[tool] ?? (url ? ["sh", "-c", `curl -fsSL ${url} | sh`] : null);
  if (vendorArgv) {
    return runInstallerAndVerify(p, tool, "vendor", vendorArgv, "install script", "installed via vendor script");
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

// ─── setupTool ───────────────────────────────────────────────────────────

export interface SetupResult {
  ok: boolean;
  detail: string;
}

async function setupFastBrowser(p: Probes, seams: ToolsInstallSeams): Promise<SetupResult> {
  const resolved = seams.resolveTool(p, "fast-browser");
  if (!resolved.exec) throw new UserActionableError("tool-missing", "fast-browser is not resolvable (not bundled, no user copy on PATH)");

  const res = await p.exec([...resolved.exec, "setup"], { timeoutMs: INSTALL_TIMEOUT_MS });
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

async function setupExtension(p: Probes, seams: ToolsInstallSeams): Promise<SetupResult> {
  const vsix = seams.findVsix(p);
  if (!vsix) return { ok: false, detail: "rt-context.vsix not found — expected in the app bundle or next to the binary" };

  const editors: DetectedEditor[] = seams.detectEditors();
  if (editors.length === 0) return { ok: false, detail: "no compatible editors found" };

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
