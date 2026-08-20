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

import { existsSync } from "fs";

// Deliberately module-load-time (matches the pre-move behavior): the bun test
// preload (test-setup.ts) repoints HOME before any module loads, so this
// still lands in the per-test throwaway tree.
const DEV_MODE_WRAPPER = `${Bun.env.HOME}/.local/bin/rt`;

export function currentMode(): "dev" | "prod" {
  return existsSync(DEV_MODE_WRAPPER) ? "dev" : "prod";
}
