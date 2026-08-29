/**
 * lib/state/chat-store.ts — rooms, members, and (Task 3+) messages for
 * `rt chat`.
 *
 * The only module that touches chat_rooms/chat_members/chat_messages: rooms,
 * members, and messages live in one file because posting a message reads
 * membership inside the same transaction that writes it.
 */

import { Database } from "bun:sqlite";
import { getStateDb } from "./db.ts";
import { runCriticalWrite } from "./busy.ts";
import { presenceForHandle } from "./presence-store.ts";
// Intra-lib/state exception (see presence-store.ts's note on the same
// pattern): dm-store.ts is the only module that touches chat_dms, so
// joinRoom asks it directly rather than duplicating a chat_dms query here.
import { dmParticipants } from "./dm-store.ts";

export type WakeMode = "mention" | "all" | "none";

export interface ChatMember {
  room: string;
  handle: string;
  joinedAt: number;
  lastReadId: number;
  wakeOn: WakeMode;
  cwd?: string;
  pane?: string;
}

export interface RoomSummary {
  room: string;
  memberCount: number;
  unread: number;
  mentions: number;
  lastPostedAt?: number;
  /** Set only when the caller asked for archived rooms; absent on an open room. */
  archivedAt?: number;
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
  cwd: string | null;
  pane: string | null;
}

interface MembershipRow extends MemberRow {
  archived_at: number | null;
}

function rowToMember(row: MemberRow): ChatMember {
  const member: ChatMember = {
    room: row.room,
    handle: row.handle,
    joinedAt: row.joined_at,
    lastReadId: row.last_read_id,
    wakeOn: row.wake_on,
  };
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

const MEMBER_COLUMNS = "room, handle, joined_at, last_read_id, wake_on, cwd, pane";
const SELECT_ROOM_MEMBER_SQL = `SELECT ${MEMBER_COLUMNS} FROM chat_members WHERE room = ? AND handle = ?;`;
const SELECT_ROOM_MEMBERS_SQL = `SELECT ${MEMBER_COLUMNS} FROM chat_members WHERE room = ? ORDER BY handle;`;
const SELECT_HANDLE_MEMBERSHIPS_SQL = `SELECT ${MEMBER_COLUMNS} FROM chat_members WHERE handle = ? ORDER BY room;`;
const SELECT_HANDLE_MEMBERSHIPS_WITH_ROOM_SQL = `SELECT ${MEMBER_COLUMNS}, archived_at FROM chat_members JOIN chat_rooms ON chat_rooms.name = chat_members.room WHERE handle = ? ORDER BY room;`;
const SELECT_ROOM_ARCHIVED_SQL = `SELECT archived_at FROM chat_rooms WHERE name = ?;`;
const UPDATE_ROOM_ARCHIVED_SQL = `UPDATE chat_rooms SET archived_at = ? WHERE name = ?;`;
const REVIVE_ROOM_SQL = `UPDATE chat_rooms SET archived_at = NULL WHERE name = ? AND archived_at IS NOT NULL;`;
const SELECT_ROOM_MEMBER_COUNT_SQL = `SELECT COUNT(*) AS n FROM chat_members WHERE room = ?;`;
const SELECT_ROOM_MAX_ID_SQL = `SELECT COALESCE(MAX(id), 0) AS maxId FROM chat_messages WHERE room = ?;`;
const SELECT_ROOM_LAST_POSTED_SQL = `SELECT MAX(posted_at) AS lastPostedAt FROM chat_messages WHERE room = ?;`;
const SELECT_ROOM_UNREAD_SQL = `SELECT COUNT(*) AS n FROM chat_messages WHERE room = ? AND id > ?;`;
const SELECT_ROOM_UNREAD_MENTIONS_SQL = `SELECT COUNT(*) AS n FROM chat_messages WHERE room = ? AND id > ? AND mentions LIKE ? ESCAPE '\\';`;
const UPSERT_ROOM_SQL = `INSERT INTO chat_rooms (name, created_at) VALUES (?, ?) ON CONFLICT(name) DO NOTHING;`;
const SELECT_ROOM_DEFAULT_WAKE_SQL = `SELECT wake_on FROM chat_room_defaults WHERE room = ?;`;
const INSERT_ROOM_DEFAULT_WAKE_SQL = `INSERT INTO chat_room_defaults (room, wake_on) VALUES (?, ?) ON CONFLICT(room) DO NOTHING;`;
const INSERT_MEMBER_SQL = `INSERT INTO chat_members (room, handle, joined_at, last_read_id, wake_on, cwd, pane) VALUES (?, ?, ?, ?, ?, ?, ?);`;
const DELETE_MEMBER_SQL = `DELETE FROM chat_members WHERE room = ? AND handle = ?;`;
const UPDATE_LAST_READ_SQL = `UPDATE chat_members SET last_read_id = ? WHERE room = ? AND handle = ?;`;

/** How long a message survives before it's eligible for pruning (R053). */
export const CHAT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
/** The newest N messages per room that pruneMessages never deletes, age floor notwithstanding -- a live room is never emptied. */
export const CHAT_ROOM_FLOOR = 200;

const MESSAGE_COLUMNS = "id, room, handle, body, mentions, reply_to, posted_at";
const INSERT_MESSAGE_SQL = `INSERT INTO chat_messages (room, handle, body, mentions, reply_to, posted_at) VALUES (?, ?, ?, ?, ?, ?);`;
// Ranks each room's own messages newest-first (rn=1 is the newest); a row is
// only a delete candidate once it falls outside the per-room floor AND past
// the age cutoff -- either condition alone must keep it.
const PRUNE_MESSAGES_SQL = `
DELETE FROM chat_messages
WHERE id IN (
  SELECT id FROM (
    SELECT id, posted_at, ROW_NUMBER() OVER (PARTITION BY room ORDER BY id DESC) AS rn
    FROM chat_messages
  )
  WHERE rn > ? AND posted_at < ?
);
`;
const SELECT_UNREAD_SQL = `SELECT ${MESSAGE_COLUMNS} FROM chat_messages WHERE room = ? AND id > ? ORDER BY id ASC LIMIT ?;`;
const SELECT_SINCE_SQL = `SELECT ${MESSAGE_COLUMNS} FROM chat_messages WHERE room = ? AND posted_at >= ? ORDER BY id ASC LIMIT ?;`;
const SELECT_MESSAGES_SQL = `SELECT ${MESSAGE_COLUMNS} FROM chat_messages WHERE room = ? ORDER BY id DESC LIMIT ?;`;
const SELECT_MESSAGES_BEFORE_SQL = `SELECT ${MESSAGE_COLUMNS} FROM chat_messages WHERE room = ? AND id < ? ORDER BY id DESC LIMIT ?;`;
const SELECT_PENDING_SQL = `SELECT ${MESSAGE_COLUMNS} FROM chat_messages WHERE room = ? AND id > ? AND id <= ? ORDER BY id ASC;`;
const UPDATE_LAST_READ_CLAMPED_SQL = `UPDATE chat_members SET last_read_id = MAX(last_read_id, ?) WHERE room = ? AND handle = ?;`;

// `@` is strictly the mention sigil, and `/` would reshape the
// `chat/<room>/msg` event topic (lib/daemon/handlers/chat.ts's
// postAndNotify) into extra segments -- so both are excluded even though
// the rest of [a-z0-9._-] is otherwise permissive. Delivery chain keys
// ("<room>:<handle>", also chat.ts) rely on the same charset to keep each
// half free of the other's ":" separator.
export function isValidChatName(name: string): boolean {
  return /^[a-z0-9._-]+$/.test(name);
}

/**
 * The one INSERT that creates a chat_rooms row. dm-store.ts's dmRoomFor
 * reuses this (intra-lib/state exception) so a DM's room row is created
 * through the exact same idempotent statement a normal join uses, never a
 * second, divergent one.
 */
export function ensureRoomRow(room: string, now: number, db: Database = getStateDb()): boolean {
  return db.query(UPSERT_ROOM_SQL).run(room, now).changes > 0;
}

/**
 * Refuses a colliding handle rather than suffixing it. The suffix is only
 * reachable from inside this function, while `post`/`read`/`join` each
 * resolve the same handle independently and can only produce the unsuffixed
 * base, so a suffixed join would desync the joined handle from the one every
 * other verb resolves and posts travel as.
 */
export function joinRoom(
  args: { room: string; handle: string; wakeOn?: WakeMode; cwd?: string; pane?: string },
  db: Database = getStateDb(),
): { handle: string; memberCount: number; unread: number } {
  const { room, handle, cwd, pane } = args;
  const explicitWakeOn = args.wakeOn;
  const argCwd = cwd ?? null;

  const run = db.transaction(() => {
    // A DM's membership is fixed at creation (dmRoomFor) and its two
    // participants live in chat_dms, not chat_rooms/chat_members alone —
    // joining it here would let a third handle in without a chat_dms row
    // to match, silently turning a DM into an ordinary room.
    if (dmParticipants(room, db)) {
      throw new Error(`chat: "${room}" is a DM room; use \`rt chat dm <handle>\` to message it, not \`join\``);
    }

    const now = Date.now();
    const creatingRoom = ensureRoomRow(room, now, db);

    const maxId = (db.query(SELECT_ROOM_MAX_ID_SQL).get(room) as { maxId: number }).maxId;

    // An unsigned handle has no presence row to establish identity, so this
    // guard is what stands in: a handle must map to one cwd across every
    // room, or two different directories could silently share one identity.
    // A row for this handle in any room from a different cwd is a collision.
    // Once a presence row exists for the handle, presence owns uniqueness
    // instead (spec "The shipped joinRoom cwd guard is scoped to unsigned
    // handles"); memberships from an earlier cwd are just that session's
    // history.
    const priorRows = db.query(SELECT_HANDLE_MEMBERSHIPS_SQL).all(handle) as MemberRow[];
    const collision = priorRows.find((r) => r.cwd !== argCwd);
    if (collision && !presenceForHandle(handle, db)) {
      throw new Error(
        `chat: handle "${handle}" is already in use from a different directory (#${collision.room}) — pass --as <handle> to join under another name`,
      );
    }
    const existing = priorRows.find((r) => r.room === room) ?? null;

    let lastReadId: number;
    if (existing) {
      lastReadId = existing.last_read_id;
    } else {
      lastReadId = maxId;
      let wakeOn: WakeMode;
      if (explicitWakeOn !== undefined) {
        wakeOn = explicitWakeOn;
        // Only the join that CREATES the room stamps its default — a later
        // explicit flag wins for that member alone (spec "A room can
        // default its members to wake_on all").
        if (creatingRoom) db.query(INSERT_ROOM_DEFAULT_WAKE_SQL).run(room, wakeOn);
      } else {
        const defaultRow = db.query(SELECT_ROOM_DEFAULT_WAKE_SQL).get(room) as { wake_on: WakeMode } | null;
        wakeOn = defaultRow ? defaultRow.wake_on : "mention";
      }
      db.query(INSERT_MEMBER_SQL).run(room, handle, now, lastReadId, wakeOn, argCwd, pane ?? null);
    }

    const memberCount = (db.query(SELECT_ROOM_MEMBER_COUNT_SQL).get(room) as { n: number }).n;
    return { handle, memberCount, unread: Math.max(0, maxId - lastReadId) };
  });

  // BEGIN IMMEDIATE: read-then-write must lock up front or SQLITE_BUSY_SNAPSHOT bypasses busy_timeout.
  return run.immediate();
}

export function leaveRoom(room: string, handle: string, db: Database = getStateDb()): void {
  db.query(DELETE_MEMBER_SQL).run(room, handle);
}

/** A handle's memberships in rooms that are not archived: the rows every
    room-less walk (rooms, read, mark) is allowed to see. An explicit room
    bypasses this on purpose. */
function openMembershipsFor(handle: string, db: Database): MembershipRow[] {
  const rows = db.query(SELECT_HANDLE_MEMBERSHIPS_WITH_ROOM_SQL).all(handle) as MembershipRow[];
  return rows.filter((r) => r.archived_at === null);
}

export function listRooms(
  handle: string,
  db: Database = getStateDb(),
  opts: { includeArchived?: boolean } = {},
): RoomSummary[] {
  const all = db.query(SELECT_HANDLE_MEMBERSHIPS_WITH_ROOM_SQL).all(handle) as MembershipRow[];
  const rows = opts.includeArchived ? all : all.filter((r) => r.archived_at === null);
  return rows.map((row) => {
    const memberCount = (db.query(SELECT_ROOM_MEMBER_COUNT_SQL).get(row.room) as { n: number }).n;
    const unread = (db.query(SELECT_ROOM_UNREAD_SQL).get(row.room, row.last_read_id) as { n: number }).n;
    const mentions = (
      db.query(SELECT_ROOM_UNREAD_MENTIONS_SQL).get(row.room, row.last_read_id, `%"${escapeLike(handle)}"%`) as { n: number }
    ).n;
    const lastPosted = (db.query(SELECT_ROOM_LAST_POSTED_SQL).get(row.room) as { lastPostedAt: number | null }).lastPostedAt;

    const summary: RoomSummary = { room: row.room, memberCount, unread, mentions };
    if (lastPosted !== null) summary.lastPostedAt = lastPosted;
    if (row.archived_at !== null) summary.archivedAt = row.archived_at;
    return summary;
  });
}

/** Tri-state: a timestamp means archived, null means open, undefined means no such room (archiveRoom's existence check relies on that undefined). */
export function roomArchivedAt(room: string, db: Database = getStateDb()): number | null | undefined {
  const row = db.query(SELECT_ROOM_ARCHIVED_SQL).get(room) as { archived_at: number | null } | null;
  return row ? row.archived_at : undefined;
}

export function archiveRoom(
  room: string,
  archived: boolean,
  db: Database = getStateDb(),
): { room: string; archivedAt: number | null } {
  const run = db.transaction((): { room: string; archivedAt: number | null } => {
    const current = roomArchivedAt(room, db);
    if (current === undefined) throw new Error(`chat: no such room "${room}"`);
    if (!archived) {
      db.query(UPDATE_ROOM_ARCHIVED_SQL).run(null, room);
      return { room, archivedAt: null };
    }
    const archivedAt = current ?? Date.now();
    if (current === null) db.query(UPDATE_ROOM_ARCHIVED_SQL).run(archivedAt, room);
    return { room, archivedAt };
  });
  return run.immediate();
}

/** The wake mode stamped by whichever join created `room`; undefined for a room never stamped (including every DM room — dmRoomFor never stamps one). */
export function roomDefaultWake(room: string, db: Database = getStateDb()): WakeMode | undefined {
  const row = db.query(SELECT_ROOM_DEFAULT_WAKE_SQL).get(room) as { wake_on: WakeMode } | null;
  return row?.wake_on;
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
  return openMembershipsFor(handle, db);
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

/** Unions an explicit recipient list into a body's parsed @mentions — the one merge rule storage (postMessage) and the daemon's desk-notify check both need, so the two can never diverge. */
export function mergeMentions(body: string, explicit?: string[]): string[] {
  const parsed = parseMentions(body);
  return explicit ? [...new Set([...parsed, ...explicit])] : parsed;
}

/**
 * The recipient rule over an already-fetched member list. Both the post path
 * and the wake-catch-up path route through here so they can never diverge —
 * the wake path fetches a room's members once and reuses them across every
 * unread row rather than re-querying per row.
 */
function recipientsFromMembers(members: MemberRow[], authorHandle: string, mentions: string[]): string[] {
  const mentionSet = new Set(mentions);
  const hasHere = mentionSet.has("here");

  return members
    .filter((m) => m.handle !== authorHandle && m.wake_on !== "none")
    // 'all' is an unconditional leg: an all-mode member wakes on every message,
    // including one that @-mentions someone else. It is not gated on an empty
    // mention set — that gate silences an agent that opted into all room traffic.
    .filter((m) => m.wake_on === "all" || hasHere || mentionSet.has(m.handle))
    .map((m) => m.handle)
    .sort();
}

export function recipientsFor(
  room: string,
  authorHandle: string,
  mentions: string[],
  db: Database = getStateDb(),
): string[] {
  const members = db.query(SELECT_ROOM_MEMBERS_SQL).all(room) as MemberRow[];
  return recipientsFromMembers(members, authorHandle, mentions);
}

export function postMessage(
  args: { room: string; handle: string; body: string; mentions?: string[] },
  db: Database = getStateDb(),
): { id: number; recipients: string[] } | undefined {
  const { room, handle, body } = args;
  const mentions = mergeMentions(body, args.mentions);

  const run = db.transaction((): { id: number; recipients: string[] } => {
    const now = Date.now();
    db.query(REVIVE_ROOM_SQL).run(room);
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
      // A sinceMs read is a time window over the room, read or not: the only
      // way back to a message once the cursor has passed it (a delivery that
      // never landed, or a viewer that was unreachable at the time). The
      // cursor-bound read is contiguous, so advancing to the highest id
      // returned marks exactly what was shown; the window is not contiguous
      // and never advances.
      const rows = (
        sinceMs !== undefined
          ? db.query(SELECT_SINCE_SQL).all(member.room, sinceMs, limit)
          : db.query(SELECT_UNREAD_SQL).all(member.room, cursor, limit)
      ) as MessageRow[];
      if (rows.length === 0) continue;

      if (sinceMs === undefined) {
        const highestReturned = rows[rows.length - 1]!.id;
        db.query(UPDATE_LAST_READ_SQL).run(highestReturned, member.room, handle);
      }
      results.push({ room: member.room, messages: rows.map(rowToMessage) });
    }

    return results;
  });

  return run.immediate();
}

/**
 * Same shape as `readUnread`'s cursor-bound branch, minus the write: never
 * advances `last_read_id`. For a caller that must preview what a member
 * would see (the sign-in welcome frame) before committing to having shown
 * it -- delivery can still fail after the preview is built, and only a
 * caller that confirms delivery (via `markDelivered`) may advance the
 * cursor, or a failed send permanently loses whatever this returned.
 */
export function peekUnread(
  args: { handle: string; room?: string; limit: number },
  db: Database = getStateDb(),
): { room: string; messages: ChatMessage[] }[] {
  const { handle, room, limit } = args;
  const members = membershipsFor(handle, room, db);
  const results: { room: string; messages: ChatMessage[] }[] = [];
  for (const member of members) {
    const maxId = getRoomMaxId(member.room, db);
    const cursor = member.last_read_id <= maxId ? member.last_read_id : maxId;
    const rows = db.query(SELECT_UNREAD_SQL).all(member.room, cursor, limit) as MessageRow[];
    if (rows.length === 0) continue;
    results.push({ room: member.room, messages: rows.map(rowToMessage) });
  }
  return results;
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

/**
 * The daily retention sweep (R053): deletes messages older than
 * `olderThanMs` EXCEPT the newest `perRoomFloor` per room, which survive
 * regardless of age -- the floor is what keeps a quiet-but-live room from
 * ever being emptied outright.
 */
export function pruneMessages(
  db: Database,
  opts: { olderThanMs?: number; perRoomFloor?: number } = {},
): { removed: number } {
  const cutoff = Date.now() - (opts.olderThanMs ?? CHAT_RETENTION_MS);
  const floor = opts.perRoomFloor ?? CHAT_ROOM_FLOOR;
  const result = db.query(PRUNE_MESSAGES_SQL).run(floor, cutoff);
  return { removed: result.changes };
}

export function markRead(handle: string, room?: string, db: Database = getStateDb()): void {
  const members = membershipsFor(handle, room, db);
  for (const member of members) {
    const maxId = getRoomMaxId(member.room, db);
    db.query(UPDATE_LAST_READ_SQL).run(maxId, member.room, handle);
  }
}

/**
 * A delivered body is the read surface: the daemon calls this in place of
 * markRead once a Claude inbox socket confirms the frame landed, bounded to
 * the id actually delivered rather than the room's current max. The MAX
 * clamp is required, not defensive: two deliveries for the same recipient
 * can be in flight at once (a slow send racing a fast one for a later
 * message), and the slower one completing second must never walk the cursor
 * backwards past what the faster one already confirmed delivered.
 */
export function markDelivered(room: string, handle: string, upToId: number, db: Database = getStateDb()): void {
  db.query(UPDATE_LAST_READ_CLAMPED_SQL).run(upToId, room, handle);
}

/**
 * A recipient's undelivered backlog in one room, bounded above by upToId. A
 * failed delivery leaves the cursor behind; the next successful one must
 * catch up everything since, not just the message that triggered it, or the
 * skipped ones are gone from the recipient's inbox for good once the cursor
 * advances past them.
 */
export function pendingMessages(room: string, handle: string, upToId: number, db: Database = getStateDb()): ChatMessage[] {
  const member = db.query(SELECT_ROOM_MEMBER_SQL).get(room, handle) as MemberRow | null;
  if (!member) return [];
  const rows = db.query(SELECT_PENDING_SQL).all(room, member.last_read_id, upToId) as MessageRow[];
  return rows.map(rowToMessage);
}
