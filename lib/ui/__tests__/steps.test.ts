import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { createStepRunner, withSpinner, __test__ } from "../steps.ts";
import { T, toAnsiFg } from "../../tui/palette.ts";

const FAKE = resolve(import.meta.dir, "fake-rt-ui.ts");
let dir: string;
let record: string;
let out: string[];
const realWrite = process.stdout.write;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rt-ui-steps-"));
  record = join(dir, "record.ndjson");
  process.env.RT_UI_BIN = FAKE;
  process.env.RT_UI_FAKE = JSON.stringify({ record });
  // bun test's stdin is not a TTY, so the real gate would never spawn; force
  // it open here and closed only in the test that is about the gate.
  __test__.setInteractive(() => true);
  out = [];
  process.stdout.write = ((chunk: string | Uint8Array) => { out.push(String(chunk)); return true; }) as typeof process.stdout.write;
});
afterEach(() => {
  process.stdout.write = realWrite;
  __test__.setInteractive(undefined);
  delete process.env.RT_UI_BIN;
  delete process.env.RT_UI_FAKE;
  rmSync(dir, { recursive: true, force: true });
});

const sent = () => readFileSync(record, "utf8").trim().split("\n").map((l) => JSON.parse(l));

test("run streams start/done with the done title and hint, and returns the task result", async () => {
  const steps = createStepRunner();
  const r = await steps.run("fetching origin…", async () => 42, { done: "origin fetched", doneHint: "3 new commits" });
  expect(r).toBe(42);
  expect(sent()).toEqual([
    { t: "hello", protocol: 1 },
    { t: "start", title: "fetching origin…" },
    { t: "done", title: "origin fetched", hint: "3 new commits" },
  ]);
});

test("run streams fail with the error message and rethrows", async () => {
  const steps = createStepRunner();
  await expect(steps.run("pushing…", async () => { throw new Error("rejected"); })).rejects.toThrow("rejected");
  expect(sent().at(-1)).toEqual({ t: "fail", title: "pushing failed", hint: "rejected" });
});

test("done title defaults to the pending title without its ellipsis", async () => {
  const steps = createStepRunner();
  await steps.run("rebasing…", async () => undefined);
  expect(sent().at(-1)).toEqual({ t: "done", title: "rebasing" });
});

test("log between steps prints a palette-colored line to stdout and spawns nothing", async () => {
  const steps = createStepRunner();
  steps.log("diverged from origin/main", "warn");
  expect(out.join("")).toContain("diverged from origin/main");
  expect(out.join("")).toContain(toAnsiFg(T.peach));
  expect(() => readFileSync(record)).toThrow();
});

test("withSpinner maps doneLabel/failLabel", async () => {
  await withSpinner("fetching origin…", async () => 1, { doneLabel: "origin fetched" });
  expect(sent().at(-1)).toEqual({ t: "done", title: "origin fetched" });
});

test("with the gate closed nothing is spawned and the plain final line is printed", async () => {
  __test__.setInteractive(undefined);
  process.env.RT_BATCH = "1";
  try {
    const steps = createStepRunner();
    await steps.run("fetching origin…", async () => 1, { done: "origin fetched", doneHint: "3 new commits" });
  } finally {
    delete process.env.RT_BATCH;
  }
  expect(() => readFileSync(record)).toThrow();
  const text = out.join("");
  expect(text).toContain("✓");
  expect(text).toContain("origin fetched");
  expect(text).toContain("3 new commits");
});

test("the real gate is closed off a TTY and under RT_BATCH", () => {
  __test__.setInteractive(undefined);
  expect(__test__.interactive()).toBe(Boolean(process.stdin.isTTY));
  process.env.RT_BATCH = "1";
  try {
    expect(__test__.interactive()).toBe(false);
  } finally {
    delete process.env.RT_BATCH;
  }
});

test("an unspawnable helper costs the spinner, not the work", async () => {
  // The helper only narrates the step. Resolving or spawning it is the one
  // failure that used to escape before the task ever ran.
  process.env.RT_UI_BIN = join(dir, "does-not-exist", "rt-ui");
  const errOut: string[] = [];
  const realErr = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => { errOut.push(String(chunk)); return true; }) as typeof process.stderr.write;
  let ran = false;
  try {
    const steps = createStepRunner();
    const r = await steps.run("fetching origin…", async () => { ran = true; return 42; }, { done: "origin fetched" });
    expect(r).toBe(42);
  } finally {
    process.stderr.write = realErr;
  }
  expect(ran).toBe(true);
  const text = out.join("");
  expect(text).toContain("✓");
  expect(text).toContain("origin fetched");
  expect(errOut.join("")).toContain("rt-ui");
});

test("when the child dies mid-step the plain final line is printed and a warning is shown", async () => {
  process.env.RT_UI_FAKE = JSON.stringify({ dieOn: "start" });
  const errOut: string[] = [];
  const realErr = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => { errOut.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try {
    const steps = createStepRunner();
    const r = await steps.run("pushing…", async () => { await Bun.sleep(150); return "ok"; }, { done: "pushed" });
    expect(r).toBe("ok");
  } finally {
    process.stderr.write = realErr;
  }
  expect(out.join("")).toContain("pushed");
  expect(errOut.join("")).toContain("rt-ui");
});
