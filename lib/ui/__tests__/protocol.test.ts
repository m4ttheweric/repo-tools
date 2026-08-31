import { test, expect } from "bun:test";
import { readFileSync, readdirSync } from "fs";
import { join, resolve } from "path";
import { PROTOCOL_VERSION, encodeLine, parsePromptResult, parseSessionLine, type PromptSpec, type StepEvent, type BoardModel } from "../protocol.ts";

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
