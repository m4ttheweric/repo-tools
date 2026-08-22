/**
 * fzf is a hard dependency of rt: every interactive picker (run, nav, commit,
 * …) shells out to it, and nothing installs it for the user. If it is missing
 * — never installed, or reaped by `brew autoremove`/`brew cleanup` — we want a
 * single, actionable error rather than silently degrading to a non-fuzzy
 * picker or crashing with an opaque spawn ENOENT. Every fzf spawn site calls
 * ensureFzf() before spawning, except `rt skills surface`'s bare palette:
 * that one deliberately soft-falls-back to printing the static list instead
 * of erroring, since the same config-write path is also reachable via
 * `rt skills surface set`.
 *
 * rt prefers the fzf bundled inside mattstack.app by absolute path and only
 * falls back to PATH when it is not running from an install (source
 * checkout, dev mode).
 */
import { bundledHelperPath } from "./bundle-layout.ts";
import { bold, dim, yellow, reset } from "./tui.ts";

type Which = (bin: string) => string | null;
type Bundled = () => string | null;
const defaultWhich: Which = (b) => Bun.which(b);
// bundledHelperPath throws on a mislabeled "buildtool" row; a bad deps.lock
// entry must degrade to the PATH fallback here, not crash every picker spawn.
const defaultBundled: Bundled = () => {
  try {
    return bundledHelperPath("fzf");
  } catch {
    return null;
  }
};

/** Resolve the fzf binary path: bundled inside mattstack.app first, then PATH; null if neither. Injectable for tests. */
export function resolveFzf(which: Which = defaultWhich, bundled: Bundled = defaultBundled): string | null {
  return bundled() ?? which("fzf");
}

/** Shown when fzf is missing. Exported for reuse and tests. */
export const FZF_MISSING_MESSAGE =
  `\n  ${yellow}fzf not found${reset}\n` +
  `  ${dim}rt uses the fzf inside mattstack.app (Contents/Helpers/fzf) and found neither it nor an fzf on PATH.${reset}\n` +
  `  ${dim}Reinstall mattstack.app, or${reset} ${bold}brew install fzf${reset}${dim} to use your own copy, then re-run.${reset}\n`;

/**
 * Ensure fzf is available before spawning it. Returns the resolved path when
 * present; prints FZF_MISSING_MESSAGE and exits(1) when absent.
 *
 * `which`, `fail`, and `bundled` are injectable so the missing-binary path
 * can be unit tested without terminating the test process or resolving the
 * real /Applications.
 */
export function ensureFzf(
  which: Which = defaultWhich,
  fail: (msg: string) => never = (msg) => {
    console.error(msg);
    process.exit(1);
  },
  bundled: Bundled = defaultBundled,
): string {
  const path = resolveFzf(which, bundled);
  if (path) return path;
  return fail(FZF_MISSING_MESSAGE);
}
