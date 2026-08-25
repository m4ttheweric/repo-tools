/**
 * lib/state/dm-store.test.ts — DM room lookup/creation.
 */
import { expect, test } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { openStateDb } from "../db.ts";
import { joinRoom, listMembers, postMessage, recipientsFor } from "../chat-store.ts";
import { dmParticipants, dmRoomFor, listDms } from "../dm-store.ts";

let n = 0;
function fresh() {
  return openStateDb(join(tmpdir(), `dm-test-${process.pid}-${n++}.db`));
}

test("dm rooms are keyed by the sorted pair, and dotted handles cannot collide", () => {
  const db = fresh();
  const r1 = dmRoomFor("x.y", "z", "matt", db);
  const r2 = dmRoomFor("x", "y.z", "matt", db);
  expect(r1.room).not.toBe(r2.room);
  expect(dmRoomFor("z", "x.y", "matt", db)).toMatchObject({ room: r1.room, created: false });
});

test("an agent<->agent dm carries the human wake_on none; a dm with the human does not add him twice", () => {
  const db = fresh();
  const { room } = dmRoomFor("a", "b", "matt", db);
  expect(listMembers(room, db).map(m => [m.handle, m.wakeOn]).sort()).toEqual([["a","all"],["b","all"],["matt","none"]]);
  const { room: r2 } = dmRoomFor("a", "matt", "matt", db);
  expect(listMembers(r2, db).map(m => m.handle).sort()).toEqual(["a", "matt"]);
});

test("a self-DM is refused", () => {
  expect(() => dmRoomFor("a", "a", "matt", fresh())).toThrow(/your own/i);
});

test("join refuses a DM room", () => {
  const db = fresh();
  const { room } = dmRoomFor("a", "b", "matt", db);
  expect(() => joinRoom({ room, handle: "c" }, db)).toThrow(/is a DM/);
});

test("postMessage merges explicit mentions with parsed ones", () => {
  const db = fresh();
  const { room } = dmRoomFor("a", "b", "matt", db);
  const msg = postMessage({ room, handle: "a", body: "ping", mentions: ["b"] }, db);
  const row = db.query("SELECT mentions FROM chat_messages WHERE id = ?").get(msg!.id) as { mentions: string };
  expect(JSON.parse(row.mentions)).toEqual(["b"]);
});

test("a dm post wakes the other participant; the human's post wakes both", () => {
  const db = fresh();
  const { room } = dmRoomFor("a", "b", "matt", db);
  expect(recipientsFor(room, "a", ["b"], db)).toEqual(["b"]);       // wake_on all: b wakes even unmentioned
  expect(recipientsFor(room, "matt", [], db).sort()).toEqual(["a", "b"]);
});

test("dmParticipants is null for a non-DM room and returns the sorted pair for a DM", () => {
  const db = fresh();
  joinRoom({ room: "build", handle: "a" }, db);
  expect(dmParticipants("build", db)).toBeNull();
  const { room } = dmRoomFor("b", "a", "matt", db);
  expect(dmParticipants(room, db)).toEqual({ a: "a", b: "b" });
});

test("listDms finds a handle's DMs on either side of the pair", () => {
  const db = fresh();
  const { room: r1 } = dmRoomFor("a", "b", "matt", db);
  const { room: r2 } = dmRoomFor("a", "matt", "matt", db);
  expect(listDms("a", db).map(d => d.room).sort()).toEqual([r1, r2].sort());
  expect(listDms("b", db).map(d => d.room)).toEqual([r1]);
  expect(listDms("nobody", db)).toEqual([]);
});

test("a truncated-hash collision with a different pair fails loud instead of merging", () => {
  const db = fresh();
  const { room } = dmRoomFor("a", "b", "matt", db);
  // Simulate the 48-bit truncation colliding for a genuinely different pair —
  // dmRoomFor must refuse to treat this room as the ("c","d") DM.
  expect(() => {
    const collidingId = room;
    db.query("UPDATE chat_dms SET a = 'c', b = 'd' WHERE room = ?").run(collidingId);
  }).not.toThrow();
  expect(() => dmRoomFor("a", "b", "matt", db)).toThrow();
});
