/**
 * wireProcessEvents unit tests — bridges StateStore transitions to the WS
 * broadcast as `process:changed`. Dependencies are injected so this is tested
 * without a live daemon, StateStore, or socket.
 */

import { describe, test, expect } from "bun:test";
import { wireProcessEvents } from "../process-events.ts";
import type { ProcessState } from "../state-store.ts";

function setup(opts: {
  pidOf?: (id: string) => number | undefined;
  exitCodeOf?: (id: string) => number | undefined;
}) {
  let listener: ((id: string, prev: ProcessState, next: ProcessState) => void) | undefined;
  const events: Array<{ type: string; data: any }> = [];
  wireProcessEvents({
    onStateChange: (cb) => { listener = cb; },
    pidOf: opts.pidOf ?? (() => undefined),
    exitCodeOf: opts.exitCodeOf ?? (() => undefined),
    broadcast: (type, data) => events.push({ type, data }),
  });
  return { fire: (id: string, prev: ProcessState, next: ProcessState) => listener!(id, prev, next), events };
}

describe("wireProcessEvents", () => {
  test("broadcasts process:changed with from/to and pid on a transition", () => {
    const { fire, events } = setup({ pidOf: (id) => (id === "p1" ? 123 : undefined) });
    fire("p1", "starting", "running");
    expect(events).toEqual([
      { type: "process:changed", data: { id: "p1", from: "starting", to: "running", pid: 123, exitCode: undefined } },
    ]);
  });

  test("includes exitCode on a terminal transition", () => {
    const { fire, events } = setup({ exitCodeOf: (id) => (id === "p1" ? 1 : undefined) });
    fire("p1", "running", "crashed");
    expect(events[0]?.data).toEqual({ id: "p1", from: "running", to: "crashed", pid: undefined, exitCode: 1 });
  });

  test("emits one event per transition", () => {
    const { fire, events } = setup({});
    fire("p1", "stopped", "starting");
    fire("p1", "starting", "running");
    expect(events.map((e) => e.data.to)).toEqual(["starting", "running"]);
  });
});
