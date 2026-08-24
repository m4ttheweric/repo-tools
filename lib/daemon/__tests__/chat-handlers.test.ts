import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { tmpdir } from "os";
import { join } from "path";
import { openStateDb } from "../../state/index.ts";
import { createChatHandlers } from "../handlers/chat.ts";

let n = 0;
function freshHandlers(emitEvent: (topic: string, payload?: unknown) => number = () => 0) {
  const db = openStateDb(join(tmpdir(), `chat-h-${process.pid}-${n++}.db`));
  return createChatHandlers({ db, emitEvent });
}

function snapshotChatTables(db: Database) {
  return {
    members: db.query("SELECT * FROM chat_members ORDER BY room, handle;").all(),
    messages: db.query("SELECT * FROM chat_messages ORDER BY id;").all(),
  };
}

test("chat:join returns the resolved handle and member count", async () => {
  const h = freshHandlers();
  const res = await h["chat:join"]({ room: "build", handle: "a" });
  expect(res.ok).toBe(true);
  if (!res.ok) throw new Error("unreachable");
  expect(res.data).toMatchObject({ handle: "a", memberCount: 1 });
});

test("chat:join rejects an invalid handle with a reason rather than normalizing it", async () => {
  const h = freshHandlers();
  const res = await h["chat:join"]({ room: "build", handle: "Has@Sigil" });
  expect(res.ok).toBe(false);
  if (res.ok) throw new Error("unreachable");
  expect(res.error).toContain("handle");
});

test("chat:post returns the recipients and emits one wake event per recipient", async () => {
  const emitted: string[] = [];
  const h = freshHandlers((topic) => { emitted.push(topic); return 0; });
  await h["chat:join"]({ room: "r", handle: "a" });
  await h["chat:join"]({ room: "r", handle: "b" });
  const res = await h["chat:post"]({ room: "r", handle: "a", body: "@b hi" });
  expect(res.ok).toBe(true);
  if (!res.ok) throw new Error("unreachable");
  expect(res.data).toMatchObject({ recipients: ["b"] });
  expect(emitted).toEqual(["chat/r/msg", "chat/wake/b"]);
});

test("chat:unread-waking reports what would wake a handle without advancing its cursor", async () => {
  const h = freshHandlers();
  await h["chat:join"]({ room: "r", handle: "a" });
  await h["chat:join"]({ room: "r", handle: "b" });
  await h["chat:post"]({ room: "r", handle: "a", body: "@b hi" });
  const res1 = await h["chat:unread-waking"]({ handle: "b" });
  if (!res1.ok) throw new Error("unreachable");
  const first = res1.data;
  expect(first).toMatchObject({ rooms: [{ room: "r", count: 1, mentions: 1 }] });
  // maxId is the watermark Task 8's step 4 skips at or below; without it the
  // tail cannot tell which wakes the catch-up already covered.
  expect(first.rooms[0]!.maxId).toBeGreaterThan(0);
  const res2 = await h["chat:unread-waking"]({ handle: "b" });
  if (!res2.ok) throw new Error("unreachable");
  expect(res2.data).toEqual(first);
});

test("the read-only handlers mutate nothing", async () => {
  const h = freshHandlers();
  await h["chat:join"]({ room: "r", handle: "a" });
  await h["chat:join"]({ room: "r", handle: "b" });
  await h["chat:post"]({ room: "r", handle: "a", body: "@b hello" });
  const before = snapshotChatTables(h.db);
  await h["chat:rooms"]({ handle: "b" });
  await h["chat:who"]({ room: "r" });
  await h["chat:messages"]({ room: "r", limit: 20 });
  await h["chat:unread-waking"]({ handle: "b" });
  expect(snapshotChatTables(h.db)).toEqual(before);
});
