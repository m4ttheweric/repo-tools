import { expect, test } from "bun:test";
import { tmpdir } from "os";
import { join } from "path";
import { openStateDb } from "../db.ts";
import {
  finishAgent, getAgent, insertAgent, listAgents, markAgentResumed,
  newAgentId, updateAgentPane, type AgentRecord,
} from "../agents-store.ts";

let n = 0;
function freshDb() {
  return openStateDb(join(tmpdir(), `agents-test-${process.pid}-${n++}.db`));
}

function rec(over: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: newAgentId(), repo: "remote:example.com%2Fa%2Fb", cwd: "/tmp/x",
    provider: "claude", surface: "herdr",
    sessionId: crypto.randomUUID(), createdAt: Date.now(), ...over,
  };
}

test("insert then get by id and by session uuid", () => {
  const db = freshDb();
  const r = rec({ model: "haiku", caller: "board:review" });
  insertAgent(r, db);
  expect(getAgent(r.id, db)).toMatchObject({ id: r.id, model: "haiku", caller: "board:review" });
  expect(getAgent(r.sessionId, db)?.id).toBe(r.id);
  expect(getAgent("nope", db)).toBeUndefined();
});

test("list filters by repo, newest first", () => {
  const db = freshDb();
  const a = rec({ createdAt: 1 });
  const b = rec({ createdAt: 2 });
  const c = rec({ repo: "remote:other%2Fr", createdAt: 3 });
  for (const r of [a, b, c]) insertAgent(r, db);
  expect(listAgents({ repo: a.repo }, db).map((x) => x.id)).toEqual([b.id, a.id]);
  expect(listAgents({}, db)).toHaveLength(3);
});

test("pane update, resume stamp, finish", () => {
  const db = freshDb();
  const r = rec();
  insertAgent(r, db);
  updateAgentPane(r.id, { paneId: "w1:p2", tabId: "w1:t2", workspaceId: "w1" }, db);
  markAgentResumed(r.id, 42, db);
  finishAgent(r.id, { exitCode: 0, resultPath: "/tmp/r.json", finishedAt: 43 }, db);
  const got = getAgent(r.id, db)!;
  expect(got).toMatchObject({
    paneId: "w1:p2", tabId: "w1:t2", workspaceId: "w1",
    lastResumedAt: 42, exitCode: 0, resultPath: "/tmp/r.json", finishedAt: 43,
  });
});

test("duplicate session uuid is refused", () => {
  const db = freshDb();
  const r = rec();
  insertAgent(r, db);
  expect(() => insertAgent(rec({ sessionId: r.sessionId }), db)).toThrow();
});
