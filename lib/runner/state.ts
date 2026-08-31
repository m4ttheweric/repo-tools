/**
 * Pure state for the runner: what an entry is, how a pane's process info and
 * text turn into a board state, and the wire model. No I/O here.
 */
import type { BoardModel, BoardState, BoardTailLine } from "../ui/protocol.ts";
import { EXIT_SENTINEL, type ProcessInfo } from "./engine.ts";

export interface Entry {
  id: string;
  name: string;
  command: string;
  cwd: string;
  pkg: string;
  repo: string;
  tabId: string | null;
  paneId: string | null;
  state: BoardState;
  startedAt: Date | null;
  exitCode: number | null;
  error: string | null;
  tail: BoardTailLine[] | null;
}

export function newEntry(seq: number, name: string, command: string, cwd: string, pkg: string, repo: string): Entry {
  return { id: `e${seq}`, name, command, cwd, pkg, repo, tabId: null, paneId: null, state: "starting", startedAt: null, exitCode: null, error: null, tail: null };
}

/** A pane is running a command when its foreground process group is not the shell's own. */
export function isRunning(info: ProcessInfo): boolean {
  return info.foregroundPgid !== null && info.shellPid !== null && info.foregroundPgid !== info.shellPid;
}

const SENTINEL_RE = new RegExp(`^${EXIT_SENTINEL} (\\d+)\\s*$`);

export function parseExitSentinel(text: string): number | null {
  let code: number | null = null;
  for (const line of text.split("\n")) {
    const m = SENTINEL_RE.exec(line);
    if (m) code = Number(m[1]);
  }
  return code;
}

const PROMPT_RE = /[$%❯>]\s*$/;

function stamp(now: Date): string {
  return now.toTimeString().slice(0, 8);
}

export function filterTail(text: string, now: Date = new Date()): BoardTailLine[] {
  const lines = text.split("\n").filter((l) => !SENTINEL_RE.test(l));
  // The sentinel's leading newline leaves a blank above the prompt; strip
  // blanks, the prompt, then blanks again until nothing changes.
  let n = -1;
  while (n !== lines.length) {
    n = lines.length;
    while (lines.length && lines[lines.length - 1]!.trim() === "") lines.pop();
    if (lines.length && PROMPT_RE.test(lines[lines.length - 1]!)) lines.pop();
  }
  const ts = stamp(now);
  return lines.map((text) => ({ ts, text }));
}

/**
 * The optimistic states hold until the pane proves otherwise: a starting
 * entry stays starting until the command owns the foreground, a stopping one
 * until the shell has it back.
 */
export function deriveState(entry: Entry, info: ProcessInfo, paneText: string): Pick<Entry, "state" | "exitCode"> {
  if (isRunning(info)) return { state: "running", exitCode: null };
  const code = parseExitSentinel(paneText);
  if (code === null) {
    if (entry.state === "starting" || entry.state === "stopping") return { state: entry.state, exitCode: null };
    return { state: "stopped", exitCode: null };
  }
  if (code === 0 || code === 130) return { state: "stopped", exitCode: code };
  return { state: "crashed", exitCode: code };
}

export function toModel(workspace: string, entries: Entry[]): BoardModel {
  return {
    workspace,
    entries: entries.map((e) => ({
      id: e.id,
      name: e.name,
      command: e.command,
      pkg: e.pkg,
      repo: e.repo,
      state: e.state,
      startedAt: e.startedAt ? e.startedAt.toISOString() : null,
      exitCode: e.exitCode,
      error: e.error,
      tail: e.tail,
    })),
  };
}
