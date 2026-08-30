/**
 * Dev-mode detection.
 *
 * currentMode() MOVED here from commands/settings.ts:364 (MAT-383 §1), logic
 * unchanged: dev mode is detected by the presence of the CLI wrapper at
 * ~/.local/bin/rt (written by enableDevMode / removed by disableDevMode in
 * commands/settings.ts, which still owns writing it). The move exists so
 * lib/daemon-config.ts can expose activeLaunchdLabel() without a lib→commands
 * import — settings.ts already imports daemon-config, so the reverse would
 * cycle.
 *
 * currentMode() itself remains the single source of truth for the active
 * flavor (dev vs prod); dev-mode.json's existence is NOT a flavor signal.
 */

import { closeSync, existsSync, mkdirSync, openSync, readSync, renameSync, rmSync, symlinkSync } from "fs";
import { dirname, resolve } from "path";
import { homedir } from "os";
import { getSetting } from "./settings/resolve.ts";

// Call-time HOME (mirrors lib/rt-paths.ts's home()): resolved on every call,
// not baked in at module load, so tests can repoint HOME per-test by setting
// process.env.HOME before calling — module-load-time would freeze whatever
// HOME was set when this module first got imported, not when the test set it.
function home(): string {
  return process.env.HOME ?? homedir();
}

/** Where the CLI lives in both modes: the wrapper script (dev) or the compiled binary (prod). */
export function rtBinaryPath(): string {
  return `${home()}/.local/bin/rt`;
}

function devModeWrapperPath(): string {
  return rtBinaryPath();
}

/**
 * Link ~/.local/bin/rt at `src` (the rt inside the app bundle). Resolves
 * `src` to an absolute path first — symlinkSync stores the target exactly
 * as given, and a relative one would resolve against the LINK's directory
 * at read time, not the caller's cwd. Throws if `src` doesn't exist:
 * symlinkSync happily creates a dangling link otherwise, unlike the old
 * copyFileSync it replaced (which threw ENOENT). Link-then-rename so a
 * process executing the old target keeps its mapped pages and the switch is
 * atomic whether the old entry was a file or a link.
 */
export function installRtBinary(src: string): string {
  const resolvedSrc = resolve(src);
  if (!existsSync(resolvedSrc)) {
    throw new Error(`rt binary not found at ${resolvedSrc}`);
  }
  const dest = rtBinaryPath();
  mkdirSync(dirname(dest), { recursive: true });
  const tmp = `${dest}.new`;
  rmSync(tmp, { force: true });
  symlinkSync(resolvedSrc, tmp);
  try {
    renameSync(tmp, dest);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  return dest;
}

export const DEV_MODE_TAG = "# mattstack-dev-mode";

/**
 * A recognized dev-mode wrapper: our marker on line 2, OR a legacy
 * markerless wrapper (its RT_LAUNCH_CWD export line is our unique tell,
 * predating the marker). A foreign #! script -- including our own tagged
 * PATH-link wrapper from lib/deps/links.ts, which carries LINK_TAG instead
 * -- has neither, so it correctly falls through to false. `prefix` is a
 * bounded head of the file, never the whole file: in prod this path is a
 * symlink to the compiled binary.
 */
export function isDevModeWrapperContent(prefix: string): boolean {
  if (!prefix.startsWith("#!")) return false;
  const line2 = prefix.split("\n")[1] ?? "";
  return line2.startsWith(DEV_MODE_TAG) || prefix.includes("RT_LAUNCH_CWD");
}

/**
 * A bounded head of `path` (never the whole file): in prod this path is a
 * symlink to the multi-MB compiled binary, and a whole-file read there would
 * be needless I/O on every mode check. Exported so lib/deps/links.ts shares
 * this same real bounded read instead of re-implementing it.
 */
export function readWrapperPrefix(path: string): string | null {
  try {
    const fd = openSync(path, "r");
    try {
      const buf = Buffer.alloc(4096);
      const n = readSync(fd, buf, 0, 4096, 0);
      return buf.toString("latin1", 0, n);
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

/**
 * Dev mode is signalled by the dev-mode WRAPPER SCRIPT at ~/.local/bin/rt --
 * not by any file existing there. Prod mode installs the compiled binary at
 * that same path (MAT-383: leaving dev mode must leave a working rt behind),
 * so presence alone can no longer tell the modes apart: the smoke showed a
 * machine with the prod binary installed still reporting "dev", which made
 * the flavor toggle a permanent no-op.
 */
export function currentMode(): "dev" | "prod" {
  const path = devModeWrapperPath();
  if (!existsSync(path)) return "prod";
  const prefix = readWrapperPrefix(path);
  return prefix !== null && isDevModeWrapperContent(prefix) ? "dev" : "prod";
}

export interface IntendedMode {
  mode: "dev" | "prod";
  provenance: "setting" | "derived-from-wrapper";
}

/**
 * The single seam every flavor decision reads. The generic settings read is
 * NOT equivalent: it reports store values only and drops an unset value, and
 * a consumer defaulting unset→prod would stand the dev pair down on a fresh
 * machine — the opposite of self-heal.
 */
export function resolveIntendedMode(): IntendedMode {
  try {
    const { value } = getSetting<string>("mattstack.mode");
    if (value === "dev" || value === "prod") return { mode: value, provenance: "setting" };
  } catch {
    // unreadable store: derivation below always yields a mode
  }
  return { mode: currentMode(), provenance: "derived-from-wrapper" };
}
