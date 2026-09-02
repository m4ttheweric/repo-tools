import { afterEach, expect, test } from "bun:test";
import { runPick, __test__ as pickInternals } from "../pick.ts";
import { installFakePick, type PickFakeStep } from "../pick-fake.ts";
import type { PickEvent, PickResult } from "../protocol.ts";

// A regression that reintroduces the hang this guards against would otherwise
// wedge the whole suite; racing a short timeout turns that into a fast failure.
async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer!: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}: timed out after ${ms}ms (likely hung)`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

let fake: ReturnType<typeof installFakePick> | undefined;

afterEach(() => {
  fake?.restore();
  fake = undefined;
});

test("stamps t/protocol onto the request alongside the caller's fields", () => {
  fake = installFakePick([]);
  runPick({
    message: "Pick a repo",
    rows: [{ value: "a", left: [{ text: "A" }] }],
    multi: true,
  });
  expect(fake.calls).toHaveLength(1);
  expect(fake.calls[0]!.request).toEqual({
    t: "pick",
    protocol: 1,
    message: "Pick a repo",
    rows: [{ value: "a", left: [{ text: "A" }] }],
    multi: true,
  });
});

test("delivers events to onEvent in order, one at a time, awaiting an async handler before the next", async () => {
  const order: string[] = [];
  const script: PickFakeStep[] = [
    { kind: "event", event: { action: "select", value: "a", query: "" } },
    { kind: "event", event: { action: "select", value: "b", query: "" } },
    { kind: "result", result: { action: "select", value: "b", query: "" } },
  ];
  fake = installFakePick(script);
  const seen: PickEvent[] = [];
  const handle = runPick(
    { message: "m", rows: [] },
    {
      onEvent: async (e) => {
        order.push(`start:${e.value}`);
        await Bun.sleep(10);
        order.push(`end:${e.value}`);
        seen.push(e);
      },
    },
  );
  await handle.result;
  expect(order).toEqual(["start:a", "end:a", "start:b", "end:b"]);
  expect(seen.map((e) => e.value)).toEqual(["a", "b"]);
});

test("modal() sends the round trip and resolves with the scripted value", async () => {
  const script: PickFakeStep[] = [
    { kind: "modal-result", value: "yes" },
    { kind: "result", result: { action: "select", value: null, query: "" } },
  ];
  fake = installFakePick(script);
  const handle = runPick({ message: "m", rows: [] });
  const v = await handle.modal("Confirm?", [{ value: "yes", left: [{ text: "Yes" }] }]);
  expect(v).toBe("yes");
  expect(fake.calls[0]!.modals).toEqual([{ message: "Confirm?", rows: [{ value: "yes", left: [{ text: "Yes" }] }] }]);
});

test("modal() resolves with null on a scripted dismissal", async () => {
  fake = installFakePick([{ kind: "modal-result", value: null }, { kind: "result", result: { action: "select", value: null, query: "" } }]);
  const handle = runPick({ message: "m", rows: [] });
  const v = await handle.modal("Confirm?", []);
  expect(v).toBeNull();
});

test("result resolves exactly once with the terminal PickResult", async () => {
  const finalResult: Omit<PickResult, "t"> = { action: "select", value: "x", values: ["x"], query: "abc" };
  fake = installFakePick([{ kind: "result", result: finalResult }]);
  const handle = runPick({ message: "m", rows: [] });
  const r = await handle.result;
  expect(r).toEqual({ t: "result", ...finalResult });
  // Awaiting again must yield the same settled value, not re-run anything.
  const r2 = await handle.result;
  expect(r2).toBe(r);
});

test("update() records the patch the caller sent", () => {
  fake = installFakePick([]);
  const handle = runPick({ message: "m", rows: [] });
  handle.update({ message: "still working" });
  handle.update({ rows: [{ value: "z", left: [{ text: "Z" }] }] });
  expect(fake.calls[0]!.updates).toEqual([{ message: "still working" }, { rows: [{ value: "z", left: [{ text: "Z" }] }] }]);
});

test("a stream error rejects result instead of hanging forever", async () => {
  async function* throwingLines(): AsyncGenerator<string> {
    yield JSON.stringify({ t: "event", action: "select", value: "a", query: "" });
    throw new Error("stream blew up");
  }
  const { result } = pickInternals.driveReaderForTest(throwingLines());
  await expect(withTimeout(result, 500, "result")).rejects.toThrow("stream blew up");
});

test("an outstanding modal settles with null instead of hanging when the stream closes", async () => {
  async function* linesSrc(): AsyncGenerator<string> {
    yield JSON.stringify({ t: "result", action: "select", value: "x", query: "" });
  }
  const { pendingModals } = pickInternals.driveReaderForTest(linesSrc());
  const modal = new Promise<string | null>((resolve) => { pendingModals.push(resolve); });
  const v = await withTimeout(modal, 500, "modal");
  expect(v).toBeNull();
});

test("an outstanding modal settles with null instead of hanging when the stream errors", async () => {
  async function* throwingLines(): AsyncGenerator<string> {
    throw new Error("stream blew up");
  }
  const { result, pendingModals } = pickInternals.driveReaderForTest(throwingLines());
  void result.catch(() => { /* asserted separately by the sibling stream-error test */ });
  const modal = new Promise<string | null>((resolve) => { pendingModals.push(resolve); });
  const v = await withTimeout(modal, 500, "modal");
  expect(v).toBeNull();
});

test("a throwing onEvent is contained: later events and the result still settle", async () => {
  const seen: string[] = [];
  async function* linesSrc(): AsyncGenerator<string> {
    yield JSON.stringify({ t: "event", action: "select", value: "a", query: "" });
    yield JSON.stringify({ t: "event", action: "select", value: "b", query: "" });
    yield JSON.stringify({ t: "result", action: "select", value: "b", query: "" });
  }
  const { result } = pickInternals.driveReaderForTest(linesSrc(), {
    onEvent: (e) => {
      seen.push(e.value ?? "");
      if (e.value === "a") throw new Error("boom");
    },
  });
  const r = await withTimeout(result, 500, "result");
  expect(seen).toEqual(["a", "b"]);
  expect(r).toEqual({ t: "result", action: "select", value: "b", query: "" });
});

test("runPick throws when stdin/stderr are not TTYs, without installing a fake", () => {
  // No fake installed: this exercises the real spawn-based impl's guard.
  // bun test's own stdio is never a TTY, so the guard fires before any
  // process is spawned.
  expect(process.stdin.isTTY).toBeFalsy();
  expect(() => runPick({ message: "m", rows: [] })).toThrow("interactive terminal");
});
