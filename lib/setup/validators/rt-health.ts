/**
 * tools-group validators — the checks `rt verify` used to run, reframed as
 * setup Rows.
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
import { detectShellFrom, shellRcPathFor } from "../../shell-integration.ts";
import { row, type Action, type Row } from "../contract.ts";
import { LOGIN_ITEMS_SETTINGS_ACTION } from "../permissions.ts";
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
const MERGE_LEGACY_STATE_ACTION: Action = {
  type: "steps",
  label: "Merge legacy state",
  steps: [
    "Compare each file under the legacy dir(s) named above with ~/.mattstack/rt",
    "Copy over anything ~/.mattstack/rt is missing",
    "Delete the legacy dir(s) once you've confirmed nothing is left to merge",
  ],
};

async function rtRow(p: Probes): Promise<Row> {
  const base = { id: "tool.rt", kind: "tool" as const, title: "rt binary", why: "rt itself must be on PATH before anything else can run.", required: true };
  const res = await p.exec(["rt", "--version"]);
  if (res.code === 0) return row({ ...base, status: "ready", detail: res.stdout.trim() });
  if (res.code === 127) return row({ ...base, status: "missing", detail: "rt not found on PATH", action: LINK_BUNDLED_RT });
  return row({ ...base, status: "error", detail: `could not run rt (exit ${res.code})` });
}

function rtLinkRow(p: Probes): Row {
  const base = {
    id: "tool.rt-link",
    kind: "tool" as const,
    title: "rt PATH link",
    why: "Prod mode's ~/.local/bin/rt must point at the rt inside mattstack.app.",
    required: false,
    optionalNote: "Cosmetic: without this, `rt` may resolve to a different copy on PATH than the one inside mattstack.app.",
  };

  if (currentMode() === "dev") return row({ ...base, status: "skipped", detail: "dev mode owns ~/.local/bin/rt" });

  const root = appBundlePath(p);
  if (!root) return row({ ...base, status: "skipped", detail: "mattstack.app not found — nothing to link into" });

  const expected = join(root, RT_BUNDLE_PATH);
  const actual = p.readlink(linkPath(p.home, "rt"));
  if (actual === expected) return row({ ...base, status: "ready", detail: "linked into the bundle" });
  // A "run" action pointing at `setup apply --from path.link` would replay
  // the full 16-step chain from that point — buffered, one-shot, no
  // NeedBroker — and any `need` a later step raises (services.register,
  // proxy.install) would hang this cosmetic row for the full 10-minute
  // await timeout. `link-bundled` dispatches the single one-shot verb this
  // row actually needs (`rt deps link rt --json`).
  return row({ ...base, status: "needs-you", detail: "not a link into mattstack.app — run: rt deps link rt", action: LINK_BUNDLED_RT });
}

function legacyDirsRow(): Row {
  const base = { id: "tool.legacy-dirs", kind: "tool" as const, title: "Legacy state dirs", why: `rt reads only ${RT_DIR_LABEL} — a leftover legacy dir means state is split and silently ignored.`, required: true };
  const legacy = legacyDirsPresent();
  if (legacy.real.length > 0) {
    const plural = legacy.real.length !== 1 ? "s" : "";
    return row({
      ...base,
      status: "invalid",
      detail: `real legacy dir${plural} present: ${legacy.real.join(", ")} — rt reads only ${RT_DIR_LABEL}`,
      action: MERGE_LEGACY_STATE_ACTION,
    });
  }
  if (legacy.symlinks.length > 0) {
    return row({ ...base, status: "ready", detail: `compat symlink still present: ${legacy.symlinks.join(", ")}` });
  }
  return row({ ...base, status: "ready", detail: `state lives only in ${RT_DIR_LABEL}` });
}

function interceptsRow(p: Probes): Row {
  const base = {
    id: "tool.intercepts",
    kind: "tool" as const,
    title: "Intercept shims",
    why: "Team command intercepts (git, gh, …) only fire once their PATH shims are installed and current.",
    required: false,
    optionalNote: "Works without this; team command intercepts (git, gh, …) just won't fire.",
  };

  let report: ReturnType<typeof shimReport>;
  let staleRules: ReturnType<typeof staleIntercepts>;
  try {
    report = shimReport();
    staleRules = staleIntercepts();
  } catch (err) {
    return row({ ...base, status: "error", detail: `check failed: ${(err as Error).message}` });
  }

  if (report.length === 0) return row({ ...base, status: "skipped", detail: "no intercepts declared" });

  const missing = report.filter((r) => !r.installed);
  const stale = report.filter((r) => r.installed && !r.current);
  const binDir = localBinDir();
  const onPath = (p.env.PATH ?? "").split(":").some((entry) => entry === binDir || entry.replace(/\/+$/, "") === binDir);
  const pathBroken = report.some((r) => r.installed) && !onPath;
  const pathNote = pathBroken ? ` — and ${binDir} is not on PATH, so intercepts will not fire` : "";

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
  if (res.code !== 0) return row({ ...base, status: "error", detail: `resolved to ${fzfPath} but could not run it (exit ${res.code})` });

  const version = res.stdout.trim().split(/\s+/)[0] || res.stdout.trim() || "unknown version";
  const root = appBundlePath(p);
  const bundled = root !== null && (fzfPath === root || fzfPath.startsWith(`${root}/`));
  return row({ ...base, status: "ready", detail: `fzf ${version} (${bundled ? "bundled" : "PATH"})` });
}

async function appRow(p: Probes): Promise<Row> {
  const base = {
    id: "tool.app",
    kind: "tool" as const,
    title: "mattstack.app",
    why: "The tray app hosts the daemon, permissions, and every bundled tool.",
    required: true,
    recheck: "on-activate" as const,
  };
  const root = appBundlePath(p);
  if (!root) return row({ ...base, status: "missing", detail: "mattstack.app not found in /Applications or ~/Applications" });

  const plist = join(root, "Contents", "Info.plist");
  const res = await p.exec(["/usr/libexec/PlistBuddy", "-c", "Print CFBundleShortVersionString", plist]);
  const version = res.code === 0 ? res.stdout.trim() : null;
  let detail = version ? `${root} (v${version})` : root;

  const legacyHits = legacyTrayAppPaths().filter((path) => p.exists(path));
  if (legacyHits.length > 0) detail += ` — old bundle still present: ${legacyHits.join(", ")}`;

  return row({ ...base, status: "ready", detail });
}

function vsixRow(p: Probes): Row {
  const base = {
    id: "tool.vsix",
    kind: "tool" as const,
    title: "Bundled extension",
    why: "mattstack.app can carry the rt-context editor extension pre-bundled.",
    required: false,
    optionalNote: "Works without this; the rt-context editor extension just won't be pre-installed for you.",
  };
  const root = appBundlePath(p);
  if (!root) return row({ ...base, status: "skipped", detail: "mattstack.app not found" });

  const vsix = join(root, "Contents", "Resources", "rt-context.vsix");
  if (p.exists(vsix)) return row({ ...base, status: "ready", detail: "bundled extension present" });
  return row({ ...base, status: "skipped", detail: "extension not bundled (pre-bundle build)" });
}

function extensionRow(p: Probes): Row {
  const base = {
    id: "tool.extension",
    kind: "tool" as const,
    title: "rt-context extension",
    why: "Gives your editor rt-aware context.",
    required: false,
    optionalNote: "Works without this; your editor just won't have rt-aware context.",
  };
  const result = checkRtContextExtension(p.home);
  if (result.status === "pass") return row({ ...base, status: "ready", detail: result.detail });
  if (result.status === "warn") return row({ ...base, status: "needs-you", detail: result.detail, action: INSTALL_EXTENSION_ACTION });
  return row({ ...base, status: "skipped", detail: result.detail });
}

function shellRow(p: Probes): Row {
  const base = {
    id: "tool.shell",
    kind: "tool" as const,
    title: "Shell integration",
    why: "The rtcd alias and PATH precedence come from your shell rc file.",
    required: false,
    optionalNote: "Works without this; you can still run `rt cd` directly, just not the `rtcd` shell alias.",
  };
  const shell = detectShellFrom(p.env.SHELL ?? "");
  const rc = shellRcPathFor(shell, p.home);
  if (rc) {
    const content = p.readFile(rc) ?? "";
    if (content.includes("rtcd")) return row({ ...base, status: "ready", detail: `rtcd alias in ${rc}` });
    return row({ ...base, status: "needs-you", detail: "shell integration missing — Install writes it" });
  }
  return row({ ...base, status: "needs-you", detail: "unrecognized shell — can't write shell integration automatically; add the rtcd alias yourself" });
}

async function daemonRow(p: Probes, opts: { ci: boolean }): Promise<Row> {
  const base = {
    id: "tool.daemon",
    kind: "tool" as const,
    title: "Daemon",
    why: "The daemon watches your repos and backs rt status, MRs, and notifications.",
    required: true,
    recheck: "on-activate" as const,
  };

  if (!isDaemonInstalled()) return row({ ...base, status: "missing", detail: "run Install (registers the daemon)" });

  const ping = await p.daemon("ping");
  if (!ping || !ping.ok) {
    if (opts.ci) return row({ ...base, status: "needs-you", detail: "not booted (expected in CI)" });
    return row({ ...base, status: "needs-you", detail: "installed but not responding — approve in Login Items", action: LOGIN_ITEMS_SETTINGS_ACTION });
  }

  const [statusRes, launchd, worktrees] = await Promise.all([
    p.daemon("status"),
    p.exec(["launchctl", "list", activeLaunchdLabel()]),
    p.daemon("worktrees"),
  ]);

  const data = (statusRes?.data ?? {}) as { pid?: number; uptime?: number; watchedRepos?: number };

  // launchctl exiting 124 (this module's own timeout code) or 127 (not
  // found) means the probe never produced an answer — that is "could not
  // determine", not "determined not registered". Only a clean exit whose
  // output actually says so is a real negative. Same distinction for
  // `worktrees === null`, which is the daemon-client's transport-failure
  // sentinel, not the endpoint answering "no".
  const launchdInconclusive = launchd.code === 124 || launchd.code === 127;
  const launchdOk = !launchdInconclusive && launchd.code === 0 && !launchd.stdout.includes("Could not find");
  const launchdMissing = !launchdInconclusive && !launchdOk;
  const worktreesInconclusive = worktrees === null;

  const parts: string[] = [];
  if (data.pid !== undefined) parts.push(`pid ${data.pid}`);
  if (typeof data.uptime === "number") parts.push(`uptime ${Math.floor(data.uptime / 1000)}s`);
  if (typeof data.watchedRepos === "number") parts.push(`watching ${data.watchedRepos} repos`);

  // A daemon that answers ping but fails a sub-fact is a real negative
  // signal, not cosmetic: launchd registration is what makes it survive a
  // login, and the worktrees endpoint is the daemon's own smoke test
  // (`rt verify` today hard-fails on exactly this — verify.ts's "daemon api"
  // check). Folding these into a "ready" detail would let a structurally
  // broken daemon enable Install.
  const inconclusive: string[] = [];
  if (launchdInconclusive) inconclusive.push(`launchctl check failed (${launchd.code === 124 ? "timed out" : "not found"})`);
  if (worktreesInconclusive) inconclusive.push("worktrees endpoint check failed (daemon unreachable)");

  const missing: string[] = [];
  if (launchdMissing) missing.push("not registered with launchd");

  // Any inconclusive sub-fact makes the whole row "could not determine" —
  // never "invalid" alongside evidence that never actually arrived.
  if (inconclusive.length > 0) return row({ ...base, status: "error", detail: [...parts, ...missing, ...inconclusive].join(", ") });
  if (missing.length > 0) return row({ ...base, status: "invalid", detail: [...parts, ...missing].join(", ") });

  parts.push("registered with launchd", "worktrees endpoint responding");
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
