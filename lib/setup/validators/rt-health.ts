/**
 * tools-group validators — the checks `rt verify` used to run, reframed as
 * setup Rows. Every sub-fact that today's `rt verify` prints as its own line
 * (launchd registration, the worktrees endpoint smoke test) folds into a
 * single row's `detail` here instead — the table this module implements
 * names exactly which row owns which fact, so nothing doubles up with
 * plan.ts's mac/permissions rows.
 *
 * `checkRtContextExtension` lives here now (moved from commands/verify.ts,
 * which re-exports it) so both `rt verify` and the setup plan share one
 * implementation.
 */

import { existsSync, readdirSync } from "fs";
import { join } from "path";
import { RT_BUNDLE_PATH } from "../../bundle-layout.ts";
import { activeLaunchdLabel, isDaemonInstalled } from "../../daemon-config.ts";
import { currentMode } from "../../dev-mode.ts";
import { appBundlePath, linkPath } from "../../deps/resolve.ts";
import { localBinDir, shimReport, staleIntercepts } from "../../endpoint/shim.ts";
import { resolveFzf } from "../../fzf.ts";
import { legacyDirsPresent, legacyTrayAppPaths, RT_DIR_LABEL } from "../../rt-paths.ts";
import { row, type Action, type Row } from "../contract.ts";
import type { Probes } from "../probes.ts";

// ─── rt-context extension check (moved from commands/verify.ts) ──────────────

export interface ExtensionCheckResult {
  name: string;
  status: "pass" | "warn" | "skip";
  detail: string;
  severity: "warning" | "info";
}

/**
 * Pure directory reads against a fixture `home`, no subprocess and no
 * version comparison — the extension versions independently of the CLI, so
 * a version check is underivable here. Shape matches `rt verify`'s
 * CheckResult (name/status/detail/severity) so commands/verify.ts's
 * re-export slots straight into its existing `results.push(...)`.
 */
export function checkRtContextExtension(home: string): ExtensionCheckResult {
  const editors = [
    { name: "VS Code", dir: join(home, ".vscode", "extensions") },
    { name: "Cursor", dir: join(home, ".cursor", "extensions") },
  ];

  const dirsFound: string[] = [];
  const editorsWithExtension: string[] = [];

  for (const editor of editors) {
    if (!existsSync(editor.dir)) continue;
    dirsFound.push(editor.name);
    let entries: string[] = [];
    try {
      entries = readdirSync(editor.dir);
    } catch {
      continue;
    }
    if (entries.some((e) => e.toLowerCase().includes("rt-context"))) editorsWithExtension.push(editor.name);
  }

  const name = "rt-context extension";
  if (editorsWithExtension.length > 0) return { name, status: "pass", detail: `installed in ${editorsWithExtension.join(", ")}`, severity: "warning" };
  if (dirsFound.length > 0) return { name, status: "warn", detail: `not installed in ${dirsFound.join(", ")} — run: rt settings extension`, severity: "warning" };
  return { name, status: "skip", detail: "no editor extensions directories found", severity: "info" };
}

// ─── injectable seams ─────────────────────────────────────────────────────────

export interface RtHealthSeams {
  resolveFzf: typeof resolveFzf;
}

const REAL_SEAMS: RtHealthSeams = { resolveFzf };

// ─── row builders ──────────────────────────────────────────────────────────

const LINK_BUNDLED_RT: Action = { type: "link-bundled", label: "Use mattstack's", tool: "rt" };
const LINK_BUNDLED_FZF: Action = { type: "link-bundled", label: "Use mattstack's", tool: "fzf" };
const REINSTALL_SHIMS_ACTION: Action = { type: "run", label: "Re-install shims", verb: ["intercept", "install"] };
const INSTALL_EXTENSION_ACTION: Action = { type: "run", label: "Install extension", verb: ["tools", "setup", "extension"] };
const LOGIN_ITEMS_ACTION: Action = { type: "open-settings", label: "Open Login Items…", target: "login-items" };

async function rtRow(p: Probes): Promise<Row> {
  const base = { id: "tool.rt", kind: "tool" as const, title: "rt binary", why: "rt itself must be on PATH before anything else can run.", required: true };
  const res = await p.exec(["rt", "--version"]);
  if (res.code === 0) return row({ ...base, status: "ready", detail: res.stdout.trim() });
  return row({ ...base, status: "missing", detail: "rt not found on PATH", action: LINK_BUNDLED_RT });
}

function rtLinkRow(p: Probes): Row {
  const base = { id: "tool.rt-link", kind: "tool" as const, title: "rt PATH link", why: "Prod mode's ~/.local/bin/rt must point at the rt inside mattstack.app.", required: false };

  if (currentMode() === "dev") return row({ ...base, status: "skipped", detail: "dev mode owns ~/.local/bin/rt" });

  const root = appBundlePath(p);
  if (!root) return row({ ...base, status: "skipped", detail: "mattstack.app not found — nothing to link into" });

  const expected = join(root, RT_BUNDLE_PATH);
  const actual = p.readlink(linkPath(p.home, "rt"));
  if (actual === expected) return row({ ...base, status: "ready", detail: "linked into the bundle" });
  return row({ ...base, status: "needs-you", detail: "not a link into mattstack.app — run: rt setup apply --from path.link" });
}

function legacyDirsRow(): Row {
  const base = { id: "tool.legacy-dirs", kind: "tool" as const, title: "Legacy state dirs", why: `rt reads only ${RT_DIR_LABEL} — a leftover legacy dir means state is split and silently ignored.`, required: true };
  const legacy = legacyDirsPresent();
  if (legacy.real.length > 0) {
    return row({ ...base, status: "invalid", detail: `real legacy dir present: ${legacy.real.join(", ")} — rt reads only ${RT_DIR_LABEL}` });
  }
  if (legacy.symlinks.length > 0) {
    return row({ ...base, status: "ready", detail: `compat symlink still present: ${legacy.symlinks.join(", ")}` });
  }
  return row({ ...base, status: "ready", detail: `state lives only in ${RT_DIR_LABEL}` });
}

function interceptsRow(p: Probes): Row {
  const base = { id: "tool.intercepts", kind: "tool" as const, title: "Intercept shims", why: "Team command intercepts (git, gh, …) only fire once their PATH shims are installed and current.", required: false };
  const report = shimReport();
  if (report.length === 0) return row({ ...base, status: "skipped", detail: "no intercepts declared" });

  const missing = report.filter((r) => !r.installed);
  const stale = report.filter((r) => r.installed && !r.current);
  const binDir = localBinDir();
  const onPath = (p.env.PATH ?? "").split(":").some((entry) => entry === binDir || entry.replace(/\/+$/, "") === binDir);
  const pathBroken = report.some((r) => r.installed) && !onPath;
  const pathNote = pathBroken ? ` — and ${binDir} is not on PATH, so intercepts will not fire` : "";
  const staleRules = staleIntercepts();

  if (missing.length > 0) {
    return row({ ...base, status: "needs-you", detail: `declared but not installed: ${missing.map((r) => r.command).join(", ")} — run rt intercept install${pathNote}`, action: REINSTALL_SHIMS_ACTION });
  }
  if (stale.length > 0) {
    return row({ ...base, status: "needs-you", detail: `stale shim content: ${stale.map((r) => r.command).join(", ")} — run rt intercept install${pathNote}`, action: REINSTALL_SHIMS_ACTION });
  }
  if (pathBroken) {
    return row({ ...base, status: "needs-you", detail: `shims installed but ${binDir} is not on PATH — intercepts will not fire`, action: REINSTALL_SHIMS_ACTION });
  }
  if (staleRules.stale) {
    return row({ ...base, status: "needs-you", detail: `shims are current but the rules cache is stale (${staleRules.reason}) — run rt intercept install`, action: REINSTALL_SHIMS_ACTION });
  }
  return row({ ...base, status: "ready", detail: `${report.length} installed and current` });
}

async function fzfRow(p: Probes, seams: RtHealthSeams): Promise<Row> {
  const base = { id: "tool.fzf", kind: "tool" as const, title: "fzf", why: "Every interactive rt picker shells out to fzf.", required: true };
  const fzfPath = seams.resolveFzf();
  if (!fzfPath) return row({ ...base, status: "missing", detail: "fzf not found", action: LINK_BUNDLED_FZF });

  const res = await p.exec([fzfPath, "--version"]);
  const version = res.stdout.trim().split(/\s+/)[0] || res.stdout.trim() || "unknown version";
  const root = appBundlePath(p);
  const bundled = root !== null && (fzfPath === root || fzfPath.startsWith(`${root}/`));
  return row({ ...base, status: "ready", detail: `fzf ${version} (${bundled ? "bundled" : "PATH"})` });
}

async function appRow(p: Probes): Promise<Row> {
  const base = { id: "tool.app", kind: "tool" as const, title: "mattstack.app", why: "The tray app hosts the daemon, permissions, and every bundled tool.", required: true };
  const root = appBundlePath(p);
  if (!root) return row({ ...base, status: "missing", detail: "mattstack.app not found in /Applications or ~/Applications" });

  const plist = join(root, "Contents", "Info.plist");
  const res = await p.exec(["/usr/libexec/PlistBuddy", "-c", "Print CFBundleShortVersionString", plist]);
  const version = res.code === 0 ? res.stdout.trim() : null;
  let detail = version ? `${root} (v${version})` : root;

  const legacyPresent = legacyTrayAppPaths().some((path) => p.exists(path));
  if (legacyPresent) detail += " — legacy rt-tray.app still present";

  return row({ ...base, status: "ready", detail });
}

function vsixRow(p: Probes): Row {
  const base = { id: "tool.vsix", kind: "tool" as const, title: "Bundled extension", why: "mattstack.app can carry the rt-context editor extension pre-bundled.", required: false };
  const root = appBundlePath(p);
  if (!root) return row({ ...base, status: "skipped", detail: "mattstack.app not found" });

  const vsix = join(root, "Contents", "Resources", "rt-context.vsix");
  if (p.exists(vsix)) return row({ ...base, status: "ready", detail: "bundled extension present" });
  return row({ ...base, status: "skipped", detail: "extension not bundled (pre-bundle build)" });
}

function extensionRow(p: Probes): Row {
  const base = { id: "tool.extension", kind: "tool" as const, title: "rt-context extension", why: "Gives your editor rt-aware context.", required: false };
  const result = checkRtContextExtension(p.home);
  if (result.status === "pass") return row({ ...base, status: "ready", detail: result.detail });
  if (result.status === "warn") return row({ ...base, status: "needs-you", detail: result.detail, action: INSTALL_EXTENSION_ACTION });
  return row({ ...base, status: "skipped", detail: result.detail });
}

/** Mirrors lib/shell-integration.ts's detectShell/shellRcPath, but over Probes (p.env.SHELL, p.home) so it's testable without touching real HOME/SHELL. */
function shellRcCandidate(p: Pick<Probes, "env" | "home">): string | null {
  const shell = p.env.SHELL ?? "";
  if (shell.endsWith("zsh")) return join(p.home, ".zshrc");
  if (shell.endsWith("bash")) return join(p.home, ".bash_profile");
  if (shell.endsWith("fish")) return join(p.home, ".config", "fish", "conf.d", "rt.fish");
  return null;
}

function shellRow(p: Probes): Row {
  const base = { id: "tool.shell", kind: "tool" as const, title: "Shell integration", why: "The rtcd alias and PATH precedence come from your shell rc file.", required: false };
  const rc = shellRcCandidate(p);
  if (rc) {
    const content = p.readFile(rc) ?? "";
    if (content.includes("rtcd")) return row({ ...base, status: "ready", detail: `rtcd alias in ${rc}` });
  }
  return row({ ...base, status: "needs-you", detail: "shell integration missing — Install writes it" });
}

async function daemonRow(p: Probes, opts: { ci: boolean }): Promise<Row> {
  const base = { id: "tool.daemon", kind: "tool" as const, title: "Daemon", why: "The daemon watches your repos and backs rt status, MRs, and notifications.", required: true };

  if (!isDaemonInstalled()) return row({ ...base, status: "missing", detail: "run Install (registers the daemon)" });

  const ping = await p.daemon("ping");
  if (!ping || !ping.ok) {
    if (opts.ci) return row({ ...base, status: "needs-you", detail: "not booted (expected in CI)" });
    return row({ ...base, status: "needs-you", detail: "installed but not responding — approve in Login Items", action: LOGIN_ITEMS_ACTION });
  }

  const [statusRes, launchd, worktrees] = await Promise.all([
    p.daemon("status"),
    p.exec(["launchctl", "list", activeLaunchdLabel()]),
    p.daemon("worktrees"),
  ]);

  const data = (statusRes?.data ?? {}) as { pid?: number; uptime?: number; watchedRepos?: number };
  const launchdOk = launchd.code === 0 && !launchd.stdout.includes("Could not find");
  const worktreesOk = worktrees !== null;

  const parts: string[] = [];
  if (data.pid !== undefined) parts.push(`pid ${data.pid}`);
  if (typeof data.uptime === "number") parts.push(`uptime ${Math.floor(data.uptime / 1000)}s`);
  if (typeof data.watchedRepos === "number") parts.push(`watching ${data.watchedRepos} repos`);
  parts.push(launchdOk ? "registered with launchd" : "not registered with launchd");
  parts.push(worktreesOk ? "worktrees endpoint responding" : "worktrees endpoint not responding");

  return row({ ...base, status: "ready", detail: parts.join(", ") });
}

// ─── entry point ────────────────────────────────────────────────────────────

export async function rtHealthRows(p: Probes, opts: { ci: boolean }, seams: RtHealthSeams = REAL_SEAMS): Promise<Row[]> {
  return [
    await rtRow(p),
    rtLinkRow(p),
    legacyDirsRow(),
    interceptsRow(p),
    await fzfRow(p, seams),
    await appRow(p),
    vsixRow(p),
    extensionRow(p),
    shellRow(p),
    await daemonRow(p, opts),
  ];
}
