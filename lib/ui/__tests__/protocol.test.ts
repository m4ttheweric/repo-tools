import { test, expect } from "bun:test";
import { readFileSync, readdirSync } from "fs";
import { join, resolve } from "path";
import {
  PROTOCOL_VERSION,
  encodeLine,
  parsePromptResult,
  parseSessionLine,
  type PromptSpec,
  type StepEvent,
  type BoardModel,
  type PickRequest,
  type PickUpdate,
  type PickModal,
  type PickEvent,
  type PickModalResult,
  type PickResult,
} from "../protocol.ts";

const FIXTURES = resolve(import.meta.dir, "..", "..", "..", "ui", "fixtures");

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));
}

test("protocol version is 1 and every prompt fixture carries it", () => {
  expect(PROTOCOL_VERSION).toBe(1);
  for (const f of readdirSync(FIXTURES).filter((n) => n.startsWith("prompt-"))) {
    const spec = fixture(f) as PromptSpec;
    expect(spec.t).toBe("prompt");
    expect(spec.protocol).toBe(1);
  }
});

test("prompt specs round-trip through encodeLine byte-for-byte as one line", () => {
  for (const f of readdirSync(FIXTURES).filter((n) => n.startsWith("prompt-"))) {
    const spec = fixture(f) as PromptSpec;
    const line = encodeLine(spec);
    expect(line.endsWith("\n")).toBe(true);
    expect(line.slice(0, -1).includes("\n")).toBe(false);
    expect(JSON.parse(line)).toEqual(spec);
  }
});

test("parsePromptResult accepts every result fixture and rejects junk", () => {
  expect(parsePromptResult(readFileSync(join(FIXTURES, "result-select.json"), "utf8"))).toEqual({ t: "result", value: "1h" });
  expect(parsePromptResult(readFileSync(join(FIXTURES, "result-multiselect.json"), "utf8"))).toEqual({ t: "result", values: ["pre-commit", "pre-push"] });
  expect(parsePromptResult(readFileSync(join(FIXTURES, "result-confirm.json"), "utf8"))).toEqual({ t: "result", ok: true });
  expect(parsePromptResult(readFileSync(join(FIXTURES, "result-text.json"), "utf8"))).toEqual({ t: "result", text: "linear-tools" });
  expect(() => parsePromptResult("not json")).toThrow(/rt-ui result/);
  expect(() => parsePromptResult('{"t":"nope"}')).toThrow(/rt-ui result/);
});

test("steps stream fixture is a hello followed by typed events", () => {
  const events = fixture("steps-stream.json") as StepEvent[];
  expect(events[0]).toEqual({ t: "hello", protocol: 1 });
  expect(events.map((e) => e.t)).toEqual(["hello", "start", "log", "done"]);
});

test("session fixtures parse to typed inbound messages", () => {
  const hello = parseSessionLine(readFileSync(join(FIXTURES, "session-hello.json"), "utf8"));
  expect(hello).toEqual({ t: "hello", protocol: 1, version: "0.1.0", views: ["board"] });
  expect(parseSessionLine(readFileSync(join(FIXTURES, "session-intent-stop.json"), "utf8"))).toEqual({ t: "intent", name: "stop", entryId: "e1" });
  expect(parseSessionLine(readFileSync(join(FIXTURES, "session-intent-tail.json"), "utf8"))).toEqual({ t: "intent", name: "tail", entryId: "e1", open: true });
  expect(parseSessionLine(readFileSync(join(FIXTURES, "session-closed-quit.json"), "utf8"))).toEqual({ t: "closed", reason: "quit" });
  expect(() => parseSessionLine("{}")).toThrow(/rt-ui session/);
});

test("parseSessionLine parses an edit intent's command field", () => {
  expect(parseSessionLine(JSON.stringify({ t: "intent", name: "edit", entryId: "e1", command: "bun run dev2" }))).toEqual({
    t: "intent",
    name: "edit",
    entryId: "e1",
    command: "bun run dev2",
  });
});

test("parseSessionLine rejects an intent name outside the declared union", () => {
  expect(() => parseSessionLine(JSON.stringify({ t: "intent", name: "explode" }))).toThrow(/rt-ui session/);
});

test("parseSessionLine rejects a close reason outside the declared union", () => {
  expect(() => parseSessionLine(JSON.stringify({ t: "closed", reason: "unknown" }))).toThrow(/rt-ui session/);
});

test("the board model fixture matches the BoardModel type shape", () => {
  const open = fixture("session-model-board.json") as { model: BoardModel };
  expect(open.model.workspace).toBe("rt-runner-a3f9");
  expect(open.model.entries[0]!.state).toBe("running");
  expect(open.model.entries[1]!.exitCode).toBe(1);
  expect(open.model.entries[1]!.tail).toBeNull();
});

// open and close are TS-to-Go messages, not parseSessionLine input; these
// golden-test the fixture JSON directly, mirroring the Go side's coverage.
test("the open fixture matches its view and BoardModel shape", () => {
  const open = fixture("session-open-board.json") as { t: string; view: string; model: BoardModel };
  expect(open.t).toBe("open");
  expect(open.view).toBe("board");
  expect(open.model.workspace).toBe("rt-runner-a3f9");
  expect(open.model.entries).toEqual([]);
});

test("the close fixture has the close tag", () => {
  const close = fixture("session-close.json") as { t: string };
  expect(close.t).toBe("close");
});

// ─── pick ────────────────────────────────────────────────────────────────────

test("pick request fixture carries protocol 1 and round-trips through encodeLine", () => {
  const req = fixture("pick-request.json") as PickRequest;
  expect(req.t).toBe("pick");
  expect(req.protocol).toBe(1);
  expect(req.rows.length).toBeGreaterThanOrEqual(2);
  expect(req.actions?.length).toBeGreaterThan(0);
  expect(req.actions?.find((a) => a.id === "dispose")?.event).toBe(true);
  expect(req.actions?.find((a) => a.id === "refresh")?.event).toBeUndefined();
  expect(req.crumbEvents).toBe(true);
  expect(req.acceptNoMatch).toBe(true);
  const line = encodeLine(req);
  expect(line.endsWith("\n")).toBe(true);
  expect(JSON.parse(line)).toEqual(req);
});

test("pick request fixture's withArgs field matches the Go parity fixture (PickRow.WithArgs)", () => {
  const req = fixture("pick-request.json") as PickRequest;
  const bill = req.rows.find((r) => r.value.endsWith("/bill"));
  const cho = req.rows.find((r) => r.value.endsWith("/cho"));
  expect(bill?.withArgs).toBe(true);
  expect(cho?.withArgs).toBeUndefined();
});

test("pick update and modal fixtures match their typed shape and round-trip", () => {
  const update = fixture("pick-update.json") as PickUpdate;
  expect(update.t).toBe("update");
  expect(update.rows?.[0]?.right?.some((seg) => seg.hex !== undefined)).toBe(true);
  expect(update.actions?.find((a) => a.id === "refresh")?.event).toBe(true);
  expect(update.actions?.find((a) => a.id === "cd")?.event).toBeUndefined();
  expect(update.breadcrumb?.length).toBeGreaterThan(0);
  expect(update.resetQuery).toBe(true);
  expect(JSON.parse(encodeLine(update))).toEqual(update);

  const modal = fixture("pick-modal.json") as PickModal;
  expect(modal.t).toBe("modal");
  expect(modal.rows.length).toBeGreaterThan(0);
  expect(JSON.parse(encodeLine(modal))).toEqual(modal);
});

test("pick nav update fixture carries the faint idle count + sort suffix and round-trips (Go/TS parity)", () => {
  const nav = fixture("pick-update-nav.json") as PickUpdate;
  expect(nav.t).toBe("update");
  expect(nav.idleCount).toBe("10 folders · 2 files");
  expect(nav.crumbSuffix).toBe(" (Size, largest first)");
  expect(JSON.parse(encodeLine(nav))).toEqual(nav);

  // The non-nav cd update omits both, so its golden stays additive/untouched.
  const cd = fixture("pick-update.json") as PickUpdate;
  expect(cd.idleCount).toBeUndefined();
  expect(cd.crumbSuffix).toBeUndefined();
});

test("pick event, modal-result, and result fixtures match their typed shape", () => {
  const event = fixture("pick-event.json") as PickEvent;
  expect(event).toEqual({
    t: "event",
    action: "dispose",
    value: "/Users/matt/Documents/GitHub/assured-dev/.worktrees/on-deck/cho",
    query: "cho",
  });

  const modalResult = fixture("pick-modal-result.json") as PickModalResult;
  expect(modalResult).toEqual({ t: "modal-result", value: "dispose" });

  const result = fixture("pick-result.json") as PickResult;
  expect(result.t).toBe("result");
  expect(result.values).toEqual([
    "/Users/matt/Documents/GitHub/assured-dev/.worktrees/on-deck/bill",
    "/Users/matt/Documents/GitHub/assured-dev/.worktrees/on-deck/cho",
  ]);
});

test("pick result value accepts null and round-trips through encodeLine", () => {
  const cancel: PickResult = { t: "result", action: "cancel", value: null, query: "" };
  expect(JSON.parse(encodeLine(cancel))).toEqual(cancel);
});
