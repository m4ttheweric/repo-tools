/**
 * lib/state/dm-store.ts — DM room lookup/creation for `rt chat dm`. The
 * only module that touches `chat_dms`; the DM's room and membership rows
 * still live in chat_rooms/chat_members, created here through
 * chat-store.ts's `ensureRoomRow` (intra-lib/state exception — see
 * presence-store.ts's note on the same pattern) so a DM's room row is
 * never a second, divergent INSERT.
 */

import { Database } from "bun:sqlite";
import { getStateDb } from "./db.ts";
import { ensureRoomRow } from "./chat-store.ts";

interface DmRow {
  room: string;
  a: string;
  b: string;
}

const SELECT_DM_BY_ROOM_SQL = `SELECT room, a, b FROM chat_dms WHERE room = ?;`;
const SELECT_DMS_FOR_HANDLE_SQL = `SELECT room, a, b FROM chat_dms WHERE a = ? OR b = ? ORDER BY created_at;`;
const INSERT_DM_SQL = `INSERT INTO chat_dms (room, a, b, created_at) VALUES (?, ?, ?, ?);`;
const INSERT_DM_MEMBER_SQL = `INSERT INTO chat_members (room, handle, joined_at, last_read_id, wake_on, cwd, pane) VALUES (?, ?, ?, 0, ?, NULL, NULL);`;

/**
 * `dm-` plus the first 12 hex digits of `sha256(sortedA + "\n" + sortedB)`.
 * Handles may contain `.`, so concatenating them without a separator can
 * collide across pairs (`x.y`+`z` vs `x`+`y.z`) — the newline is what keeps
 * those distinct.
 */
function dmRoomId(a: string, b: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(`${a}\n${b}`);
  return "dm-" + hasher.digest("hex").slice(0, 12);
}

export function dmRoomFor(
  x: string,
  y: string,
  humanHandle: string,
  db: Database = getStateDb(),
): { room: string; created: boolean } {
  if (x === y) throw new Error(`chat: can't dm your own handle ("${x}")`);
  const [a, b] = x < y ? [x, y] : [y, x];
  const room = dmRoomId(a, b);

  const run = db.transaction((): { room: string; created: boolean } => {
    const existing = db.query(SELECT_DM_BY_ROOM_SQL).get(room) as DmRow | null;
    if (existing) {
      // The 48-bit truncated hash is not collision-proof; an existing row
      // for a DIFFERENT pair under this id must fail loud rather than merge
      // two conversations.
      if (existing.a !== a || existing.b !== b) {
        throw new Error(
          `chat: dm room id collision — "${room}" already holds ${existing.a}/${existing.b}, not ${a}/${b}`,
        );
      }
      return { room, created: false };
    }

    const now = Date.now();
    ensureRoomRow(room, now, db);
    db.query(INSERT_DM_SQL).run(room, a, b, now);
    db.query(INSERT_DM_MEMBER_SQL).run(room, a, now, "all");
    db.query(INSERT_DM_MEMBER_SQL).run(room, b, now, "all");
    // The human is a silent third party in every DM, added once as
    // wake_on none — never duplicated when he is already one of the two
    // named participants.
    if (a !== humanHandle && b !== humanHandle) {
      db.query(INSERT_DM_MEMBER_SQL).run(room, humanHandle, now, "none");
    }
    return { room, created: true };
  });

  return run.immediate();
}

export function dmParticipants(room: string, db: Database = getStateDb()): { a: string; b: string } | null {
  const row = db.query(SELECT_DM_BY_ROOM_SQL).get(room) as DmRow | null;
  return row ? { a: row.a, b: row.b } : null;
}

export function listDms(handle: string, db: Database = getStateDb()): Array<{ room: string; a: string; b: string }> {
  return db.query(SELECT_DMS_FOR_HANDLE_SQL).all(handle, handle) as DmRow[];
}
