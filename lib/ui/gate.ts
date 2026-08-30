/**
 * The one gate every rt-ui spawn passes. Steps and prompts both paint on
 * /dev/tty, which is the developer's terminal whether or not the caller is
 * driving it: off a TTY, or under RT_BATCH, nothing may be spawned at all.
 * The swappable seam exists because bun test's own stdin is never a TTY, so a
 * test that wants the interactive path has to say so.
 */
export function realInteractive(): boolean {
  return Boolean(process.stdin.isTTY) && !process.env.RT_BATCH;
}

let gate: () => boolean = realInteractive;

export function interactive(): boolean {
  return gate();
}

export const __test__ = {
  setInteractive(fn: (() => boolean) | undefined): void {
    gate = fn ?? realInteractive;
  },
  interactive,
};
