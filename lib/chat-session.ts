/**
 * The chat session file — the local record of a signed-in session's assigned
 * handle. `rt chat sign-in` writes it; every other verb's handle resolution
 * reads it as position 0 (ahead of `--as`); `rt chat sign-out` deletes it.
 *
 * Lives at ~/.mattstack/rt/chat/sessions/<session-id>.json, one file per
 * session so a stale or foreign id can never resolve to someone else's
 * handle — readChatSession enforces that by checking the file's own
 * sessionId against the one asked for, not just trusting the filename.
 */
import { unlinkSync } from "fs";
import { join } from "path";
import { readJson, writeJson } from "./json-store.ts";
import { rtDir } from "./rt-paths.ts";

export interface ChatSession {
  sessionId: string;
  handle: string;
  baseHandle: string;
  signedInAt: number;
  room?: string;
  lastCwd?: string;
  lastBranchReadAt?: number;
}

function sessionsDir(): string {
  return join(rtDir(), "chat", "sessions");
}

const VALID_SESSION_ID = /^[A-Za-z0-9._-]+$/;

/** Whether `id` is safe as a session filename component — rejects `/`, `..`, and anything else path-traversal could use. */
export function isValidSessionId(id: string): boolean {
  return VALID_SESSION_ID.test(id);
}

export function sessionFilePath(sessionId: string): string {
  if (!isValidSessionId(sessionId)) {
    throw new Error(`invalid session id "${sessionId}" — must match ${VALID_SESSION_ID}`);
  }
  return join(sessionsDir(), `${sessionId}.json`);
}

/**
 * Null on absence, on a session-id mismatch (a copied ~/.mattstack or a
 * session resumed under a new id must never resolve to a stale handle that
 * was never established for the id in hand), on an invalid id (path
 * traversal — treated as "no session", not an error, since every read-only
 * verb runs this on whatever `--session`/CLAUDE_CODE_SESSION_ID happens to
 * contain), and on a non-string `handle` (a corrupt file's `undefined` must
 * never coerce into the literal pidfile-path segment `"undefined"`).
 */
export function readChatSession(sessionId: string | undefined): ChatSession | null {
  if (!sessionId) return null;
  let path: string;
  try {
    path = sessionFilePath(sessionId);
  } catch {
    return null;
  }
  const session = readJson<ChatSession | null>(path, null);
  if (!session || session.sessionId !== sessionId || typeof session.handle !== "string") return null;
  return session;
}

export function writeChatSession(s: ChatSession): void {
  writeJson(sessionFilePath(s.sessionId), s);
}

export function deleteChatSession(sessionId: string): void {
  try {
    unlinkSync(sessionFilePath(sessionId));
  } catch {
    // already gone, or an invalid id — nothing to remove either way
  }
}

/**
 * `--session <id>` (the documented path for a process with no environment
 * variable) else `CLAUDE_CODE_SESSION_ID` (present in every Claude Code
 * session on this machine but undocumented — the CLI's own Bash calls rely
 * on it, `--session` stays the supported override for everything else).
 */
export function currentSessionId(args: string[]): string | undefined {
  const i = args.indexOf("--session");
  const value = i >= 0 ? args[i + 1] : undefined;
  // A value slot that is itself a flag means --session was given no value
  // (e.g. `--session --no-room`) — treat it as missing rather than signing
  // in as the literal next flag's name.
  if (value !== undefined && !value.startsWith("--")) return value;
  return process.env.CLAUDE_CODE_SESSION_ID || undefined;
}
