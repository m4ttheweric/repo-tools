import { describe, test, expect } from "bun:test";
import { createHumanEmitter, createNdjsonEmitter } from "../emit.ts";
import type { ApplyEvent } from "../contract.ts";

describe("createNdjsonEmitter", () => {
  test("writes exactly one line per event and round-trips through JSON.parse", () => {
    const lines: string[] = [];
    const emit = createNdjsonEmitter((l) => lines.push(l));
    const events: ApplyEvent[] = [
      { event: "plan", steps: [{ id: "home.init", title: "Init home", kind: "rt" }] },
      { event: "step", id: "home.init", state: "done" },
      { event: "done", ok: true },
    ];
    for (const ev of events) emit(ev);

    expect(lines.length).toBe(events.length);
    for (const line of lines) expect(line.endsWith("\n")).toBe(true);
    const parsed = lines.map((l) => JSON.parse(l));
    expect(parsed).toEqual(events);
  });
});

describe("createHumanEmitter", () => {
  test("prints a remedy line for a failed step", () => {
    const printed: string[] = [];
    const emit = createHumanEmitter((s) => printed.push(s));
    emit({ event: "step", id: "secrets.write", state: "failed", detail: "boom", remedy: "run rt secrets set" });

    expect(printed.length).toBe(1);
    expect(printed[0]).toContain("→ run rt secrets set");
  });
});
