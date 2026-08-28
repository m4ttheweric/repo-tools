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

/**
 * chat:sign-in now fires a welcome delivery through the same queued
 * microtask + InboxDeps seam as a post: a test whose resolve/deliver mocks
 * happen to answer for the just-signed-in session (most of this file's do,
 * since that is exactly what they are testing) sees that delivery land in
 * `calls` too. Awaiting the microtask then clearing the log is the seam
 * between "sign-in settled" and "now assert only the deliveries the test
 * actually cares about".
 */
async function settleWelcome(calls: unknown[]): Promise<void> {
  await Bun.sleep(0);
  calls.length = 0;
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
  await settleWelcome(calls);
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

test("a failed delivery batches with the next successful one, catching up the whole pending range", async () => {
  const calls: Array<[string, string]> = [];
  const sock = fakeSocketPath();
  let attempt = 0;
  const inboxDeps: InboxDeps = {
    resolve: () => ({ pid: process.pid, socketPath: sock, status: "idle" }),
    deliver: async (socketPath, content) => {
      attempt++;
      calls.push([socketPath, content]);
      return attempt === 1 ? { ok: false, error: "timeout" } : { ok: true };
    },
  };
  const h = freshHandlers(inboxDeps);
  await h["chat:sign-in"]({ sessionId: "sess-b", baseHandle: "b" });
  await settleWelcome(calls);
  attempt = 0;
  await h["chat:join"]({ room: "general", handle: "a" });
  await h["chat:join"]({ room: "general", handle: "b", wakeOn: "all" });
  const first = await h["chat:post"]({ room: "general", handle: "a", body: "one" });
  if (!first.ok) throw new Error("unreachable");
  await Bun.sleep(0);
  const second = await h["chat:post"]({ room: "general", handle: "a", body: "two" });
  if (!second.ok) throw new Error("unreachable");
  await Bun.sleep(0);
  expect(calls).toHaveLength(2);
  expect(calls[1]![1]).toBe("[#general] a: one\n[#general] a: two");
  expect(lastReadId(h.db, "general", "b")).toBe(second.data.id);
});

test("concurrent posts to the same recipient serialize delivery so a held first send never duplicates the backlog", async () => {
  const calls: Array<[string, string]> = [];
  const sock = fakeSocketPath();
  let releaseFirst: (() => void) | undefined;
  let deliverCount = 0;
  const inboxDeps: InboxDeps = {
    resolve: () => ({ pid: process.pid, socketPath: sock, status: "idle" }),
    deliver: async (socketPath, content) => {
      deliverCount++;
      calls.push([socketPath, content]);
      if (deliverCount === 1) {
        await new Promise<void>((resolve) => { releaseFirst = resolve; });
      }
      return { ok: true };
    },
  };
  const h = freshHandlers(inboxDeps);
  await h["chat:sign-in"]({ sessionId: "sess-b", baseHandle: "b" });
  await settleWelcome(calls);
  deliverCount = 0;
  await h["chat:join"]({ room: "general", handle: "a" });
  await h["chat:join"]({ room: "general", handle: "b", wakeOn: "all" });

  const first = await h["chat:post"]({ room: "general", handle: "a", body: "one" });
  if (!first.ok) throw new Error("unreachable");
  await Bun.sleep(0); // let the first delivery's synchronous prefix run and start blocking on deliver()

  const second = await h["chat:post"]({ room: "general", handle: "a", body: "two" });
  if (!second.ok) throw new Error("unreachable");
  await Bun.sleep(0); // let the second delivery register behind the first in the chain

  // The second delivery must not have started yet: it is chained behind the
  // first, which is still awaiting release.
  expect(calls).toHaveLength(1);

  releaseFirst?.();
  await Bun.sleep(0);
  await Bun.sleep(0);

  expect(calls).toHaveLength(2);
  expect(calls[0]![1]).toBe("[#general] a: one");
  expect(calls[1]![1]).toBe("[#general] a: two");
  expect(lastReadId(h.db, "general", "b")).toBe(second.data.id);
});

test("a held first delivery that ultimately fails still lets the second carry both bodies once released", async () => {
  const calls: Array<[string, string]> = [];
  const sock = fakeSocketPath();
  let releaseFirst: (() => void) | undefined;
  let attempt = 0;
  const inboxDeps: InboxDeps = {
    resolve: () => ({ pid: process.pid, socketPath: sock, status: "idle" }),
    deliver: async (socketPath, content) => {
      attempt++;
      calls.push([socketPath, content]);
      if (attempt === 1) {
        await new Promise<void>((resolve) => { releaseFirst = resolve; });
        return { ok: false, error: "timeout" };
      }
      return { ok: true };
    },
  };
  const h = freshHandlers(inboxDeps);
  await h["chat:sign-in"]({ sessionId: "sess-b", baseHandle: "b" });
  await settleWelcome(calls);
  attempt = 0;
  await h["chat:join"]({ room: "general", handle: "a" });
  await h["chat:join"]({ room: "general", handle: "b", wakeOn: "all" });

  const first = await h["chat:post"]({ room: "general", handle: "a", body: "one" });
  if (!first.ok) throw new Error("unreachable");
  await Bun.sleep(0);

  const second = await h["chat:post"]({ room: "general", handle: "a", body: "two" });
  if (!second.ok) throw new Error("unreachable");
  await Bun.sleep(0);

  expect(calls).toHaveLength(1); // second still chained behind the held first

  releaseFirst?.();
  await Bun.sleep(0);
  await Bun.sleep(0);

  expect(calls).toHaveLength(2);
  expect(calls[1]![1]).toBe("[#general] a: one\n[#general] a: two");
  expect(lastReadId(h.db, "general", "b")).toBe(second.data.id);
});

test("a resolver that throws is caught, leaving chat:post ok and no unhandled rejection", async () => {
  const rejections: unknown[] = [];
  const onRejection = (reason: unknown) => rejections.push(reason);
  process.on("unhandledRejection", onRejection);
  try {
    const inboxDeps: InboxDeps = {
      resolve: () => { throw new Error("registry scan exploded"); },
      deliver: async () => ({ ok: true }),
    };
    const h = freshHandlers(inboxDeps);
    await h["chat:sign-in"]({ sessionId: "sess-b", baseHandle: "b" });
    await h["chat:join"]({ room: "general", handle: "a" });
    await h["chat:join"]({ room: "general", handle: "b" });
    const posted = await h["chat:post"]({ room: "general", handle: "a", body: "@b hi" });
    expect(posted.ok).toBe(true);
    await Bun.sleep(0);
    expect(rejections).toEqual([]);
  } finally {
    process.off("unhandledRejection", onRejection);
  }
});

test("a signed-out recipient's inbox is never delivered to", async () => {
  const calls: Array<[string, string]> = [];
  const sock = fakeSocketPath();
  const inboxDeps: InboxDeps = {
    resolve: () => ({ pid: process.pid, socketPath: sock, status: "idle" }),
    deliver: async (socketPath, content) => { calls.push([socketPath, content]); return { ok: true }; },
  };
  const h = freshHandlers(inboxDeps);
  await h["chat:sign-in"]({ sessionId: "sess-b", baseHandle: "b" });
  await settleWelcome(calls);
  await h["chat:join"]({ room: "general", handle: "a" });
  await h["chat:join"]({ room: "general", handle: "b" });
  await h["chat:sign-out"]({ sessionId: "sess-b" });
  await h["chat:post"]({ room: "general", handle: "a", body: "@b hi" });
  await Bun.sleep(0);
  expect(calls).toEqual([]);
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
  await settleWelcome(calls);
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
  await settleWelcome(calls);
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
