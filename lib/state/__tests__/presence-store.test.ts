/**
 * lib/state/presence-store.ts — sign-in, presence, and the one reclaim
 * predicate (RT-48, delivery-v2 hard cutover).
 *
 * joinRoom/listMembers come from chat-store.ts to exercise the room-default
 * wiring those tests cover.
 */
import { expect, test } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { openStateDb } from "../db.ts";
import { joinRoom, listMembers } from "../chat-store.ts";
import {
  assertSessionOwnsHandle,
  assertSessionSignedIn,
  buddyStatus,
  presenceThresholds,
  prunePresence,
  signIn,
  signOut,
  type RegistryDeps,
} from "../presence-store.ts";
import type { InboxBinding } from "../../claude-registry.ts";
import { AGENT_NAMES } from "../../chat-names.ts";
import { getKvValue } from "../kv-blob.ts";

/** No binding for any session id: the default in every test that doesn't care about the registry (matches the real resolver's behavior for a fake test session id it will never find on disk). */
const NO_BINDING: RegistryDeps = { resolve: () => null, alive: () => false };

function fakeBinding(status: InboxBinding["status"]): RegistryDeps {
  const binding: InboxBinding = { pid: 1, socketPath: "/fake.sock", status };
  return { resolve: () => binding, alive: () => true };
}

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

test("a session-stale holder with no live binding is never reclaimed inside the session-stale window", () => {
  const db = fresh();
  signIn({ sessionId: "s1", baseHandle: "x", cwd: "/w", now }, db);
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

test("a live registry binding blocks reclaim even when the session heartbeat is hours old", () => {
  const db = fresh();
  signIn({ sessionId: "s1", baseHandle: "x", now }, db);
  const deps = fakeBinding("idle");
  expect(signIn({ sessionId: "s2", baseHandle: "x", now: now + 3 * HOUR + MIN }, db, deps).handle).toBe("x-2");
});

test("a dead registry binding does not block reclaim once session-stale", () => {
  const db = fresh();
  signIn({ sessionId: "s1", baseHandle: "x", now }, db);
  const r = signIn({ sessionId: "s2", baseHandle: "x", now: now + 3 * HOUR + MIN }, db, NO_BINDING);
  expect(r).toMatchObject({ handle: "x", reclaimed: true });
});

test("buddyStatus: offline (signed out, then pruned) beats everything else; otherwise the registry mirror decides live vs idle", () => {
  expect(buddyStatus({ signedOutAt: now }, now)).toBe("offline");
  expect(buddyStatus({ lastSeenAt: now - 25 * HOUR }, now)).toBe("offline");
  expect(buddyStatus({ lastSeenAt: now, sessionId: "s1" }, now, presenceThresholds(), fakeBinding("busy"))).toBe("live");
  expect(buddyStatus({ lastSeenAt: now, sessionId: "s1" }, now, presenceThresholds(), fakeBinding("idle"))).toBe("idle");
  expect(buddyStatus({ lastSeenAt: now, sessionId: "s1" }, now, presenceThresholds(), fakeBinding("shell"))).toBe("idle");
  // No resolvable binding at all (dead pid, or a session id the registry has never heard of): idle, not offline, until pruned.
  expect(buddyStatus({ lastSeenAt: now, sessionId: "s1" }, now, presenceThresholds(), NO_BINDING)).toBe("idle");
  expect(buddyStatus({ lastSeenAt: now }, now, presenceThresholds(), NO_BINDING)).toBe("idle");
});

test("assertSessionOwnsHandle throws only on a mismatched signed handle", () => {
  const db = fresh();
  signIn({ sessionId: "s1", baseHandle: "x", now }, db);
  expect(() => assertSessionOwnsHandle("x", "s1", db)).not.toThrow();
  expect(() => assertSessionOwnsHandle("x", "s2", db)).toThrow(/handle reclaimed/);
  expect(() => assertSessionOwnsHandle("unsigned", "s2", db)).not.toThrow(); // plan-1 path: no presence row, no enforcement
  expect(() => assertSessionOwnsHandle("x", undefined, db)).not.toThrow(); // no session id offered, no enforcement
});

test("assertSessionSignedIn throws when the session's row is gone", () => {
  const db = fresh();
  expect(() => assertSessionSignedIn("ghost", db)).toThrow(/handle reclaimed/);
});

test("assertSessionSignedIn refuses a signed-out session without the reclaimed wording", () => {
  const db = fresh();
  signIn({ sessionId: "s1", baseHandle: "x", now }, db);
  signOut("s1", now, db);
  expect(() => assertSessionSignedIn("s1", db)).toThrow(/not signed in/);
  expect(() => assertSessionSignedIn("s1", db)).not.toThrow(/handle reclaimed/);
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

test("a repeat sign-in from the same session, same base, retakes its own seat", () => {
  const db = fresh();
  expect(signIn({ sessionId: "s1", baseHandle: "x", now }, db).handle).toBe("x");
  // Before the fix this threw a raw UNIQUE violation on "x": the scan found
  // s1's own (non-reclaimable, fresh) row still holding it.
  const r = signIn({ sessionId: "s1", baseHandle: "x", now: now + MIN }, db);
  expect(r.handle).toBe("x");
  expect(db.query("SELECT COUNT(*) c FROM chat_presence").get()).toMatchObject({ c: 1 });
});

test("a repeat sign-in from the same session comes back to its own higher suffix rather than filling a lower gap", () => {
  const db = fresh();
  signIn({ sessionId: "s0", baseHandle: "x", now }, db); // holds "x", stays live throughout
  signIn({ sessionId: "s-mid", baseHandle: "x", now }, db); // holds "x-2"
  expect(signIn({ sessionId: "s1", baseHandle: "x", now }, db).handle).toBe("x-3");
  db.run("DELETE FROM chat_presence WHERE session_id = 's-mid'"); // "x-2" is now a genuine gap
  // Without the same-seat rule this would refill the gap at "x-2" — the
  // suffix churn the reclaim predicate exists to prevent.
  const r = signIn({ sessionId: "s1", baseHandle: "x", now: now + MIN }, db);
  expect(r.handle).toBe("x-3");
});

test("a repeat sign-in with a different base releases the old seat and takes a fresh one", () => {
  const db = fresh();
  expect(signIn({ sessionId: "s1", baseHandle: "x", now }, db).handle).toBe("x");
  expect(signIn({ sessionId: "s1", baseHandle: "y", now: now + MIN }, db).handle).toBe("y");
  // the old base's slot was released outright, not left behind as a ghost
  expect(signIn({ sessionId: "s2", baseHandle: "x", now: now + 2 * MIN }, db)).toMatchObject({ handle: "x", reclaimed: false });
});

test("signIn skips a candidate handle that's globally held by an unrelated base family", () => {
  const db = fresh();
  signIn({ sessionId: "s1", baseHandle: "x", now }, db); // "x"
  signIn({ sessionId: "s2", baseHandle: "x", now }, db); // "x-2" — base_handle "x", live
  // s3's OWN derived base happens to be the literal string "x-2" (e.g. a
  // worktree dir named "2"). Scoping seat selection to base_handle="x-2"
  // alone would see no rows at all and hand out "x-2" — already taken.
  const r = signIn({ sessionId: "s3", baseHandle: "x-2", now }, db);
  expect(r.handle).toBe("x-2-2");
});

test("signIn reclaims a globally-held candidate rather than just skipping it", () => {
  const db = fresh();
  signIn({ sessionId: "s1", baseHandle: "x", now }, db); // "x"
  signIn({ sessionId: "s2", baseHandle: "x-2", now }, db); // base_handle "x-2", handle "x-2"
  // s2 goes silent for 2h with no tail — reclaimable by the time s3 arrives.
  const later = now + 2 * HOUR;
  const r = signIn({ sessionId: "s3", baseHandle: "x-2", now: later }, db);
  expect(r).toMatchObject({ handle: "x-2", reclaimed: true });
});

test("own-seat preference: a reclaimable row with matching cwd+pane wins over an earlier lower-suffix reclaimable row", () => {
  const db = fresh();
  signIn({ sessionId: "s1", baseHandle: "x", now }, db); // "x"
  signIn({ sessionId: "s2", baseHandle: "x", cwd: "/other", now }, db); // "x-2"
  signIn({ sessionId: "s3", baseHandle: "x", cwd: "/mine", pane: "7", now }, db); // "x-3"
  const later = now + 2 * HOUR;
  db.run("UPDATE chat_presence SET last_seen_at = ? WHERE handle = 'x'", [later]); // "x" stays live
  // "x-2" and "x-3" are both stale (untouched last_seen_at) and reclaimable
  // by `later`; only "x-3"'s cwd+pane matches the incoming session.
  const r = signIn({ sessionId: "s4", baseHandle: "x", cwd: "/mine", pane: "7", now: later }, db);
  expect(r).toMatchObject({ handle: "x-3", reclaimed: true });
  // "x-2" — the lower-suffix reclaimable row a plain first-by-suffix scan
  // would have picked — is left completely untouched.
  expect(db.query("SELECT session_id FROM chat_presence WHERE handle = 'x-2'").get()).toMatchObject({ session_id: "s2" });
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
    session: process.env.RT_CHAT_SESSION_STALE_MS,
    prune: process.env.RT_CHAT_PRUNE_MS,
  };
  delete process.env.RT_CHAT_SESSION_STALE_MS;
  delete process.env.RT_CHAT_PRUNE_MS;
  try {
    expect(presenceThresholds()).toEqual({ sessionStaleMs: HOUR, pruneMs: 24 * HOUR });
  } finally {
    if (saved.session !== undefined) process.env.RT_CHAT_SESSION_STALE_MS = saved.session;
    if (saved.prune !== undefined) process.env.RT_CHAT_PRUNE_MS = saved.prune;
  }
});

// ─── The pool draw (no baseHandle) ──────────────────────────────────────────

const DAY = 24 * HOUR;

test("signIn without a base draws a pool name that no live session holds", () => {
  const db = fresh();
  const a = signIn({ sessionId: "s1", now }, db);
  const b = signIn({ sessionId: "s2", now }, db);
  expect(AGENT_NAMES).toContain(a.baseHandle);
  expect(AGENT_NAMES).toContain(b.baseHandle);
  expect(a.handle).toBe(a.baseHandle);
  expect(b.baseHandle).not.toBe(a.baseHandle);
});

test("the draw is least-recently-used: every name goes once before any comes back", () => {
  const db = fresh();
  const drawn: string[] = [];
  // Each sign-in lands two days after the last, so the previous row is
  // pruned and only the ledger keeps the name from coming back.
  for (let i = 0; i <= AGENT_NAMES.length; i++) {
    const t = now + i * 2 * DAY;
    const { baseHandle } = signIn({ sessionId: `s${i}`, now: t }, db);
    signOut(`s${i}`, t, db);
    drawn.push(baseHandle);
  }
  expect(new Set(drawn.slice(0, AGENT_NAMES.length)).size).toBe(AGENT_NAMES.length);
  expect(drawn[AGENT_NAMES.length]).toBe(drawn[0]);
});

test("a repeat sign-in with no base keeps the name the session already holds", () => {
  const db = fresh();
  const first = signIn({ sessionId: "s1", now }, db);
  const again = signIn({ sessionId: "s1", now: now + MIN }, db);
  expect(again.baseHandle).toBe(first.baseHandle);
  expect(again.handle).toBe(first.handle);
});

test("an explicitly named pool name counts as used; a non-pool base is not recorded", () => {
  const db = fresh();
  signIn({ sessionId: "s1", baseHandle: "kai", now }, db);
  signIn({ sessionId: "s2", baseHandle: "mr-board", now }, db);
  const ledger = getKvValue<Record<string, number>>("chat", "names", {}, db);
  expect(ledger.kai).toBe(now);
  expect(ledger["mr-board"]).toBeUndefined();
});
