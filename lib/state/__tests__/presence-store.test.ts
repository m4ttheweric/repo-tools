/**
 * lib/state/presence-store.ts — sign-in, presence, and the one reclaim
 * predicate (RT-48, delivery-v2 hard cutover).
 *
 * joinRoom/listMembers come from chat-store.ts to exercise the room-default
 * wiring those tests cover.
 */
import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { openStateDb } from "../db.ts";
import { joinRoom, listMembers } from "../chat-store.ts";
import {
  assertSessionOwnsHandle,
  assertSessionSignedIn,
  buddyStatus,
  listBuddies,
  presenceForSession,
  presenceThresholds,
  prunePresence,
  setAway,
  signIn,
  signOut,
  touchLastSeen,
  type RegistryDeps,
} from "../presence-store.ts";
import type { InboxBinding } from "../../claude-registry.ts";
import { AGENT_NAMES } from "../../chat-names.ts";
import { getKvValue } from "../kv-blob.ts";

/** No binding for any session id: the default in every test that doesn't care about the registry (matches the real resolver's behavior for a fake test session id it will never find on disk). */
const NO_BINDING: RegistryDeps = { resolve: () => null, alive: () => false, resolveAll: () => new Map() };

/** Resolves ONLY `sessionId` (default "s1", matching every test's own session id) -- `resolveAll` must carry the same entry, since callers with more than one lookup go through it instead of `resolve` directly. */
function fakeBinding(status: InboxBinding["status"], sessionId = "s1"): RegistryDeps {
  const binding: InboxBinding = { pid: 1, socketPath: "/fake.sock", status };
  return {
    resolve: (id) => (id === sessionId ? binding : null),
    alive: () => true,
    resolveAll: () => new Map([[sessionId, binding]]),
  };
}

/** A registry entry that resolves but whose process is gone (dead pid, or a socket that no longer exists). */
function deadPidBinding(sessionId = "s1"): RegistryDeps {
  const binding: InboxBinding = { pid: 1, socketPath: "/fake.sock", status: "busy" };
  return {
    resolve: (id) => (id === sessionId ? binding : null),
    alive: () => false,
    resolveAll: () => new Map([[sessionId, binding]]),
  };
}

let n = 0;
function fresh() {
  return openStateDb(join(tmpdir(), `presence-test-${process.pid}-${n++}.db`));
}

/** signIn(), asserted non-undefined: every ordinary (non-contention) test
 *  call is expected to succeed, so this narrows the R057 `| undefined`
 *  return without repeating a non-null assertion at every call site. */
function mustSignIn(...args: Parameters<typeof signIn>): { handle: string; baseHandle: string; reclaimed: boolean } {
  const result = signIn(...args);
  if (!result) throw new Error("mustSignIn: signIn() unexpectedly returned undefined");
  return result;
}

const now = 1_700_000_000_000;
const MIN = 60_000, HOUR = 3_600_000;

test("a base held by a live row is suffixed; the suffix is stable", () => {
  const db = fresh();
  expect(mustSignIn({ sessionId: "s1", baseHandle: "x", now }, db).handle).toBe("x");
  expect(mustSignIn({ sessionId: "s2", baseHandle: "x", now }, db).handle).toBe("x-2");
  expect(mustSignIn({ sessionId: "s3", baseHandle: "x", now }, db).handle).toBe("x-3");
});

test("a session-stale holder with no live binding is never reclaimed inside the session-stale window", () => {
  const db = fresh();
  mustSignIn({ sessionId: "s1", baseHandle: "x", cwd: "/w", now }, db);
  const r = mustSignIn({ sessionId: "s2", baseHandle: "x", cwd: "/w", now: now + MIN }, db);
  expect(r).toMatchObject({ handle: "x-2", reclaimed: false });
});

test("a stale same-seat row is reclaimed by deletion and the handle comes back", () => {
  const db = fresh();
  mustSignIn({ sessionId: "s1", baseHandle: "x", cwd: "/w", pane: "3", now }, db);
  const r = mustSignIn({ sessionId: "s2", baseHandle: "x", cwd: "/w", pane: "3", now: now + 2 * HOUR }, db);
  expect(r).toMatchObject({ handle: "x", reclaimed: true });
  expect(db.query("SELECT COUNT(*) c FROM chat_presence").get()).toMatchObject({ c: 1 });
});

test("a live registry binding blocks reclaim even when the session heartbeat is hours old", () => {
  const db = fresh();
  mustSignIn({ sessionId: "s1", baseHandle: "x", now }, db);
  const deps = fakeBinding("idle");
  expect(mustSignIn({ sessionId: "s2", baseHandle: "x", now: now + 3 * HOUR + MIN }, db, deps).handle).toBe("x-2");
});

test("a dead registry binding does not block reclaim once session-stale", () => {
  const db = fresh();
  mustSignIn({ sessionId: "s1", baseHandle: "x", now }, db);
  const r = mustSignIn({ sessionId: "s2", baseHandle: "x", now: now + 3 * HOUR + MIN }, db, NO_BINDING);
  expect(r).toMatchObject({ handle: "x", reclaimed: true });
});

test("buddyStatus: offline beats everything (signed out, unresolvable, or a dead pid); otherwise the registry mirror decides live vs idle, regardless of how stale last_seen_at is", () => {
  expect(buddyStatus({ signedOutAt: now }, now)).toBe("offline");
  // No sessionId at all: offline, independent of lastSeenAt.
  expect(buddyStatus({ lastSeenAt: now - 25 * HOUR }, now)).toBe("offline");
  expect(buddyStatus({ lastSeenAt: now, sessionId: "s1" }, now, presenceThresholds(), fakeBinding("busy"))).toBe("live");
  expect(buddyStatus({ lastSeenAt: now, sessionId: "s1" }, now, presenceThresholds(), fakeBinding("idle"))).toBe("idle");
  expect(buddyStatus({ lastSeenAt: now, sessionId: "s1" }, now, presenceThresholds(), fakeBinding("shell"))).toBe("idle");
  // A last_seen_at well past pruneMs never turns this offline on its own:
  // an alive, busy binding still vouches for the session. prunePresence,
  // not buddyStatus, is what retires a truly dead row.
  expect(buddyStatus({ lastSeenAt: now - 25 * HOUR, sessionId: "s1" }, now, presenceThresholds(), fakeBinding("busy"))).toBe("live");
  // No resolvable registry entry at all (a session id the registry has never
  // heard of): offline, per spec ("pid dead, or socket gone" -- unresolvable
  // is the same "nothing to vouch for this session" case).
  expect(buddyStatus({ lastSeenAt: now, sessionId: "s1" }, now, presenceThresholds(), NO_BINDING)).toBe("offline");
  expect(buddyStatus({ lastSeenAt: now }, now, presenceThresholds(), NO_BINDING)).toBe("offline");
  // A registry file resolves, but the pid is dead (or the socket is gone): offline too.
  expect(buddyStatus({ lastSeenAt: now, sessionId: "s1" }, now, presenceThresholds(), deadPidBinding())).toBe("offline");
});

/** Counts `resolveAll()` calls; `resolve`/`alive` are unused once a caller batches through `resolveAll`, so they throw if anything still calls them directly. */
function countingRegistryDeps(): RegistryDeps & { scans: number } {
  const state = {
    scans: 0,
    resolve: (): InboxBinding | null => {
      throw new Error("resolve() called directly -- the caller under test should batch through resolveAll() instead");
    },
    alive: () => true,
    resolveAll: (): Map<string, InboxBinding> => {
      state.scans++;
      return new Map();
    },
  };
  return state;
}

test("listBuddies scans the registry exactly once regardless of buddy count", () => {
  const db = fresh();
  mustSignIn({ sessionId: "s1", baseHandle: "a", now }, db);
  mustSignIn({ sessionId: "s2", baseHandle: "b", now }, db);
  mustSignIn({ sessionId: "s3", baseHandle: "c", now }, db);
  const deps = countingRegistryDeps();
  const buddies = listBuddies(now, db, deps);
  expect(buddies).toHaveLength(3);
  expect(deps.scans).toBe(1);
});

test("listBuddies: a live-binding row with a 25h-old stamp still appears, classified by the registry; a dead-binding stale row reads offline but still appears", () => {
  const db = fresh();
  mustSignIn({ sessionId: "s1", baseHandle: "live-stale", now }, db);
  mustSignIn({ sessionId: "s2", baseHandle: "dead-stale", now }, db);
  db.run("UPDATE chat_presence SET last_seen_at = ? WHERE session_id IN ('s1', 's2')", [now - 25 * HOUR]);

  const deps = fakeBinding("busy", "s1"); // only s1 resolves; s2 has no registry entry
  const buddies = listBuddies(now, db, deps);

  const live = buddies.find((b) => b.handle === "live-stale");
  const dead = buddies.find((b) => b.handle === "dead-stale");
  expect(live?.status).toBe("live");
  expect(dead?.status).toBe("offline");
});

test("signIn scans the registry exactly once per call, even while probing several suffix candidates", () => {
  const db = fresh();
  // Three existing "x" rows (x, x-2, x-3) so the incoming sign-in's own
  // family scan, plus findOpenSuffix's fallback walk if it reaches that far,
  // both have several rows to check reclaimability for -- all against the
  // one map a single signIn call is allowed to build.
  mustSignIn({ sessionId: "s1", baseHandle: "x", now }, db);
  mustSignIn({ sessionId: "s2", baseHandle: "x", now }, db);
  mustSignIn({ sessionId: "s3", baseHandle: "x", now }, db);
  const deps = countingRegistryDeps();
  const r = mustSignIn({ sessionId: "s4", baseHandle: "x", now }, db, deps);
  expect(r.handle).toBe("x-4");
  expect(deps.scans).toBe(1);
});

test("assertSessionOwnsHandle throws only on a mismatched signed handle", () => {
  const db = fresh();
  mustSignIn({ sessionId: "s1", baseHandle: "x", now }, db);
  expect(() => assertSessionOwnsHandle("x", "s1", db)).not.toThrow();
  expect(() => assertSessionOwnsHandle("x", "s2", db)).toThrow(/handle reclaimed/);
  expect(() => assertSessionOwnsHandle("unsigned", "s2", db)).not.toThrow(); // plan-1 path: no presence row, no enforcement
  expect(() => assertSessionOwnsHandle("x", undefined, db)).not.toThrow(); // no session id offered, no enforcement
});

test("S073: signIn's read-then-write transaction uses .immediate() (BEGIN IMMEDIATE), not a deferred BEGIN", () => {
  // A plain db.transaction()'s deferred BEGIN lets signIn's own reads
  // (prunePresence, SELECT_PRESENCE_BY_SESSION_SQL) open a snapshot before
  // any write; a commit by another connection in that window turns the
  // eventual write into an unretryable SQLITE_BUSY_SNAPSHOT that the
  // flavor's busy_timeout cannot absorb. .immediate() takes the write lock
  // at BEGIN, so contention surfaces as an ordinary, retryable SQLITE_BUSY
  // instead (matching the chat-store.ts/dm-store.ts/notifier-store.ts
  // siblings already converted for the same reason).
  const src = readFileSync(resolve(import.meta.dir, "..", "presence-store.ts"), "utf8");
  const runIndex = src.indexOf("const run = db.transaction(");
  expect(runIndex).toBeGreaterThan(-1);
  expect(src.indexOf("return run.immediate();", runIndex)).toBeGreaterThan(runIndex);
});

test("C9: reserveAgentHandle's read-then-write transaction also uses .immediate(), same reason as signIn's S073 fix", () => {
  const src = readFileSync(resolve(import.meta.dir, "..", "presence-store.ts"), "utf8");
  const fnIndex = src.indexOf("export function reserveAgentHandle(");
  expect(fnIndex).toBeGreaterThan(-1);
  const runIndex = src.indexOf("const run = db.transaction(", fnIndex);
  expect(runIndex).toBeGreaterThan(fnIndex);
  expect(src.indexOf("return run.immediate();", runIndex)).toBeGreaterThan(runIndex);
});

test("assertSessionSignedIn throws when the session's row is gone", () => {
  const db = fresh();
  expect(() => assertSessionSignedIn("ghost", db)).toThrow(/handle reclaimed/);
});

test("assertSessionSignedIn refuses a signed-out session without the reclaimed wording", () => {
  const db = fresh();
  mustSignIn({ sessionId: "s1", baseHandle: "x", now }, db);
  signOut("s1", now, db);
  expect(() => assertSessionSignedIn("s1", db)).toThrow(/not signed in/);
  expect(() => assertSessionSignedIn("s1", db)).not.toThrow(/handle reclaimed/);
});

test("prune: the ghost path — a never-signed-out row goes after 24h of silence", () => {
  const db = fresh();
  mustSignIn({ sessionId: "s1", baseHandle: "x", now }, db); // never signs out
  expect(prunePresence(now + 2 * HOUR, db)).toBe(0);
  expect(prunePresence(now + 25 * HOUR, db)).toBe(1); // last_seen_at leg, signed_out_at NULL
});

test("prune: the signed-out path keeps the offline window", () => {
  const db = fresh();
  mustSignIn({ sessionId: "s1", baseHandle: "x", now }, db);
  signOut("s1", now, db);
  expect(prunePresence(now + 2 * HOUR, db)).toBe(0); // offline (last 24h) still shows it
  expect(prunePresence(now + 25 * HOUR, db)).toBe(1); // signed_out_at leg
});

test("prune: a never-signed-out row past 24h survives when the registry still vouches for its session", () => {
  const db = fresh();
  mustSignIn({ sessionId: "s1", baseHandle: "x", now }, db);
  expect(prunePresence(now + 25 * HOUR, db, fakeBinding("busy"))).toBe(0);
  expect(db.query("SELECT COUNT(*) c FROM chat_presence").get()).toMatchObject({ c: 1 });
});

test("prune: a never-signed-out row past 24h with no live binding is deleted", () => {
  const db = fresh();
  mustSignIn({ sessionId: "s1", baseHandle: "x", now }, db);
  expect(prunePresence(now + 25 * HOUR, db, NO_BINDING)).toBe(1);
  expect(db.query("SELECT COUNT(*) c FROM chat_presence").get()).toMatchObject({ c: 0 });
});

test("prune: a signed-out row within its 24h offline window survives even when last_seen_at is stale (C9: PRUNABLE_SQL must not let a signed-out row's last_seen_at leg bypass its own signed_out_at age bound)", () => {
  const db = fresh();
  mustSignIn({ sessionId: "s1", baseHandle: "x", now }, db); // last_seen_at pinned at `now`, no touches
  signOut("s1", now + 30 * HOUR, db); // signed out well after last_seen_at went stale
  // 1h after signing out: signed_out_at leg is nowhere near its 24h bound,
  // but last_seen_at (still `now`, 31h stale) trips the OTHER leg.
  expect(prunePresence(now + 31 * HOUR, db)).toBe(0);
  expect(db.query("SELECT COUNT(*) c FROM chat_presence").get()).toMatchObject({ c: 1 });
});

// R057: presence writes bypassed both busy wrappers, so a write racing a
// held lock past the daemon's 250ms busy_timeout surfaced as a raw thrown
// error to the caller (a chat:sign-in 500, a pulse hook error) instead of
// the policy table in busy.ts's warn-and-defer / bounded-retry treatment.
// `locker` pins a real BEGIN IMMEDIATE write lock on a second connection to
// the same file so `db`'s own write genuinely blocks out its busy_timeout
// and throws SQLITE_BUSY -- the same conflict shape production hits, not a
// fabricated error code.
function heldWriteLock(path: string): { locker: Database; release: () => void } {
  const locker = new Database(path);
  locker.exec("BEGIN IMMEDIATE;");
  return { locker, release: () => { try { locker.exec("ROLLBACK;"); } catch {} locker.close(); } };
}

test("R057: signIn does not throw when the write races a held lock past busy_timeout", () => {
  const path = join(tmpdir(), `presence-busy-signin-${process.pid}-${n++}.db`);
  const db = openStateDb(path, "daemon");
  const { release } = heldWriteLock(path);
  try {
    expect(() => signIn({ sessionId: "s1", baseHandle: "x", now }, db)).not.toThrow();
  } finally {
    release();
  }
}, 5000);

test("R057: signOut does not throw when the write races a held lock past busy_timeout", () => {
  const path = join(tmpdir(), `presence-busy-signout-${process.pid}-${n++}.db`);
  const db = openStateDb(path, "daemon");
  signIn({ sessionId: "s1", baseHandle: "x", now }, db);
  const { release } = heldWriteLock(path);
  try {
    expect(() => signOut("s1", now, db)).not.toThrow();
  } finally {
    release();
  }
}, 5000);

test("R057: setAway does not throw when the write races a held lock past busy_timeout", () => {
  const path = join(tmpdir(), `presence-busy-setaway-${process.pid}-${n++}.db`);
  const db = openStateDb(path, "daemon");
  signIn({ sessionId: "s1", baseHandle: "x", now }, db);
  const { release } = heldWriteLock(path);
  try {
    expect(() => setAway("s1", "afk", db)).not.toThrow();
  } finally {
    release();
  }
}, 5000);

test("R057: touchLastSeen does not throw when the write races a held lock past busy_timeout", () => {
  const path = join(tmpdir(), `presence-busy-touch-${process.pid}-${n++}.db`);
  const db = openStateDb(path, "daemon");
  signIn({ sessionId: "s1", baseHandle: "x", now }, db);
  const { release } = heldWriteLock(path);
  try {
    expect(() => touchLastSeen("s1", now + 1000, db)).not.toThrow();
  } finally {
    release();
  }
}, 5000);

test("touchLastSeen refreshes only last_seen_at -- the sole remaining route to it now that chat:pulse is gone", () => {
  const db = fresh();
  signIn({ sessionId: "s1", baseHandle: "x", now }, db);
  touchLastSeen("s1", now + HOUR, db);
  expect(presenceForSession("s1", db)?.lastSeenAt).toBe(now + HOUR);
  // A row delivery keeps touching never goes stale enough for prune to
  // consider it, even with no registry binding at all.
  expect(prunePresence(now + HOUR + 23 * HOUR, db, NO_BINDING)).toBe(0);
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
  expect(listMembers("calm", db).map((m) => m.wakeOn)).toEqual(["all", "all"]);
});

test("a repeat sign-in from the same session, same base, retakes its own seat", () => {
  const db = fresh();
  expect(mustSignIn({ sessionId: "s1", baseHandle: "x", now }, db).handle).toBe("x");
  // Before the fix this threw a raw UNIQUE violation on "x": the scan found
  // s1's own (non-reclaimable, fresh) row still holding it.
  const r = mustSignIn({ sessionId: "s1", baseHandle: "x", now: now + MIN }, db);
  expect(r.handle).toBe("x");
  expect(db.query("SELECT COUNT(*) c FROM chat_presence").get()).toMatchObject({ c: 1 });
});

test("a repeat sign-in from the same session comes back to its own higher suffix rather than filling a lower gap", () => {
  const db = fresh();
  mustSignIn({ sessionId: "s0", baseHandle: "x", now }, db); // holds "x", stays live throughout
  mustSignIn({ sessionId: "s-mid", baseHandle: "x", now }, db); // holds "x-2"
  expect(mustSignIn({ sessionId: "s1", baseHandle: "x", now }, db).handle).toBe("x-3");
  db.run("DELETE FROM chat_presence WHERE session_id = 's-mid'"); // "x-2" is now a genuine gap
  // Without the same-seat rule this would refill the gap at "x-2" — the
  // suffix churn the reclaim predicate exists to prevent.
  const r = mustSignIn({ sessionId: "s1", baseHandle: "x", now: now + MIN }, db);
  expect(r.handle).toBe("x-3");
});

test("a repeat sign-in with a different base releases the old seat and takes a fresh one", () => {
  const db = fresh();
  expect(mustSignIn({ sessionId: "s1", baseHandle: "x", now }, db).handle).toBe("x");
  expect(mustSignIn({ sessionId: "s1", baseHandle: "y", now: now + MIN }, db).handle).toBe("y");
  // the old base's slot was released outright, not left behind as a ghost
  expect(mustSignIn({ sessionId: "s2", baseHandle: "x", now: now + 2 * MIN }, db)).toMatchObject({ handle: "x", reclaimed: false });
});

test("signIn skips a candidate handle that's globally held by an unrelated base family", () => {
  const db = fresh();
  mustSignIn({ sessionId: "s1", baseHandle: "x", now }, db); // "x"
  mustSignIn({ sessionId: "s2", baseHandle: "x", now }, db); // "x-2" — base_handle "x", live
  // s3's OWN derived base happens to be the literal string "x-2" (e.g. a
  // worktree dir named "2"). Scoping seat selection to base_handle="x-2"
  // alone would see no rows at all and hand out "x-2" — already taken.
  const r = mustSignIn({ sessionId: "s3", baseHandle: "x-2", now }, db);
  expect(r.handle).toBe("x-2-2");
});

test("signIn reclaims a globally-held candidate rather than just skipping it", () => {
  const db = fresh();
  mustSignIn({ sessionId: "s1", baseHandle: "x", now }, db); // "x"
  mustSignIn({ sessionId: "s2", baseHandle: "x-2", now }, db); // base_handle "x-2", handle "x-2"
  // s2 goes silent for 2h with no tail — reclaimable by the time s3 arrives.
  const later = now + 2 * HOUR;
  const r = mustSignIn({ sessionId: "s3", baseHandle: "x-2", now: later }, db);
  expect(r).toMatchObject({ handle: "x-2", reclaimed: true });
});

test("own-seat preference: a reclaimable row with matching cwd+pane wins over an earlier lower-suffix reclaimable row", () => {
  const db = fresh();
  mustSignIn({ sessionId: "s1", baseHandle: "x", now }, db); // "x"
  mustSignIn({ sessionId: "s2", baseHandle: "x", cwd: "/other", now }, db); // "x-2"
  mustSignIn({ sessionId: "s3", baseHandle: "x", cwd: "/mine", pane: "7", now }, db); // "x-3"
  const later = now + 2 * HOUR;
  db.run("UPDATE chat_presence SET last_seen_at = ? WHERE handle = 'x'", [later]); // "x" stays live
  // "x-2" and "x-3" are both stale (untouched last_seen_at) and reclaimable
  // by `later`; only "x-3"'s cwd+pane matches the incoming session.
  const r = mustSignIn({ sessionId: "s4", baseHandle: "x", cwd: "/mine", pane: "7", now: later }, db);
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
  mustSignIn({ sessionId: "s1", baseHandle: "y", now }, db2);
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
  const a = mustSignIn({ sessionId: "s1", now }, db);
  const b = mustSignIn({ sessionId: "s2", now }, db);
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
    const { baseHandle } = mustSignIn({ sessionId: `s${i}`, now: t }, db);
    signOut(`s${i}`, t, db);
    drawn.push(baseHandle);
  }
  expect(new Set(drawn.slice(0, AGENT_NAMES.length)).size).toBe(AGENT_NAMES.length);
  expect(drawn[AGENT_NAMES.length]).toBe(drawn[0]);
});

test("a repeat sign-in with no base keeps the name the session already holds", () => {
  const db = fresh();
  const first = mustSignIn({ sessionId: "s1", now }, db);
  const again = mustSignIn({ sessionId: "s1", now: now + MIN }, db);
  expect(again.baseHandle).toBe(first.baseHandle);
  expect(again.handle).toBe(first.handle);
});

test("an explicitly named pool name counts as used; a non-pool base is not recorded", () => {
  const db = fresh();
  mustSignIn({ sessionId: "s1", baseHandle: "kai", now }, db);
  mustSignIn({ sessionId: "s2", baseHandle: "mr-board", now }, db);
  const ledger = getKvValue<Record<string, number>>("chat", "names", {}, db);
  expect(ledger.kai).toBe(now);
  expect(ledger["mr-board"]).toBeUndefined();
});
