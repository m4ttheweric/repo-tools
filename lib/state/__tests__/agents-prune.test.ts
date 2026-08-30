/**
 * lib/state/agents-store.ts -- pruneAgents coverage (R054).
 */
import { expect, test } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import type { Database } from "bun:sqlite";
import { openStateDb } from "../db.ts";
import { insertAgent, newAgentId, pruneAgents, AGENTS_RETENTION_MS, type AgentRecord } from "../agents-store.ts";

let n = 0;
function freshDb(): Database {
  return openStateDb(join(tmpdir(), `agents-prune-test-${process.pid}-${n++}.db`));
}

function rec(over: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: newAgentId(), repo: "remote:example.com%2Fa%2Fb", cwd: "/tmp/x",
    provider: "claude", surface: "herdr",
    sessionId: crypto.randomUUID(), createdAt: Date.now(), ...over,
  };
}

function countAgents(db: Database): number {
  return (db.query("SELECT COUNT(*) AS n FROM agents;").get() as { n: number }).n;
}

test("named constant carries the documented retention value", () => {
  expect(AGENTS_RETENTION_MS).toBe(30 * 24 * 60 * 60 * 1000);
});

test("deletes finished agents older than the floor", () => {
  const db = freshDb();
  const old = Date.now() - 10_000;
  insertAgent(rec({ createdAt: old, finishedAt: old }), db);

  const { removed } = pruneAgents(db, { finishedBeforeMs: 500 });

  expect(removed).toBe(1);
  expect(countAgents(db)).toBe(0);
});

test("leaves finished agents newer than the floor", () => {
  const db = freshDb();
  const now = Date.now();
  insertAgent(rec({ createdAt: now, finishedAt: now }), db);

  const { removed } = pruneAgents(db, { finishedBeforeMs: 500 });

  expect(removed).toBe(0);
  expect(countAgents(db)).toBe(1);
});

test("never deletes a running agent, no matter how old", () => {
  const db = freshDb();
  const old = Date.now() - 10_000;
  insertAgent(rec({ createdAt: old }), db);

  const { removed } = pruneAgents(db, { finishedBeforeMs: 500 });

  expect(removed).toBe(0);
  expect(countAgents(db)).toBe(1);
});

test("prunes finished rows while a running row from the same repo survives", () => {
  const db = freshDb();
  const old = Date.now() - 10_000;
  insertAgent(rec({ createdAt: old, finishedAt: old }), db);
  insertAgent(rec({ createdAt: old }), db);

  const { removed } = pruneAgents(db, { finishedBeforeMs: 500 });

  expect(removed).toBe(1);
  expect(countAgents(db)).toBe(1);
});

test("defaults to AGENTS_RETENTION_MS when opts are omitted", () => {
  const db = freshDb();
  const now = Date.now();
  insertAgent(rec({ createdAt: now, finishedAt: now }), db);

  const { removed } = pruneAgents(db, {});

  expect(removed).toBe(0);
});
