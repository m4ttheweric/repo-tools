/**
 * fzf is a hard dependency of rt. The Homebrew formula installs it alongside
 * rt, and every interactive picker (run, nav, commit, branch, …) shells out to
 * it. If it goes missing — e.g. `brew autoremove`/`brew cleanup` reaps it while
 * installing an unrelated formula — we want a single, actionable error rather
 * than silently degrading to a non-fuzzy picker or crashing with an opaque
 * spawn ENOENT. Every fzf spawn site calls ensureFzf() before spawning.
 */
import { bold, dim, yellow, reset } from "./tui.ts";

type Which = (bin: string) => string | null;
const defaultWhich: Which = (b) => Bun.which(b);

/** Resolve the fzf binary path, or null if it isn't on PATH. Injectable for tests. */
export function resolveFzf(which: Which = defaultWhich): string | null {
  return which("fzf");
}

/** Shown when fzf is missing. Exported for reuse and tests. */
export const FZF_MISSING_MESSAGE =
  `\n  ${yellow}fzf not found on PATH${reset}\n` +
  `  ${dim}rt uses fzf for its interactive pickers — it's a hard dependency.${reset}\n` +
  `  ${dim}Reinstall it with${reset} ${bold}brew install fzf${reset}${dim}, then re-run.${reset}\n`;

/**
 * Ensure fzf is available before spawning it. Returns the resolved path when
 * present; prints FZF_MISSING_MESSAGE and exits(1) when absent.
 *
 * `which` and `fail` are injectable so the missing-binary path can be unit
 * tested without terminating the test process.
 */
export function ensureFzf(
  which: Which = defaultWhich,
  fail: (msg: string) => never = (msg) => {
    console.error(msg);
    process.exit(1);
  },
): string {
  const path = resolveFzf(which);
  if (path) return path;
  return fail(FZF_MISSING_MESSAGE);
}
