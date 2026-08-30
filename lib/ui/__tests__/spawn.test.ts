import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { BackNavigation } from "../../back-navigation.ts";
import { runPrompt, openStep, __test__ } from "../spawn.ts";
import type { PromptSpec } from "../protocol.ts";

const FAKE = resolve(import.meta.dir, "fake-rt-ui.ts");
let dir: string;
let record: string;
const exits: number[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rt-ui-spawn-"));
  record = join(dir, "record.ndjson");
  process.env.RT_UI_BIN = FAKE;
  exits.length = 0;
  __test__.setExit((code) => {
    exits.push(code);
    throw new Error(`exit ${code}`);
  });
});

afterEach(() => {
  delete process.env.RT_UI_BIN;
  delete process.env.RT_UI_FAKE;
  __test__.setExit(undefined);
  rmSync(dir, { recursive: true, force: true });
});

const spec: PromptSpec = { t: "prompt", protocol: 1, kind: "select", title: "Pick", options: [{ value: "a", label: "A" }] };

test("runPrompt sends exactly one spec line and returns the parsed result", async () => {
  process.env.RT_UI_FAKE = JSON.stringify({ answer: { value: "a" }, record });
  const r = await runPrompt(spec);
  expect(r).toEqual({ t: "result", value: "a" });
  const sent = readFileSync(record, "utf8").trim().split("\n");
  expect(sent).toHaveLength(1);
  expect(JSON.parse(sent[0]!)).toEqual(spec);
});

test("runPrompt keeps stdin open until the child exits", async () => {
  process.env.RT_UI_FAKE = JSON.stringify({ answer: { value: "a" }, holdMs: 300 });
  const t0 = Date.now();
  await runPrompt(spec);
  expect(Date.now() - t0).toBeGreaterThanOrEqual(280);
});

test("exit 130 maps to process.exit(130)", async () => {
  process.env.RT_UI_FAKE = JSON.stringify({ exit: 130 });
  await expect(runPrompt(spec)).rejects.toThrow("exit 130");
  expect(exits).toEqual([130]);
});

test("exit 131 throws BackNavigation", async () => {
  process.env.RT_UI_FAKE = JSON.stringify({ exit: 131 });
  await expect(runPrompt(spec)).rejects.toBeInstanceOf(BackNavigation);
});

test("exit 2 and 70 exit 1 with a message naming the binary", async () => {
  for (const code of [2, 70]) {
    process.env.RT_UI_FAKE = JSON.stringify({ exit: code });
    await expect(runPrompt(spec)).rejects.toThrow("exit 1");
  }
  expect(exits).toEqual([1, 1]);
});

test("openStep streams hello, start, log, done and resolves on child exit", async () => {
  process.env.RT_UI_FAKE = JSON.stringify({ record });
  const step = openStep("fetching origin…");
  step.log("warn", "diverged");
  await step.done("origin fetched", "3 new commits");
  const sent = readFileSync(record, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  expect(sent).toEqual([
    { t: "hello", protocol: 1 },
    { t: "start", title: "fetching origin…" },
    { t: "log", level: "warn", text: "diverged" },
    { t: "done", title: "origin fetched", hint: "3 new commits" },
  ]);
});

test("openStep resolves true when the child painted the final line", async () => {
  process.env.RT_UI_FAKE = JSON.stringify({ record });
  const step = openStep("pushing…");
  expect(await step.done("pushed")).toBe(true);
});

test("openStep resolves false, never throws or exits, when the child died mid-step", async () => {
  process.env.RT_UI_FAKE = JSON.stringify({ dieOn: "start" });
  const step = openStep("pushing…");
  await Bun.sleep(150);
  step.log("info", "still going");
  expect(await step.done("pushed")).toBe(false);
  expect(exits).toEqual([]);
});
