import { describe, test, expect, spyOn } from "bun:test";
import {
  buildOpenPayload,
  buildAnswerPayload,
  buildListPayload,
  buildSubscriptionsPayload,
  waitForGate,
} from "../gate.ts";
import type { Commands, GateRow, RtResponse } from "../../packages/rt-client/src/index.ts";

// ─── open ────────────────────────────────────────────────────────────────────

describe("buildOpenPayload", () => {
  test("required flags only", () => {
    const payload = buildOpenPayload([
      "--subject", "run:abc123",
      "--kind", "approval",
      "--questions", '[{"id":"q1","label":"Proceed?","multi":false,"options":["yes","no"]}]',
    ]);
    expect(payload).toEqual({
      subject: "run:abc123",
      kind: "approval",
      questions: [{ id: "q1", label: "Proceed?", multi: false, options: ["yes", "no"] }],
    });
  });

  test("optional flags carried through when present", () => {
    const payload = buildOpenPayload([
      "--subject", "run:abc123",
      "--kind", "approval",
      "--questions", "[]",
      "--meta", '{"label":"nightly"}',
      "--agent", "ag-1a2b3c4d",
      "--pane", "!7",
      "--nudge", '{"session":"!7"}',
    ]);
    expect(payload).toEqual({
      subject: "run:abc123",
      kind: "approval",
      questions: [],
      meta: { label: "nightly" },
      agent: "ag-1a2b3c4d",
      pane: "!7",
      nudge: { session: "!7" },
    });
  });

  test("--context is raw text and --origin is JSON, both carried through", () => {
    const payload = buildOpenPayload([
      "--subject", "run:abc123", "--kind", "approval", "--questions", "[]",
      "--context", "the failing check output",
      "--origin", '{"paneId":"p1","worktree":"/tmp/wt","presentation":"form"}',
    ]);
    expect(payload.context).toBe("the failing check output");
    expect(payload.origin).toEqual({ paneId: "p1", worktree: "/tmp/wt", presentation: "form" });
  });
});

// ─── answer ──────────────────────────────────────────────────────────────────

describe("buildAnswerPayload", () => {
  test("id is positional, answers/by are flags", () => {
    const payload = buildAnswerPayload(["gt-1a2b3c4d", "--answers", '{"q1":"yes"}', "--by", "human"]);
    expect(payload).toEqual({ id: "gt-1a2b3c4d", answers: { q1: "yes" }, by: "human" });
  });

  test("positional works regardless of flag order", () => {
    const payload = buildAnswerPayload(["--by", "human", "--answers", '{"q1":"yes"}', "gt-1a2b3c4d"]);
    expect(payload).toEqual({ id: "gt-1a2b3c4d", answers: { q1: "yes" }, by: "human" });
  });
});

// ─── list ────────────────────────────────────────────────────────────────────

describe("buildListPayload", () => {
  test("no flags → empty payload", () => {
    expect(buildListPayload([])).toEqual({});
  });

  test("--open is a boolean presence flag", () => {
    expect(buildListPayload(["--open"])).toEqual({ open: true });
  });

  test("subject-prefix and kind carried through together", () => {
    expect(buildListPayload(["--subject-prefix", "run:", "--kind", "approval", "--open"])).toEqual({
      open: true,
      subjectPrefix: "run:",
      kind: "approval",
    });
  });

  test("limit and cursor are numeric (F7)", () => {
    expect(buildListPayload(["--limit", "50", "--cursor", "12"])).toEqual({ limit: 50, cursor: 12 });
  });

  test("a non-numeric --limit fails fast instead of silently becoming NaN (daemon-omitted)", () => {
    const exitSpy = spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(() => buildListPayload(["--limit", "abc"])).toThrow("exit:1");
    } finally {
      exitSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});

// ─── subscriptions ───────────────────────────────────────────────────────────

describe("buildSubscriptionsPayload", () => {
  test("no flags → empty payload", () => {
    expect(buildSubscriptionsPayload([])).toEqual({});
  });

  test("--session and --live carried through together (F3)", () => {
    expect(buildSubscriptionsPayload(["--session", "!7", "--live"])).toEqual({ session: "!7", live: true });
  });
});

// ─── wait loop ───────────────────────────────────────────────────────────────

function fakeRow(overrides: Partial<GateRow> = {}): GateRow {
  return {
    id: "gt-1a2b3c4d", subject: "run:abc123", kind: "approval",
    questions: [], meta: null,
    status: "answered", answer: null,
    openedAt: 0, parkedAt: null, closedAt: null, closedReason: null,
    agent: null, pane: null, nudge: null, delivery: null, released: false,
    ...overrides,
  };
}

type WaitFn = (a: Commands["gate:wait"]["payload"]) => Promise<RtResponse<Commands["gate:wait"]["data"]>>;

describe("waitForGate", () => {
  test("not-found is terminal on the first call — never re-entered", async () => {
    let calls = 0;
    const wait: WaitFn = async () => {
      calls++;
      return { ok: false, error: "not-found" };
    };
    const outcome = await waitForGate("gt-missing", null, wait);
    expect(outcome).toEqual({ terminal: "not-found" });
    expect(calls).toBe(1);
  });

  test("closed is terminal and carries the row", async () => {
    const row = fakeRow({ status: "closed", closedReason: "abandoned" });
    let calls = 0;
    const wait: WaitFn = async () => {
      calls++;
      return { ok: true, data: { status: "closed", row } };
    };
    const outcome = await waitForGate("gt-1a2b3c4d", null, wait);
    expect(outcome).toEqual({ terminal: "closed", row });
    expect(calls).toBe(1);
  });

  test("answered is terminal and carries the row", async () => {
    const row = fakeRow({ status: "answered" });
    const wait: WaitFn = async () => ({ ok: true, data: { status: "answered", row } });
    const outcome = await waitForGate("gt-1a2b3c4d", null, wait);
    expect(outcome).toEqual({ terminal: "answered", row });
  });

  test("a timeout status re-enters the loop until the gate resolves", async () => {
    const row = fakeRow({ status: "answered" });
    let calls = 0;
    const wait: WaitFn = async () => {
      calls++;
      if (calls < 3) return { ok: true, data: { status: "timeout" } };
      return { ok: true, data: { status: "answered", row } };
    };
    const outcome = await waitForGate("gt-1a2b3c4d", null, wait);
    expect(outcome).toEqual({ terminal: "answered", row });
    expect(calls).toBe(3);
  });

  test("an already-spent budget returns terminal without calling wait", async () => {
    let calls = 0;
    const wait: WaitFn = async () => {
      calls++;
      return { ok: true, data: { status: "timeout" } };
    };
    const outcome = await waitForGate("gt-1a2b3c4d", Date.now() - 1, wait);
    expect(outcome).toEqual({ terminal: "budget" });
    expect(calls).toBe(0);
  });

  test("a budget spent across several timeout re-entries stops the loop", async () => {
    const realNow = Date.now;
    let now = 1_000_000;
    Date.now = () => now;
    try {
      const deadline = now + 250;
      let calls = 0;
      const wait: WaitFn = async () => {
        calls++;
        now += 100; // simulate time passing while "waiting"
        return { ok: true, data: { status: "timeout" } };
      };
      const outcome = await waitForGate("gt-1a2b3c4d", deadline, wait);
      expect(outcome).toEqual({ terminal: "budget" });
      // 250ms budget, 100ms consumed per call: three calls (250, 150, 50ms
      // remaining each time) exhaust the deadline; the loop then returns
      // without a fourth call.
      expect(calls).toBe(3);
    } finally {
      Date.now = realNow;
    }
  });

  test("a daemon-unreachable failure retries (backing off) rather than failing — not-found is the ONLY terminal ok:false", async () => {
    const row = fakeRow({ status: "answered" });
    let calls = 0;
    const sleeps: number[] = [];
    const wait: WaitFn = async () => {
      calls++;
      if (calls === 1) return { ok: false, error: "rt daemon unreachable: connect ECONNREFUSED" };
      return { ok: true, data: { status: "answered", row } };
    };
    const sleep = async (ms: number) => { sleeps.push(ms); };
    const outcome = await waitForGate("gt-1a2b3c4d", null, wait, sleep);
    expect(outcome).toEqual({ terminal: "answered", row });
    expect(calls).toBe(2); // the first (unreachable) attempt, then the recovered answer
    expect(sleeps).toEqual([1000]); // one backoff between the two calls
  });

  test("a short --timeout bounds the backoff sleep to the remaining budget, never past the deadline", async () => {
    const realNow = Date.now;
    let now = 1_000_000;
    Date.now = () => now;
    try {
      const deadline = now + 300; // well under the 1s backoff start
      const sleeps: number[] = [];
      let calls = 0;
      const wait: WaitFn = async () => {
        calls++;
        return { ok: false, error: "rt daemon unreachable: connect ECONNREFUSED" };
      };
      const sleep = async (ms: number) => { sleeps.push(ms); now += ms; };
      const outcome = await waitForGate("gt-1a2b3c4d", deadline, wait, sleep);
      expect(outcome).toEqual({ terminal: "budget" });
      expect(calls).toBe(1);
      expect(sleeps).toEqual([300]); // clamped to the remaining budget, not the full 1000ms backoff step
    } finally {
      Date.now = realNow;
    }
  });

  test("unreachable with a tiny budget exhausts and returns budget, never a hard failure", async () => {
    const realNow = Date.now;
    let now = 1_000_000;
    Date.now = () => now;
    try {
      const deadline = now + 50; // smaller than one backoff step
      let calls = 0;
      const wait: WaitFn = async () => {
        calls++;
        return { ok: false, error: "rt daemon unreachable: connect ECONNREFUSED" };
      };
      const sleep = async (ms: number) => { now += ms; }; // advance the fake clock instead of really sleeping
      const outcome = await waitForGate("gt-1a2b3c4d", deadline, wait, sleep);
      expect(outcome).toEqual({ terminal: "budget" });
      expect(calls).toBe(1); // one attempt, then the post-backoff budget check exits without a second
    } finally {
      Date.now = realNow;
    }
  });
});
