import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { openSession, __test__ } from "../spawn.ts";
import { __test__ as gate } from "../gate.ts";

const FAKE = resolve(import.meta.dir, "fake-rt-ui.ts");
let dir: string;
let record: string;
const exits: number[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rt-ui-session-"));
  record = join(dir, "record.ndjson");
  process.env.RT_UI_BIN = FAKE;
  gate.setInteractive(() => true);
  exits.length = 0;
  __test__.setExit((code) => { exits.push(code); throw new Error(`exit ${code}`); });
});
afterEach(() => {
  gate.setInteractive(undefined);
  __test__.setExit(undefined);
  delete process.env.RT_UI_BIN;
  delete process.env.RT_UI_FAKE;
  rmSync(dir, { recursive: true, force: true });
});

const sent = () => readFileSync(record, "utf8").trim().split("\n").map((l) => JSON.parse(l));

test("open sends the model after hello, intents stream in order, close resolves closed", async () => {
  process.env.RT_UI_FAKE = JSON.stringify({ record, intents: [{ name: "stop", entryId: "e1" }, { name: "tail", entryId: "e1", open: true }] });
  const s = await openSession("board", { workspace: "w", entries: [] });
  const got: unknown[] = [];
  for await (const it of s.intents) {
    got.push(it);
    if (got.length === 2) break;
  }
  expect(got).toEqual([{ t: "intent", name: "stop", entryId: "e1" }, { t: "intent", name: "tail", entryId: "e1", open: true }]);
  s.push({ workspace: "w", entries: [{ id: "e1" }] });
  const end = await s.close();
  expect(end).toEqual({ reason: "closed", code: 0 });
  expect(sent()).toEqual([
    { t: "open", view: "board", model: { workspace: "w", entries: [] } },
    { t: "model", model: { workspace: "w", entries: [{ id: "e1" }] } },
    { t: "close" },
  ]);
});

test("a quit intent ends the stream and close reports quit", async () => {
  process.env.RT_UI_FAKE = JSON.stringify({ record, intents: [{ name: "quit" }] });
  const s = await openSession("board", { workspace: "w", entries: [] });
  const got: unknown[] = [];
  for await (const it of s.intents) got.push(it);
  expect(got).toEqual([{ t: "intent", name: "quit" }]);
  expect(await s.close()).toEqual({ reason: "quit", code: 0 });
});

test("a child that dies after open surfaces as died with its code and push becomes a no-op", async () => {
  process.env.RT_UI_FAKE = JSON.stringify({ record, exit: 130 });
  const s = await openSession("board", { workspace: "w", entries: [] });
  const got: unknown[] = [];
  for await (const it of s.intents) got.push(it);
  expect(got).toEqual([]);
  s.push({ workspace: "w", entries: [] });
  expect(await s.close()).toEqual({ reason: "died", code: 130 });
});

test("a hello with the wrong protocol fails through the exit seam with code 1", async () => {
  process.env.RT_UI_FAKE = JSON.stringify({ record, protocol: 9 });
  await expect(openSession("board", {})).rejects.toThrow("exit 1");
  expect(exits).toEqual([1]);
});

test("a closed gate refuses to spawn", async () => {
  gate.setInteractive(() => false);
  process.env.RT_UI_FAKE = JSON.stringify({ record });
  await expect(openSession("board", {})).rejects.toThrow("exit 1");
  expect(() => readFileSync(record)).toThrow();
});
