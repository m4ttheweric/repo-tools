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

import { chmodSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync, readSync, renameSync } from "fs";
import { dirname } from "path";
import { homedir } from "os";

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
 * Install a compiled rt at rtBinaryPath(). Copy-then-rename so a process
 * currently executing the old binary (rt update running from it, say) keeps
 * its mapped pages instead of having them overwritten underneath it.
 */
export function installRtBinary(src: string): string {
  const dest = rtBinaryPath();
  mkdirSync(dirname(dest), { recursive: true });
  const tmp = `${dest}.new`;
  copyFileSync(src, tmp);
  chmodSync(tmp, 0o755);
  renameSync(tmp, dest);
  return dest;
}

/**
 * Dev mode is signalled by the dev-mode WRAPPER SCRIPT at ~/.local/bin/rt --
 * not by any file existing there. Prod mode installs the compiled binary at
 * that same path (MAT-383: leaving dev mode must leave a working rt behind),
 * so presence alone can no longer tell the modes apart: the smoke showed a
 * machine with the prod binary installed still reporting "dev", which made
 * the flavor toggle a permanent no-op. A script starts with "#!"; a Mach-O
 * binary never does.
 */
export function currentMode(): "dev" | "prod" {
  const path = devModeWrapperPath();
  if (!existsSync(path)) return "prod";
  try {
    const fd = openSync(path, "r");
    try {
      const head = Buffer.alloc(2);
      readSync(fd, head, 0, 2, 0);
      return head.toString("latin1") === "#!" ? "dev" : "prod";
    } finally {
      closeSync(fd);
    }
  } catch {
    return "prod";
  }
}
