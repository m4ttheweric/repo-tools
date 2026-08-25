/**
 * lib/state/presence-store.ts — sign-in, two heartbeats, one reclaim
 * predicate (RT-48 chat-presence Task 3).
 *
 * Verbatim from the plan's Task 3 step-1 block (design spec's Testing
 * "Store" bullet). armMember/touchMember/joinRoom/listMembers come from
 * chat-store.ts to exercise the dual-write and room-default wiring those
 * tests cover.
 */
import { expect, test } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { openStateDb } from "../db.ts";
import { armMember, joinRoom, listMembers, touchMember } from "../chat-store.ts";
import {
  assertSessionOwnsHandle,
  buddyStatus,
  presenceThresholds,
  prunePresence,
  signIn,
  signOut,
  pulseSession,
} from "../presence-store.ts";

let n = 0;
function fresh() {
  return openStateDb(join(tmpdir(), `presence-test-${process.pid}-${n++}.db`));
}

const now = 1_700_000_000_000;
const MIN = 60_000, HOUR = 3_600_000;

test("a base held by a live row is suffixed; the suffix is stable", () => {
  const db = fresh();
  expect(signIn({ sessionId: "s1", baseHandle: "x", now }, db).handle).toBe("x");
  expect(signIn({ sessionId: "s2", baseHandle: "x", now }, db).handle).toBe("x-2");
  expect(signIn({ sessionId: "s3", baseHandle: "x", now }, db).handle).toBe("x-3");
});

test("an idle holder is never reclaimed, even before it arms", () => {
  const db = fresh();
  signIn({ sessionId: "s1", baseHandle: "x", cwd: "/w", now }, db); // signed in, not armed
  const r = signIn({ sessionId: "s2", baseHandle: "x", cwd: "/w", now: now + MIN }, db);
  expect(r).toMatchObject({ handle: "x-2", reclaimed: false });
});

test("a stale same-seat row is reclaimed by deletion and the handle comes back", () => {
  const db = fresh();
  signIn({ sessionId: "s1", baseHandle: "x", cwd: "/w", pane: "3", now }, db);
  const r = signIn({ sessionId: "s2", baseHandle: "x", cwd: "/w", pane: "3", now: now + 2 * HOUR }, db);
  expect(r).toMatchObject({ handle: "x", reclaimed: true });
  expect(db.query("SELECT COUNT(*) c FROM chat_presence").get()).toMatchObject({ c: 1 });
});

test("a live tail blocks reclaim even when the session heartbeat is hours old", () => {
  const db = fresh();
  signIn({ sessionId: "s1", baseHandle: "x", now }, db);
  db.run("UPDATE chat_presence SET armed_at = ?, tail_seen_at = ? WHERE session_id = 's1'", [now + 3 * HOUR, now + 3 * HOUR]);
  expect(signIn({ sessionId: "s2", baseHandle: "x", now: now + 3 * HOUR + MIN }, db).handle).toBe("x-2");
});

test("buddyStatus: table order, first match wins, tail heartbeat is COALESCE(tail_seen_at, armed_at)", () => {
  expect(buddyStatus({ signedOutAt: now }, now)).toBe("offline");
  expect(buddyStatus({ lastSeenAt: now - 25 * HOUR }, now)).toBe("offline");
  expect(buddyStatus({ lastSeenAt: now, armedAt: now - 20 * MIN }, now)).toBe("deaf"); // armed, no touch, 20m
  expect(buddyStatus({ lastSeenAt: now - 2 * HOUR, armedAt: now, tailSeenAt: now }, now)).toBe("live"); // prompt-starved but touching
  expect(buddyStatus({ lastSeenAt: now, armedAt: now }, now)).toBe("live"); // just armed, tail_seen_at NULL
  expect(buddyStatus({ lastSeenAt: now - 2 * HOUR }, now)).toBe("deaf"); // unarmed, session stale
  expect(buddyStatus({ lastSeenAt: now }, now)).toBe("idle");
});

test("pulse writes last_seen_at and deets only", () => {
  const db = fresh();
  signIn({ sessionId: "s1", baseHandle: "x", now }, db);
  pulseSession({ sessionId: "s1", branch: "feat", now: now + MIN }, db);
  expect(db.query("SELECT last_seen_at, tail_seen_at, branch FROM chat_presence").get())
    .toMatchObject({ last_seen_at: now + MIN, tail_seen_at: null, branch: "feat" });
});

test("assertSessionOwnsHandle throws only on a mismatched signed handle", () => {
  const db = fresh();
  signIn({ sessionId: "s1", baseHandle: "x", now }, db);
  expect(() => assertSessionOwnsHandle("x", "s1", db)).not.toThrow();
  expect(() => assertSessionOwnsHandle("x", "s2", db)).toThrow(/handle reclaimed/);
  expect(() => assertSessionOwnsHandle("unsigned", "s2", db)).not.toThrow(); // plan-1 path: no presence row, no enforcement
  expect(() => assertSessionOwnsHandle("x", undefined, db)).not.toThrow(); // no session id offered, no enforcement
});

test("prune: the ghost path — a never-signed-out row goes after 24h of silence", () => {
  const db = fresh();
  signIn({ sessionId: "s1", baseHandle: "x", now }, db); // never signs out
  expect(prunePresence(now + 2 * HOUR, db)).toBe(0);
  expect(prunePresence(now + 25 * HOUR, db)).toBe(1); // last_seen_at leg, signed_out_at NULL
});

test("prune: the signed-out path keeps the offline window", () => {
  const db = fresh();
  signIn({ sessionId: "s1", baseHandle: "x", now }, db);
  signOut("s1", now, db);
  expect(prunePresence(now + 2 * HOUR, db)).toBe(0); // offline (last 24h) still shows it
  expect(prunePresence(now + 25 * HOUR, db)).toBe(1); // signed_out_at leg
});

test("arm starts a new tail epoch: sets armed_at and CLEARS tail_seen_at", () => {
  const db = fresh();
  signIn({ sessionId: "s1", baseHandle: "x", now }, db);
  db.run("UPDATE chat_presence SET tail_seen_at = ?", [now - 20 * MIN]); // a dead predecessor's last touch
  joinRoom({ room: "r", handle: "x" }, db);
  armMember(undefined, "x", db);
  const row = db.query("SELECT tail_seen_at FROM chat_presence WHERE handle = 'x'").get() as { tail_seen_at: number | null };
  expect(row.tail_seen_at).toBeNull(); // COALESCE falls to the fresh armed_at → live, not deaf
});

test("arm/touch/disarm dual-write when a presence row exists, and still work without one", () => {
  const db = fresh();
  signIn({ sessionId: "s1", baseHandle: "x", now }, db);
  joinRoom({ room: "r", handle: "x" }, db);
  armMember(undefined, "x", db);
  touchMember("x", db);
  const armedRow = db.query("SELECT armed_at, tail_seen_at FROM chat_presence WHERE handle = 'x'").get() as { armed_at: number | null };
  expect(armedRow.armed_at).toBeTruthy();
  joinRoom({ room: "r", handle: "unsigned" }, db);
  expect(() => armMember(undefined, "unsigned", db)).not.toThrow(); // member columns as in plan 1
});

test("a creating join with wake-on stamps the room default and later joins inherit it", () => {
  const db = fresh();
  joinRoom({ room: "war", handle: "a", wakeOn: "all" }, db); // creates → stamps
  joinRoom({ room: "war", handle: "b" }, db); // flagless → inherits
  joinRoom({ room: "war", handle: "c", wakeOn: "mention" }, db); // explicit → wins
  const byHandle = Object.fromEntries(listMembers("war", db).map((m) => [m.handle, m.wakeOn]));
  expect(byHandle).toEqual({ a: "all", b: "all", c: "mention" });
  joinRoom({ room: "calm", handle: "a" }, db); // creating join WITHOUT a flag stamps nothing
  joinRoom({ room: "calm", handle: "b" }, db);
  expect(listMembers("calm", db).map((m) => m.wakeOn)).toEqual(["mention", "mention"]);
});

test("the joinRoom cwd guard is scoped to unsigned handles", () => {
  const db = fresh();
  joinRoom({ room: "a", handle: "x", cwd: "/one" }, db);
  expect(() => joinRoom({ room: "b", handle: "x", cwd: "/two" }, db)).toThrow(/--as/); // unsigned: as shipped
  const db2 = fresh();
  signIn({ sessionId: "s1", baseHandle: "y", now }, db2);
  joinRoom({ room: "a", handle: "y", cwd: "/one" }, db2);
  expect(() => joinRoom({ room: "b", handle: "y", cwd: "/two" }, db2)).not.toThrow(); // signed: presence owns uniqueness
});

// presenceThresholds smoke test: not in the plan's verbatim block, but the
// module's Produces list requires it and nothing else here exercises the
// env-driven defaults.
test("presenceThresholds returns the documented defaults with no env set", () => {
  const saved = {
    tail: process.env.RT_CHAT_TAIL_STALE_MS,
    session: process.env.RT_CHAT_SESSION_STALE_MS,
    prune: process.env.RT_CHAT_PRUNE_MS,
  };
  delete process.env.RT_CHAT_TAIL_STALE_MS;
  delete process.env.RT_CHAT_SESSION_STALE_MS;
  delete process.env.RT_CHAT_PRUNE_MS;
  try {
    expect(presenceThresholds()).toEqual({ tailStaleMs: 10 * MIN, sessionStaleMs: HOUR, pruneMs: 24 * HOUR });
  } finally {
    if (saved.tail !== undefined) process.env.RT_CHAT_TAIL_STALE_MS = saved.tail;
    if (saved.session !== undefined) process.env.RT_CHAT_SESSION_STALE_MS = saved.session;
    if (saved.prune !== undefined) process.env.RT_CHAT_PRUNE_MS = saved.prune;
  }
});
