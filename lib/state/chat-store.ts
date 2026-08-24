/**
 * lib/state/chat-store.ts — rooms, members, and (Task 3+) messages for
 * `rt chat`.
 *
 * The only module that touches chat_rooms/chat_members/chat_messages:
 * rooms, members, and messages live in one file because posting a message
 * reads membership inside the same transaction that writes it.
 */

import { Database } from "bun:sqlite";
import { getStateDb } from "./db.ts";

export type WakeMode = "mention" | "all" | "none";

export interface ChatMember {
  room: string;
  handle: string;
  joinedAt: number;
  lastReadId: number;
  wakeOn: WakeMode;
  lastSeenAt?: number;
  armedAt?: number;
  cwd?: string;
  pane?: string;
}

export interface RoomSummary {
  room: string;
  memberCount: number;
  unread: number;
  mentions: number;
  lastPostedAt?: number;
}

interface MemberRow {
  room: string;
  handle: string;
  joined_at: number;
  last_read_id: number;
  wake_on: WakeMode;
  last_seen_at: number | null;
  armed_at: number | null;
  cwd: string | null;
  pane: string | null;
}

function rowToMember(row: MemberRow): ChatMember {
  const member: ChatMember = {
    room: row.room,
    handle: row.handle,
    joinedAt: row.joined_at,
    lastReadId: row.last_read_id,
    wakeOn: row.wake_on,
  };
  if (row.last_seen_at !== null) member.lastSeenAt = row.last_seen_at;
  if (row.armed_at !== null) member.armedAt = row.armed_at;
  if (row.cwd !== null) member.cwd = row.cwd;
  if (row.pane !== null) member.pane = row.pane;
  return member;
}

/** Escapes SQLite LIKE wildcards so a handle containing `_` or `%` can't match beyond itself. */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, "\\$&");
}

const MEMBER_COLUMNS = "room, handle, joined_at, last_read_id, wake_on, last_seen_at, armed_at, cwd, pane";
const SELECT_ROOM_MEMBER_SQL = `SELECT ${MEMBER_COLUMNS} FROM chat_members WHERE room = ? AND handle = ?;`;
const SELECT_ROOM_MEMBERS_SQL = `SELECT ${MEMBER_COLUMNS} FROM chat_members WHERE room = ? ORDER BY handle;`;
const SELECT_HANDLE_MEMBERSHIPS_SQL = `SELECT ${MEMBER_COLUMNS} FROM chat_members WHERE handle = ? ORDER BY room;`;
const SELECT_ROOM_MEMBER_COUNT_SQL = `SELECT COUNT(*) AS n FROM chat_members WHERE room = ?;`;
const SELECT_ROOM_MAX_ID_SQL = `SELECT COALESCE(MAX(id), 0) AS maxId FROM chat_messages WHERE room = ?;`;
const SELECT_ROOM_LAST_POSTED_SQL = `SELECT MAX(posted_at) AS lastPostedAt FROM chat_messages WHERE room = ?;`;
const SELECT_ROOM_UNREAD_SQL = `SELECT COUNT(*) AS n FROM chat_messages WHERE room = ? AND id > ?;`;
const SELECT_ROOM_UNREAD_MENTIONS_SQL = `SELECT COUNT(*) AS n FROM chat_messages WHERE room = ? AND id > ? AND mentions LIKE ? ESCAPE '\\';`;
const UPSERT_ROOM_SQL = `INSERT INTO chat_rooms (name, created_at) VALUES (?, ?) ON CONFLICT(name) DO NOTHING;`;
const INSERT_MEMBER_SQL = `INSERT INTO chat_members (room, handle, joined_at, last_read_id, wake_on, cwd, pane) VALUES (?, ?, ?, ?, ?, ?, ?);`;
const DELETE_MEMBER_SQL = `DELETE FROM chat_members WHERE room = ? AND handle = ?;`;

// `@` is strictly the mention sigil and `/` would reshape chat/wake/<handle>
// into a nested topic glob, so both are excluded even though the rest of
// [a-z0-9._-] is otherwise permissive.
export function isValidChatName(name: string): boolean {
  return /^[a-z0-9._-]+$/.test(name);
}

/**
 * Refuses a colliding handle rather than suffixing it. The suffix is only
 * reachable from inside this function, while `tail`/`post`/`read` each
 * resolve the same handle independently and can only produce the
 * unsuffixed base — a suffixed join would desync the joined handle from
 * the one its tail arms on and its posts travel as.
 */
export function joinRoom(
  args: { room: string; handle: string; wakeOn?: WakeMode; cwd?: string; pane?: string },
  db: Database = getStateDb(),
): { handle: string; memberCount: number; unread: number } {
  const { room, handle, wakeOn = "mention", cwd, pane } = args;
  const argCwd = cwd ?? null;

  const run = db.transaction(() => {
    const now = Date.now();
    db.query(UPSERT_ROOM_SQL).run(room, now);

    const maxId = (db.query(SELECT_ROOM_MAX_ID_SQL).get(room) as { maxId: number }).maxId;
    const existing = db.query(SELECT_ROOM_MEMBER_SQL).get(room, handle) as MemberRow | null;

    let lastReadId: number;
    if (existing) {
      if (existing.cwd !== argCwd) {
        throw new Error(
          `chat: handle "${handle}" is already in #${room} from a different directory — pass --as <handle> to join under another name`,
        );
      }
      lastReadId = existing.last_read_id;
    } else {
      lastReadId = maxId;
      db.query(INSERT_MEMBER_SQL).run(room, handle, now, lastReadId, wakeOn, argCwd, pane ?? null);
    }

    const memberCount = (db.query(SELECT_ROOM_MEMBER_COUNT_SQL).get(room) as { n: number }).n;
    return { handle, memberCount, unread: Math.max(0, maxId - lastReadId) };
  });

  return run();
}

export function leaveRoom(room: string, handle: string, db: Database = getStateDb()): void {
  db.query(DELETE_MEMBER_SQL).run(room, handle);
}

export function listRooms(handle: string, db: Database = getStateDb()): RoomSummary[] {
  const rows = db.query(SELECT_HANDLE_MEMBERSHIPS_SQL).all(handle) as MemberRow[];
  return rows.map((row) => {
    const memberCount = (db.query(SELECT_ROOM_MEMBER_COUNT_SQL).get(row.room) as { n: number }).n;
    const unread = (db.query(SELECT_ROOM_UNREAD_SQL).get(row.room, row.last_read_id) as { n: number }).n;
    const mentions = (
      db.query(SELECT_ROOM_UNREAD_MENTIONS_SQL).get(row.room, row.last_read_id, `%"${escapeLike(handle)}"%`) as { n: number }
    ).n;
    const lastPosted = (db.query(SELECT_ROOM_LAST_POSTED_SQL).get(row.room) as { lastPostedAt: number | null }).lastPostedAt;

    const summary: RoomSummary = { room: row.room, memberCount, unread, mentions };
    if (lastPosted !== null) summary.lastPostedAt = lastPosted;
    return summary;
  });
}

export function listMembers(room: string, db: Database = getStateDb()): ChatMember[] {
  const rows = db.query(SELECT_ROOM_MEMBERS_SQL).all(room) as MemberRow[];
  return rows.map(rowToMember);
}
