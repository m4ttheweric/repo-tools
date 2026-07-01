/**
 * Remedy banner strings emitted into a process's PTY stream when a remedy
 * matches and when its fix completes.
 *
 * A single blank line is emitted above and below each banner so it stands out
 * from the surrounding stack traces. The match banner is broken across three
 * lines (title + pattern + running) because a single long line wraps awkwardly
 * in narrow panes and is hard to scan at a glance.
 */

const ANSI_RESET  = "\x1b[0m";
const ANSI_YELLOW = "\x1b[1;33m"; // matched
const ANSI_GREEN  = "\x1b[1;32m"; // ✓ fix succeeded
const ANSI_RED    = "\x1b[1;31m"; // ✗ fix failed
const ANSI_DIM    = "\x1b[2m";    // label gutter

export function matchBanner(name: string, pattern: string, cmd: string): string {
  return (
    `\r\n\r\n` +
    `${ANSI_YELLOW}▸ rt remedy matched: ${name}${ANSI_RESET}\r\n` +
    `${ANSI_DIM}    pattern:${ANSI_RESET}  ${pattern}\r\n` +
    `${ANSI_DIM}    running:${ANSI_RESET}  ${cmd}\r\n` +
    `\r\n`
  );
}

export function fireBanner(name: string, success: boolean, willRestart: boolean): string {
  const color = success ? ANSI_GREEN : ANSI_RED;
  const mark  = success ? "✓" : "✗";
  const tail  = success
    ? (willRestart ? "fix succeeded — restarting process" : "fix succeeded")
    : "fix failed";
  return (
    `\r\n` +
    `${color}▸ rt remedy ${mark} ${name} — ${tail}${ANSI_RESET}\r\n` +
    `\r\n\r\n`
  );
}
