import { beforeEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { tmpdir } from "os";
import { join } from "path";
import { openStateDb } from "../../state/index.ts";
import { createChatHandlers } from "../handlers/chat.ts";
import { drainNotifications, loadNotificationPrefs, peekNotifications, saveNotificationPrefs } from "../../notifier.ts";

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

beforeEach(() => { drainNotifications(); });

test("notifies on a mention even when the human has never joined the room", async () => {
  // The common case, not an edge: agents create rooms via join-creates and
  // Matt is not a member until he posts. Gating this on recipientsFor -- which
  // reads chat_members and can only return members -- means the desk never
  // rings for the very question the skill tells agents to ask him.
  const h = freshHandlers();
  await h["chat:join"]({ room: "r", handle: "agent" });
  await h["chat:post"]({ room: "r", handle: "agent", body: "@matt ok to force-release?" });
  expect(peekNotifications()).toHaveLength(1);
});

test("notifies even when the human is a member with wake_on none", async () => {
  // Plausible for a human who does not want a waiter armed; his wake setting
  // must not silently disable his desk notifications.
  const h = freshHandlers();
  await h["chat:join"]({ room: "r", handle: "agent" });
  await h["chat:join"]({ room: "r", handle: "matt", wakeOn: "none" });
  await h["chat:post"]({ room: "r", handle: "agent", body: "@matt still there?" });
  expect(peekNotifications()).toHaveLength(1);
});

test("does not notify on a mention of anyone else", async () => {
  const h = freshHandlers();
  await h["chat:join"]({ room: "r", handle: "agent" });
  await h["chat:post"]({ room: "r", handle: "agent", body: "@nobody hello" });
  expect(peekNotifications()).toHaveLength(0);
});

test("chat_mention disabled in prefs suppresses the notification entirely", async () => {
  const saved = loadNotificationPrefs();
  try {
    saveNotificationPrefs({ ...saved, chat_mention: false });
    const h = freshHandlers();
    await h["chat:join"]({ room: "r", handle: "agent" });
    await h["chat:post"]({ room: "r", handle: "agent", body: "@matt hi" });
    expect(peekNotifications()).toHaveLength(0);
  } finally {
    saveNotificationPrefs(saved);
  }
});
