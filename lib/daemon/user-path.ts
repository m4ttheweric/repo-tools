/**
 * Resolve the user's full PATH once at daemon startup.
 *
 * Strategy: use `$SHELL -ilc` (interactive login). Sources .zprofile AND
 * .zshrc, which is where most users actually put their PATH exports
 * (bun, ~/.local/bin, etc.). Slower than `-lc` due to compinit/OMZ, but
 * the daemon is long-running so the one-time cost is irrelevant.
 * Then layer in an explicit NVM resolution so nvm-managed tools (node, pnpm,
 * etc.) are included regardless of how the daemon was launched.
 */

import { execSync } from "child_process";
import type { Logger } from "pino";

/** Which of `names` is a non-empty file on `pathValue`, keyed `has<Name>`. */
export function probeTools(pathValue: string, names: string[]): Record<string, boolean> {
  const entries = pathValue.split(":").filter((p) => p.length > 0);
  const probed: Record<string, boolean> = {};
  for (const name of names) {
    probed[`has${name[0]!.toUpperCase()}${name.slice(1)}`] = entries.some((p) => {
      try {
        return Bun.file(`${p}/${name}`).size > 0;
      } catch {
        return false;
      }
    });
  }
  return probed;
}

export function resolveUserPath(log: Logger): string {
  const shell = process.env.SHELL ?? "/bin/zsh";
  let resolvedPath = process.env.PATH ?? ""; // baseline

  // 1. Interactive login shell — sources both .zprofile and .zshrc.
  try {
    resolvedPath = execSync(`${shell} -ilc 'echo $PATH' 2>/dev/null`, {
      encoding: "utf8",
      timeout: 30000,
    }).trim() || resolvedPath;
  } catch { /* timeout or shell error — keep baseline */ }

  // 2. Explicit NVM: source nvm.sh on top of the already-resolved PATH so
  //    NVM prepends its bin dirs without losing Homebrew/login-shell entries.
  try {
    const nvmDir = process.env.NVM_DIR ?? `${process.env.HOME}/.nvm`;
    const nvmScript = `${nvmDir}/nvm.sh`;
    const nvmPath = execSync(
      `[ -s "${nvmScript}" ] && export PATH="${resolvedPath}" && . "${nvmScript}" && echo $PATH`,
      { encoding: "utf8", timeout: 5000, shell: "/bin/zsh" },
    ).trim();
    if (nvmPath) resolvedPath = nvmPath;
  } catch { /* nvm not installed or failed */ }

  // Log so we can verify key tools are present after restarts
  const pathEntries = resolvedPath.split(":");
  log.info(
    { entries: pathEntries.length, ...probeTools(resolvedPath, ["node", "pnpm", "doppler"]) },
    "PATH resolved",
  );

  return resolvedPath;
}
