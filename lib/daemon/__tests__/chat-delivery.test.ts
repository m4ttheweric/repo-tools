import { beforeEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { Logger } from "pino";
import { openStateDb, presenceForSession, type RegistryDeps } from "../../state/index.ts";
import type { InboxBinding } from "../../claude-registry.ts";
import { createChatDeliverySweep, createChatHandlers, pendingIncludesRecipient, planSweepTargets, type InboxDeps } from "../handlers/chat.ts";
import { drainNotifications, peekNotifications } from "../../notifier.ts";
import { setSetting } from "../../settings/write.ts";
import { herdrRequest } from "../../herdr/client.ts";
import { fakeHerdr, type FakeHerdrHandler } from "../../herdr/__tests__/fake-herdr.ts";

let n = 0;
function freshHandlers(inboxDeps?: InboxDeps, herdr?: typeof herdrRequest, extra?: { log?: Logger; retryDelayMs?: number }) {
  const db = openStateDb(join(tmpdir(), `chat-deliv-${process.pid}-${n++}.db`));
  // Handlers no longer expose `db` (R028); tests that need to reach the
  // underlying table directly get it back alongside the handler map.
  return Object.assign(createChatHandlers({ db, emitEvent: () => 0, inboxDeps, herdr, ...extra }), { db });
}

/** Captures warn/info calls without pulling in a real pino instance. */
function fakeLogger() {
  const warnCalls: unknown[][] = [];
  const infoCalls: unknown[][] = [];
  const log = {
    warn: (...args: unknown[]) => { warnCalls.push(args); },
    info: (...args: unknown[]) => { infoCalls.push(args); },
    debug: () => {},
    error: () => {},
  } as unknown as Logger;
  return { log, warnCalls, infoCalls };
}

/** Points a real `herdrRequest` at a fake unix-socket herdr server for the duration of one test. */
function fakeHerdrClient(handler: FakeHerdrHandler) {
  const { sock, seen, stop } = fakeHerdr(handler);
  const herdr: typeof herdrRequest = (m, p, o) => herdrRequest(m, p, { ...o, sockPath: sock });
  return { herdr, seen, stop };
}

/** The badge call is a real unix-socket round trip past the queued delivery microtask, so a bare `Bun.sleep(0)` isn't enough; poll instead of guessing a fixed delay. */
async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor: timed out");
    await Bun.sleep(5);
  }
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

// Kept as a literal (not imported from inbox.ts) so an accidental change to
// the shipped steer line fails these assertions instead of vanishing into a
// tautology.
const STEER =
  'reply via rt chat post <room> "..." or rt chat dm <handle> "..." (never SendMessage; this arrived through rt chat)';

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
  expect(calls).toEqual([
    [sock, `<cross-session-message from-name="a (#general)">\n[#general] a: @b hi\n${STEER}\n</cross-session-message>`],
  ]);
  expect(lastReadId(h.db, "general", "b")).toBe(posted.data.id);
});

test("a successful delivery refreshes the recipient's last_seen_at -- the only remaining route to it now that chat:pulse is gone", async () => {
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
  const before = presenceForSession("sess-b", h.db)!.lastSeenAt;
  await Bun.sleep(2); // last_seen_at is a millisecond Date.now() stamp; the post must land strictly after sign-in's own stamp
  const posted = await h["chat:post"]({ room: "general", handle: "a", body: "@b hi" });
  if (!posted.ok) throw new Error("unreachable");
  await Bun.sleep(0);
  expect(calls).toHaveLength(1);
  expect(presenceForSession("sess-b", h.db)!.lastSeenAt).toBeGreaterThan(before);
});

test("a successful welcome delivery also refreshes last_seen_at", async () => {
  const calls: Array<[string, string]> = [];
  const sock = fakeSocketPath();
  // Held until the test explicitly releases it, so the sentinel write below
  // is guaranteed to land strictly BEFORE touchLastSeen's own write, rather
  // than racing the queued welcome-delivery microtask against a clock tick
  // (a millisecond stamp and a bare Bun.sleep were flaky here).
  let releaseDeliver: () => void = () => {};
  const deliverGate = new Promise<void>((resolve) => { releaseDeliver = resolve; });
  const inboxDeps: InboxDeps = {
    resolve: (sessionId) => (sessionId === "sess-c" ? { pid: process.pid, socketPath: sock, status: "idle" } : null),
    deliver: async (socketPath, content) => {
      await deliverGate;
      calls.push([socketPath, content]);
      return { ok: true };
    },
  };
  const h = freshHandlers(inboxDeps);
  const signedIn = await h["chat:sign-in"]({ sessionId: "sess-c", baseHandle: "c" });
  if (!signedIn.ok) throw new Error("unreachable");

  // Let the queued welcome delivery run up to (and block on) the gate.
  await Bun.sleep(0);
  expect(calls).toHaveLength(0); // still held -- proves the gate is doing its job, not skipping delivery

  const SENTINEL = 0;
  h.db.run("UPDATE chat_presence SET last_seen_at = ? WHERE session_id = ?", [SENTINEL, "sess-c"]);
  expect(presenceForSession("sess-c", h.db)!.lastSeenAt).toBe(SENTINEL);

  releaseDeliver();
  await Bun.sleep(0); // drain: deliver() resolves, markDelivered + touchLastSeen run

  expect(calls).toHaveLength(1); // the welcome frame landed
  expect(presenceForSession("sess-c", h.db)!.lastSeenAt).toBeGreaterThan(SENTINEL);
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

test("a delivery failure paints the recipient's pane with an unread badge over herdr", async () => {
  const sock = fakeSocketPath();
  const inboxDeps: InboxDeps = {
    resolve: () => ({ pid: process.pid, socketPath: sock, status: "idle" }),
    deliver: async () => ({ ok: false, error: "timeout" }),
  };
  const { herdr, seen, stop } = fakeHerdrClient(() => ({}));
  const h = freshHandlers(inboxDeps, herdr);
  await h["chat:sign-in"]({ sessionId: "sess-b", baseHandle: "b", pane: "w1:p1" });
  await h["chat:join"]({ room: "general", handle: "a" });
  await h["chat:join"]({ room: "general", handle: "b" });
  await h["chat:post"]({ room: "general", handle: "a", body: "@b hi" });
  await waitFor(() => seen.some((r) => r.method === "pane.report_metadata"));
  const badge = seen.find((r) => r.method === "pane.report_metadata");
  expect(badge?.params).toMatchObject({ pane_id: "w1:p1", source: "rt-chat", tokens: { chat_unread: "1" }, ttl_ms: 600_000 });
  // herdr's report_metadata schema types `seq` as a uint64 INTEGER -- a
  // number, never a bigint-derived string (which herdr would reject as
  // invalid_request and drop the badge silently).
  const params = badge?.params as { seq?: unknown } | undefined;
  expect(typeof params?.seq).toBe("number");
  expect(Number.isInteger(params?.seq)).toBe(true);
  stop();
});

test("two badges in the same delivery chain get strictly increasing seq numbers", async () => {
  const sock = fakeSocketPath();
  const inboxDeps: InboxDeps = {
    resolve: () => ({ pid: process.pid, socketPath: sock, status: "idle" }),
    deliver: async () => ({ ok: false, error: "timeout" }),
  };
  const { herdr, seen, stop } = fakeHerdrClient(() => ({}));
  const h = freshHandlers(inboxDeps, herdr);
  await h["chat:sign-in"]({ sessionId: "sess-b", baseHandle: "b", pane: "w1:p1" });
  await h["chat:join"]({ room: "general", handle: "a" });
  await h["chat:join"]({ room: "general", handle: "b" });
  await h["chat:post"]({ room: "general", handle: "a", body: "@b one" });
  await h["chat:post"]({ room: "general", handle: "a", body: "@b two" });
  await waitFor(() => seen.filter((r) => r.method === "pane.report_metadata").length >= 2);
  const badges = seen.filter((r) => r.method === "pane.report_metadata").map((r) => (r.params as { seq: number }).seq);
  expect(badges.length).toBeGreaterThanOrEqual(2);
  for (let i = 1; i < badges.length; i++) expect(badges[i]).toBeGreaterThan(badges[i - 1]!);
  stop();
});

test("a successful delivery never paints an unread badge", async () => {
  const sock = fakeSocketPath();
  const inboxDeps: InboxDeps = {
    resolve: () => ({ pid: process.pid, socketPath: sock, status: "idle" }),
    deliver: async () => ({ ok: true }),
  };
  const { herdr, seen, stop } = fakeHerdrClient(() => ({}));
  const h = freshHandlers(inboxDeps, herdr);
  await h["chat:sign-in"]({ sessionId: "sess-b", baseHandle: "b", pane: "w1:p1" });
  await h["chat:join"]({ room: "general", handle: "a" });
  await h["chat:join"]({ room: "general", handle: "b" });
  await h["chat:post"]({ room: "general", handle: "a", body: "@b hi" });
  await Bun.sleep(50); // give a stray badge call, if any, time to land before asserting its absence
  expect(seen.find((r) => r.method === "pane.report_metadata")).toBeUndefined();
  stop();
});

test("a delivery failure with no pane on presence skips the badge call entirely", async () => {
  const sock = fakeSocketPath();
  const inboxDeps: InboxDeps = {
    resolve: () => ({ pid: process.pid, socketPath: sock, status: "idle" }),
    deliver: async () => ({ ok: false, error: "timeout" }),
  };
  const { herdr, seen, stop } = fakeHerdrClient(() => ({}));
  const h = freshHandlers(inboxDeps, herdr);
  await h["chat:sign-in"]({ sessionId: "sess-b", baseHandle: "b" }); // no pane
  await h["chat:join"]({ room: "general", handle: "a" });
  await h["chat:join"]({ room: "general", handle: "b" });
  const posted = await h["chat:post"]({ room: "general", handle: "a", body: "@b hi" });
  expect(posted.ok).toBe(true);
  await Bun.sleep(50); // give a stray badge call, if any, time to land before asserting its absence
  expect(seen.find((r) => r.method === "pane.report_metadata")).toBeUndefined();
  stop();
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

test("one retry on a failed push: fails once then succeeds -- single frame, cursor advanced, no badge", async () => {
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
  const { herdr, seen, stop } = fakeHerdrClient(() => ({}));
  const { log, warnCalls, infoCalls } = fakeLogger();
  const h = freshHandlers(inboxDeps, herdr, { log, retryDelayMs: 1 });
  await h["chat:sign-in"]({ sessionId: "sess-b", baseHandle: "b", pane: "w1:p1" });
  await settleWelcome(calls);
  attempt = 0;
  await h["chat:join"]({ room: "general", handle: "a" });
  await h["chat:join"]({ room: "general", handle: "b", wakeOn: "all" });
  const posted = await h["chat:post"]({ room: "general", handle: "a", body: "hi" });
  if (!posted.ok) throw new Error("unreachable");
  await waitFor(() => calls.length >= 2);
  expect(calls).toHaveLength(2); // the failed attempt, then the retry
  expect(calls[1]![1]).toBe(
    `<cross-session-message from-name="a (#general)">\n[#general] a: hi\n${STEER}\n</cross-session-message>`,
  );
  expect(lastReadId(h.db, "general", "b")).toBe(posted.data.id);
  await Bun.sleep(20); // give a stray badge/warn time to land before asserting their absence
  expect(seen.find((r) => r.method === "pane.report_metadata")).toBeUndefined();
  expect(warnCalls).toHaveLength(0); // an invisible transient must not log -- the seams cover it
  expect(infoCalls).toHaveLength(0);
  stop();
});

test("both delivery attempts failing logs a warn with recipient, room, and the raw error string, then still badges", async () => {
  const sock = fakeSocketPath();
  const inboxDeps: InboxDeps = {
    resolve: () => ({ pid: process.pid, socketPath: sock, status: "idle" }),
    deliver: async () => ({ ok: false, error: "timeout" }),
  };
  const { herdr, seen, stop } = fakeHerdrClient(() => ({}));
  const { log, warnCalls } = fakeLogger();
  const h = freshHandlers(inboxDeps, herdr, { log, retryDelayMs: 1 });
  await h["chat:sign-in"]({ sessionId: "sess-b", baseHandle: "b", pane: "w1:p1" });
  await h["chat:join"]({ room: "general", handle: "a" });
  await h["chat:join"]({ room: "general", handle: "b" });
  await h["chat:post"]({ room: "general", handle: "a", body: "@b hi" });
  await waitFor(() => warnCalls.length >= 1);
  expect(warnCalls[0]![0]).toMatchObject({ recipient: "b", room: "general", err: "timeout" });
  await waitFor(() => seen.some((r) => r.method === "pane.report_metadata"));
  stop();
});

test("a failed delivery (both attempts) batches with the next successful one, catching up the whole pending range", async () => {
  const calls: Array<[string, string]> = [];
  const sock = fakeSocketPath();
  let attempt = 0;
  let releaseFirst: (() => void) | undefined;
  const inboxDeps: InboxDeps = {
    resolve: () => ({ pid: process.pid, socketPath: sock, status: "idle" }),
    deliver: async (socketPath, content) => {
      attempt++;
      calls.push([socketPath, content]);
      if (attempt === 1) {
        await new Promise<void>((resolve) => { releaseFirst = resolve; });
        return { ok: false, error: "timeout" };
      }
      return attempt === 2 ? { ok: false, error: "timeout" } : { ok: true };
    },
  };
  const h = freshHandlers(inboxDeps, undefined, { retryDelayMs: 1 });
  await h["chat:sign-in"]({ sessionId: "sess-b", baseHandle: "b" });
  await settleWelcome(calls);
  attempt = 0;
  await h["chat:join"]({ room: "general", handle: "a" });
  await h["chat:join"]({ room: "general", handle: "b", wakeOn: "all" });
  const first = await h["chat:post"]({ room: "general", handle: "a", body: "one" });
  if (!first.ok) throw new Error("unreachable");
  await waitFor(() => calls.length >= 1); // attempt 1 registered, now blocked on the gate
  const second = await h["chat:post"]({ room: "general", handle: "a", body: "two" });
  if (!second.ok) throw new Error("unreachable");
  await Bun.sleep(0);
  expect(calls).toHaveLength(1); // second is chained behind the still-held first
  releaseFirst?.();
  await waitFor(() => calls.length >= 3); // attempt1 (held, fails), attempt2 (retry, fails), attempt3 (post two, succeeds and catches up both)
  expect(calls[2]![1]).toBe(
    `<cross-session-message from-name="rt chat (2 messages)">\n[#general] a: one\n[#general] a: two\n${STEER}\n</cross-session-message>`,
  );
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
  expect(calls[0]![1]).toBe(`<cross-session-message from-name="a (#general)">\n[#general] a: one\n${STEER}\n</cross-session-message>`);
  expect(calls[1]![1]).toBe(`<cross-session-message from-name="a (#general)">\n[#general] a: two\n${STEER}\n</cross-session-message>`);
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
      // The automatic retry (attempt 2) also fails, so the held delivery
      // stays genuinely stuck and only the second post's own send (attempt
      // 3) recovers it -- this test is about the next-post safety net, not
      // the retry.
      return attempt === 2 ? { ok: false, error: "timeout" } : { ok: true };
    },
  };
  const h = freshHandlers(inboxDeps, undefined, { retryDelayMs: 1 });
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
  await waitFor(() => calls.length >= 3); // held attempt fails, retry fails, then post two's own send catches up both

  expect(calls[2]![1]).toBe(
    `<cross-session-message from-name="rt chat (2 messages)">\n[#general] a: one\n[#general] a: two\n${STEER}\n</cross-session-message>`,
  );
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
  expect(calls).toEqual([[sock, `<cross-session-message from-name="a (dm)">\n[dm] a: hi\n${STEER}\n</cross-session-message>`]]);
});

test("the desk-notification path still fires on a mention, independent of inbox delivery", async () => {
  const h = freshHandlers();
  await h["chat:join"]({ room: "r", handle: "agent" });
  await h["chat:post"]({ room: "r", handle: "agent", body: "@matt look" });
  await Bun.sleep(0);
  expect(peekNotifications()).toHaveLength(1);
});

test("a failed welcome delivery leaves the catch-up cursor untouched; the same message re-batches into a later successful welcome", async () => {
  const sock = fakeSocketPath();
  let deliverOk = false;
  const inboxDeps: InboxDeps = {
    resolve: (sessionId) => (sessionId === "sess-b" ? { pid: process.pid, socketPath: sock, status: "idle" } : null),
    deliver: async () => (deliverOk ? { ok: true } : { ok: false, error: "boom" }),
  };
  const h = freshHandlers(inboxDeps);
  await h["chat:join"]({ room: "r", handle: "a" });
  await h["chat:join"]({ room: "r", handle: "b" });
  await h["chat:post"]({ room: "r", handle: "a", body: "hello" });
  await Bun.sleep(0);

  const before = lastReadId(h.db, "r", "b");

  await h["chat:sign-in"]({ sessionId: "sess-b", baseHandle: "b" });
  await Bun.sleep(0);
  expect(lastReadId(h.db, "r", "b")).toBe(before); // welcome delivery failed: cursor must not move

  await h["chat:sign-out"]({ sessionId: "sess-b" });
  deliverOk = true;
  await h["chat:sign-in"]({ sessionId: "sess-b", baseHandle: "b" });
  await Bun.sleep(0);
  expect(lastReadId(h.db, "r", "b")).toBeGreaterThan(before); // same unread, now shown and confirmed: cursor advances
});

// ─── planSweepTargets (pure planner) ────────────────────────────────────────

test("planSweepTargets keeps a stale pair whose recipient is signed in with an alive binding", () => {
  const stale = [{ room: "r", handle: "b", maxId: 5, wakeOn: "all" as const }];
  const presenceByHandle = new Map([["b", { sessionId: "sess-b" }]]);
  const alive = new Set(["sess-b"]);
  expect(planSweepTargets(stale, presenceByHandle, alive)).toEqual(stale);
});

test("planSweepTargets drops a stale pair with no presence row at all", () => {
  const stale = [{ room: "r", handle: "ghost", maxId: 5, wakeOn: "all" as const }];
  expect(planSweepTargets(stale, new Map(), new Set())).toEqual([]);
});

test("planSweepTargets drops a signed-out recipient even with a presence row", () => {
  const stale = [{ room: "r", handle: "b", maxId: 5, wakeOn: "all" as const }];
  const presenceByHandle = new Map([["b", { sessionId: "sess-b", signedOutAt: 123 }]]);
  const alive = new Set(["sess-b"]);
  expect(planSweepTargets(stale, presenceByHandle, alive)).toEqual([]);
});

test("planSweepTargets drops a signed-in recipient whose binding is not alive", () => {
  const stale = [{ room: "r", handle: "b", maxId: 5, wakeOn: "all" as const }];
  const presenceByHandle = new Map([["b", { sessionId: "sess-b" }]]);
  expect(planSweepTargets(stale, presenceByHandle, new Set())).toEqual([]); // alive set is empty
});

// Review finding 1/8: a wake_on:"none" member is dropped purely, with no
// pendingMessages fetch needed -- the sweep must never treat "none" as
// though it were "all" just because the member happens to be signed in with
// an alive binding.
test("planSweepTargets drops a wake_on:none member even when signed in with an alive binding", () => {
  const stale = [{ room: "r", handle: "silent", maxId: 5, wakeOn: "none" as const }];
  const presenceByHandle = new Map([["silent", { sessionId: "sess-silent" }]]);
  const alive = new Set(["sess-silent"]);
  expect(planSweepTargets(stale, presenceByHandle, alive)).toEqual([]);
});

test("planSweepTargets filters a mixed batch independently, keeping order", () => {
  const stale = [
    { room: "r1", handle: "live", maxId: 1, wakeOn: "all" as const },
    { room: "r2", handle: "ghost", maxId: 2, wakeOn: "all" as const },
    { room: "r3", handle: "away", maxId: 3, wakeOn: "all" as const },
    { room: "r4", handle: "dead-binding", maxId: 4, wakeOn: "all" as const },
    { room: "r5", handle: "silent", maxId: 5, wakeOn: "none" as const },
  ];
  const presenceByHandle = new Map([
    ["live", { sessionId: "sess-live" }],
    ["away", { sessionId: "sess-away", signedOutAt: 999 }],
    ["dead-binding", { sessionId: "sess-dead" }],
    ["silent", { sessionId: "sess-silent" }],
  ]);
  const alive = new Set(["sess-live", "sess-silent"]);
  expect(planSweepTargets(stale, presenceByHandle, alive)).toEqual([{ room: "r1", handle: "live", maxId: 1, wakeOn: "all" }]);
});

// ─── pendingIncludesRecipient (pure: wake_on/mention parity with recipientsFromMembers) ──

test("pendingIncludesRecipient is false outright for wake_on:none, regardless of pending content", () => {
  expect(pendingIncludesRecipient([{ handle: "a", mentions: ["b"] }], "b", "none")).toBe(false);
});

test("pendingIncludesRecipient is true for wake_on:all on any non-author message", () => {
  expect(pendingIncludesRecipient([{ handle: "a", mentions: [] }], "b", "all")).toBe(true);
});

test("pendingIncludesRecipient never counts the recipient's own message, even under wake_on:all", () => {
  expect(pendingIncludesRecipient([{ handle: "b", mentions: [] }], "b", "all")).toBe(false);
});

test("pendingIncludesRecipient is true for wake_on:mention when a pending message names the handle", () => {
  expect(pendingIncludesRecipient([{ handle: "a", mentions: ["nobody"] }, { handle: "a", mentions: ["b"] }], "b", "mention")).toBe(true);
});

test("pendingIncludesRecipient is true for wake_on:mention on an @here message", () => {
  expect(pendingIncludesRecipient([{ handle: "a", mentions: ["here"] }], "b", "mention")).toBe(true);
});

test("pendingIncludesRecipient is false for wake_on:mention when nothing pending ever names the handle", () => {
  expect(pendingIncludesRecipient([{ handle: "a", mentions: [] }, { handle: "a", mentions: ["someone-else"] }], "b", "mention")).toBe(false);
});

// ─── createChatDeliverySweep (wiring) ───────────────────────────────────────

function freshSweep(inboxDeps: InboxDeps, opts?: { herdr?: typeof herdrRequest; log?: Logger; retryDelayMs?: number; registryDeps?: RegistryDeps }) {
  const db = openStateDb(join(tmpdir(), `chat-sweep-${process.pid}-${n++}.db`));
  const deliveryChains = new Map<string, Promise<void>>();
  const sweep = createChatDeliverySweep({ db, deliveryChains, inboxDeps, ...opts });
  return { db, deliveryChains, sweep };
}

test("the sweep is a no-op when nothing is stale", async () => {
  const calls: Array<[string, string]> = [];
  const inboxDeps: InboxDeps = {
    resolve: () => ({ pid: process.pid, socketPath: fakeSocketPath(), status: "idle" }),
    deliver: async (socketPath, content) => { calls.push([socketPath, content]); return { ok: true }; },
  };
  const { db, sweep } = freshSweep(inboxDeps);
  const h = Object.assign(createChatHandlers({ db, emitEvent: () => 0, inboxDeps }), { db });
  await h["chat:join"]({ room: "general", handle: "a" });
  const result = await sweep();
  expect(result).toEqual({ swept: 0, recovered: 0 });
  expect(calls).toEqual([]);
});

test("the sweep re-delivers a stale cursor for a signed-in, alive-bound recipient through the real deliver path", async () => {
  const calls: Array<[string, string]> = [];
  const sock = fakeSocketPath();
  // The registry resolver misses "b" at post time (modeling exactly the
  // incident: a binding the daemon can't resolve yet/right now) and only
  // starts answering once the sweep runs -- the normal per-post delivery
  // never gets a chance to advance the cursor, so it is genuinely stuck
  // until the sweep discovers it.
  let resolverReady = false;
  const binding: InboxBinding = { pid: process.pid, socketPath: sock, status: "idle" };
  const inboxDeps: InboxDeps = {
    resolve: (sessionId) => (resolverReady && sessionId === "sess-b" ? binding : null),
    deliver: async (socketPath, content) => { calls.push([socketPath, content]); return { ok: true }; },
  };
  // The sweep's own presence/binding pre-check goes through registryDeps
  // (finding 2), separately from inboxDeps -- gated on the same
  // resolverReady flag so both come alive together.
  const registryDeps: RegistryDeps = {
    resolve: (sessionId) => (resolverReady && sessionId === "sess-b" ? binding : null),
    alive: () => true,
    resolveAll: () => new Map(resolverReady ? [["sess-b", binding] as const] : []),
  };
  const { log, infoCalls } = fakeLogger();
  const { db, sweep } = freshSweep(inboxDeps, { log, registryDeps });
  const h = Object.assign(createChatHandlers({ db, emitEvent: () => 0, inboxDeps }), { db });
  await h["chat:join"]({ room: "general", handle: "a" });
  await h["chat:join"]({ room: "general", handle: "b" });

  const signIn = (await import("../../state/index.ts")).signIn;
  signIn({ sessionId: "sess-b", baseHandle: "b" }, db);

  const posted = await h["chat:post"]({ room: "general", handle: "a", body: "hi" });
  if (!posted.ok) throw new Error("unreachable");
  await Bun.sleep(0); // the queued post delivery ran and missed (resolver not ready), just like the incident
  expect(calls).toEqual([]);
  expect(lastReadId(db, "general", "b")).toBeLessThan(posted.data.id);

  resolverReady = true;
  const result = await sweep();
  expect(result).toEqual({ swept: 1, recovered: 1 });
  expect(calls).toHaveLength(1);
  expect(lastReadId(db, "general", "b")).toBe(posted.data.id);
  expect(infoCalls[0]![0]).toMatchObject({ recipient: "b", room: "general", recovered: 1 });
});

test("the sweep never re-delivers a poster's own message back to themselves", async () => {
  const calls: Array<[string, string]> = [];
  const sock = fakeSocketPath();
  const inboxDeps: InboxDeps = {
    resolve: (sessionId) => (sessionId === "sess-a" ? { pid: process.pid, socketPath: sock, status: "idle" } : null),
    deliver: async (socketPath, content) => { calls.push([socketPath, content]); return { ok: true }; },
  };
  const { db, sweep } = freshSweep(inboxDeps);
  const h = Object.assign(createChatHandlers({ db, emitEvent: () => 0, inboxDeps }), { db });
  await h["chat:join"]({ room: "general", handle: "a" });

  const signIn = (await import("../../state/index.ts")).signIn;
  signIn({ sessionId: "sess-a", baseHandle: "a" }, db);

  await h["chat:post"]({ room: "general", handle: "a", body: "hi" });
  await Bun.sleep(0);

  const result = await sweep();
  expect(result).toEqual({ swept: 0, recovered: 0 });
  expect(calls).toEqual([]);
});

// Review finding 1 (BLOCKING): the sweep must never treat a wake_on:"none"
// or an un-mentioned wake_on:"mention" member as though they were "all" --
// doing so both pushes them a message they opted out of AND clobbers
// last_read_id, so a later `rt chat read` from that member would never show
// them the backlog either.
test("the sweep never delivers to a wake_on:none member even with a genuinely stale, alive-bound cursor", async () => {
  const calls: Array<[string, string]> = [];
  const sock = fakeSocketPath();
  const inboxDeps: InboxDeps = {
    resolve: (sessionId) => (sessionId === "sess-b" ? { pid: process.pid, socketPath: sock, status: "idle" } : null),
    deliver: async (socketPath, content) => { calls.push([socketPath, content]); return { ok: true }; },
  };
  const { db, sweep } = freshSweep(inboxDeps);
  const h = Object.assign(createChatHandlers({ db, emitEvent: () => 0, inboxDeps }), { db });
  await h["chat:join"]({ room: "general", handle: "a" });
  await h["chat:join"]({ room: "general", handle: "b", wakeOn: "none" });

  const signIn = (await import("../../state/index.ts")).signIn;
  signIn({ sessionId: "sess-b", baseHandle: "b" }, db);

  const posted = await h["chat:post"]({ room: "general", handle: "a", body: "hi" });
  if (!posted.ok) throw new Error("unreachable");
  await Bun.sleep(0); // the normal per-post delivery also skips a wake_on:none member -- confirms the setup, not the fix
  expect(calls).toEqual([]);

  const result = await sweep();
  expect(result).toEqual({ swept: 0, recovered: 0 });
  expect(calls).toEqual([]);
  expect(lastReadId(db, "general", "b")).toBeLessThan(posted.data.id); // cursor must stay untouched -- rt chat read must still show this later
});

test("the sweep never delivers to a wake_on:mention member who was never mentioned in any pending message", async () => {
  const calls: Array<[string, string]> = [];
  const sock = fakeSocketPath();
  const inboxDeps: InboxDeps = {
    resolve: (sessionId) => (sessionId === "sess-b" ? { pid: process.pid, socketPath: sock, status: "idle" } : null),
    deliver: async (socketPath, content) => { calls.push([socketPath, content]); return { ok: true }; },
  };
  const { db, sweep } = freshSweep(inboxDeps);
  const h = Object.assign(createChatHandlers({ db, emitEvent: () => 0, inboxDeps }), { db });
  await h["chat:join"]({ room: "general", handle: "a" });
  await h["chat:join"]({ room: "general", handle: "b", wakeOn: "mention" });

  const signIn = (await import("../../state/index.ts")).signIn;
  signIn({ sessionId: "sess-b", baseHandle: "b" }, db);

  const posted = await h["chat:post"]({ room: "general", handle: "a", body: "no mention here" });
  if (!posted.ok) throw new Error("unreachable");
  await Bun.sleep(0);
  expect(calls).toEqual([]);

  const result = await sweep();
  expect(result).toEqual({ swept: 0, recovered: 0 });
  expect(calls).toEqual([]);
  expect(lastReadId(db, "general", "b")).toBeLessThan(posted.data.id);
});

test("the sweep DOES deliver to a wake_on:mention member once a pending message actually names them", async () => {
  const calls: Array<[string, string]> = [];
  const sock = fakeSocketPath();
  let resolverReady = false;
  const binding: InboxBinding = { pid: process.pid, socketPath: sock, status: "idle" };
  const inboxDeps: InboxDeps = {
    resolve: (sessionId) => (resolverReady && sessionId === "sess-b" ? binding : null),
    deliver: async (socketPath, content) => { calls.push([socketPath, content]); return { ok: true }; },
  };
  const registryDeps: RegistryDeps = {
    resolve: (sessionId) => (resolverReady && sessionId === "sess-b" ? binding : null),
    alive: () => true,
    resolveAll: () => new Map(resolverReady ? [["sess-b", binding] as const] : []),
  };
  const { db, sweep } = freshSweep(inboxDeps, { registryDeps });
  const h = Object.assign(createChatHandlers({ db, emitEvent: () => 0, inboxDeps }), { db });
  await h["chat:join"]({ room: "general", handle: "a" });
  await h["chat:join"]({ room: "general", handle: "b", wakeOn: "mention" });

  const signIn = (await import("../../state/index.ts")).signIn;
  signIn({ sessionId: "sess-b", baseHandle: "b" }, db);

  const posted = await h["chat:post"]({ room: "general", handle: "a", body: "@b hi" });
  if (!posted.ok) throw new Error("unreachable");
  await Bun.sleep(0); // resolver not ready yet: the normal push missed it, same as the incident
  expect(calls).toEqual([]);

  resolverReady = true;
  const result = await sweep();
  expect(result).toEqual({ swept: 1, recovered: 1 });
  expect(calls).toHaveLength(1);
  expect(lastReadId(db, "general", "b")).toBe(posted.data.id);
});

test("the sweep skips a signed-out recipient and a recipient with a dead binding", async () => {
  const calls: Array<[string, string]> = [];
  const sock = fakeSocketPath();
  const inboxDeps: InboxDeps = {
    resolve: (sessionId) => (sessionId === "sess-b" ? { pid: process.pid, socketPath: sock, status: "idle" } : null),
    deliver: async (socketPath, content) => { calls.push([socketPath, content]); return { ok: true }; },
  };
  const { db, sweep } = freshSweep(inboxDeps);
  const h = Object.assign(createChatHandlers({ db, emitEvent: () => 0, inboxDeps }), { db });
  await h["chat:join"]({ room: "general", handle: "a" });
  await h["chat:join"]({ room: "general", handle: "b" });
  await h["chat:join"]({ room: "general", handle: "c" });

  const { signIn, signOut } = await import("../../state/index.ts");
  signIn({ sessionId: "sess-b", baseHandle: "b" }, db);
  signOut("sess-b", undefined, db); // signed out: a live binding must not matter
  signIn({ sessionId: "sess-c", baseHandle: "c" }, db); // resolver never answers for sess-c: dead binding

  await h["chat:post"]({ room: "general", handle: "a", body: "hi" });
  await Bun.sleep(0);

  const result = await sweep();
  expect(result).toEqual({ swept: 0, recovered: 0 });
  expect(calls).toEqual([]);
});

// Review finding 2 (SHOULD-FIX): resolveInbox does a full registry directory
// scan per call (see claude-registry.ts's own doc on resolveAllInboxes --
// "the batch form callers with more than one lookup ... must use instead of
// calling resolveInbox once per id"). The sweep must scan once per run, not
// once per stale candidate.
test("the sweep resolves the registry once per run, not once per stale candidate", async () => {
  const sock = fakeSocketPath();
  const binding: InboxBinding = { pid: process.pid, socketPath: sock, status: "idle" };
  // inboxDeps never resolves anyone at post time, so all three stay
  // genuinely stale into the sweep -- if it resolved eagerly, the normal
  // per-post push would deliver to everyone before the sweep ever ran,
  // leaving nothing stale to exercise the once-per-run registry scan.
  const inboxDeps: InboxDeps = {
    resolve: () => null,
    deliver: async () => ({ ok: true }),
  };
  let resolveAllCalls = 0;
  const registryDeps: RegistryDeps = {
    resolve: () => binding,
    alive: () => true,
    resolveAll: () => { resolveAllCalls++; return new Map([["sess-b", binding], ["sess-c", binding], ["sess-d", binding]]); },
  };
  const { db, sweep } = freshSweep(inboxDeps, { registryDeps });
  const h = Object.assign(createChatHandlers({ db, emitEvent: () => 0, inboxDeps }), { db });
  await h["chat:join"]({ room: "general", handle: "a" });
  await h["chat:join"]({ room: "general", handle: "b" });
  await h["chat:join"]({ room: "general", handle: "c" });
  await h["chat:join"]({ room: "general", handle: "d" });

  const { signIn } = await import("../../state/index.ts");
  signIn({ sessionId: "sess-b", baseHandle: "b" }, db);
  signIn({ sessionId: "sess-c", baseHandle: "c" }, db);
  signIn({ sessionId: "sess-d", baseHandle: "d" }, db);

  await h["chat:post"]({ room: "general", handle: "a", body: "hi" }); // 3 stale candidates (b, c, d) in one run
  await Bun.sleep(0);

  await sweep();
  expect(resolveAllCalls).toBe(1);
});

// Review finding 2: a signed-out presence must never even reach the
// registry alive-check -- it's excluded regardless of what the registry
// says, so checking it first is pure waste on top of being (before this
// fix) a per-candidate registry scan.
test("the sweep never checks binding-aliveness for a signed-out presence", async () => {
  const sock = fakeSocketPath();
  const binding: InboxBinding = { pid: process.pid, socketPath: sock, status: "idle" };
  const inboxDeps: InboxDeps = {
    resolve: () => binding,
    deliver: async () => ({ ok: true }),
  };
  const aliveChecked: string[] = [];
  const registryDeps: RegistryDeps = {
    resolve: () => binding,
    alive: (b) => { aliveChecked.push(b.socketPath); return true; },
    resolveAll: () => new Map([["sess-away", binding]]),
  };
  const { db, sweep } = freshSweep(inboxDeps, { registryDeps });
  const h = Object.assign(createChatHandlers({ db, emitEvent: () => 0, inboxDeps }), { db });
  await h["chat:join"]({ room: "general", handle: "a" });
  await h["chat:join"]({ room: "general", handle: "away" });

  const { signIn, signOut } = await import("../../state/index.ts");
  signIn({ sessionId: "sess-away", baseHandle: "away" }, db);
  signOut("sess-away", undefined, db);

  await h["chat:post"]({ room: "general", handle: "a", body: "hi" });
  await Bun.sleep(0);

  await sweep();
  expect(aliveChecked).toEqual([]);
});

test("a sweep re-delivery chains behind an in-flight post delivery to the same recipient instead of racing it", async () => {
  const calls: Array<[string, string]> = [];
  const sock = fakeSocketPath();
  let releaseFirst: (() => void) | undefined;
  let deliverCount = 0;
  const inboxDeps: InboxDeps = {
    resolve: (sessionId) => (sessionId === "sess-b" ? { pid: process.pid, socketPath: sock, status: "idle" } : null),
    deliver: async (socketPath, content) => {
      deliverCount++;
      calls.push([socketPath, content]);
      if (deliverCount === 1) await new Promise<void>((resolve) => { releaseFirst = resolve; });
      return { ok: true };
    },
  };
  const db = openStateDb(join(tmpdir(), `chat-sweep-race-${process.pid}-${n++}.db`));
  const deliveryChains = new Map<string, Promise<void>>();
  const h = Object.assign(createChatHandlers({ db, emitEvent: () => 0, inboxDeps, deliveryChains }), { db });
  const sweep = createChatDeliverySweep({ db, deliveryChains, inboxDeps });

  await h["chat:join"]({ room: "general", handle: "a" });
  await h["chat:join"]({ room: "general", handle: "b" });
  const { signIn } = await import("../../state/index.ts");
  signIn({ sessionId: "sess-b", baseHandle: "b" }, db);

  const posted = await h["chat:post"]({ room: "general", handle: "a", body: "one" });
  if (!posted.ok) throw new Error("unreachable");
  await Bun.sleep(0); // the queued post delivery is now blocked on the gate

  const sweepResult = sweep(); // must chain behind, not race, the held post delivery
  await Bun.sleep(0);
  expect(calls).toHaveLength(1); // still just the held first attempt

  releaseFirst?.();
  await sweepResult;
  expect(calls).toHaveLength(1); // the sweep found nothing left stale once it finally ran
});
