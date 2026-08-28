/**
 * What `rt chat sign-in` titles the Claude Code session. rt's own rename
 * must never erase a title the user typed: a user title is kept and the
 * handle appended (`board review · kai`), so the pane still reads the way
 * they named it and still says which handle chat knows it by.
 *
 * "The user's" is decided by elimination. A title that is handle-like (the
 * handle rt assigned this session before, or any pool name, since a
 * signed-out session's file is gone but its `/rename` is still in the
 * transcript) is rt's own; so is the handle-like tail of a composite rt
 * wrote before. Anything left after that is the user's label.
 */
import { existsSync, readdirSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { AGENT_NAMES, baseOfHandle } from "./chat-names.ts";
import { isValidSessionId } from "./chat-session.ts";

export const TITLE_SEPARATOR = " · ";

export interface PriorTitleContext {
  handle: string;
}

export function composeSessionTitle(args: { customTitle: string | null; prior: PriorTitleContext | null; handle: string }): string {
  const { customTitle, prior, handle } = args;
  if (!customTitle) return handle;
  const isHandleLike = (s: string): boolean => s === handle || s === prior?.handle || AGENT_NAMES.includes(baseOfHandle(s));

  let label = customTitle.trim();
  const at = label.lastIndexOf(TITLE_SEPARATOR);
  if (at >= 0 && isHandleLike(label.slice(at + TITLE_SEPARATOR.length))) label = label.slice(0, at).trim();

  if (!label || isHandleLike(label)) return handle;
  return `${label}${TITLE_SEPARATOR}${handle}`;
}

export function claudeConfigDir(env: Record<string, string | undefined> = process.env): string {
  return env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
}

/**
 * The last `/rename` of a session, from its transcript under
 * `<configDir>/projects/<project>/<sessionId>.jsonl`. Every project dir is
 * probed rather than deriving the project slug from cwd: session ids are
 * unique, and the session may have started in a different directory.
 */
export function readSessionCustomTitle(sessionId: string, configDir: string): string | null {
  if (!isValidSessionId(sessionId)) return null;
  const projects = join(configDir, "projects");
  let dirs: string[];
  try {
    dirs = readdirSync(projects);
  } catch {
    return null;
  }
  for (const dir of dirs) {
    const file = join(projects, dir, `${sessionId}.jsonl`);
    if (!existsSync(file)) continue;
    try {
      return lastCustomTitle(readFileSync(file, "utf8"));
    } catch {
      return null;
    }
  }
  return null;
}

/** Scans backwards from the last occurrence of the marker; a message body that merely quotes the marker parses as some other entry type and is skipped. */
function lastCustomTitle(text: string): string | null {
  const marker = '"custom-title"';
  let at = text.lastIndexOf(marker);
  while (at >= 0) {
    const start = text.lastIndexOf("\n", at) + 1;
    const end = text.indexOf("\n", at);
    const line = text.slice(start, end < 0 ? undefined : end);
    try {
      const entry = JSON.parse(line) as { type?: unknown; customTitle?: unknown };
      if (entry.type === "custom-title" && typeof entry.customTitle === "string") return entry.customTitle;
    } catch {
      // a truncated or non-JSON line: keep scanning
    }
    at = start > 0 ? text.lastIndexOf(marker, start - 1) : -1;
  }
  return null;
}
