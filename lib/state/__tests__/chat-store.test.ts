/**
 * lib/state/chat-store.ts — rooms/members coverage (RT-48 Task 2).
 *
 * Handle-derivation tests from the plan's Task 2 step-1 block
 * (deriveHandle/makeWorktreeFixtures/makeBrokenWorktreeFixture) are not
 * included here: that function is never in this task's Produces list, is
 * unimported in the plan's own test snippet, and the design spec ("Identity")
 * states resolution happens client-side and `deriveRepoIdentity` is
 * deliberately async — incompatible with this store's sync
 * `db.transaction()` writes. They belong with the CLI task that owns
 * handle resolution, not this store.
 */
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { tmpdir } from "os";
import { join } from "path";
import { openStateDb } from "../db.ts";
import {
  archiveRoom,
  isValidChatName,
  joinRoom,
  leaveRoom,
  listMembers,
  listMessages,
  listRooms,
  markDelivered,
  markRead,
  parseMentions,
  pendingMessages,
  postMessage,
  readUnread,
  recipientsFor,
  roomArchivedAt,
} from "../chat-store.ts";

let n = 0;
function freshDb() {
  return openStateDb(join(tmpdir(), `chat-test-${process.pid}-${n++}.db`));
}

test("rejects names outside the charset", () => {
  expect(isValidChatName("build")).toBe(true);
  expect(isValidChatName("acme-dev-42")).toBe(true);
  expect(isValidChatName("has@sigil")).toBe(false);
  expect(isValidChatName("has/slash")).toBe(false);
  expect(isValidChatName("HasUpper")).toBe(false);
  expect(isValidChatName("")).toBe(false);
});

test("join creates the room and reports being alone", () => {
  const db = freshDb();
  const r = joinRoom({ room: "build", handle: "a" }, db);
  expect(r.memberCount).toBe(1);
  expect(r.unread).toBe(0);
  expect(listRooms("a", db).map(x => x.room)).toEqual(["build"]);
});

test("a colliding handle from a different cwd is refused, not suffixed", () => {
  // Suffixing is unreachable from local resolution: every other verb would
  // still produce the unsuffixed base, so the agent would join as "a-2" while
  // post/read/join keep resolving plain "a" for it.
  const db = freshDb();
  joinRoom({ room: "build", handle: "a", cwd: "/one" }, db);
  expect(() => joinRoom({ room: "build", handle: "a", cwd: "/two" }, db)).toThrow(/--as/);
  expect(listMembers("build", db).map(m => m.handle)).toEqual(["a"]);
});

test("a colliding handle from a different cwd is refused across DIFFERENT rooms", () => {
  // An unsigned handle has no presence row to establish identity, so it must
  // map to one cwd across every room, not just the one being joined here.
  const db = freshDb();
  joinRoom({ room: "a", handle: "agent", cwd: "/one" }, db);
  expect(() => joinRoom({ room: "b", handle: "agent", cwd: "/two" }, db)).toThrow(/--as/);
  expect(listMembers("b", db)).toHaveLength(0);
});

test("the same cwd may hold one handle across multiple rooms", () => {
  const db = freshDb();
  joinRoom({ room: "a", handle: "agent", cwd: "/one" }, db);
  joinRoom({ room: "b", handle: "agent", cwd: "/one" }, db);
  expect(listRooms("agent", db).map(r => r.room).sort()).toEqual(["a", "b"]);
});

test("rejoining from the same cwd keeps the handle rather than refusing", () => {
  const db = freshDb();
  joinRoom({ room: "build", handle: "a", cwd: "/one" }, db);
  const again = joinRoom({ room: "build", handle: "a", cwd: "/one" }, db);
  expect(again.handle).toBe("a");
  expect(listMembers("build", db)).toHaveLength(1);
});

test("wakeOn defaults to all and round-trips when set", () => {
  const db = freshDb();
  joinRoom({ room: "build", handle: "a" }, db);
  joinRoom({ room: "build", handle: "b", wakeOn: "mention" }, db);
  const byHandle = Object.fromEntries(listMembers("build", db).map(m => [m.handle, m.wakeOn]));
  expect(byHandle).toEqual({ a: "all", b: "mention" });
});

test("leave drops membership", () => {
  const db = freshDb();
  joinRoom({ room: "build", handle: "a" }, db);
  leaveRoom("build", "a", db);
  expect(listMembers("build", db)).toHaveLength(0);
});

test("parses mentions and ignores an email-shaped token", () => {
  expect(parseMentions("hi @alice and @bob-2")).toEqual(["alice", "bob-2"]);
  expect(parseMentions("mail me at a@b.com")).toEqual([]);
  expect(parseMentions("@here everyone")).toEqual(["here"]);
});

test("recipients: mention mode wakes only on being named, and never the author", () => {
  const db = freshDb();
  joinRoom({ room: "r", handle: "a", wakeOn: "mention" }, db);
  joinRoom({ room: "r", handle: "b", wakeOn: "mention" }, db);
  expect(recipientsFor("r", "a", [], db)).toEqual([]);
  expect(recipientsFor("r", "a", ["b"], db)).toEqual(["b"]);
  expect(recipientsFor("r", "a", ["a"], db)).toEqual([]);
});

test("recipients: wakeOn all wakes without a mention; none never wakes", () => {
  const db = freshDb();
  joinRoom({ room: "r", handle: "a" }, db);
  joinRoom({ room: "r", handle: "b", wakeOn: "all" }, db);
  joinRoom({ room: "r", handle: "c", wakeOn: "none" }, db);
  expect(recipientsFor("r", "a", [], db)).toEqual(["b"]);
  // c (none) is excluded even when directly mentioned; b (all) still wakes,
  // because all-mode is unconditional and does not silence on a directed message.
  expect(recipientsFor("r", "a", ["c"], db)).toEqual(["b"]);
});

test("@here wakes every member except the author and the none-mode members", () => {
  const db = freshDb();
  joinRoom({ room: "r", handle: "a" }, db);
  joinRoom({ room: "r", handle: "b" }, db);
  joinRoom({ room: "r", handle: "c", wakeOn: "none" }, db);
  expect(recipientsFor("r", "a", ["here"], db).sort()).toEqual(["b"]);
});

test("read returns unread, advances the cursor, and is empty on a second call", () => {
  const db = freshDb();
  joinRoom({ room: "r", handle: "a" }, db);
  joinRoom({ room: "r", handle: "b" }, db);
  postMessage({ room: "r", handle: "a", body: "one" }, db);
  const first = readUnread({ handle: "b", limit: 20 }, db);
  expect(first[0]!.messages.map(m => m.body)).toEqual(["one"]);
  expect(readUnread({ handle: "b", limit: 20 }, db)).toEqual([]);
});

test("a sinceMs read shows a message the cursor has already passed", () => {
  const db = freshDb();
  joinRoom({ room: "r", handle: "a" }, db);
  joinRoom({ room: "r", handle: "b" }, db);
  const msg = postMessage({ room: "r", handle: "a", body: "the long recipe" }, db);
  db.query("UPDATE chat_messages SET posted_at = 5000 WHERE id = ?;").run(msg!.id);
  expect(readUnread({ handle: "b", room: "r", limit: 20 }, db)[0]?.messages).toHaveLength(1);
  expect(readUnread({ handle: "b", room: "r", limit: 20 }, db)).toHaveLength(0);
  const again = readUnread({ handle: "b", room: "r", limit: 20, sinceMs: 1000 }, db);
  expect(again[0]?.messages.map((m) => m.body)).toEqual(["the long recipe"]);
  expect(readUnread({ handle: "b", room: "r", limit: 20 }, db)).toHaveLength(0);
});

test("a sinceMs read is a non-advancing peek: it can skip an older unread message without losing it", () => {
  const db = freshDb();
  joinRoom({ room: "r", handle: "a" }, db);
  joinRoom({ room: "r", handle: "b" }, db);
  const oldMsg = postMessage({ room: "r", handle: "a", body: "old" }, db);
  const newMsg = postMessage({ room: "r", handle: "a", body: "new" }, db);
  db.query("UPDATE chat_messages SET posted_at = 1000 WHERE id = ?;").run(oldMsg!.id);
  db.query("UPDATE chat_messages SET posted_at = 2000 WHERE id = ?;").run(newMsg!.id);

  const peek = readUnread({ handle: "b", room: "r", limit: 20, sinceMs: 2000 }, db);
  expect(peek[0]!.messages.map(m => m.body)).toEqual(["new"]);

  const full = readUnread({ handle: "b", limit: 20 }, db);
  expect(full[0]!.messages.map(m => m.body)).toEqual(["old", "new"]);
});

test("listMessages does not advance any cursor", () => {
  const db = freshDb();
  joinRoom({ room: "r", handle: "a" }, db);
  joinRoom({ room: "r", handle: "b" }, db);
  postMessage({ room: "r", handle: "a", body: "one" }, db);
  const before = listMembers("r", db).map(m => m.lastReadId);
  listMessages({ room: "r", limit: 20 }, db);
  expect(listMembers("r", db).map(m => m.lastReadId)).toEqual(before);
});

test("a last_read_id ahead of MAX(id) is clamped rather than hanging", () => {
  const db = freshDb();
  joinRoom({ room: "r", handle: "a" }, db);
  joinRoom({ room: "r", handle: "b" }, db);
  postMessage({ room: "r", handle: "a", body: "@b one" }, db);
  db.run("UPDATE chat_members SET last_read_id = 999999 WHERE handle = 'b';");
  expect(readUnread({ handle: "b", limit: 20 }, db)).toEqual([]);
  postMessage({ room: "r", handle: "a", body: "@b two" }, db);
  const after = readUnread({ handle: "b", limit: 20 }, db);
  expect(after[0]!.messages.map((m) => m.body)).toEqual(["@b two"]);
});

test("mark advances without returning messages", () => {
  const db = freshDb();
  joinRoom({ room: "r", handle: "a" }, db);
  joinRoom({ room: "r", handle: "b" }, db);
  postMessage({ room: "r", handle: "a", body: "one" }, db);
  markRead("b", "r", db);
  expect(readUnread({ handle: "b", limit: 20 }, db)).toEqual([]);
});

test("markDelivered clamps the cursor: a slower delivery completing after a newer one never moves it backwards", () => {
  const db = freshDb();
  joinRoom({ room: "r", handle: "a" }, db);
  joinRoom({ room: "r", handle: "b" }, db);
  postMessage({ room: "r", handle: "a", body: "one" }, db);
  postMessage({ room: "r", handle: "a", body: "two" }, db);
  markDelivered("r", "b", 2, db);
  markDelivered("r", "b", 1, db); // a slow send for the older message settling second
  expect(listMembers("r", db).find((m) => m.handle === "b")!.lastReadId).toBe(2);
});

test("pendingMessages returns the recipient's unread backlog bounded above by the given id, in order", () => {
  const db = freshDb();
  joinRoom({ room: "r", handle: "a" }, db);
  joinRoom({ room: "r", handle: "b" }, db);
  const one = postMessage({ room: "r", handle: "a", body: "one" }, db)!;
  const two = postMessage({ room: "r", handle: "a", body: "two" }, db)!;
  postMessage({ room: "r", handle: "a", body: "three" }, db);
  expect(pendingMessages("r", "b", two.id, db).map((m) => m.body)).toEqual(["one", "two"]);
  markDelivered("r", "b", one.id, db);
  expect(pendingMessages("r", "b", two.id, db).map((m) => m.body)).toEqual(["two"]);
  expect(pendingMessages("r", "nobody", two.id, db)).toEqual([]);
});

test("archive hides a room from every membership walk and keeps the member rows", () => {
  const db = freshDb();
  joinRoom({ room: "build", handle: "a" }, db);
  joinRoom({ room: "build", handle: "b" }, db);
  joinRoom({ room: "other", handle: "b" }, db);
  postMessage({ room: "build", handle: "a", body: "@b look" }, db);

  const stamped = archiveRoom("build", true, db);
  expect(stamped.room).toBe("build");
  expect(typeof stamped.archivedAt).toBe("number");
  expect(roomArchivedAt("build", db)).toBe(stamped.archivedAt);

  expect(listRooms("b", db).map(r => r.room)).toEqual(["other"]);
  expect(listRooms("b", db, { includeArchived: true }).map(r => [r.room, r.archivedAt !== undefined])).toEqual([["build", true], ["other", false]]);
  expect(readUnread({ handle: "b", limit: 20 }, db)).toEqual([]);
  expect(listMembers("build", db).map(m => m.handle)).toEqual(["a", "b"]);
});

test("a room named explicitly still answers while archived", () => {
  const db = freshDb();
  joinRoom({ room: "build", handle: "a" }, db);
  joinRoom({ room: "build", handle: "b" }, db);
  postMessage({ room: "build", handle: "a", body: "hi" }, db);
  archiveRoom("build", true, db);
  const read = readUnread({ handle: "b", room: "build", limit: 20 }, db);
  expect(read).toHaveLength(1);
  expect(read[0]!.messages.map(m => m.body)).toEqual(["hi"]);
  expect(listMessages({ room: "build", limit: 20 }, db)).toHaveLength(1);
});

test("a post into an archived room revives it and wakes the members who were there", () => {
  const db = freshDb();
  joinRoom({ room: "build", handle: "a" }, db);
  joinRoom({ room: "build", handle: "b", wakeOn: "all" }, db);
  archiveRoom("build", true, db);
  expect(listRooms("a", db)).toEqual([]);

  const posted = postMessage({ room: "build", handle: "a", body: "back to it" }, db)!;
  expect(posted.recipients).toEqual(["b"]);
  expect(roomArchivedAt("build", db)).toBeNull();
  expect(listRooms("a", db).map(r => r.room)).toEqual(["build"]);
  expect(listRooms("b", db).map(r => [r.room, r.unread])).toEqual([["build", 1]]);
});

test("archive refuses a room that does not exist, reopen clears the stamp, and both are idempotent", () => {
  const db = freshDb();
  expect(() => archiveRoom("nope", true, db)).toThrow(/no such room/);
  expect(roomArchivedAt("nope", db)).toBeUndefined();
  joinRoom({ room: "build", handle: "a" }, db);
  const first = archiveRoom("build", true, db).archivedAt;
  expect(archiveRoom("build", true, db).archivedAt).toBe(first);
  expect(archiveRoom("build", false, db)).toEqual({ room: "build", archivedAt: null });
  expect(archiveRoom("build", false, db)).toEqual({ room: "build", archivedAt: null });
  expect(listRooms("a", db).map(r => r.room)).toEqual(["build"]);
});

test("room-less markRead skips an archived room, naming it still clears the cursor", () => {
  const db = freshDb();
  joinRoom({ room: "build", handle: "a" }, db);
  joinRoom({ room: "build", handle: "b" }, db);
  joinRoom({ room: "other", handle: "a" }, db);
  joinRoom({ room: "other", handle: "b" }, db);
  postMessage({ room: "build", handle: "a", body: "skip me" }, db);
  postMessage({ room: "other", handle: "a", body: "clear me" }, db);
  archiveRoom("build", true, db);
  archiveRoom("other", true, db);

  markRead("b", undefined, db);
  expect(readUnread({ handle: "b", room: "build", limit: 20 }, db)).toHaveLength(1);

  markRead("b", "other", db);
  expect(readUnread({ handle: "b", room: "other", limit: 20 }, db)).toHaveLength(0);
});

test("join by name does not revive an archived room", () => {
  const db = freshDb();
  joinRoom({ room: "build", handle: "a" }, db);
  archiveRoom("build", true, db);
  joinRoom({ room: "build", handle: "c" }, db);
  expect(roomArchivedAt("build", db)).not.toBeNull();
  expect(listRooms("c", db)).toEqual([]);
});

// R057: leaveRoom/markRead are cache-class membership writes (self-healing
// on the next call) that bypassed persistOrWarn, so a write racing a held
// lock past the daemon's 250ms busy_timeout threw a raw SQLITE_BUSY at the
// caller instead of warning and deferring per busy.ts's policy table.
function heldWriteLock(path: string): { release: () => void } {
  const locker = new Database(path);
  locker.exec("BEGIN IMMEDIATE;");
  return { release: () => { try { locker.exec("ROLLBACK;"); } catch {} locker.close(); } };
}

test("R057: leaveRoom does not throw when the write races a held lock past busy_timeout", () => {
  const path = join(tmpdir(), `chat-busy-leave-${process.pid}-${n++}.db`);
  const db = openStateDb(path, "daemon");
  joinRoom({ room: "build", handle: "a" }, db);
  const { release } = heldWriteLock(path);
  try {
    expect(() => leaveRoom("build", "a", db)).not.toThrow();
  } finally {
    release();
  }
}, 5000);

test("R057: markRead does not throw when the write races a held lock past busy_timeout", () => {
  const path = join(tmpdir(), `chat-busy-markread-${process.pid}-${n++}.db`);
  const db = openStateDb(path, "daemon");
  joinRoom({ room: "build", handle: "a" }, db);
  postMessage({ room: "build", handle: "a", body: "hi" }, db);
  const { release } = heldWriteLock(path);
  try {
    expect(() => markRead("a", "build", db)).not.toThrow();
  } finally {
    release();
  }
}, 5000);
