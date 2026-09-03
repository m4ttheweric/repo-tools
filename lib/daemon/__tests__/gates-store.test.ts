import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import pino from "pino";
import { createGatesStore, type GateQuestion } from "../gates-store.ts";

const log = pino({ level: "silent" });

let dirs: string[] = [];

/** A fresh tmp dir per call, joined with `name`; every dir is swept in afterEach. */
function tmp(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), "rt-gates-"));
  dirs.push(dir);
  return join(dir, name);
}

function qs(): GateQuestion[] {
  return [{ id: "q", label: "Pick", multi: false, options: ["a", "b"] }];
}

beforeEach(() => {
  dirs = [];
});

afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("gates store", () => {
  test("open mints an id and persists the row", () => {
    const s = createGatesStore({ dbPath: tmp("gates.db"), log });
    const { row, supersededId } = s.open({ subject: "run:abc", kind: "clarify", questions: [{ id: "q", label: "Pick", multi: false, options: ["a", "b"] }] });
    expect(row.status).toBe("open");
    expect(supersededId).toBeNull();
    expect(s.get(row.id)?.subject).toBe("run:abc");
    s.close_();
  });

  test("open on a subject with an open gate of the SAME kind supersedes it in one transaction", () => {
    const s = createGatesStore({ dbPath: tmp("gates.db"), log });
    const first = s.open({ subject: "mr:https://x/1", kind: "review-post", questions: qs() }).row;
    const { row: second, supersededId } = s.open({ subject: "mr:https://x/1", kind: "review-post", questions: qs() });
    expect(supersededId).toBe(first.id);
    expect(s.get(first.id)?.status).toBe("closed");
    expect(s.get(first.id)?.closedReason).toBe("superseded");
    expect(s.get(second.id)?.status).toBe("open");
    s.close_();
  });

  test("open does NOT supersede a different kind on the same subject", () => {
    const s = createGatesStore({ dbPath: tmp("gates.db"), log });
    const a = s.open({ subject: "mr:https://x/1", kind: "review-post", questions: qs() }).row;
    const { supersededId } = s.open({ subject: "mr:https://x/1", kind: "doctor-escalation", questions: qs() });
    expect(supersededId).toBeNull();
    expect(s.get(a.id)?.status).toBe("open");
    s.close_();
  });

  test("rows survive close and reopen of the store (persistence)", () => {
    const p = tmp("gates.db");
    const s1 = createGatesStore({ dbPath: p, log });
    const id = s1.open({ subject: "run:r1", kind: "clarify", questions: qs() }).row.id;
    s1.close_();
    const s2 = createGatesStore({ dbPath: p, log });
    expect(s2.get(id)?.status).toBe("open");
    s2.close_();
  });

  test("subject validation: rejects empty and colon-less subjects", () => {
    const s = createGatesStore({ dbPath: tmp("gates.db"), log });
    expect(() => s.open({ subject: "", kind: "k", questions: qs() })).toThrow();
    expect(() => s.open({ subject: "nocolon", kind: "k", questions: qs() })).toThrow();
    s.close_();
  });
});
