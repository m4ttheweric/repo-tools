import { test, expect } from "bun:test";
import { readFileSync, readdirSync } from "fs";
import { join, resolve } from "path";
import { PROTOCOL_VERSION, encodeLine, parsePromptResult, type PromptSpec, type StepEvent } from "../protocol.ts";

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
