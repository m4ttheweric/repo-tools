/**
 * Single source of truth for ~/.rt path layout.
 *
 * Per-repo data lives under ~/.rt/repos/<repoName>/ (NOT ~/.rt/<repoName>/).
 * Keeping the construction here means there is exactly one place that knows the
 * layout, so a future move is a one-line change and stray `join(RT_DIR,
 * repoName, ...)` callsites can't drift. The source-guard test
 * (lib/__tests__/rt-paths.test.ts) fails the build if that pattern reappears
 * outside this module.
 *
 * HOME is resolved at CALL time via `process.env.HOME ?? homedir()` so tests can
 * point the whole tree at a temp dir by setting process.env.HOME before calling.
 * This also unifies the two conventions that previously coexisted (some modules
 * used homedir() at module-load time, others process.env.HOME at call time) —
 * a real divergence if the two ever differed.
 */

import { homedir } from "os";
import { join } from "path";

/** ~/.rt — the root of all rt state. App-level files live directly here. */
export function rtDir(): string {
  return join(process.env.HOME ?? homedir(), ".rt");
}

/** ~/.rt/repos — the container for every per-repo data directory. */
export function reposDir(): string {
  return join(rtDir(), "repos");
}

/**
 * ~/.rt/logs... every surface's JSON-lines log files.
 *
 * Log *writers* must resolve through this (call-time HOME) rather than a
 * module-load-time const: a const is baked from whatever HOME was set when the
 * module first loaded, so a test that repoints HOME afterwards still writes
 * into the developer's real ~/.rt/logs. Readers (the `rt daemon logs` viewer)
 * can keep using the const, since they only ever run against the real tree.
 */
export function logsDir(): string {
  return join(rtDir(), "logs");
}

/**
 * ~/.rt/repos/<repoName> — a single repo's data directory (config, hooks,
 * scripts, run-history, etc.). This is `RepoIdentity.dataDir`.
 */
export function repoDataDir(repoName: string): string {
  return join(reposDir(), repoName);
}

/** ~/.rt/sandboxes — local anchor directories for cloud sandboxes. */
export function sandboxesDir(): string {
  return join(rtDir(), "sandboxes");
}

/**
 * ~/.rt/sandboxes/<repoId>/<id> — a sandbox's local anchor directory: the
 * real local path that keys its dev-ports state entry (skills key that file
 * by directory) and holds sandbox.json metadata.
 */
export function sandboxAnchorDir(repoId: string, sandboxId: string): string {
  return join(sandboxesDir(), repoId, sandboxId);
}
