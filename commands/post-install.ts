/**
 * rt --post-install — the headless installer entry. Auto-triggered on the
 * first `rt` invocation without a daemon.json, and re-run by `rt update`
 * from a freshly extracted release.
 *
 * Three things happen, in order:
 *   1. A refusal if the running app is at a transient location (a mounted
 *      DMG, or a Gatekeeper-translocated copy) — that path can vanish out
 *      from under an install the moment it's ejected. Checked FIRST, before
 *      anything below can delete a single file: a refusal that has already
 *      destroyed the user's prior install is the worst outcome in this flow.
 *   2. A one-shot legacy migration sweep (idempotent, safe to run every
 *      time): retires the pre-app-shell `com.rt.daemon` launchd label, any
 *      leftover rt-tray.app bundle, and — once a different root is the one
 *      actually running — a stale ~/Applications/mattstack.app copy left
 *      over from the phase-1 install location.
 *   3. `rt setup apply --non-interactive --team-of-one`, which does
 *      everything else: linking `rt` onto PATH, shell integration, the
 *      daemon, extensions, and the rest of the 22-step install. Only once
 *      that has actually run does a swept migration get its outcome report
 *      — reporting on the daemon's health before apply has had a chance to
 *      (re-)register it would verify nothing.
 *
 * All console output here goes to stderr — this entry point forwards
 * whatever args it was given straight into `setupApply`, and a `--json`
 * caller's stdout must carry nothing but that verb's NDJSON stream.
 */

import { spawnSync } from "child_process";
import { existsSync } from "fs";
import { join, resolve } from "path";
import { bundleRootFromExec, RT_BUNDLE_PATH } from "../lib/bundle-layout.ts";
import { legacyTrayAppPaths, legacyUserAppPath, TRAY_APP_BUNDLE, TRAY_APP_NAME } from "../lib/rt-paths.ts";
import { isTransientAppRoot } from "../lib/setup/steps/settings.ts";
import { setupApply, type ApplyDeps } from "./setup.ts";

export interface PostInstallOptions {
  /** Test override for `bundleRootFromExec()`; production passes nothing. */
  bundleRoot?: string | null;
  /** Test-only: overrides `setupApply`'s real deps so a sweep test never spins up the real 22-step engine, touches a real keychain/sops, or calls the real `process.exit`. Never set in production. */
  applyDeps?: ApplyDeps;
}

function bootout(label: string): void {
  spawnSync("launchctl", ["bootout", `gui/${process.getuid?.() ?? 0}/${label}`], { stdio: "pipe", env: process.env });
}

function quitApp(name: string): void {
  spawnSync("osascript", ["-e", `tell application "${name}" to quit`], { stdio: "pipe", timeout: 3_000, env: process.env });
  spawnSync("pkill", ["-x", name], { stdio: "pipe", env: process.env });
}

/**
 * Idempotent, and must run on EVERY post-install BEFORE anything else
 * launches or registers:
 *   - `com.rt.daemon` is booted out unconditionally — the pre-app-shell
 *     daemon label, fully superseded by `com.mattstack.daemon`; safe and a
 *     no-op on a machine that never had it.
 *   - every `legacyTrayAppPaths()` candidate that exists is quit (by its own
 *     never-changing "rt-tray" identity) and removed.
 *   - a stale `~/Applications/mattstack.app` (the phase-1 install location)
 *     is quit, its OWN old daemon registration booted out (its
 *     BundleProgram points into the bundle about to be deleted — `setup
 *     apply`'s services.register re-registers), and removed — but only when
 *     `root` names a DIFFERENT install; a machine still running from that
 *     exact location has nothing stale to sweep.
 * Returns whether anything was actually swept, so the caller knows whether
 * a migration note is worth printing.
 */
function runLegacySweep(root: string | null): boolean {
  let swept = false;

  bootout("com.rt.daemon");

  for (const legacyPath of legacyTrayAppPaths()) {
    if (!existsSync(legacyPath)) continue;
    quitApp("rt-tray");
    spawnSync("rm", ["-rf", legacyPath], { stdio: "pipe", env: process.env });
    swept = true;
  }

  const stale = legacyUserAppPath();
  if (root && root !== stale && existsSync(stale)) {
    quitApp(TRAY_APP_NAME);
    bootout("com.mattstack.daemon");
    spawnSync("rm", ["-rf", stale], { stdio: "pipe", env: process.env });
    swept = true;
  }

  return swept;
}

/** A DMG mount or a Gatekeeper-translocated copy — `root` from either can vanish out from under an install the moment it's ejected. `root === null` (e.g. a bare `dist/rt` outside any bundle) is never transient — there's no bundle location to refuse. */
function appPathIsTransient(root: string | null): boolean {
  return root !== null && isTransientAppRoot(root);
}

/** Loud, not a silent "should work": confirms the new registration actually came up, and reminds the operator that notification/full-disk-access permissions must be re-granted since the bundle id changed. Only worth checking when the sweep actually swept something — and only AFTER `setup apply` has run, or there is nothing yet to verify (services.register/services.start are steps inside that run, not the sweep). */
async function reportMigrationOutcome(): Promise<void> {
  const { isDaemonRunning } = await import("../lib/daemon-client.ts");
  if (await isDaemonRunning()) {
    console.error("  ✓ migration: daemon healthy under the new registration");
  } else {
    console.error("  ✗ migration: daemon did not come up under the new registration yet");
    console.error("    Check: rt daemon status   /   rt verify");
  }
  console.error(`  NOTE: notification + full-disk-access permissions must be re-granted for ${TRAY_APP_BUNDLE} — the bundle id changed as part of this migration.`);
}

export async function runPostInstall(args: string[], opts: PostInstallOptions = {}): Promise<void> {
  const root = opts.bundleRoot !== undefined ? opts.bundleRoot : bundleRootFromExec();
  const exit = opts.applyDeps?.exit ?? process.exit;

  // Refuse BEFORE sweeping — the sweep deletes files (a legacy rt-tray.app,
  // a stale ~/Applications/mattstack.app), and a transient root means this
  // process might not even be the real install: destroying the prior
  // install and then refusing to replace it is strictly worse than doing
  // nothing and refusing.
  if (appPathIsTransient(root)) {
    console.error(`  rt: running from ${root} — drag mattstack.app to /Applications and run this again`);
    return exit(2);
  }

  const swept = runLegacySweep(root);

  await setupApply(["--non-interactive", "--team-of-one", ...args], {}, opts.applyDeps);

  // Only reached once apply has actually run (a failed/bug exit above
  // returns or throws first) — the daemon this checks is one of apply's own
  // steps, so checking any earlier would verify nothing.
  if (swept) await reportMigrationOutcome();
}

// ─── rt binary link source resolution (kept for its own test suite) ───────

/**
 * Where `~/.local/bin/rt` should link from once a bundle is installed at
 * `bundleInstallDest` — the `path.link` step's own concern now, this pure
 * decision function is kept here only because
 * `lib/__tests__/post-install-rt-binary-src.test.ts` still exercises it in
 * isolation. Prefers the rt inside the bundle over `execPath` (the
 * transient extracted-tarball binary, gone once install finishes) and falls
 * back to `execPath` only when the bundle carries no `Contents/MacOS/rt` at
 * all but we can tell we're running from an extracted release.
 */
export function resolveRtBinarySrc(
  bundleInstallDest: string,
  execPath: string,
  exists: (path: string) => boolean = existsSync,
): { src: string; fallbackWarning: boolean } | null {
  const bundleBinary = join(bundleInstallDest, RT_BUNDLE_PATH);
  if (exists(bundleBinary)) return { src: bundleBinary, fallbackWarning: false };
  if (exists(resolve(execPath, `../${TRAY_APP_BUNDLE}`))) return { src: execPath, fallbackWarning: true };
  return null;
}
