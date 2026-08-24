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
import { runCriticalWrite } from "./busy.ts";

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

export interface ChatMessage {
  id: number;
  room: string;
  handle: string;
  body: string;
  mentions: string[];
  replyTo?: number;
  postedAt: number;
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

interface MessageRow {
  id: number;
  room: string;
  handle: string;
  body: string;
  mentions: string | null;
  reply_to: number | null;
  posted_at: number;
}

function rowToMessage(row: MessageRow): ChatMessage {
  const message: ChatMessage = {
    id: row.id,
    room: row.room,
    handle: row.handle,
    body: row.body,
    mentions: row.mentions ? (JSON.parse(row.mentions) as string[]) : [],
    postedAt: row.posted_at,
  };
  if (row.reply_to !== null) message.replyTo = row.reply_to;
  return message;
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
const UPDATE_LAST_READ_SQL = `UPDATE chat_members SET last_read_id = ? WHERE room = ? AND handle = ?;`;

const MESSAGE_COLUMNS = "id, room, handle, body, mentions, reply_to, posted_at";
const INSERT_MESSAGE_SQL = `INSERT INTO chat_messages (room, handle, body, mentions, reply_to, posted_at) VALUES (?, ?, ?, ?, ?, ?);`;
const SELECT_UNREAD_SQL = `SELECT ${MESSAGE_COLUMNS} FROM chat_messages WHERE room = ? AND id > ? ORDER BY id ASC LIMIT ?;`;
const SELECT_UNREAD_SINCE_SQL = `SELECT ${MESSAGE_COLUMNS} FROM chat_messages WHERE room = ? AND id > ? AND posted_at >= ? ORDER BY id ASC LIMIT ?;`;
const SELECT_UNREAD_ALL_SQL = `SELECT ${MESSAGE_COLUMNS} FROM chat_messages WHERE room = ? AND id > ? ORDER BY id ASC;`;
const SELECT_MESSAGES_SQL = `SELECT ${MESSAGE_COLUMNS} FROM chat_messages WHERE room = ? ORDER BY id DESC LIMIT ?;`;
const SELECT_MESSAGES_BEFORE_SQL = `SELECT ${MESSAGE_COLUMNS} FROM chat_messages WHERE room = ? AND id < ? ORDER BY id DESC LIMIT ?;`;

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

function getRoomMaxId(room: string, db: Database): number {
  return (db.query(SELECT_ROOM_MAX_ID_SQL).get(room) as { maxId: number }).maxId;
}

/**
 * A `last_read_id` above the room's current max can only mean a recreated
 * `state.db` (ids only grow within one generation); left unclamped it makes
 * every future read return nothing forever, indistinguishable from a hung
 * agent that never wakes.
 */
function clampCursor(member: MemberRow, maxId: number, db: Database): number {
  if (member.last_read_id <= maxId) return member.last_read_id;
  db.query(UPDATE_LAST_READ_SQL).run(maxId, member.room, member.handle);
  return maxId;
}

function membershipsFor(handle: string, room: string | undefined, db: Database): MemberRow[] {
  if (room) {
    const row = db.query(SELECT_ROOM_MEMBER_SQL).get(room, handle) as MemberRow | null;
    return row ? [row] : [];
  }
  return db.query(SELECT_HANDLE_MEMBERSHIPS_SQL).all(handle) as MemberRow[];
}

// The lookbehind is what keeps `a@b.com` from reading as a mention of
// `b.com`: without it, any `@` preceded by an identifier char would match.
const MENTION_RE = /(?<![A-Za-z0-9._-])@([a-z0-9._-]+)/g;

export function parseMentions(body: string): string[] {
  const found = new Set<string>();
  for (const match of body.matchAll(MENTION_RE)) {
    found.add(match[1]!);
  }
  return [...found];
}

export function recipientsFor(
  room: string,
  authorHandle: string,
  mentions: string[],
  db: Database = getStateDb(),
): string[] {
  const members = db.query(SELECT_ROOM_MEMBERS_SQL).all(room) as MemberRow[];
  const mentionSet = new Set(mentions);
  const hasHere = mentionSet.has("here");

  const recipients = members
    .filter((m) => m.handle !== authorHandle && m.wake_on !== "none")
    .filter((m) => (mentionSet.size === 0 ? m.wake_on === "all" : hasHere || mentionSet.has(m.handle)))
    .map((m) => m.handle);

  return recipients.sort();
}

export function postMessage(
  args: { room: string; handle: string; body: string },
  db: Database = getStateDb(),
): { id: number; recipients: string[] } | undefined {
  const { room, handle, body } = args;
  const mentions = parseMentions(body);

  const run = db.transaction((): { id: number; recipients: string[] } => {
    const now = Date.now();
    const result = db.query(INSERT_MESSAGE_SQL).run(room, handle, body, JSON.stringify(mentions), null, now);
    const recipients = recipientsFor(room, handle, mentions, db);
    return { id: Number(result.lastInsertRowid), recipients };
  });

  return runCriticalWrite("postMessage", () => run(), { room, handle });
}

export function readUnread(
  args: { handle: string; room?: string; limit: number; sinceMs?: number },
  db: Database = getStateDb(),
): { room: string; messages: ChatMessage[] }[] {
  const { handle, room, limit, sinceMs } = args;

  const run = db.transaction((): { room: string; messages: ChatMessage[] }[] => {
    const members = membershipsFor(handle, room, db);
    const results: { room: string; messages: ChatMessage[] }[] = [];

    for (const member of members) {
      const maxId = getRoomMaxId(member.room, db);
      const cursor = clampCursor(member, maxId, db);
      const rows = (
        sinceMs !== undefined
          ? db.query(SELECT_UNREAD_SINCE_SQL).all(member.room, cursor, sinceMs, limit)
          : db.query(SELECT_UNREAD_SQL).all(member.room, cursor, limit)
      ) as MessageRow[];
      if (rows.length === 0) continue;

      // The cursor advances only to what this call actually returned, not
      // to MAX(id): a capped or --since-filtered read must leave the rest
      // unread for the next call, not silently mark it seen.
      const highestReturned = rows[rows.length - 1]!.id;
      db.query(UPDATE_LAST_READ_SQL).run(highestReturned, member.room, handle);
      results.push({ room: member.room, messages: rows.map(rowToMessage) });
    }

    return results;
  });

  return run();
}

export function listMessages(
  args: { room: string; before?: number; limit: number },
  db: Database = getStateDb(),
): ChatMessage[] {
  const { room, before, limit } = args;
  const rows = (
    before !== undefined
      ? db.query(SELECT_MESSAGES_BEFORE_SQL).all(room, before, limit)
      : db.query(SELECT_MESSAGES_SQL).all(room, limit)
  ) as MessageRow[];
  return rows.reverse().map(rowToMessage);
}

export function markRead(handle: string, room?: string, db: Database = getStateDb()): void {
  const members = membershipsFor(handle, room, db);
  for (const member of members) {
    const maxId = getRoomMaxId(member.room, db);
    db.query(UPDATE_LAST_READ_SQL).run(maxId, member.room, handle);
  }
}

export function unreadWakingCount(
  handle: string,
  db: Database = getStateDb(),
): { room: string; count: number; mentions: number; maxId: number }[] {
  const members = db.query(SELECT_HANDLE_MEMBERSHIPS_SQL).all(handle) as MemberRow[];
  const results: { room: string; count: number; mentions: number; maxId: number }[] = [];

  for (const member of members) {
    if (member.wake_on === "none") continue;

    const maxId = getRoomMaxId(member.room, db);
    const cursor = clampCursor(member, maxId, db);
    if (cursor >= maxId) continue;

    const rows = db.query(SELECT_UNREAD_ALL_SQL).all(member.room, cursor) as MessageRow[];
    // recipientsFor is the same rule the post path used to decide who to
    // wake at post time; recomputing it here (rather than a parallel
    // wake_on/mentions check) is what keeps the two from ever diverging.
    let count = 0;
    for (const row of rows) {
      const rowMentions: string[] = row.mentions ? (JSON.parse(row.mentions) as string[]) : [];
      if (recipientsFor(row.room, row.handle, rowMentions, db).includes(handle)) count++;
    }
    if (count === 0) continue;

    const mentionsCount = (
      db.query(SELECT_ROOM_UNREAD_MENTIONS_SQL).get(member.room, cursor, `%"${escapeLike(handle)}"%`) as { n: number }
    ).n;
    results.push({ room: member.room, count, mentions: mentionsCount, maxId });
  }

  return results;
}
