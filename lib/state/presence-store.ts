/**
 * lib/state/presence-store.ts — sign-in presence for `rt chat` (RT-48).
 * The only module that touches `chat_presence`; `chat_room_defaults` and
 * `chat_dms` remain chat-store.ts's and dm-store.ts's respectively, since
 * neither carries a heartbeat or a reclaim predicate.
 */

import { Database } from "bun:sqlite";
import { AGENT_NAMES, pickAgentName } from "../chat-names.ts";
import { getStateDb } from "./db.ts";
import { getKvValue, setKvValue } from "./kv-blob.ts";

export type BuddyStatus = "live" | "idle" | "deaf" | "offline";

export interface PresenceRow {
  sessionId: string;
  handle: string;
  baseHandle: string;
  cwd?: string;
  repo?: string;
  branch?: string;
  pane?: string;
  statusText?: string;
  signedInAt: number;
  lastSeenAt: number;
  tailSeenAt?: number;
  armedAt?: number;
  signedOutAt?: number;
}

export interface PresenceThresholds {
  tailStaleMs: number;
  sessionStaleMs: number;
  pruneMs: number;
}

interface PresenceRawRow {
  session_id: string;
  handle: string;
  base_handle: string;
  cwd: string | null;
  repo: string | null;
  branch: string | null;
  pane: string | null;
  status_text: string | null;
  signed_in_at: number;
  last_seen_at: number;
  tail_seen_at: number | null;
  armed_at: number | null;
  signed_out_at: number | null;
}

function rowToPresence(row: PresenceRawRow): PresenceRow {
  const presence: PresenceRow = {
    sessionId: row.session_id,
    handle: row.handle,
    baseHandle: row.base_handle,
    signedInAt: row.signed_in_at,
    lastSeenAt: row.last_seen_at,
  };
  if (row.cwd !== null) presence.cwd = row.cwd;
  if (row.repo !== null) presence.repo = row.repo;
  if (row.branch !== null) presence.branch = row.branch;
  if (row.pane !== null) presence.pane = row.pane;
  if (row.status_text !== null) presence.statusText = row.status_text;
  if (row.tail_seen_at !== null) presence.tailSeenAt = row.tail_seen_at;
  if (row.armed_at !== null) presence.armedAt = row.armed_at;
  if (row.signed_out_at !== null) presence.signedOutAt = row.signed_out_at;
  return presence;
}

const PRESENCE_COLUMNS =
  "session_id, handle, base_handle, cwd, repo, branch, pane, status_text, signed_in_at, last_seen_at, tail_seen_at, armed_at, signed_out_at";

/**
 * The one reclaim predicate (spec "Failure modes" — "Suffix churn"): a
 * handle's holder is reclaimable when signed out, OR its session heartbeat
 * is older than the session-stale cutoff AND its tail heartbeat
 * (COALESCE(tail_seen_at, armed_at), absent counting as 0 — maximally
 * stale) is older than the tail-stale cutoff. Bind params in order:
 * sessionStaleCutoff, tailStaleCutoff (absolute timestamps, `now - Ms`).
 */
const RECLAIMABLE_SQL = `signed_out_at IS NOT NULL OR (last_seen_at < ? AND COALESCE(tail_seen_at, armed_at, 0) < ?)`;

/**
 * Prune's own predicate, deliberately never RECLAIMABLE_SQL: that fragment's
 * bare `signed_out_at IS NOT NULL` leg would delete every signed-out row at
 * daemon startup and empty the offline window. The second leg also honors
 * the tail heartbeat (COALESCE(tail_seen_at, armed_at, 0)), the same fold
 * buddyStatus's offline check uses — an armed row a long autonomous turn is
 * still touching must survive even once last_seen_at alone looks stale.
 * Bind params in order: dayAgo, dayAgo, dayAgo (same cutoff, all three legs).
 */
const PRUNABLE_SQL = `(signed_out_at IS NOT NULL AND signed_out_at < ?) OR (last_seen_at < ? AND COALESCE(tail_seen_at, armed_at, 0) < ?)`;

const SELECT_PRESENCE_BY_HANDLE_SQL = `SELECT ${PRESENCE_COLUMNS} FROM chat_presence WHERE handle = ?;`;
const SELECT_PRESENCE_BY_SESSION_SQL = `SELECT ${PRESENCE_COLUMNS} FROM chat_presence WHERE session_id = ?;`;
// Bind order: sessionStaleCutoff, tailStaleCutoff, baseHandle — the whole
// suffix family in one query, so signIn's seat selection scans an in-memory
// set instead of probing candidates one handle string at a time (a probe
// loop can never look past the first free slot to a same-base row beyond
// it).
const SELECT_BASE_HANDLE_ROWS_SQL = `SELECT ${PRESENCE_COLUMNS}, (${RECLAIMABLE_SQL}) AS reclaimable FROM chat_presence WHERE base_handle = ?;`;
// `handle` is globally UNIQUE across every base_handle family, so a "gap"
// suffix absent from THIS family's rows can still be occupied by a row from
// an unrelated one (e.g. a worktree dir literally named "2" derives the
// base "x-2", which collides with "x"'s own second suffix). Bind order:
// sessionStaleCutoff, tailStaleCutoff, handle.
const SELECT_HANDLE_RECLAIMABLE_SQL = `SELECT ${PRESENCE_COLUMNS}, (${RECLAIMABLE_SQL}) AS reclaimable FROM chat_presence WHERE handle = ?;`;
const SELECT_NON_PRUNABLE_PRESENCE_SQL = `SELECT ${PRESENCE_COLUMNS} FROM chat_presence WHERE NOT (${PRUNABLE_SQL});`;
const DELETE_PRUNABLE_PRESENCE_SQL = `DELETE FROM chat_presence WHERE ${PRUNABLE_SQL};`;
const DELETE_PRESENCE_BY_SESSION_SQL = `DELETE FROM chat_presence WHERE session_id = ?;`;
const INSERT_PRESENCE_SQL = `INSERT INTO chat_presence (session_id, handle, base_handle, cwd, repo, branch, pane, status_text, signed_in_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`;
const UPDATE_SIGN_OUT_SQL = `UPDATE chat_presence SET signed_out_at = ?, armed_at = NULL WHERE session_id = ?;`;
const UPDATE_STATUS_TEXT_SQL = `UPDATE chat_presence SET status_text = ? WHERE session_id = ?;`;
const UPDATE_PULSE_SQL = `UPDATE chat_presence SET last_seen_at = ?, cwd = COALESCE(?, cwd), repo = COALESCE(?, repo), branch = COALESCE(?, branch), pane = COALESCE(?, pane) WHERE session_id = ?;`;
const UPDATE_PRESENCE_ARMED_BY_HANDLE_SQL = `UPDATE chat_presence SET armed_at = ?, tail_seen_at = NULL WHERE handle = ?;`;
const UPDATE_PRESENCE_TAIL_BY_HANDLE_SQL = `UPDATE chat_presence SET tail_seen_at = ?, armed_at = COALESCE(armed_at, ?) WHERE handle = ?;`;
const UPDATE_PRESENCE_DISARMED_BY_HANDLE_SQL = `UPDATE chat_presence SET armed_at = NULL WHERE handle = ?;`;

const DEFAULT_TAIL_STALE_MS = 10 * 60_000;
const DEFAULT_SESSION_STALE_MS = 60 * 60_000;
const DEFAULT_PRUNE_MS = 24 * 60 * 60_000;

function envMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Read at call time (never memoized): the daemon evaluates thresholds fresh on every status computation, per env at that instant. */
export function presenceThresholds(): PresenceThresholds {
  return {
    tailStaleMs: envMs("RT_CHAT_TAIL_STALE_MS", DEFAULT_TAIL_STALE_MS),
    sessionStaleMs: envMs("RT_CHAT_SESSION_STALE_MS", DEFAULT_SESSION_STALE_MS),
    pruneMs: envMs("RT_CHAT_PRUNE_MS", DEFAULT_PRUNE_MS),
  };
}

/**
 * The spec's Statuses table, rows tested most-stale-first so the first
 * match wins (a signed-in row silent for 30 hours is offline, not deaf).
 * For an armed row the tail heartbeat is the sole authority — the session
 * heartbeat only advances on user prompts, so a long autonomous turn
 * starves it for hours while the tail keeps touching.
 */
export function buddyStatus(
  row: Partial<Pick<PresenceRow, "signedOutAt" | "lastSeenAt" | "tailSeenAt" | "armedAt">>,
  now: number,
  th: PresenceThresholds = presenceThresholds(),
): BuddyStatus {
  if (row.signedOutAt !== undefined) return "offline";
  const lastSeenAt = row.lastSeenAt ?? 0;
  // A >24h autonomous agent (Monitor-driven, no user prompt) keeps only its
  // tail heartbeat fresh — last_seen_at advances on a user prompt alone, so
  // it starves for hours while the tail keeps touching. The offline check
  // must honor whichever heartbeat is newer, or the handle reads offline
  // (and the next chat:sign-in by any session prunes and reclaims it) out
  // from under a session that never left.
  const tailLiveness = row.armedAt !== undefined ? (row.tailSeenAt ?? row.armedAt) : 0;
  const liveness = Math.max(lastSeenAt, tailLiveness);
  if (now - liveness > th.pruneMs) return "offline";
  if (row.armedAt !== undefined) {
    const tailHeartbeat = row.tailSeenAt ?? row.armedAt;
    return now - tailHeartbeat <= th.tailStaleMs ? "live" : "deaf";
  }
  return now - lastSeenAt > th.sessionStaleMs ? "deaf" : "idle";
}

/**
 * The suffix number a handle occupies within `baseHandle`'s family (`x` is
 * 1, `x-2` is 2, …), or null when `handle` isn't one of that family's
 * members at all — the case for a session's remembered handle after its
 * own baseHandle has changed (a different cwd), where no suffix of the new
 * base can mean "this exact prior handle".
 */
function suffixOf(handle: string, baseHandle: string): number | null {
  if (handle === baseHandle) return 1;
  const prefix = `${baseHandle}-`;
  if (!handle.startsWith(prefix)) return null;
  const n = Number(handle.slice(prefix.length));
  return Number.isInteger(n) && n >= 2 ? n : null;
}

function suffixToHandle(suffix: number, baseHandle: string): string {
  return suffix === 1 ? baseHandle : `${baseHandle}-${suffix}`;
}

/**
 * (c)/(d): walks suffixes from 1, skipping ones this family already
 * occupies, and returns the first that's free or reclaimable GLOBALLY — a
 * suffix absent from the family can still be held by an unrelated base's
 * family (`handle` is globally UNIQUE, `base_handle` is not what's being
 * matched here), so each such candidate needs its own check against the
 * whole table rather than just this family's rows.
 */
function findOpenSuffix(
  db: Database,
  baseHandle: string,
  bySuffix: Map<number, PresenceRawRow & { reclaimable: number }>,
  sessionStaleCutoff: number,
  tailStaleCutoff: number,
): { suffix: number; row: (PresenceRawRow & { reclaimable: number }) | null } {
  for (let candidate = 1; ; candidate++) {
    if (bySuffix.has(candidate)) continue;
    const globalRow = db.query(SELECT_HANDLE_RECLAIMABLE_SQL).get(sessionStaleCutoff, tailStaleCutoff, suffixToHandle(candidate, baseHandle)) as
      | (PresenceRawRow & { reclaimable: number })
      | null;
    if (!globalRow) return { suffix: candidate, row: null };
    if (globalRow.reclaimable) return { suffix: candidate, row: globalRow };
  }
}

export function signIn(
  args: {
    sessionId: string;
    baseHandle?: string;
    cwd?: string;
    repo?: string;
    branch?: string;
    pane?: string;
    statusText?: string;
    now?: number;
  },
  db: Database = getStateDb(),
): { handle: string; baseHandle: string; reclaimed: boolean } {
  const { sessionId, statusText } = args;
  // Defense in depth: the handler (lib/daemon/handlers/chat.ts) is the
  // root-cause guard, but session_id is a bare TEXT PRIMARY KEY with no
  // NOT NULL/CHECK constraint (bun:sqlite binds undefined as NULL, which
  // SQLite accepts), so any future caller of this store function directly
  // must not be able to wedge the same NULL-keyed-row failure mode.
  if (!sessionId) throw new Error("signIn: sessionId is required");
  const cwd = args.cwd ?? null;
  const repo = args.repo ?? null;
  const branch = args.branch ?? null;
  const pane = args.pane ?? null;
  const now = args.now ?? Date.now();
  const th = presenceThresholds();
  const sessionStaleCutoff = now - th.sessionStaleMs;
  const tailStaleCutoff = now - th.tailStaleMs;

  const run = db.transaction((): { handle: string; baseHandle: string; reclaimed: boolean } => {
    // The two moments a handle is about to be needed (spec "Pruning").
    prunePresence(now, db);

    // A session may always retake its own seat: drop whatever row it
    // already held before selecting, so a repeat sign-in is idempotent
    // rather than a raw UNIQUE violation against the very handle it's
    // about to be granted again. Once dropped, that exact handle string
    // can never be "occupied" by anyone else inside this same transaction.
    // With no base requested, the row's own base is kept over a fresh
    // draw, so a repeat sign-in never changes identity.
    const ownPriorRow = db.query(SELECT_PRESENCE_BY_SESSION_SQL).get(sessionId) as PresenceRawRow | null;
    if (ownPriorRow) db.query(DELETE_PRESENCE_BY_SESSION_SQL).run(sessionId);
    const baseHandle = args.baseHandle ?? ownPriorRow?.base_handle ?? drawPoolName(db);

    const familyRows = db.query(SELECT_BASE_HANDLE_ROWS_SQL).all(sessionStaleCutoff, tailStaleCutoff, baseHandle) as (PresenceRawRow & {
      reclaimable: number;
    })[];
    const bySuffix = new Map<number, PresenceRawRow & { reclaimable: number }>();
    for (const row of familyRows) {
      const suffix = suffixOf(row.handle, baseHandle);
      if (suffix !== null) bySuffix.set(suffix, row);
    }

    // "Own seat" (a): the session's own previous row, if it named a suffix
    // within THIS baseHandle's family (suffixOf returns null when the
    // remembered handle belonged to a different base — nothing here to
    // prefer) — or, failing that, a reclaimable family row whose cwd AND
    // pane both match the incoming session (a restarted process: new
    // session id, same seat). Every family row here is already the sole
    // global occupant of its exact handle string (handle is UNIQUE), so
    // neither branch needs a global check: the own-row slot is free by
    // construction (just dropped above) and the cwd/pane match is a real
    // row already in hand.
    let winnerSuffix: number | null = ownPriorRow ? suffixOf(ownPriorRow.handle, baseHandle) : null;
    let winnerRow: (PresenceRawRow & { reclaimable: number }) | null = null;
    if (winnerSuffix === null) {
      const seatMatch = familyRows.find((row) => row.reclaimable && row.cwd === cwd && row.pane === pane);
      if (seatMatch) {
        winnerSuffix = suffixOf(seatMatch.handle, baseHandle);
        winnerRow = seatMatch;
      }
    }

    if (winnerSuffix === null) {
      // (b) the first reclaimable row, by suffix order — same reasoning:
      // a family row is already the exact global occupant.
      const reclaimableBySuffix = [...bySuffix.entries()].filter(([, row]) => row.reclaimable).sort((a, b) => a[0] - b[0]);
      if (reclaimableBySuffix.length > 0) [winnerSuffix, winnerRow] = reclaimableBySuffix[0]!;
    }

    if (winnerSuffix === null) {
      const open = findOpenSuffix(db, baseHandle, bySuffix, sessionStaleCutoff, tailStaleCutoff);
      winnerSuffix = open.suffix;
      winnerRow = open.row;
    }

    const handle = suffixToHandle(winnerSuffix, baseHandle);
    // The old row's session_id is its primary key and its handle is
    // UNIQUE, so it cannot be updated into the new session — delete then insert.
    if (winnerRow) db.query(DELETE_PRESENCE_BY_SESSION_SQL).run(winnerRow.session_id);
    db.query(INSERT_PRESENCE_SQL).run(sessionId, handle, baseHandle, cwd, repo, branch, pane, statusText ?? null, now, now);
    recordPoolNameUse(baseHandle, now, db);

    return { handle, baseHandle, reclaimed: winnerRow !== null };
  });

  return run.immediate();
}

const NAMES_KV_NS = "chat";
const NAMES_KV_KEY = "names";
const SELECT_ALL_HANDLES_SQL = `SELECT handle FROM chat_presence;`;

/** Runs after the prune, so every remaining row counts as held: signed-out rows in their offline window included, which is exactly the buddy list. */
function drawPoolName(db: Database): string {
  const taken = (db.query(SELECT_ALL_HANDLES_SQL).all() as { handle: string }[]).map((r) => r.handle);
  return pickAgentName(taken, getKvValue<Record<string, number>>(NAMES_KV_NS, NAMES_KV_KEY, {}, db));
}

function recordPoolNameUse(name: string, now: number, db: Database): void {
  if (!AGENT_NAMES.includes(name)) return;
  const ledger = getKvValue<Record<string, number>>(NAMES_KV_NS, NAMES_KV_KEY, {}, db);
  ledger[name] = now;
  setKvValue(NAMES_KV_NS, NAMES_KV_KEY, ledger, db);
}

export function signOut(sessionId: string, now: number = Date.now(), db: Database = getStateDb()): void {
  db.query(UPDATE_SIGN_OUT_SQL).run(now, sessionId);
}

export function setAway(sessionId: string, text: string | null, db: Database = getStateDb()): void {
  db.query(UPDATE_STATUS_TEXT_SQL).run(text, sessionId);
}

/** last_seen_at + deets only — NEVER tail_seen_at, which is chat:touch's alone (spec "Two heartbeats, never one"). */
export function pulseSession(
  args: { sessionId: string; cwd?: string; repo?: string; branch?: string; pane?: string; now?: number },
  db: Database = getStateDb(),
): void {
  const { sessionId, cwd, repo, branch, pane } = args;
  const now = args.now ?? Date.now();
  db.query(UPDATE_PULSE_SQL).run(now, cwd ?? null, repo ?? null, branch ?? null, pane ?? null, sessionId);
}

export function listBuddies(now: number, db: Database = getStateDb()): Array<PresenceRow & { status: BuddyStatus }> {
  const th = presenceThresholds();
  const dayAgo = now - th.pruneMs;
  const rows = db.query(SELECT_NON_PRUNABLE_PRESENCE_SQL).all(dayAgo, dayAgo, dayAgo) as PresenceRawRow[];
  return rows.map((raw) => {
    const presence = rowToPresence(raw);
    return { ...presence, status: buddyStatus(presence, now, th) };
  });
}

export function presenceForHandle(handle: string, db: Database = getStateDb()): PresenceRow | null {
  const row = db.query(SELECT_PRESENCE_BY_HANDLE_SQL).get(handle) as PresenceRawRow | null;
  return row ? rowToPresence(row) : null;
}

export function presenceForSession(sessionId: string, db: Database = getStateDb()): PresenceRow | null {
  const row = db.query(SELECT_PRESENCE_BY_SESSION_SQL).get(sessionId) as PresenceRawRow | null;
  return row ? rowToPresence(row) : null;
}

/** Handle-keyed payloads (arm/touch/disarm): enforced only when a presence row exists for the handle AND a session id was offered — the unsigned plan-1 path stays unenforced. */
export function assertSessionOwnsHandle(handle: string, sessionId: string | undefined, db: Database = getStateDb()): void {
  if (sessionId === undefined) return;
  const row = db.query(SELECT_PRESENCE_BY_HANDLE_SQL).get(handle) as PresenceRawRow | null;
  if (row === null) return;
  if (row.session_id !== sessionId) throw new Error(`chat: handle reclaimed — "${handle}" is now held by another session; sign in again`);
}

/**
 * Session-keyed payloads (pulse/away/back): no row for this session id means
 * the handle was reclaimed; a row whose `signed_out_at` is set means this
 * exact session chose to sign out — a deliberate state, not a reclaim, so
 * its message must never contain "handle reclaimed" (the hook treats that
 * substring as the reclaimed notice). pulse's own contract (`status` is
 * never "offline") holds only because this throws before pulse ever
 * heartbeats a signed-out row.
 */
export function assertSessionSignedIn(sessionId: string, db: Database = getStateDb()): PresenceRow {
  const row = presenceForSession(sessionId, db);
  if (!row) throw new Error("chat: handle reclaimed while you were away; sign in again");
  if (row.signedOutAt !== undefined) throw new Error(`chat: session ${sessionId} is not signed in`);
  return row;
}

/**
 * Signed out more than 24h ago, or a session heartbeat over 24h old — the
 * two moments a handle is about to be needed (sign-in, daemon startup) are
 * the only call sites; RT_CHAT_PRUNE_MS has no other route in.
 */
export function prunePresence(now: number, db: Database = getStateDb()): number {
  const th = presenceThresholds();
  const dayAgo = now - th.pruneMs;
  return db.query(DELETE_PRUNABLE_PRESENCE_SQL).run(dayAgo, dayAgo, dayAgo).changes;
}

// --- Internal wiring for chat-store.ts's dual-write (arm/touch/disarm). ---
// Not part of the barrel-exported contract: chat-store.ts imports these
// directly, per RT-48's intra-lib/state exception, so every write against
// chat_presence stays owned by this file.

export function armPresenceByHandle(handle: string, now: number, db: Database = getStateDb()): void {
  db.query(UPDATE_PRESENCE_ARMED_BY_HANDLE_SQL).run(now, handle);
}

export function touchPresenceByHandle(handle: string, now: number, db: Database = getStateDb()): void {
  db.query(UPDATE_PRESENCE_TAIL_BY_HANDLE_SQL).run(now, now, handle);
}

export function disarmPresenceByHandle(handle: string, db: Database = getStateDb()): void {
  db.query(UPDATE_PRESENCE_DISARMED_BY_HANDLE_SQL).run(handle);
}
