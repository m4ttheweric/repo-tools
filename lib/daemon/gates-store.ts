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
import type {
  GateStatus,
  GateQuestion,
  GateAnswer,
  GateRow,
} from "../../packages/rt-client/src/commands.ts";

export type { GateStatus, GateQuestion, GateAnswer, GateRow };

export interface OpenResult { row: GateRow; supersededId: string | null }

export interface GatesStore {
  open(input: {
    subject: string;
    kind: string;
    questions: GateQuestion[];
    meta?: Record<string, unknown>;
    agent?: string;
    pane?: string;
    nudge?: { session: string };
  }): OpenResult;
  get(id: string): GateRow | null;
  list(filter: { open?: boolean; subjectPrefix?: string; kind?: string }): GateRow[];
  answer(
    id: string,
    answers: GateAnswer["answers"],
    by: string,
  ): { ok: true; row: GateRow } | { ok: false; reason: "not-found" | "closed" | "already-answered"; row: GateRow | null };
  park(id: string): { ok: true } | { ok: false; reason: "not-found" | "not-open"; row: GateRow | null };
  close(id: string, reason: "abandoned" | "superseded" | "pruned"): { ok: true } | { ok: false; reason: "not-found" | "already-answered" | "already-closed" };
  markDelivery(id: string, outcome: "delivered" | "dead-pane"): void;
  markReleased(id: string): void;
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

export function createGatesStore(opts: { dbPath: string; log: Logger }): GatesStore {
  const log = opts.log.child({ module: "gates" });
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
      released      INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_gates_subject_kind_status ON gates(subject, kind, status);
  `);

  const getStmt = db.prepare("SELECT * FROM gates WHERE id = ?");
  const insertStmt = db.prepare(`
    INSERT INTO gates (
      id, subject, kind, questions, meta, status, answer,
      openedAt, parkedAt, closedAt, closedReason, agent, pane, nudge, delivery, released
    ) VALUES (?, ?, ?, ?, ?, 'open', NULL, ?, NULL, NULL, NULL, ?, ?, ?, NULL, 0)
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
    );
    return existing?.id ?? null;
  });

  // Winner-path answer + release must commit together: a reader between two
  // separate auto-commits could observe status='answered' with released=0.
  const answerWinTxn = db.transaction((answerJson: string, id: string, by: string): { changed: boolean } => {
    const result = answerStmt.run(answerJson, id);
    if (result.changes === 0) return { changed: false };
    if (by === "pane") {
      const row = getStmt.get(id) as GateColumns; // pane is immutable after insert
      if (row.pane) releaseStmt.run(id);
    }
    return { changed: true };
  });

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
      });
      log.debug({ id, subject: input.subject, kind: input.kind, supersededId }, "gate opened");
      return { row: get(id)!, supersededId };
    },

    get,

    list(filter) {
      const clauses: string[] = [];
      const params: string[] = [];
      if (filter.open) { clauses.push("status = 'open'"); }
      if (filter.subjectPrefix) { clauses.push("subject LIKE ? ESCAPE '\\'"); params.push(`${filter.subjectPrefix.replace(/[%_\\]/g, "\\$&")}%`); }
      if (filter.kind) { clauses.push("kind = ?"); params.push(filter.kind); }
      const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
      const rows = db.query(`SELECT * FROM gates ${where} ORDER BY openedAt`).all(...params) as GateColumns[];
      return rows.map(rowToGate);
    },

    answer(id, answers, by) {
      const answer: GateAnswer = { answers, by, answeredAt: Date.now() };
      // Winner: a pane that decided has provably reconciled (release commits with the answer).
      const { changed } = answerWinTxn(JSON.stringify(answer), id, by);
      if (changed) return { ok: true, row: get(id)! };
      let row = get(id);
      if (!row) return { ok: false, reason: "not-found", row: null };
      // Loser: a pane that only read the winning answer has also reconciled.
      if (by === "pane" && row.pane) {
        releaseStmt.run(id);
        row = get(id)!;
      }
      if (row.status === "closed") return { ok: false, reason: "closed", row };
      return { ok: false, reason: "already-answered", row };
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
      if (result.changes > 0) return { ok: true };
      const row = get(id);
      if (!row) return { ok: false, reason: "not-found" };
      return { ok: false, reason: row.status === "closed" ? "already-closed" : "already-answered" };
    },

    markDelivery(id, outcome) {
      db.prepare("UPDATE gates SET delivery = ? WHERE id = ?")
        .run(JSON.stringify({ outcome, at: Date.now() }), id);
    },

    markReleased(id) {
      releaseStmt.run(id);
    },

    close_() {
      db.close();
    },

    __db: db,
  };
}
