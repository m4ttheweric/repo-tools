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
import type { TeamSnapshotEntry, TeamSnapshotSettings } from "../../daemon/team-snapshots.ts";
import { currentMode, resolveIntendedMode } from "../../dev-mode.ts";
import { appBundlePath, linkPath } from "../../deps/resolve.ts";
import { localBinDir, shimReport, staleIntercepts } from "../../endpoint/shim.ts";
import { legacyDirsPresent, legacyTrayAppPaths, RT_DIR_LABEL } from "../../rt-paths.ts";
import { getSetting } from "../../settings/resolve.ts";
import { detectShellFrom, shellRcPathFor } from "../../shell-integration.ts";
import { readHomePushRecord, type HomePushRecord } from "../../home/push-record.ts";
import { row, type Action, type Row } from "../contract.ts";
import { hasCommits, hasRemote, isGitRepo, originPushState } from "../home-git.ts";
import { LOGIN_ITEMS_SETTINGS_ACTION } from "../permissions.ts";
import { execWithTimeout, type Probes } from "../probes.ts";
import { discoverTeams } from "../team-settings.ts";

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

// The bare exec, not `createRealProbes().exec`: a full Probes captures $HOME at
// construction, and this is module-load time.
const REAL_EXEC: Probes["exec"] = execWithTimeout;

// ─── row builders ──────────────────────────────────────────────────────────

const LINK_BUNDLED_RT: Action = { type: "link-bundled", label: "Use mattstack's", tool: "rt" };
const RECHECK_ACTION: Action = { type: "run", label: "Re-check", verb: ["setup", "status"] };
const REINSTALL_SHIMS_ACTION: Action = { type: "run", label: "Re-install shims", verb: ["intercept", "install"] };
const INSTALL_EXTENSION_ACTION: Action = { type: "run", label: "Install extension", verb: ["tools", "setup", "extension"] };
/** No `rt home remote set` verb exists yet (installer-lane scope), so the remedy names the raw git commands instead of a `run` action. */
const HOME_BACKUP_PUSH_STEP = "git -C ~/.mattstack/user push origin HEAD (or wait — the daemon pushes on its next cycle, up to 30 minutes)";
const HOME_BACKUP_ADD_REMOTE_ACTION: Action = {
  type: "steps",
  label: "Show steps…",
  steps: ["git -C ~/.mattstack/user remote add origin <url>", HOME_BACKUP_PUSH_STEP],
};
const HOME_BACKUP_PUSH_ACTION: Action = { type: "steps", label: "Show steps…", steps: [HOME_BACKUP_PUSH_STEP] };
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
  if (res.code === 127) {
    // ~/.local/bin joins PATH only in Install's own path step, so before
    // Install the link there is the only rt a fresh machine can have.
    const linked = linkPath(p.home, "rt");
    if (p.exists(linked)) {
      const viaLink = await p.exec([linked, "--version"]);
      if (viaLink.code === 0) return row({ ...base, status: "ready", detail: `${viaLink.stdout.trim()} at ~/.local/bin (PATH entry added by Install)` });
    }
    return row({ ...base, status: "missing", detail: "rt not found on PATH", action: LINK_BUNDLED_RT });
  }
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
    why: "The daemon watches your repos and backs MRs and notifications.",
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

/**
 * Compares three flavor legs — the intended setting, the CLI wrapper, and
 * a LIVE daemon's own ping — and fails only when a running daemon actually
 * disagrees. A daemon that never answers (down, uninstalled, unreachable)
 * is `tool.daemon`'s failure to report, not this row's: CI's clean-room gate
 * runs verify with no daemon at all, so that leg reading "n/a" must always
 * resolve `ready` here or a headless run could never pass.
 */
async function flavorRow(p: Probes): Promise<Row> {
  const base = {
    id: "tool.flavor",
    kind: "tool" as const,
    title: "Flavor coherence",
    why: "One intended flavor serves this machine; a mismatched daemon means stale code answering fresh CLIs.",
    required: true,
    recheck: "on-activate" as const,
  };
  const intended = resolveIntendedMode();
  const cli = currentMode();
  const ping = await p.daemon("ping");
  const daemonFlavor = ping && ping.ok && (ping as any).flavor ? String((ping as any).flavor) : null;

  if (daemonFlavor === null) {
    return row({ ...base, status: "ready", detail: `intended ${intended.mode} (${intended.provenance}) · cli ${cli} · daemon n/a` });
  }
  if (daemonFlavor === intended.mode && cli === intended.mode) {
    return row({ ...base, status: "ready", detail: `${intended.mode} everywhere (${intended.provenance})` });
  }
  return row({
    ...base,
    status: "invalid",
    detail: `intended ${intended.mode} (${intended.provenance}) · cli ${cli} · daemon ${daemonFlavor} — run: rt settings dev-mode ${intended.mode}`,
  });
}

/** Wall-clock, not an injected `now()` — this row takes a bare `exec`, not a full Probes, so there is no seam to inject. */
function relativeWhen(at: Date | null): string {
  if (!at) return "recently";
  const mins = Math.floor((Date.now() - at.getTime()) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

/** One line, bounded: a push failure's stderr can run to a paragraph, and this shares a row's `detail` with the count it explains. */
function pushFailureSummary(record: HomePushRecord): string | null {
  if (record.ok) return null;
  const firstLine = (record.error ?? "").split("\n").map((l) => l.trim()).find((l) => l !== "");
  if (!firstLine) return null;
  return firstLine.length > 160 ? `${firstLine.slice(0, 157)}…` : firstLine;
}

/**
 * Green means a push actually happened, never merely that a remote is
 * configured — read from git's own remote-tracking ref, so this is right on
 * a machine where the daemon has never run and right when the user pushed
 * by hand. Takes a bare `repoDir` + `exec` (not the full `Probes`) so it can
 * be pointed at a real git repo directly, independent of the OS `$HOME` a
 * full `Probes` carries.
 *
 * `readLastPush` supplies only diagnostic detail — the daemon's own record of
 * its last push attempt. It never gates `ready`: a record saying "pushed fine"
 * on a repo whose tracking ref disagrees is exactly the shape-not-outcome
 * reading this row exists to refuse.
 */
export async function homeBackupRow(
  repoDir: string,
  exec: Probes["exec"] = REAL_EXEC,
  readLastPush: () => HomePushRecord | null = () => readHomePushRecord(),
): Promise<Row> {
  const base = {
    id: "home.backup",
    kind: "tool" as const,
    title: "Home repo backup",
    why: "Local-only is fully supported — this only confirms whether your settings are actually backed up anywhere, not just committed on this machine.",
    required: false,
    optionalNote: "Works without this; local-only just means this machine is the only copy of your settings.",
    recheck: "on-activate" as const,
  };

  if (!(await isGitRepo(exec, repoDir))) {
    return row({ ...base, status: "needs-you", detail: "no home repo found yet — nothing to back up" });
  }

  // Ahead of the remote check: an unborn repo is not "versioned on this
  // machine" either way, so a local-only one must not claim it is.
  if (!(await hasCommits(exec, repoDir))) {
    return row({ ...base, status: "needs-you", detail: "no commits yet — nothing is versioned or backed up" });
  }

  if (!(await hasRemote(exec, repoDir))) {
    return row({ ...base, status: "needs-you", detail: "local only — your settings are versioned on this machine but are not backed up anywhere", action: HOME_BACKUP_ADD_REMOTE_ACTION });
  }

  const state = await originPushState(exec, repoDir);
  if (state.kind === "no-ref") return row({ ...base, status: "needs-you", detail: "remote configured, nothing pushed yet", action: HOME_BACKUP_PUSH_ACTION });
  if (state.kind === "unknown") return row({ ...base, status: "needs-you", detail: "could not determine push status — the rev-list check failed" });

  const lastPush = readLastPush();
  if (state.kind === "ahead") {
    const why = lastPush ? pushFailureSummary(lastPush) : null;
    const detail = `${state.count} commit(s) not pushed${why ? ` — the last push failed: ${why}` : ""}`;
    return row({ ...base, status: "needs-you", detail });
  }

  // `state.committedAt` is the tracking ref tip's COMMITTER date, not a push
  // time — a week-old commit pushed five minutes ago would read "last pushed
  // 7d ago". Only the daemon's record carries a real push timestamp, so the
  // wording changes with the evidence rather than overstating it.
  if (lastPush?.ok) return row({ ...base, status: "ready", detail: `in sync — last pushed ${relativeWhen(new Date(lastPush.at))}` });
  return row({ ...base, status: "ready", detail: `in sync — last commit ${relativeWhen(state.committedAt)}` });
}

/** Every clone's daemon-side sync state in one row: a joiner who cannot decrypt is almost always a clone that has not pulled the owner's recipients yet. */
export async function teamSyncRow(
  slugs: string[],
  readStatus: () => Promise<TeamSnapshotEntry[] | null>,
  now: () => number,
  pullIntervalSec: number,
): Promise<Row | null> {
  if (slugs.length === 0) return null;
  const base = {
    id: "team.sync",
    kind: "tool" as const,
    title: "Team sync",
    why: "Your team clone pulls the roster, recipients and packs on a timer and pushes your own team edits; this is whether that is keeping up.",
    required: false,
    optionalNote: "Works without this; `rt team pull` and `rt team publish` do the same by hand.",
    recheck: "on-activate" as const,
  };
  const entries = await readStatus();
  if (entries === null) return row({ ...base, status: "missing", detail: "rt daemon not reachable — team clones sync once it is running" });

  const staleMs = pullIntervalSec * 2 * 1000;
  const problems: string[] = [];
  for (const slug of slugs) {
    const e = entries.find((x) => x.slug === slug);
    if (!e) {
      problems.push(`${slug}: not watched (no origin?)`);
      continue;
    }
    if (e.conflicted) {
      problems.push(`${slug}: rebase conflict — ${e.conflicted.detail}; rebase and rt team publish by hand`);
      continue;
    }
    // Both fields come off the same redactCredentials(stderr) shape in the
    // engine, so "" is reachable for either — tested against null/undefined,
    // never a truthiness check `""` would fail past.
    if (e.lastPushError != null) {
      problems.push(`${slug}: push failing — ${e.lastPushError || "push failed"}`);
      continue;
    }
    if (e.lastPullError != null) {
      problems.push(`${slug}: fetch failing — ${e.lastPullError || "fetch failed"}`);
      continue;
    }
    if (e.lastPullAt === 0 || now() - e.lastPullAt > staleMs) {
      problems.push(`${slug}: last pull ${e.lastPullAt === 0 ? "never" : `${Math.round((now() - e.lastPullAt) / 60_000)} min ago`}`);
    }
  }
  if (problems.length > 0) return row({ ...base, status: "needs-you", detail: problems.join("; "), action: RECHECK_ACTION });

  // A pull skipped every tick (a dirty src/ refusing the rebase) is not a
  // failure, but it is why a member's store edits are not moving; say so
  // without changing the status.
  const skips = slugs.map((slug) => entries.find((x) => x.slug === slug)?.lastPullSkipped).filter((d): d is string => !!d);
  const detail = `${slugs.length} clone${slugs.length === 1 ? "" : "s"} in sync${skips.length ? `; last pull skipped: ${skips.join("; ")}` : ""}`;
  return row({ ...base, status: "ready", detail });
}

// ─── entry point ────────────────────────────────────────────────────────────

export async function rtHealthRows(p: Probes, opts: { ci: boolean }): Promise<Row[]> {
  const teamSync = await teamSyncRow(
    discoverTeams(p),
    async () => {
      const res = await p.daemon("team:snapshot-status");
      if (!res || !res.ok) return null;
      return res.data as TeamSnapshotEntry[];
    },
    () => p.now().getTime(),
    getSetting<TeamSnapshotSettings>("rt.teamSnapshot").value?.pullIntervalSec ?? 300,
  );

  return [
    await rtRow(p),
    rtLinkRow(p),
    legacyDirsRow(),
    interceptsRow(p),
    await appRow(p),
    vsixRow(p),
    extensionRow(p),
    shellRow(p),
    await daemonRow(p, opts),
    await flavorRow(p),
    await homeBackupRow(join(p.home, ".mattstack", "user"), p.exec),
    ...(teamSync ? [teamSync] : []),
  ];
}
