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
import { tmpdir } from "os";
import { join } from "path";
import { openStateDb } from "../db.ts";
import {
  armMember,
  clearAllArmed,
  disarmMember,
  isValidChatName,
  joinRoom,
  leaveRoom,
  listMembers,
  listMessages,
  listRooms,
  markRead,
  parseMentions,
  postMessage,
  readUnread,
  recipientsFor,
  touchMember,
  unreadWakingCount,
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
  // its tail armed on chat/wake/a.
  const db = freshDb();
  joinRoom({ room: "build", handle: "a", cwd: "/one" }, db);
  expect(() => joinRoom({ room: "build", handle: "a", cwd: "/two" }, db)).toThrow(/--as/);
  expect(listMembers("build", db).map(m => m.handle)).toEqual(["a"]);
});

test("a colliding handle from a different cwd is refused across DIFFERENT rooms", () => {
  // The wake topic and pidfile are per-handle across every room, so the
  // collision check spans all rooms — not just the one being joined.
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

test("wakeOn defaults to mention and round-trips when set", () => {
  const db = freshDb();
  joinRoom({ room: "build", handle: "a" }, db);
  joinRoom({ room: "build", handle: "b", wakeOn: "all" }, db);
  const byHandle = Object.fromEntries(listMembers("build", db).map(m => [m.handle, m.wakeOn]));
  expect(byHandle).toEqual({ a: "mention", b: "all" });
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
  joinRoom({ room: "r", handle: "a" }, db);
  joinRoom({ room: "r", handle: "b" }, db);
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
  // because all-mode is unconditional and does not go deaf on a directed message.
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
  expect(unreadWakingCount("b", db)).toEqual([]);
  postMessage({ room: "r", handle: "a", body: "@b two" }, db);
  expect(unreadWakingCount("b", db)[0]!.count).toBe(1);
});

test("mark advances without returning messages", () => {
  const db = freshDb();
  joinRoom({ room: "r", handle: "a" }, db);
  joinRoom({ room: "r", handle: "b" }, db);
  postMessage({ room: "r", handle: "a", body: "one" }, db);
  markRead("b", "r", db);
  expect(readUnread({ handle: "b", limit: 20 }, db)).toEqual([]);
});

test("arm sets armed_at, disarm clears it, touch updates last_seen_at", () => {
  const db = freshDb();
  joinRoom({ room: "r", handle: "a" }, db);
  armMember(undefined, "a", db);
  expect(listMembers("r", db)[0]!.armedAt).toBeGreaterThan(0);
  touchMember(undefined, "a", db);
  expect(listMembers("r", db)[0]!.lastSeenAt).toBeGreaterThan(0);
  disarmMember("a", db);
  expect(listMembers("r", db)[0]!.armedAt).toBeUndefined();
});

test("clearAllArmed clears every row and reports how many it cleared", () => {
  const db = freshDb();
  joinRoom({ room: "r", handle: "a" }, db);
  joinRoom({ room: "r", handle: "b" }, db);
  armMember(undefined, "a", db);
  armMember(undefined, "b", db);
  expect(clearAllArmed(db)).toBe(2);
  expect(listMembers("r", db).every(m => m.armedAt === undefined)).toBe(true);
});

test("touch re-arms what the boot clear disarmed, scoped like arm, and never moves a live armed_at", () => {
  const db = freshDb();
  joinRoom({ room: "r1", handle: "a" }, db);
  joinRoom({ room: "r2", handle: "a" }, db);
  armMember(undefined, "a", db);
  const armedAt = listMembers("r1", db)[0]!.armedAt!;

  touchMember(undefined, "a", db);
  expect(listMembers("r1", db)[0]!.armedAt).toBe(armedAt); // touch keeps the arm epoch

  clearAllArmed(db); // the daemon restarted under a tail that is still running
  touchMember("r1", "a", db); // a --room r1 tail touches
  expect(listMembers("r1", db)[0]!.armedAt).toBeGreaterThan(0);
  expect(listMembers("r2", db)[0]!.armedAt).toBeUndefined(); // arm scope respected

  clearAllArmed(db);
  touchMember(undefined, "a", db); // an unscoped tail touches
  expect(listMembers("r1", db)[0]!.armedAt).toBeGreaterThan(0);
  expect(listMembers("r2", db)[0]!.armedAt).toBeGreaterThan(0);
});

test("startup clear covers presence arming", () => {
  const db = freshDb();
  db.query(
    "INSERT INTO chat_presence (session_id, handle, base_handle, signed_in_at, last_seen_at, armed_at) VALUES ('s1','a','a',1,1,1)",
  ).run();
  clearAllArmed(db);
  expect(db.query("SELECT armed_at FROM chat_presence").get()).toMatchObject({ armed_at: null });
});
