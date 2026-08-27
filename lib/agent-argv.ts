/**
 * lib/agent-argv.ts ... pure claude/cswap invocation building for `rt agent`.
 *
 * Session uuids are validated here because the claude CLI fails soft:
 * `--session-id ""` is silently ignored (random id minted) and
 * `-p --resume ""` silently resumes the most recent session in cwd
 * (spike 2026-08-25). Headless without a prompt blocks on stdin, so it is
 * refused at build time.
 *
 * Two output shapes: argv arrays for daemon-side Bun.spawn (absolute bins ...
 * executable lookup uses the process-start PATH), and a single shell string
 * for `herdr pane run` (bare names ... the pane shell carries the login PATH).
 */

import { homedir } from "os";
import { join } from "path";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidSessionUuid(s: string): boolean {
  return UUID_RE.test(s);
}

export function shellSingleQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

export interface ClaudeInvocation {
  account?: string;
  model?: string;
  effort?: string;
  extraArgs?: string;
  session: { kind: "start"; sessionId: string } | { kind: "resume"; sessionId: string };
  headless: boolean;
  prompt?: string;
}

export function resolveClaudeBin(): string {
  return Bun.which("claude") ?? join(process.env.HOME ?? homedir(), ".local", "bin", "claude");
}

export function resolveCswapBin(): string {
  return Bun.which("cswap") ?? join(process.env.HOME ?? homedir(), ".local", "bin", "cswap");
}

function claudeArgs(inv: ClaudeInvocation): string[] {
  if (!isValidSessionUuid(inv.session.sessionId)) {
    throw new Error(`invalid session uuid "${inv.session.sessionId}" ... refusing to spawn`);
  }
  if (inv.headless && !inv.prompt) {
    throw new Error("headless launch requires a prompt (claude -p with no prompt blocks on stdin)");
  }
  const args: string[] = [];
  if (inv.headless) args.push("-p", "--output-format", "json");
  if (inv.model) args.push("--model", inv.model);
  if (inv.effort) args.push("--effort", inv.effort);
  if (inv.session.kind === "start") args.push("--session-id", inv.session.sessionId);
  else args.push("--resume", inv.session.sessionId);
  if (inv.extraArgs) args.push(...inv.extraArgs.split(/\s+/).filter(Boolean));
  if (inv.prompt) args.push(inv.prompt);
  return args;
}

export function buildClaudeArgv(inv: ClaudeInvocation, bins?: { claude?: string; cswap?: string }): string[] {
  const args = claudeArgs(inv);
  // claude args live only after "--"; the literal word "claude" is never
  // among them since cswap runs claude itself.
  if (inv.account) return [bins?.cswap ?? resolveCswapBin(), "run", inv.account, "--", ...args];
  return [bins?.claude ?? resolveClaudeBin(), ...args];
}

export function buildPaneCommand(cwd: string, inv: ClaudeInvocation): string {
  // Every token is single-quoted, including flag names (no allowlist), so a
  // prompt equal to a flag like "-p" is still treated as data.
  const quoted = claudeArgs(inv).map(shellSingleQuote);
  const head = inv.account ? `cswap run ${shellSingleQuote(inv.account)} --` : "claude";
  return `cd ${shellSingleQuote(cwd)} && ${[head, ...quoted].join(" ")}`;
}
