/**
 * How `rt chat sign-in` titles the Claude Code session after the chat
 * handle it was just assigned, so the pane, the `--resume` picker and the
 * buddy list all agree (`fred`, or `board review · fred` when the user had
 * already named the pane; see chat-title.ts).
 *
 * Only the session being signed in may be renamed, and only from inside
 * it: the gate is `CLAUDE_CODE_SESSION_ID` (exported into every Bash tool
 * call) matching the session id sign-in resolved. A `--session` passed
 * from anywhere else, tests included, never spawns anything.
 *
 * Inside a herdr pane the rename is typed into that pane as `/rename
 * <title>` and submits when the agent's turn ends, which is what updates
 * the live title. Anywhere else `claude -p --resume` appends the rename to
 * the transcript, which reaches the picker but not a running pane's title.
 */
export type RenamePlan = { via: "herdr" | "claude"; argv: string[] };

export function planSessionRename(args: {
  title: string;
  sessionId: string;
  env: Record<string, string | undefined>;
  disabled: boolean;
}): RenamePlan | null {
  if (args.disabled) return null;
  if (!args.env.CLAUDE_CODE_SESSION_ID || args.env.CLAUDE_CODE_SESSION_ID !== args.sessionId) return null;
  const pane = args.env.HERDR_PANE_ID;
  if (pane) return { via: "herdr", argv: ["herdr", "pane", "run", pane, `/rename ${args.title}`] };
  return { via: "claude", argv: ["claude", "-p", "--resume", args.sessionId, `/rename ${args.title}`] };
}
