import { beforeEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { openStateDb } from "../../state/index.ts";
import { createChatHandlers, type InboxDeps } from "../handlers/chat.ts";
import { drainNotifications, peekNotifications } from "../../notifier.ts";
import { setSetting } from "../../settings/write.ts";

let n = 0;
function freshHandlers(inboxDeps?: InboxDeps) {
  const db = openStateDb(join(tmpdir(), `chat-deliv-${process.pid}-${n++}.db`));
  return createChatHandlers({ db, emitEvent: () => 0, inboxDeps });
}

/** inboxAlive checks process.kill(pid,0) and existsSync(socketPath) for real; a live pid and a real (empty) file satisfy both without a listener, since `deliver` itself is faked. */
function fakeSocketPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "chat-deliv-sock-"));
  const p = join(dir, "s.sock");
  writeFileSync(p, "");
  return p;
}

function lastReadId(db: ReturnType<typeof openStateDb>, room: string, handle: string): number {
  return (db.query("SELECT last_read_id FROM chat_members WHERE room = ? AND handle = ?;").get(room, handle) as { last_read_id: number }).last_read_id;
}

beforeEach(() => {
  drainNotifications();
  setSetting("chat.humanHandle", "matt", "user");
});

test("posting to a room delivers the body to a signed-in recipient's inbox and advances their cursor", async () => {
  const calls: Array<[string, string]> = [];
  const sock = fakeSocketPath();
  const inboxDeps: InboxDeps = {
    resolve: (sessionId) => (sessionId === "sess-b" ? { pid: process.pid, socketPath: sock, status: "idle" } : null),
    deliver: async (socketPath, content) => { calls.push([socketPath, content]); return { ok: true }; },
  };
  const h = freshHandlers(inboxDeps);
  await h["chat:sign-in"]({ sessionId: "sess-b", baseHandle: "b" });
  await h["chat:join"]({ room: "general", handle: "a" });
  await h["chat:join"]({ room: "general", handle: "b" });
  const posted = await h["chat:post"]({ room: "general", handle: "a", body: "@b hi" });
  if (!posted.ok) throw new Error("unreachable");
  await Bun.sleep(0);
  expect(calls).toEqual([[sock, "[#general] a: @b hi"]]);
  expect(lastReadId(h.db, "general", "b")).toBe(posted.data.id);
});

test("a recipient whose resolver misses gets no deliver call and keeps unread", async () => {
  const calls: Array<[string, string]> = [];
  const inboxDeps: InboxDeps = {
    resolve: () => null,
    deliver: async (socketPath, content) => { calls.push([socketPath, content]); return { ok: true }; },
  };
  const h = freshHandlers(inboxDeps);
  await h["chat:sign-in"]({ sessionId: "sess-b", baseHandle: "b" });
  await h["chat:join"]({ room: "general", handle: "a" });
  await h["chat:join"]({ room: "general", handle: "b" });
  const before = lastReadId(h.db, "general", "b");
  const posted = await h["chat:post"]({ room: "general", handle: "a", body: "@b hi" });
  if (!posted.ok) throw new Error("unreachable");
  await Bun.sleep(0);
  expect(calls).toEqual([]);
  expect(lastReadId(h.db, "general", "b")).toBe(before);
});

test("a delivery failure leaves the recipient's cursor untouched", async () => {
  const sock = fakeSocketPath();
  const inboxDeps: InboxDeps = {
    resolve: () => ({ pid: process.pid, socketPath: sock, status: "idle" }),
    deliver: async () => ({ ok: false, error: "timeout" }),
  };
  const h = freshHandlers(inboxDeps);
  await h["chat:sign-in"]({ sessionId: "sess-b", baseHandle: "b" });
  await h["chat:join"]({ room: "general", handle: "a" });
  await h["chat:join"]({ room: "general", handle: "b" });
  const before = lastReadId(h.db, "general", "b");
  await h["chat:post"]({ room: "general", handle: "a", body: "@b hi" });
  await Bun.sleep(0);
  expect(lastReadId(h.db, "general", "b")).toBe(before);
});

test("a wake_on none member is never delivered even when signed in", async () => {
  const calls: Array<[string, string]> = [];
  const sock = fakeSocketPath();
  const inboxDeps: InboxDeps = {
    resolve: () => ({ pid: process.pid, socketPath: sock, status: "idle" }),
    deliver: async (socketPath, content) => { calls.push([socketPath, content]); return { ok: true }; },
  };
  const h = freshHandlers(inboxDeps);
  await h["chat:sign-in"]({ sessionId: "sess-c", baseHandle: "c" });
  await h["chat:join"]({ room: "general", handle: "a" });
  await h["chat:join"]({ room: "general", handle: "c", wakeOn: "none" });
  await h["chat:post"]({ room: "general", handle: "a", body: "hello" });
  await Bun.sleep(0);
  expect(calls).toEqual([]);
});

test("a dm post renders with the [dm] tag, not the room hash", async () => {
  const calls: Array<[string, string]> = [];
  const sock = fakeSocketPath();
  const inboxDeps: InboxDeps = {
    resolve: () => ({ pid: process.pid, socketPath: sock, status: "idle" }),
    deliver: async (socketPath, content) => { calls.push([socketPath, content]); return { ok: true }; },
  };
  const h = freshHandlers(inboxDeps);
  await h["chat:sign-in"]({ sessionId: "sess-a", baseHandle: "a" });
  await h["chat:sign-in"]({ sessionId: "sess-b", baseHandle: "b" });
  await h["chat:dm"]({ from: "a", to: "b", body: "hi" });
  await Bun.sleep(0);
  expect(calls).toEqual([[sock, "[dm] a: hi"]]);
});

test("the desk-notification path still fires on a mention, independent of inbox delivery", async () => {
  const h = freshHandlers();
  await h["chat:join"]({ room: "r", handle: "agent" });
  await h["chat:post"]({ room: "r", handle: "agent", body: "@matt look" });
  await Bun.sleep(0);
  expect(peekNotifications()).toHaveLength(1);
});
