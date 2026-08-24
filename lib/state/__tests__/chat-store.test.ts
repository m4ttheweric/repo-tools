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
import { isValidChatName, joinRoom, leaveRoom, listMembers, listRooms } from "../chat-store.ts";

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
