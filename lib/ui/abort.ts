/**
 * One "aborted" line every picker surface prints on esc/cancel-to-shell, so
 * the surfaces (commit, run, nav, cd, skills) stop disagreeing about whether
 * cancelling a flow says anything. TTY-only: a non-interactive caller
 * (--json, RT_BATCH, a piped stderr) never sees decoration mixed into its
 * output.
 */
import { dim, reset } from "../ansi.ts";

export function printAborted(): void {
  if (!process.stderr.isTTY || process.env.RT_BATCH) return;
  process.stderr.write(`\n  ${dim}aborted${reset}\n\n`);
}
