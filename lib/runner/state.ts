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
  url: string | null;
  // Internal only, never sent to the board (see toModel): a url seen on the
  // previous scan but not yet confirmed by a second, matching scan.
  urlPending: string | null;
  tail: BoardTailLine[] | null;
}

export function newEntry(seq: number, name: string, command: string, cwd: string, pkg: string, repo: string): Entry {
  return { id: `e${seq}`, name, command, cwd, pkg, repo, tabId: null, paneId: null, state: "starting", startedAt: null, exitCode: null, error: null, url: null, urlPending: null, tail: null };
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

// The output of the current run only: everything after the most recent exit
// sentinel. A restart leaves the prior run's URL banner in the pane, and
// scanning it would re-latch the old port.
export function afterLastSentinel(text: string): string {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (SENTINEL_RE.test(lines[i]!)) return lines.slice(i + 1).join("\n");
  }
  return text;
}

// A loopback/LAN dev-server URL, port required. Non-loopback hosts (real
// domains in doc links) never match; 0.0.0.0 is rewritten to localhost
// because browsers do not reliably route it.
const URL_RE = /https?:\/\/(\[::1\]|[a-zA-Z0-9.\-]+):(\d+)(\/[^\s'"()]*)?/g;
const LOOPBACK_HOST =
  /^(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})$/;

// Returns the LAST (most-recent) loopback URL, localhost/127 preferred over
// a LAN address over 0.0.0.0: a server logs its dependency/config URLs first
// and announces its own real URL last, so the most recent match in a given
// preference tier is the one to trust.
export function detectUrl(text: string): string | null {
  const hits: { host: string; url: string }[] = [];
  for (const m of text.matchAll(URL_RE)) {
    const host = m[1]!;
    if (!LOOPBACK_HOST.test(host)) continue;
    hits.push({ host, url: m[0]! });
  }
  if (hits.length === 0) return null;
  const last = (pred: (h: { host: string }) => boolean) => {
    for (let i = hits.length - 1; i >= 0; i--) if (pred(hits[i]!)) return hits[i]!;
    return undefined;
  };
  const pick =
    last((h) => h.host === "localhost" || h.host === "127.0.0.1") ??
    last((h) => h.host === "0.0.0.0") ??
    hits[hits.length - 1]!;
  return pick.url.replace(/[.,;:!?]+$/, "").replace("://0.0.0.0", "://localhost");
}

const PROMPT_RE = /[$%❯>]\s*$/;

export function filterTail(text: string): BoardTailLine[] {
  const lines = text.split("\n").filter((l) => !SENTINEL_RE.test(l));
  // The sentinel's leading newline leaves a blank above the prompt; strip
  // blanks, the prompt, then blanks again until nothing changes.
  let n = -1;
  while (n !== lines.length) {
    n = lines.length;
    while (lines.length && lines[lines.length - 1]!.trim() === "") lines.pop();
    if (lines.length && PROMPT_RE.test(lines[lines.length - 1]!)) lines.pop();
  }
  return lines.map((text) => ({ text }));
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
      url: e.url,
      tail: e.tail,
    })),
  };
}
