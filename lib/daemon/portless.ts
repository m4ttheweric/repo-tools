/**
 * portless integration helpers. We drive portless purely via the CLI (repo
 * stealth; no portless.json in the repo). `portless run <cmd>` infers the app
 * name from the cwd's package.json/git root and applies its worktree-subdomain
 * logic automatically.
 */

/** Wrap a shell command so it runs through the portless proxy. */
export function buildPortlessCommand(inner: string): string {
  return `portless run ${inner}`;
}

/** Whether the portless binary is resolvable on PATH. */
export function portlessAvailable(which: (bin: string) => string | null = (b) => Bun.which(b)): boolean {
  return which("portless") !== null;
}
