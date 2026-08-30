/**
 * lib/state/presence-store.ts — sign-in presence for `rt chat` (RT-48).
 * The only module that touches `chat_presence`; `chat_room_defaults` and
 * `chat_dms` remain chat-store.ts's and dm-store.ts's respectively, since
 * neither carries a heartbeat or a reclaim predicate.
 */

import { Database } from "bun:sqlite";
import { AGENT_NAMES, pickAgentName } from "../chat-names.ts";
import { resolveAllInboxes, resolveInbox, inboxAlive } from "../claude-registry.ts";
import { persistOrWarn, runCriticalWrite } from "./busy.ts";
import { getStateDb } from "./db.ts";
import { getKvValue, setKvValue } from "./kv-blob.ts";

export type BuddyStatus = "live" | "idle" | "offline";

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
  signedOutAt?: number;
}

export interface PresenceThresholds {
  sessionStaleMs: number;
  pruneMs: number;
}

/** The registry probe, fakeable the same way lib/daemon/handlers/chat.ts's InboxDeps is: real implementations by default, swapped for a fake in tests that need a dead or alive binding on demand. */
export type RegistryDeps = { resolve: typeof resolveInbox; alive: typeof inboxAlive; resolveAll: typeof resolveAllInboxes };
const defaultRegistryDeps: RegistryDeps = { resolve: resolveInbox, alive: inboxAlive, resolveAll: resolveAllInboxes };

/**
 * One registry scan (`deps.resolveAll()`) turned into a per-session lookup,
 * so N row/candidate checks against the result cost one directory read
 * total instead of N. Only `resolve` is replaced; `alive` and `resolveAll`
 * still come from `deps`, so a caller-supplied fake keeps controlling both.
 * Call once per outer operation (one `listBuddies`, one `chat:who`, one
 * `signIn` transaction) and thread the result down to every row it checks.
 */
export function snapshotRegistryDeps(deps: RegistryDeps = defaultRegistryDeps): RegistryDeps {
  const bindings = deps.resolveAll();
  return { resolve: (sessionId) => bindings.get(sessionId) ?? null, alive: deps.alive, resolveAll: deps.resolveAll };
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
  if (row.signed_out_at !== null) presence.signedOutAt = row.signed_out_at;
  return presence;
}

const PRESENCE_COLUMNS =
  "session_id, handle, base_handle, cwd, repo, branch, pane, status_text, signed_in_at, last_seen_at, signed_out_at";

function bindingAlive(sessionId: string, deps: RegistryDeps): boolean {
  const binding = deps.resolve(sessionId);
  return binding !== null && deps.alive(binding);
}

/**
 * The one reclaim predicate (spec "Failure modes", "Suffix churn"): a
 * handle's holder is reclaimable when signed out, or its session heartbeat
 * is older than the session-stale cutoff AND the registry has nothing alive
 * for its session id -- a long autonomous turn can leave last_seen_at old
 * while the agent is very much still there, so staleness alone must never
 * reclaim a seat the registry still vouches for.
 */
function isReclaimable(row: PresenceRawRow, sessionStaleCutoff: number, deps: RegistryDeps): boolean {
  if (row.signed_out_at !== null) return true;
  if (row.last_seen_at >= sessionStaleCutoff) return false;
  return !bindingAlive(row.session_id, deps);
}

/**
 * Prune's own CANDIDATE predicate, deliberately not `isReclaimable`: a row
 * only reaches deletion once it also passes the binding-aware check in
 * `prunePresence` below (signed out, or a dead registry binding) -- a bare
 * `signed_out_at IS NOT NULL` leg with no age bound would delete every
 * signed-out row at daemon startup and empty the offline window, so this
 * SQL only narrows to "old enough to be worth a registry check", never the
 * final delete decision. Bind params in order: dayAgo, dayAgo (both legs).
 */
const PRUNABLE_SQL = `(signed_out_at IS NOT NULL AND signed_out_at < ?) OR (signed_out_at IS NULL AND last_seen_at < ?)`;

const SELECT_PRESENCE_BY_HANDLE_SQL = `SELECT ${PRESENCE_COLUMNS} FROM chat_presence WHERE handle = ?;`;
const SELECT_PRESENCE_BY_SESSION_SQL = `SELECT ${PRESENCE_COLUMNS} FROM chat_presence WHERE session_id = ?;`;
// The whole suffix family in one query, so signIn's seat selection scans an
// in-memory set instead of probing candidates one handle string at a time (a
// probe loop can never look past the first free slot to a same-base row
// beyond it). Reclaimability is computed in TS (isReclaimable), never SQL --
// it depends on a live registry probe.
const SELECT_BASE_HANDLE_ROWS_SQL = `SELECT ${PRESENCE_COLUMNS} FROM chat_presence WHERE base_handle = ?;`;
// The roster's own cutoff is the signed-out leg alone, never last_seen_at:
// a stale-but-live-binding row must reach buddyStatus to be classified
// live/idle, not disappear from the list before buddyStatus ever sees it.
// One bind param: dayAgo.
const SELECT_ROSTER_SQL = `SELECT ${PRESENCE_COLUMNS} FROM chat_presence WHERE signed_out_at IS NULL OR signed_out_at >= ?;`;
const SELECT_PRUNE_CANDIDATES_SQL = `SELECT ${PRESENCE_COLUMNS} FROM chat_presence WHERE ${PRUNABLE_SQL};`;
const DELETE_PRESENCE_BY_SESSION_SQL = `DELETE FROM chat_presence WHERE session_id = ?;`;
const INSERT_PRESENCE_SQL = `INSERT INTO chat_presence (session_id, handle, base_handle, cwd, repo, branch, pane, status_text, signed_in_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);`;
const UPDATE_SIGN_OUT_SQL = `UPDATE chat_presence SET signed_out_at = ? WHERE session_id = ?;`;
const UPDATE_STATUS_TEXT_SQL = `UPDATE chat_presence SET status_text = ? WHERE session_id = ?;`;
const UPDATE_LAST_SEEN_SQL = `UPDATE chat_presence SET last_seen_at = ? WHERE session_id = ?;`;

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
    sessionStaleMs: envMs("RT_CHAT_SESSION_STALE_MS", DEFAULT_SESSION_STALE_MS),
    pruneMs: envMs("RT_CHAT_PRUNE_MS", DEFAULT_PRUNE_MS),
  };
}

/**
 * offline: signed out, or the registry has nothing alive for this session --
 * no resolvable entry at all, or one whose pid is dead or whose socket is
 * gone (spec: "pid dead, or socket gone"). Otherwise live when the alive
 * binding's status is busy; idle otherwise (alive but not busy).
 *
 * Deliberately no `last_seen_at` staleness leg: prunePresence (below) is
 * what actually retires a row, and it already spares anything the registry
 * still vouches for regardless of how old the heartbeat has gone.
 * Duplicating that staleness check here would flip a still-busy session to
 * offline the moment its heartbeat aged past pruneMs, even though nothing
 * about its row is anywhere near being pruned -- `now`/`th` stay for
 * signature stability with every existing call site.
 */
export function buddyStatus(
  row: Partial<Pick<PresenceRow, "signedOutAt" | "lastSeenAt" | "sessionId">>,
  now: number,
  th: PresenceThresholds = presenceThresholds(),
  deps: RegistryDeps = defaultRegistryDeps,
): BuddyStatus {
  if (row.signedOutAt !== undefined) return "offline";
  if (!row.sessionId) return "offline";
  const binding = deps.resolve(row.sessionId);
  if (!binding || !deps.alive(binding)) return "offline";
  return binding.status === "busy" ? "live" : "idle";
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
  bySuffix: Map<number, PresenceRawRow & { reclaimable: boolean }>,
  sessionStaleCutoff: number,
  deps: RegistryDeps,
): { suffix: number; row: (PresenceRawRow & { reclaimable: boolean }) | null } {
  for (let candidate = 1; ; candidate++) {
    if (bySuffix.has(candidate)) continue;
    // `handle` is globally UNIQUE across every base_handle family, so a
    // "gap" suffix absent from THIS family's rows can still be occupied by
    // a row from an unrelated one (e.g. a worktree dir literally named "2"
    // derives the base "x-2", which collides with "x"'s own second suffix).
    const globalRow = db.query(SELECT_PRESENCE_BY_HANDLE_SQL).get(suffixToHandle(candidate, baseHandle)) as PresenceRawRow | null;
    if (!globalRow) return { suffix: candidate, row: null };
    const reclaimable = isReclaimable(globalRow, sessionStaleCutoff, deps);
    if (reclaimable) return { suffix: candidate, row: { ...globalRow, reclaimable } };
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
  deps: RegistryDeps = defaultRegistryDeps,
): { handle: string; baseHandle: string; reclaimed: boolean } | undefined {
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

  const run = db.transaction((): { handle: string; baseHandle: string; reclaimed: boolean } => {
    // One registry scan for the whole transaction: prune's binding check,
    // every family row's reclaimability, and findOpenSuffix's candidate
    // walk all resolve against this same snapshot instead of each doing
    // its own directory read.
    const scoped = snapshotRegistryDeps(deps);

    // The two moments a handle is about to be needed (spec "Pruning").
    prunePresence(now, db, scoped);

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

    const familyRowsRaw = db.query(SELECT_BASE_HANDLE_ROWS_SQL).all(baseHandle) as PresenceRawRow[];
    const familyRows = familyRowsRaw.map((row) => ({ ...row, reclaimable: isReclaimable(row, sessionStaleCutoff, scoped) }));
    const bySuffix = new Map<number, PresenceRawRow & { reclaimable: boolean }>();
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
    let winnerRow: (PresenceRawRow & { reclaimable: boolean }) | null = null;
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
      const open = findOpenSuffix(db, baseHandle, bySuffix, sessionStaleCutoff, scoped);
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

  // A signed-in identity is not re-derivable from anything else (R057): a
  // busy connection here must retry, not warn-and-drop the way a cache-class
  // write can.
  return runCriticalWrite("signIn", () => run.immediate(), { sessionId });
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

/**
 * Draws a pool name for an agent that has not signed in yet (`rt agent
 * start`), against the same live-presence-held set and LRU ledger `signIn`'s
 * own draw uses, and records the draw immediately -- so a second
 * reservation or a sign-in racing before this agent's own chat:sign-in
 * lands does not also land on it.
 */
export function reserveAgentHandle(db: Database = getStateDb(), now: number = Date.now()): string {
  const run = db.transaction((): string => {
    const name = drawPoolName(db);
    recordPoolNameUse(name, now, db);
    return name;
  });
  // BEGIN IMMEDIATE: read-then-write must lock up front or SQLITE_BUSY_SNAPSHOT
  // bypasses busy_timeout (same reason as signIn's S073 fix above).
  return run.immediate();
}

export function signOut(sessionId: string, now: number = Date.now(), db: Database = getStateDb()): void {
  // A sign-out lost to a busy write is not re-derivable later the way a
  // cache-class status write is (R057): retry rather than warn-and-drop.
  runCriticalWrite("signOut", () => { db.query(UPDATE_SIGN_OUT_SQL).run(now, sessionId); }, { sessionId });
}

export function setAway(sessionId: string, text: string | null, db: Database = getStateDb()): void {
  // Cache-class (R057): the next away/back toggle overwrites this row
  // regardless, so a busy write here warns and defers rather than throwing.
  persistOrWarn("presence", () => { db.query(UPDATE_STATUS_TEXT_SQL).run(text, sessionId); }, { op: "setAway", sessionId });
}

/**
 * Refreshes the SESSION heartbeat alone (no cwd/repo/branch/pane) -- the
 * only remaining route to it now that chat:pulse is gone. Called on every
 * successful delivery (lib/daemon/handlers/chat.ts's deliverPost and
 * deliverWelcomeOnce), so a handle actively receiving messages never goes
 * stale enough for prune to consider it, let alone delete it.
 */
export function touchLastSeen(sessionId: string, now: number, db: Database = getStateDb()): void {
  // Cache-class (R057): the next delivery's touch supersedes a dropped one,
  // so a busy write here warns and defers rather than throwing.
  persistOrWarn("presence", () => { db.query(UPDATE_LAST_SEEN_SQL).run(now, sessionId); }, { op: "touchLastSeen", sessionId });
}

export function listBuddies(
  now: number,
  db: Database = getStateDb(),
  deps: RegistryDeps = defaultRegistryDeps,
): Array<PresenceRow & { status: BuddyStatus }> {
  const th = presenceThresholds();
  const dayAgo = now - th.pruneMs;
  const rows = db.query(SELECT_ROSTER_SQL).all(dayAgo) as PresenceRawRow[];
  // One registry scan for the whole roster, reused by every row's status.
  const scoped = snapshotRegistryDeps(deps);
  return rows.map((raw) => {
    const presence = rowToPresence(raw);
    return { ...presence, status: buddyStatus(presence, now, th, scoped) };
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

/** Handle-keyed payloads (dm/dm-open): enforced only when a presence row exists for the handle AND a session id was offered (the unsigned plan-1 path stays unenforced). */
export function assertSessionOwnsHandle(handle: string, sessionId: string | undefined, db: Database = getStateDb()): void {
  if (sessionId === undefined) return;
  const row = db.query(SELECT_PRESENCE_BY_HANDLE_SQL).get(handle) as PresenceRawRow | null;
  if (row === null) return;
  if (row.session_id !== sessionId) throw new Error(`chat: handle reclaimed — "${handle}" is now held by another session; sign in again`);
}

/**
 * Session-keyed payloads (away/back): no row for this session id means the
 * handle was reclaimed; a row whose `signed_out_at` is set means this exact
 * session chose to sign out (a deliberate state, not a reclaim), so its
 * message must never contain "handle reclaimed" (the hook treats that
 * substring as the reclaimed notice).
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
 *
 * PRUNABLE_SQL only narrows to candidates; the actual delete decision is
 * binding-aware, per row: signed out prunes unconditionally (that leg
 * already carries its own 24h age bound), but a never-signed-out row whose
 * session heartbeat merely went stale is spared as long as the registry
 * still vouches for it -- without chat:pulse to refresh last_seen_at, that
 * is the only thing standing between a session still busy on an autonomous
 * turn and getting pruned out from under it. `deps` is unscoped by default
 * (one directory read per candidate); pass a `snapshotRegistryDeps` result
 * from a caller that already paid for one scan this call (signIn does).
 */
export function prunePresence(now: number, db: Database = getStateDb(), deps: RegistryDeps = defaultRegistryDeps): number {
  const th = presenceThresholds();
  const dayAgo = now - th.pruneMs;
  const candidates = db.query(SELECT_PRUNE_CANDIDATES_SQL).all(dayAgo, dayAgo) as PresenceRawRow[];
  let deleted = 0;
  for (const row of candidates) {
    if (row.signed_out_at === null && bindingAlive(row.session_id, deps)) continue;
    db.query(DELETE_PRESENCE_BY_SESSION_SQL).run(row.session_id);
    deleted++;
  }
  return deleted;
}
