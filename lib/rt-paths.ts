/**
 * Single source of truth for the ~/.mattstack/rt path layout.
 *
 * rt state lives at ~/.mattstack/rt (RT-33 moved it from ~/.rt; RT-46 removed
 * the compat-symlink dependency). Per-repo data lives under
 * ~/.mattstack/rt/repos/<repoName>/ (NOT ~/.mattstack/rt/<repoName>/).
 * Keeping the construction here means there is exactly one place that knows
 * the layout, so a future move is a one-line change and stray `join(RT_DIR,
 * repoName, ...)` callsites can't drift. The source-guard tests
 * (lib/__tests__/rt-paths.test.ts) fail the build if that pattern — or any
 * legacy `.rt` literal — reappears outside this module.
 *
 * HOME is resolved at CALL time via `process.env.HOME ?? homedir()` so tests can
 * point the whole tree at a temp dir by setting process.env.HOME before calling.
 * This also unifies the two conventions that previously coexisted (some modules
 * used homedir() at module-load time, others process.env.HOME at call time) —
 * a real divergence if the two ever differed.
 *
 * This module is also the only place allowed to know the LEGACY locations
 * (~/.rt, ~/.shepherdr): it owns the one-shot migration (migrateLegacyRtDir)
 * and the canary probe (legacyDirsPresent) that `rt verify` uses to detect
 * a machine still carrying real legacy dirs.
 */

import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync } from "fs";
import { homedir, hostname } from "os";
import { basename, join } from "path";
import { getSetting } from "./settings/resolve.ts";

function home(): string {
  return process.env.HOME ?? homedir();
}

/** ~/.mattstack — the home repo root (RT-30). */
export function mattstackHome(): string {
  return join(home(), ".mattstack");
}

/** ~/.mattstack/rt — the root of all rt state. App-level files live directly here. */
export function rtDir(): string {
  return join(home(), ".mattstack", "rt");
}

/** ~/.mattstack/rt/repos — the container for every per-repo data directory. */
export function reposDir(): string {
  return join(rtDir(), "repos");
}

/**
 * ~/.mattstack/rt/logs — every surface's JSON-lines log files.
 *
 * Log *writers* must resolve through this (call-time HOME) rather than a
 * module-load-time const: a const is baked from whatever HOME was set when the
 * module first loaded, so a test that repoints HOME afterwards still writes
 * into the developer's real logs dir. Readers (the `rt daemon logs` viewer)
 * can keep using the const, since they only ever run against the real tree.
 */
export function logsDir(): string {
  return join(rtDir(), "logs");
}

/**
 * ~/.mattstack/rt/repos/<repoName> — a single repo's data directory (config,
 * hooks, scripts, run-history, etc.). This is `RepoIdentity.dataDir`.
 */
export function repoDataDir(repoName: string): string {
  return join(reposDir(), repoName);
}

// ─── Settings stores (RT-47, re-rooted under the home repo's user/ zone) ──────
//
// These paths live under ~/.mattstack directly, NOT under rtDir() — they are
// shared with the rest of mattstack (skills, board, deck), not just rt. The
// RT-46 source guards only police `.rt`/`rtDir()` reconstruction, so they
// don't apply here; these constructors exist purely for the one-layout-home
// rule (call-time HOME, single place that knows the path).

/**
 * ~/.mattstack/user/settings.user.jsonc — the user store (in the home repo's
 * tracked `user/` zone): global keys plus `repos.<identity>` sections, scoped
 * to this human across every machine they use.
 */
export function userSettingsPath(): string {
  return join(home(), ".mattstack", "user", "settings.user.jsonc");
}

/**
 * ~/.mattstack/teams/<team>/mattstack/settings.team.jsonc — the team store
 * (in the team repo zone): shared keys plus `repos.<identity>` sections.
 * `team` is a team NAME (directory name under teamsDir()), not an identity.
 */
export function teamSettingsPath(team: string): string {
  return join(teamsDir(), team, "mattstack", "settings.team.jsonc");
}

/**
 * ~/.mattstack/user/local/<machineKey()>/settings.local.jsonc — the machine
 * store: local overrides, never committed or synced (`user/local/` is
 * gitignored in the home repo). Nested per machine so multiple machines
 * sharing the synced `user/` tree don't collide on one local-overrides file.
 */
export function machineSettingsPath(): string {
  return join(home(), ".mattstack", "user", "local", machineKey(), "settings.local.jsonc");
}

/** ~/.mattstack/teams — the container every team's local clone lives under. */
export function teamsDir(): string {
  return join(home(), ".mattstack", "teams");
}

/**
 * The stable per-machine key that scopes the machine settings store — so
 * `user/local/<key>/` never collides across machines sharing one synced
 * `user/` tree.
 *
 *  1. `~/.mattstack/machine-key`, trimmed, if present and non-empty — an
 *     explicit override for machines whose hostname isn't stable or unique
 *     (fresh installs, cloned VMs).
 *  2. Otherwise the hostname, slugified: lowercased, a trailing `.local`
 *     dropped (mDNS suffix, not part of the identity), every run of
 *     characters outside `[a-z0-9-]` collapsed to one `-`, leading/trailing
 *     `-` trimmed. An all-illegal hostname slugs to `""`, which falls back
 *     to `"default"` rather than producing an empty path segment.
 */
export function machineKey(): string {
  const override = join(home(), ".mattstack", "machine-key");
  try {
    const v = readFileSync(override, "utf8").trim();
    if (v) return v;
  } catch {
    // no override file — fall through to the hostname slug
  }
  const slug = hostname()
    .toLowerCase()
    .replace(/\.local$/, "")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "default";
}

// ─── Tray app (MAT-383) ───────────────────────────────────────────────────────
//
// The single source of truth for the tray app's on-disk names/paths, shared
// by every consumer (cli.ts, commands/verify.ts, commands/daemon.ts,
// commands/post-install.ts, lib/notifier.ts, lib/daemon-config.ts). Values
// are exact per the MAT-383 phase-1 spec §2 — copy verbatim, don't paraphrase.

/** prod CFBundleExecutable — pkill/osascript use this. */
export const TRAY_APP_NAME = "mattstack";
/** dev CFBundleExecutable — the flavor-aware quit needs it. */
export const DEV_TRAY_APP_NAME = "mattstack-dev";
export const TRAY_APP_BUNDLE = "mattstack.app";
export const DEV_TRAY_APP_BUNDLE = "mattstack-dev.app";

/** ~/Applications/mattstack.app — the prod tray bundle's install location. */
export function trayAppPath(): string {
  return join(home(), "Applications", TRAY_APP_BUNDLE);
}

/** ~/Applications/mattstack-dev.app — the dev tray bundle's install location. */
export function devTrayAppPath(): string {
  return join(home(), "Applications", DEV_TRAY_APP_BUNDLE);
}

/**
 * Where a bundle is ACTUALLY installed, not just where it's meant to go
 * (that's `trayAppPath`/`devTrayAppPath` — install destinations, used by
 * post-install.ts). The app's bundles legitimately live in `/Applications`
 * now, not only `~/Applications`, so this checks every location rt could
 * plausibly have been pointed at or find it in, strongest signal first, and
 * verifies each candidate actually exists before trusting it — a stale
 * machine setting or a since-removed bundle must never be handed back as
 * fact. `exists` is injectable so tests never have to touch the real
 * `/Applications`.
 */
export function installedTrayAppPath(bundle: string, exists: (path: string) => boolean = existsSync): string | null {
  const { value } = getSetting<string>("mattstack.appPath");
  // `mattstack.appPath` names one specific bundle (whichever flavor wrote
  // it); a dev-bundle lookup must never be handed the prod bundle's path
  // just because IT happens to exist on disk, or vice versa.
  if (typeof value === "string" && value.length > 0 && basename(value) === bundle && exists(value)) return value;

  const systemPath = join("/Applications", bundle);
  if (exists(systemPath)) return systemPath;

  const userPath = join(home(), "Applications", bundle);
  if (exists(userPath)) return userPath;

  return null;
}

/**
 * Old rt-tray.app candidate locations, for migration (post-install's
 * one-shot legacy sweep) and `rt verify` warnings. A FUNCTION, not a const —
 * this module's call-time-HOME rule (see the docblock above) forbids baking
 * HOME at module load, and the source-guard tests below enforce it.
 *
 * Mirrors the candidate list scattered across commands/verify.ts and
 * commands/post-install.ts today: both install dirs the app bundles
 * themselves can now live in (/Applications and ~/Applications), plus the
 * two locations the old Homebrew install put it at relative to the running
 * binary (same dir, and one level up for the Cellar layout).
 */
export function legacyTrayAppPaths(): string[] {
  const rtExec = process.execPath;
  return [
    join("/Applications", "rt-tray.app"),
    join(home(), "Applications", "rt-tray.app"),
    join(rtExec, "../rt-tray.app"),
    join(rtExec, "../../rt-tray.app"),
  ];
}

// ─── Legacy-tree migration + canary (RT-46) ──────────────────────────────────

/** The pre-RT-33 rt state root. Only this module may reference it. */
function legacyRtDir(): string {
  return join(home(), ".rt");
}

export type LegacyMigrationResult = "none" | "migrated" | "conflict";

/**
 * Human-readable path names for user-facing messages. Callers must use these
 * instead of writing the literals — the RT-46 source-guard fails any file
 * outside this module that spells the legacy path.
 */
export const LEGACY_RT_LABEL = "~/.rt";
export const RT_DIR_LABEL = "~/.mattstack/rt";

/**
 * One-shot migration of a real legacy ~/.rt directory to ~/.mattstack/rt.
 * Called early from the CLI entry and daemon boot — BEFORE anything (loggers
 * included) can create ~/.mattstack/rt, or a machine that still has a real
 * ~/.rt would land in "conflict" instead of migrating.
 *
 *  - ~/.rt absent, or a symlink (the RT-33 compat shim): "none", untouched.
 *  - real ~/.rt, no ~/.mattstack/rt: rename it into place → "migrated".
 *  - real ~/.rt AND ~/.mattstack/rt both exist: "conflict" — state is split
 *    and a human must merge; nothing is touched.
 */
export function migrateLegacyRtDir(): LegacyMigrationResult {
  const legacy = legacyRtDir();
  let legacyStat;
  try {
    legacyStat = lstatSync(legacy);
  } catch {
    return "none"; // no ~/.rt at all
  }
  if (legacyStat.isSymbolicLink() || !legacyStat.isDirectory()) return "none";

  const target = rtDir();
  try {
    lstatSync(target);
    return "conflict"; // both trees exist — never guess which one wins
  } catch {
    // target absent — proceed
  }
  mkdirSync(join(home(), ".mattstack"), { recursive: true });
  renameSync(legacy, target);
  return "migrated";
}

export interface LegacyDirsReport {
  /** Legacy paths that exist as REAL directories — state the code no longer
   *  reads; must be merged into the new tree by hand. */
  real: string[];
  /** Legacy paths that exist as symlinks — inert compat shims, deletable. */
  symlinks: string[];
}

/**
 * Canary probe for `rt verify`: which legacy state dirs still exist, and how.
 * A real directory is a failure (split state); a symlink is only a leftover.
 */
export function legacyDirsPresent(): LegacyDirsReport {
  const report: LegacyDirsReport = { real: [], symlinks: [] };
  for (const name of [".rt", ".shepherdr"]) {
    const path = join(home(), name);
    try {
      const st = lstatSync(path);
      if (st.isSymbolicLink()) report.symlinks.push(path);
      else if (st.isDirectory()) report.real.push(path);
    } catch {
      // absent — the good state
    }
  }
  return report;
}
