/**
 * lib/state/chat-store.ts — pruneMessages coverage (R053).
 */
import { expect, test } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import type { Database } from "bun:sqlite";
import { openStateDb } from "../db.ts";
import { pruneMessages, CHAT_RETENTION_MS, CHAT_ROOM_FLOOR } from "../chat-store.ts";

let n = 0;
function freshDb(): Database {
  return openStateDb(join(tmpdir(), `chat-prune-test-${process.pid}-${n++}.db`));
}

const INSERT_SQL = "INSERT INTO chat_messages (room, handle, body, mentions, reply_to, posted_at) VALUES (?, ?, ?, ?, ?, ?);";

function seedMessage(db: Database, room: string, postedAt: number): void {
  db.query(INSERT_SQL).run(room, "agent", "hi", null, null, postedAt);
}

function countMessages(db: Database, room: string): number {
  return (db.query("SELECT COUNT(*) AS n FROM chat_messages WHERE room = ?;").get(room) as { n: number }).n;
}

test("named constants carry the documented retention values", () => {
  expect(CHAT_RETENTION_MS).toBe(90 * 24 * 60 * 60 * 1000);
  expect(CHAT_ROOM_FLOOR).toBe(200);
});

test("deletes messages past the age floor but never below perRoomFloor", () => {
  const db = freshDb();
  const old = Date.now() - 10_000;
  for (let i = 0; i < 5; i++) seedMessage(db, "build", old);

  const { removed } = pruneMessages(db, { olderThanMs: 500, perRoomFloor: 2 });

  expect(removed).toBe(3);
  expect(countMessages(db, "build")).toBe(2);
});

test("leaves a room with only recent messages untouched", () => {
  const db = freshDb();
  const now = Date.now();
  for (let i = 0; i < 5; i++) seedMessage(db, "build", now);

  const { removed } = pruneMessages(db, { olderThanMs: 500, perRoomFloor: 2 });

  expect(removed).toBe(0);
  expect(countMessages(db, "build")).toBe(5);
});

test("never empties a live room even when every message is old", () => {
  const db = freshDb();
  const old = Date.now() - 10_000;
  for (let i = 0; i < 3; i++) seedMessage(db, "build", old);

  const { removed } = pruneMessages(db, { olderThanMs: 500, perRoomFloor: 3 });

  expect(removed).toBe(0);
  expect(countMessages(db, "build")).toBe(3);
});

test("prunes independently per room", () => {
  const db = freshDb();
  const old = Date.now() - 10_000;
  for (let i = 0; i < 5; i++) seedMessage(db, "a", old);
  for (let i = 0; i < 5; i++) seedMessage(db, "b", old);

  const { removed } = pruneMessages(db, { olderThanMs: 500, perRoomFloor: 2 });

  expect(removed).toBe(6);
  expect(countMessages(db, "a")).toBe(2);
  expect(countMessages(db, "b")).toBe(2);
});

test("defaults to CHAT_RETENTION_MS/CHAT_ROOM_FLOOR when opts are omitted", () => {
  const db = freshDb();
  const now = Date.now();
  seedMessage(db, "build", now);

  const { removed } = pruneMessages(db, {});

  expect(removed).toBe(0);
});
