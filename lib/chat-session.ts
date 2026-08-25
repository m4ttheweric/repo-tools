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

export function sessionFilePath(sessionId: string): string {
  return join(sessionsDir(), `${sessionId}.json`);
}

/**
 * Null on absence AND on a session-id mismatch — a copied ~/.mattstack or a
 * session resumed under a new id must never resolve to a stale handle that
 * was never established for the id in hand.
 */
export function readChatSession(sessionId: string | undefined): ChatSession | null {
  if (!sessionId) return null;
  const session = readJson<ChatSession | null>(sessionFilePath(sessionId), null);
  if (!session || session.sessionId !== sessionId) return null;
  return session;
}

export function writeChatSession(s: ChatSession): void {
  writeJson(sessionFilePath(s.sessionId), s);
}

export function deleteChatSession(sessionId: string): void {
  try {
    unlinkSync(sessionFilePath(sessionId));
  } catch {
    // already gone
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
  if (i >= 0 && args[i + 1] !== undefined) return args[i + 1];
  return process.env.CLAUDE_CODE_SESSION_ID || undefined;
}
