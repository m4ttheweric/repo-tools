/**
 * Gates store — the daemon's registry for human-decision gates: a subject
 * (`<prefix>:<id>`, opaque to the daemon) pauses on a question set until a
 * human answers, parks it, or it's closed out from under them. One SQLite
 * file (~/.mattstack/rt/gates.db, WAL), mirroring events-bus.ts's open idiom
 * (mkdirSync + the corruption quarantine guard from ../state/db.ts).
 */

import { Database } from "bun:sqlite";
import { mkdirSync, renameSync } from "fs";
import { dirname } from "path";
import type { Logger } from "pino";
import { isCorruptionError } from "../state/db.ts";
import {
  GATE_BY_PANE,
  type GateStatus,
  type GateQuestion,
  type GateAnswer,
  type GateRow,
  type GateOrigin,
  type GateSubscription,
} from "../../packages/rt-client/src/commands.ts";

export type { GateStatus, GateQuestion, GateAnswer, GateRow, GateOrigin, GateSubscription };
export { GATE_BY_PANE };

export type WaitResult =
  | { status: "answered" | "closed"; row: GateRow }
  | { status: "timeout" }
  | { status: "not-found" };

export interface OpenResult { row: GateRow; supersededId: string | null }

/** `released` reports whether THIS call transitioned the row to released
    (pane-answer reconciliation), not the row's resulting released value --
    a caller emitting `gate/released` needs to know it happened here, not
    that it happened at all (an already-released row must not re-emit). */
export type AnswerResult =
  | { ok: true; row: GateRow; released: boolean }
  | { ok: false; reason: "not-found"; row: null; released: false }
  | { ok: false; reason: "closed" | "already-answered"; row: GateRow; released: boolean };

export interface GatesStore {
  open(input: {
    subject: string;
    kind: string;
    questions: GateQuestion[];
    meta?: Record<string, unknown>;
    agent?: string;
    pane?: string;
    nudge?: { session: string };
    context?: string;
    origin?: GateOrigin;
  }): OpenResult;
  get(id: string): GateRow | null;
  list(filter: { open?: boolean; subjectPrefix?: string; kind?: string; limit?: number; cursor?: number }): { gates: GateRow[]; cursor: number };
  answer(id: string, answers: GateAnswer["answers"], by: string): AnswerResult;
  park(id: string): { ok: true } | { ok: false; reason: "not-found" | "not-open"; row: GateRow | null };
  close(id: string, reason: "abandoned" | "superseded" | "pruned"): { ok: true } | { ok: false; reason: "not-found" | "already-answered" | "already-closed" };
  markDelivery(id: string, outcome: "delivered" | "dead-pane"): void;
  wait(id: string, opts: { waitMs?: number; signal?: AbortSignal }): Promise<WaitResult>;
  /** Idempotent on (subjectPrefix, session): a live match returns the
      existing row rather than minting a duplicate. */
  subscribe(input: { subjectPrefix: string; session: string }): GateSubscription;
  unsubscribe(id: string): boolean;
  subscriptions(filter?: { live?: boolean; session?: string }): GateSubscription[];
  markSubscriptionDelivery(id: string, outcome: "delivered" | "failed"): void;
  markSubscriptionDead(id: string): void;
  /** Deletes closed/answered rows past the retention window, floor respected.
      Returns the number of rows removed. */
  sweep(): number;
  close_(): void;
  /** Test-only debug accessor for the underlying handle (e.g. pragma checks). Not for feature code. */
  __db?: Database;
}

interface GateColumns {
  id: string;
  subject: string;
  kind: string;
  questions: string;
  meta: string | null;
  status: GateStatus;
  answer: string | null;
  openedAt: number;
  parkedAt: number | null;
  closedAt: number | null;
  closedReason: "abandoned" | "superseded" | "pruned" | null;
  agent: string | null;
  pane: string | null;
  nudge: string | null;
  delivery: string | null;
  released: number;
  context: string | null;
  origin: string | null;
}

interface SubscriptionColumns {
  id: string;
  subjectPrefix: string;
  session: string;
  createdAt: number;
  lastDelivery: string | null;
  dead: number;
}

function rowToSubscription(row: SubscriptionColumns): GateSubscription {
  return {
    id: row.id,
    subjectPrefix: row.subjectPrefix,
    session: row.session,
    createdAt: row.createdAt,
    lastDelivery: row.lastDelivery == null ? null : JSON.parse(row.lastDelivery),
    dead: row.dead === 1,
  };
}

function rowToGate(row: GateColumns): GateRow {
  return {
    id: row.id,
    subject: row.subject,
    kind: row.kind,
    questions: JSON.parse(row.questions),
    meta: row.meta == null ? null : JSON.parse(row.meta),
    status: row.status,
    answer: row.answer == null ? null : JSON.parse(row.answer),
    openedAt: row.openedAt,
    parkedAt: row.parkedAt,
    closedAt: row.closedAt,
    closedReason: row.closedReason,
    agent: row.agent,
    pane: row.pane,
    nudge: row.nudge == null ? null : JSON.parse(row.nudge),
    delivery: row.delivery == null ? null : JSON.parse(row.delivery),
    released: row.released === 1,
    context: row.context ?? null,
    origin: row.origin == null ? null : JSON.parse(row.origin),
  };
}

/** Same reasoning as events-bus.ts's quarantineEventsDb: a corrupt gates.db
    is recreated empty rather than repaired. Renames the main file plus its
    WAL sidecars (best-effort, since they're meaningless without it). */
function quarantineGatesDb(path: string, log: Logger): void {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const quarantinedPath = `${path}.corrupt-${stamp}`;
  log.warn(
    { path, quarantinedPath },
    "gates db could not be opened (corrupt), quarantining and recreating empty",
  );
  renameSync(path, quarantinedPath);
  for (const sidecar of [`${path}-wal`, `${path}-shm`]) {
    try {
      renameSync(sidecar, `${sidecar}.corrupt-${stamp}`);
    } catch {
      // sidecar absent, fine: WAL mode doesn't always leave one
    }
  }
}

/** Non-empty and contains ":": the daemon never interprets a subject beyond that. */
function assertValidSubject(subject: string): void {
  if (!subject || !subject.includes(":")) {
    throw new Error(`invalid gate subject (must be "<prefix>:<id>"): ${JSON.stringify(subject)}`);
  }
}

export function createGatesStore(opts: {
  dbPath: string;
  log: Logger;
  retentionFloor?: number;
  retentionMs?: number;
}): GatesStore {
  const log = opts.log.child({ module: "gates" });
  // Same defaults as events-bus.ts's retention family: a week, with a row
  // floor so a quiet week never drops below it.
  const retentionFloor = opts.retentionFloor ?? 50_000;
  const retentionMs = opts.retentionMs ?? 7 * 24 * 60 * 60 * 1000;
  mkdirSync(dirname(opts.dbPath), { recursive: true });

  let db: Database;
  try {
    db = new Database(opts.dbPath, { create: true });
    db.exec("PRAGMA busy_timeout = 250;");
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA synchronous = NORMAL;");
    db.query("PRAGMA user_version").get();
  } catch (err) {
    if (!isCorruptionError(err)) throw err;
    quarantineGatesDb(opts.dbPath, log);
    db = new Database(opts.dbPath, { create: true });
    db.exec("PRAGMA busy_timeout = 250;");
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA synchronous = NORMAL;");
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS gates (
      id            TEXT PRIMARY KEY,
      subject       TEXT NOT NULL,
      kind          TEXT NOT NULL,
      questions     TEXT NOT NULL,
      meta          TEXT,
      status        TEXT NOT NULL,
      answer        TEXT,
      openedAt      INTEGER NOT NULL,
      parkedAt      INTEGER,
      closedAt      INTEGER,
      closedReason  TEXT,
      agent         TEXT,
      pane          TEXT,
      nudge         TEXT,
      delivery      TEXT,
      released      INTEGER NOT NULL DEFAULT 0,
      context       TEXT,
      origin        TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_gates_subject_kind_status ON gates(subject, kind, status);

    CREATE TABLE IF NOT EXISTS gate_subscriptions (
      id            TEXT PRIMARY KEY,
      subjectPrefix TEXT NOT NULL,
      session       TEXT NOT NULL,
      createdAt     INTEGER NOT NULL,
      lastDelivery  TEXT,
      dead          INTEGER NOT NULL DEFAULT 0
    );
  `);

  // Idempotent migration for a gates.db predating the W4 columns: CREATE
  // TABLE IF NOT EXISTS above never adds columns to an existing table.
  const gateCols = new Set(
    (db.query("PRAGMA table_info(gates)").all() as Array<{ name: string }>).map((c) => c.name),
  );
  for (const col of ["context", "origin"]) {
    if (!gateCols.has(col)) db.exec(`ALTER TABLE gates ADD COLUMN ${col} TEXT;`);
  }

  const getStmt = db.prepare("SELECT * FROM gates WHERE id = ?");
  const insertStmt = db.prepare(`
    INSERT INTO gates (
      id, subject, kind, questions, meta, status, answer,
      openedAt, parkedAt, closedAt, closedReason, agent, pane, nudge, delivery, released,
      context, origin
    ) VALUES (?, ?, ?, ?, ?, 'open', NULL, ?, NULL, NULL, NULL, ?, ?, ?, NULL, 0, ?, ?)
  `);
  const supersedeStmt = db.prepare(
    "UPDATE gates SET status = 'closed', closedReason = 'superseded', closedAt = ? WHERE subject = ? AND kind = ? AND status = 'open'",
  );
  const findOpenSameKindStmt = db.prepare(
    "SELECT id FROM gates WHERE subject = ? AND kind = ? AND status = 'open'",
  );
  // CAS guards: each is a single UPDATE gated on current status; a `changes`
  // count of 0 means the row didn't qualify, and the caller re-reads to classify why.
  const answerStmt = db.prepare(
    "UPDATE gates SET status = 'answered', answer = ? WHERE id = ? AND status IN ('open', 'parked')",
  );
  const parkStmt = db.prepare(
    "UPDATE gates SET status = 'parked', parkedAt = ? WHERE id = ? AND status = 'open'",
  );
  const closeStmt = db.prepare(
    "UPDATE gates SET status = 'closed', closedReason = ?, closedAt = ? WHERE id = ? AND status IN ('open', 'parked')",
  );
  const releaseStmt = db.prepare("UPDATE gates SET released = 1 WHERE id = ?");
  const markDeliveryStmt = db.prepare("UPDATE gates SET delivery = ? WHERE id = ?");
  const maxRowidStmt = db.prepare("SELECT COALESCE(MAX(rowid), 0) AS maxId FROM gates");
  // Row floor scoped to terminal rows only: open/parked rows are never swept
  // regardless, so they shouldn't consume floor headroom meant for terminal ones.
  const sweepStmt = db.prepare(`
    DELETE FROM gates
    WHERE status IN ('closed', 'answered')
      AND COALESCE(closedAt, json_extract(answer, '$.answeredAt'), openedAt) < ?
      AND id NOT IN (
        SELECT id FROM gates
        WHERE status IN ('closed', 'answered')
        ORDER BY COALESCE(closedAt, json_extract(answer, '$.answeredAt'), openedAt) DESC
        LIMIT ?
      )
  `);

  const getSubStmt = db.prepare("SELECT * FROM gate_subscriptions WHERE id = ?");
  const findLiveSubStmt = db.prepare(
    "SELECT * FROM gate_subscriptions WHERE subjectPrefix = ? AND session = ? AND dead = 0 LIMIT 1",
  );
  const insertSubStmt = db.prepare(
    "INSERT INTO gate_subscriptions (id, subjectPrefix, session, createdAt, lastDelivery, dead) VALUES (?, ?, ?, ?, NULL, 0)",
  );
  const deleteSubStmt = db.prepare("DELETE FROM gate_subscriptions WHERE id = ?");
  const subDeliveryStmt = db.prepare("UPDATE gate_subscriptions SET lastDelivery = ? WHERE id = ?");
  const subDeadStmt = db.prepare("UPDATE gate_subscriptions SET dead = 1 WHERE id = ?");

  const get = (id: string): GateRow | null => {
    const row = getStmt.get(id) as GateColumns | null;
    return row ? rowToGate(row) : null;
  };

  const openTxn = db.transaction((input: {
    id: string;
    subject: string;
    kind: string;
    questions: string;
    meta: string | null;
    openedAt: number;
    agent: string | null;
    pane: string | null;
    nudge: string | null;
    context: string | null;
    origin: string | null;
  }): string | null => {
    const existing = findOpenSameKindStmt.get(input.subject, input.kind) as { id: string } | undefined;
    if (existing) supersedeStmt.run(input.openedAt, input.subject, input.kind);
    insertStmt.run(
      input.id,
      input.subject,
      input.kind,
      input.questions,
      input.meta,
      input.openedAt,
      input.agent,
      input.pane,
      input.nudge,
      input.context,
      input.origin,
    );
    return existing?.id ?? null;
  });

  // Winner-path answer + release must commit together: a reader between two
  // separate auto-commits could observe status='answered' with released=0.
  const answerWinTxn = db.transaction((answerJson: string, id: string, by: string): { changed: boolean; released: boolean } => {
    const result = answerStmt.run(answerJson, id);
    if (result.changes === 0) return { changed: false, released: false };
    let released = false;
    if (by === GATE_BY_PANE) {
      const row = getStmt.get(id) as GateColumns; // pane is immutable after insert
      if (row.pane) { releaseStmt.run(id); released = true; }
    }
    return { changed: true, released };
  });

  // In-memory waiter registry, mirroring events-bus.ts's idiom: one Set per
  // gate id so answer/close/supersede can wake exactly the waiters watching
  // that gate. Waiters never survive a status read taken before registration
  // (wait() is registry-status-first: registration only happens for
  // open/parked rows), so wake-up is the only path that settles a waiter.
  const MAX_WAIT_MS = 240_000; // under the 255s socket idle timeout, same cap as events-bus
  interface Waiter {
    resolve: (r: WaitResult) => void;
    timer: ReturnType<typeof setTimeout>;
    onAbort?: () => void;
    signal?: AbortSignal;
  }
  const waiters = new Map<string, Set<Waiter>>();

  const settle = (gateId: string, w: Waiter, result: WaitResult): void => {
    const set = waiters.get(gateId);
    if (!set || !set.has(w)) return;
    set.delete(w);
    if (set.size === 0) waiters.delete(gateId);
    clearTimeout(w.timer);
    if (w.signal && w.onAbort) w.signal.removeEventListener("abort", w.onAbort);
    w.resolve(result);
  };

  // Called after the transaction that produced this status has committed:
  // answer/close call it directly, and open calls it for the id it superseded.
  const wake = (gateId: string, status: "answered" | "closed"): void => {
    const set = waiters.get(gateId);
    if (!set || set.size === 0) return;
    const row = get(gateId);
    if (!row) return;
    for (const w of [...set]) settle(gateId, w, { status, row });
  };

  return {
    open(input) {
      assertValidSubject(input.subject);
      const id = crypto.randomUUID();
      const openedAt = Date.now();
      const supersededId = openTxn({
        id,
        subject: input.subject,
        kind: input.kind,
        questions: JSON.stringify(input.questions),
        meta: input.meta ? JSON.stringify(input.meta) : null,
        openedAt,
        agent: input.agent ?? null,
        pane: input.pane ?? null,
        nudge: input.nudge ? JSON.stringify(input.nudge) : null,
        context: input.context ?? null,
        origin: input.origin ? JSON.stringify(input.origin) : null,
      });
      log.debug({ id, subject: input.subject, kind: input.kind, supersededId }, "gate opened");
      // The supersede path must not bypass wake-up: a waiter on the
      // superseded gate is watching for exactly this closed transition.
      if (supersededId) wake(supersededId, "closed");
      return { row: get(id)!, supersededId };
    },

    get,

    list(filter) {
      // Paged in rowid order (== insertion == openedAt order, since rows are
      // never reordered): mirrors events-bus.ts's list, cursor pointing at
      // the last DELIVERED row on a truncated page, or the table's rowid
      // head otherwise, so an omitted limit still resumes correctly if a
      // caller starts paging later.
      const clauses: string[] = [];
      const params: (string | number)[] = [];
      if (filter.cursor != null) { clauses.push("rowid > ?"); params.push(filter.cursor); }
      if (filter.open) { clauses.push("status = 'open'"); }
      if (filter.subjectPrefix) { clauses.push("subject LIKE ? ESCAPE '\\'"); params.push(`${filter.subjectPrefix.replace(/[%_\\]/g, "\\$&")}%`); }
      if (filter.kind) { clauses.push("kind = ?"); params.push(filter.kind); }
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      const safeLimit = filter.limit == null ? undefined : Math.max(1, Math.floor(filter.limit));
      const limitClause = safeLimit != null ? "LIMIT ?" : "";
      const queryParams = safeLimit != null ? [...params, safeLimit] : params;
      const rows = db.query(`SELECT *, rowid AS rowid FROM gates ${where} ORDER BY rowid ${limitClause}`)
        .all(...queryParams) as (GateColumns & { rowid: number })[];
      const gates = rows.map(rowToGate);
      const cursor = rows.length && safeLimit != null && rows.length === safeLimit
        ? rows[rows.length - 1]!.rowid
        : (maxRowidStmt.get() as { maxId: number }).maxId;
      return { gates, cursor };
    },

    answer(id, answers, by) {
      const answer: GateAnswer = { answers, by, answeredAt: Date.now() };
      // Winner: a pane that decided has provably reconciled (release commits with the answer).
      const { changed, released: winReleased } = answerWinTxn(JSON.stringify(answer), id, by);
      if (changed) { wake(id, "answered"); return { ok: true, row: get(id)!, released: winReleased }; }
      let row = get(id);
      if (!row) return { ok: false, reason: "not-found", row: null, released: false };
      // Loser: a pane that only read the winning answer has also reconciled.
      // Only a NEW release (row wasn't already released) is reported, so a
      // caller emitting `gate/released` on it doesn't re-fire on every
      // subsequent redundant answer attempt from the same reconciled pane.
      let released = false;
      if (by === GATE_BY_PANE && row.pane && !row.released) {
        releaseStmt.run(id);
        row = get(id)!;
        released = true;
      }
      if (row.status === "closed") return { ok: false, reason: "closed", row, released };
      return { ok: false, reason: "already-answered", row, released };
    },

    park(id) {
      const result = parkStmt.run(Date.now(), id);
      if (result.changes > 0) return { ok: true };
      const row = get(id);
      if (!row) return { ok: false, reason: "not-found", row: null };
      return { ok: false, reason: "not-open", row };
    },

    close(id, reason) {
      const result = closeStmt.run(reason, Date.now(), id);
      if (result.changes > 0) { wake(id, "closed"); return { ok: true }; }
      const row = get(id);
      if (!row) return { ok: false, reason: "not-found" };
      return { ok: false, reason: row.status === "closed" ? "already-closed" : "already-answered" };
    },

    markDelivery(id, outcome) {
      markDeliveryStmt.run(JSON.stringify({ outcome, at: Date.now() }), id);
    },

    wait(id, opts) {
      return new Promise<WaitResult>((resolve) => {
        // Registry-status-first: the read and the registration decision are
        // synchronous and adjacent, so there's no window for an answer/close
        // to land between "read the row" and "decide whether to register".
        const row = get(id);
        if (!row) { resolve({ status: "not-found" }); return; }
        if (row.status === "answered" || row.status === "closed") {
          resolve({ status: row.status, row });
          return;
        }
        const capMs = Math.min(Math.max(opts.waitMs ?? MAX_WAIT_MS, 0), MAX_WAIT_MS);
        const w: Waiter = {
          resolve,
          signal: opts.signal,
          timer: setTimeout(() => settle(id, w, { status: "timeout" }), capMs),
        };
        if (opts.signal) {
          w.onAbort = () => settle(id, w, { status: "timeout" });
          if (opts.signal.aborted) { clearTimeout(w.timer); resolve({ status: "timeout" }); return; }
          opts.signal.addEventListener("abort", w.onAbort, { once: true });
        }
        let set = waiters.get(id);
        if (!set) { set = new Set(); waiters.set(id, set); }
        set.add(w);
      });
    },

    subscribe(input) {
      // Idempotent on (subjectPrefix, session): a blind re-subscribe (e.g. a
      // shepherd re-arming after a crash) must never double the fan-out. A
      // DEAD row does not block a fresh one -- only a live match short-circuits.
      const existing = findLiveSubStmt.get(input.subjectPrefix, input.session) as SubscriptionColumns | null;
      if (existing) return rowToSubscription(existing);
      const id = crypto.randomUUID();
      const createdAt = Date.now();
      insertSubStmt.run(id, input.subjectPrefix, input.session, createdAt);
      return rowToSubscription(getSubStmt.get(id) as SubscriptionColumns);
    },

    unsubscribe(id) {
      return deleteSubStmt.run(id).changes > 0;
    },

    subscriptions(filter) {
      const clauses: string[] = [];
      const params: string[] = [];
      if (filter?.live) clauses.push("dead = 0");
      if (filter?.session) { clauses.push("session = ?"); params.push(filter.session); }
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      const rows = db.query(`SELECT * FROM gate_subscriptions ${where} ORDER BY createdAt`).all(...params) as SubscriptionColumns[];
      return rows.map(rowToSubscription);
    },

    markSubscriptionDelivery(id, outcome) {
      subDeliveryStmt.run(JSON.stringify({ outcome, at: Date.now() }), id);
    },

    markSubscriptionDead(id) {
      subDeadStmt.run(id);
    },

    sweep() {
      const cutoff = Date.now() - retentionMs;
      const { changes } = sweepStmt.run(cutoff, retentionFloor);
      if (changes > 0) log.debug({ deleted: changes }, "gates retention sweep");
      return changes;
    },

    close_() {
      // Settle any still-pending waiters rather than leaving their promises
      // hanging past db.close(); a store shutdown is not an answer, so timeout.
      for (const [gateId, set] of [...waiters]) {
        for (const w of [...set]) settle(gateId, w, { status: "timeout" });
      }
      db.close();
    },

    __db: db,
  };
}
