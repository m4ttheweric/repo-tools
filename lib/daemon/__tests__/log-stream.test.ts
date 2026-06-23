/**
 * openLogStream unit tests — read-only log tail: replay buffered history, then
 * forward live output chunks; the returned unsubscribe stops forwarding.
 * Dependencies injected so this is tested without a WS server or live process.
 */

import { describe, test, expect } from "bun:test";
import { openLogStream, handleLogStreamControl, handleAttachMessage } from "../log-stream.ts";

function setup(replay: string[]) {
  const sent: string[] = [];
  let liveCb: ((chunk: Uint8Array) => void) | undefined;
  let unsubscribed = false;
  const unsub = openLogStream("p1", {
    getReplay: () => replay,
    subscribe: (_id, cb) => { liveCb = cb; return () => { unsubscribed = true; }; },
    send: (d) => sent.push(d),
  });
  return {
    sent,
    unsub,
    emit: (s: string) => liveCb?.(new TextEncoder().encode(s)),
    wasUnsubscribed: () => unsubscribed,
  };
}

describe("openLogStream", () => {
  test("replays buffered history first", () => {
    const { sent } = setup(["line1", "line2"]);
    expect(sent.join("")).toContain("line1");
    expect(sent.join("")).toContain("line2");
  });

  test("forwards live output chunks after replay", () => {
    const { sent, emit } = setup([]);
    emit("hello live");
    expect(sent.join("")).toContain("hello live");
  });

  test("does not send a replay message when history is empty", () => {
    const { sent } = setup([]);
    expect(sent).toEqual([]);
  });

  test("unsubscribe stops the live subscription", () => {
    const { unsub, wasUnsubscribed } = setup(["x"]);
    expect(wasUnsubscribed()).toBe(false);
    unsub();
    expect(wasUnsubscribed()).toBe(true);
  });
});

describe("handleLogStreamControl", () => {
  function resizeSetup() {
    const calls: { cols: number; rows: number }[] = [];
    const resize = (cols: number, rows: number) => calls.push({ cols, rows });
    return { calls, resize };
  }

  test("applies a valid resize message", () => {
    const { calls, resize } = resizeSetup();
    handleLogStreamControl(JSON.stringify({ type: "resize", cols: 120, rows: 40 }), { resize });
    expect(calls).toEqual([{ cols: 120, rows: 40 }]);
  });

  test("accepts a Uint8Array (binary frame) payload", () => {
    const { calls, resize } = resizeSetup();
    const buf = new TextEncoder().encode(JSON.stringify({ type: "resize", cols: 80, rows: 24 }));
    handleLogStreamControl(buf, { resize });
    expect(calls).toEqual([{ cols: 80, rows: 24 }]);
  });

  test("ignores non-resize message types", () => {
    const { calls, resize } = resizeSetup();
    handleLogStreamControl(JSON.stringify({ type: "input", data: "ls" }), { resize });
    expect(calls).toEqual([]);
  });

  test("ignores malformed JSON without throwing", () => {
    const { calls, resize } = resizeSetup();
    expect(() => handleLogStreamControl("not json", { resize })).not.toThrow();
    expect(calls).toEqual([]);
  });

  test("ignores non-positive or non-integer dimensions", () => {
    const { calls, resize } = resizeSetup();
    handleLogStreamControl(JSON.stringify({ type: "resize", cols: 0, rows: 40 }), { resize });
    handleLogStreamControl(JSON.stringify({ type: "resize", cols: 80, rows: -1 }), { resize });
    handleLogStreamControl(JSON.stringify({ type: "resize", cols: 80.5, rows: 24 }), { resize });
    expect(calls).toEqual([]);
  });

  test("clamps absurdly large dimensions to a sane ceiling", () => {
    const { calls, resize } = resizeSetup();
    handleLogStreamControl(JSON.stringify({ type: "resize", cols: 99999, rows: 99999 }), { resize });
    expect(calls).toEqual([{ cols: 1000, rows: 1000 }]);
  });
});

describe("handleAttachMessage", () => {
  function setup() {
    const resized: { cols: number; rows: number }[] = [];
    const inputs: Uint8Array[] = [];
    return {
      resized,
      inputs,
      deps: {
        resize: (cols: number, rows: number) => resized.push({ cols, rows }),
        input: (data: Uint8Array) => inputs.push(data),
      },
    };
  }

  test("routes binary frames to input (terminal.write), not control", () => {
    const { inputs, resized, deps } = setup();
    const bytes = new TextEncoder().encode("ls -la\n");
    handleAttachMessage(bytes, deps);
    expect(resized).toEqual([]);
    expect(inputs).toHaveLength(1);
    expect(new TextDecoder().decode(inputs[0])).toBe("ls -la\n");
  });

  test("accepts an ArrayBuffer as input", () => {
    const { inputs, deps } = setup();
    const buf = new TextEncoder().encode("x").buffer;
    handleAttachMessage(buf, deps);
    expect(inputs).toHaveLength(1);
    expect(new TextDecoder().decode(inputs[0])).toBe("x");
  });

  test("input bytes that look like JSON are still treated as input, never parsed", () => {
    // A binary frame is always input — even if its bytes spell a resize message.
    const { inputs, resized, deps } = setup();
    handleAttachMessage(new TextEncoder().encode('{"type":"resize","cols":1,"rows":1}'), deps);
    expect(resized).toEqual([]);
    expect(inputs).toHaveLength(1);
  });

  test("routes a string resize control to resize, not input", () => {
    const { inputs, resized, deps } = setup();
    handleAttachMessage(JSON.stringify({ type: "resize", cols: 120, rows: 40 }), deps);
    expect(inputs).toEqual([]);
    expect(resized).toEqual([{ cols: 120, rows: 40 }]);
  });

  test("ignores a malformed string control without throwing or writing input", () => {
    const { inputs, resized, deps } = setup();
    expect(() => handleAttachMessage("not json", deps)).not.toThrow();
    expect(inputs).toEqual([]);
    expect(resized).toEqual([]);
  });
});
