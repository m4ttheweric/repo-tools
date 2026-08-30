import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { select, multiselect, confirm, textInput } from "../prompts.ts";
import { BackNavigation } from "../../back-navigation.ts";

const FAKE = resolve(import.meta.dir, "fake-rt-ui.ts");
let dir: string;
let record: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rt-ui-prompts-"));
  record = join(dir, "record.ndjson");
  process.env.RT_UI_BIN = FAKE;
});
afterEach(() => {
  delete process.env.RT_UI_BIN;
  delete process.env.RT_UI_FAKE;
  rmSync(dir, { recursive: true, force: true });
});

const sent = () => JSON.parse(readFileSync(record, "utf8").trim().split("\n")[0]!);

test("select sends a select spec with a back row when backLabel is given, and returns the value", async () => {
  process.env.RT_UI_FAKE = JSON.stringify({ answer: { value: "4h" }, record });
  const v = await select({ message: "Access duration", options: [{ value: "1h", label: "1 hour", hint: "default" }, { value: "4h", label: "4 hours" }], backLabel: "resources", stderr: true });
  expect(v).toBe("4h");
  expect(sent()).toEqual({
    t: "prompt", protocol: 1, kind: "select", title: "Access duration",
    options: [{ value: "1h", label: "1 hour", hint: "default" }, { value: "4h", label: "4 hours" }],
    back: { label: "resources" },
  });
});

test("select never puts a color on the wire", async () => {
  process.env.RT_UI_FAKE = JSON.stringify({ answer: { value: "x" }, record });
  await select({ message: "m", options: [{ value: "x", label: "X", color: "\x1b[36m" }] });
  expect(JSON.stringify(sent())).not.toContain("color");
});

test("select back throws BackNavigation", async () => {
  process.env.RT_UI_FAKE = JSON.stringify({ exit: 131 });
  await expect(select({ message: "m", options: [{ value: "x", label: "X" }], backLabel: "b" })).rejects.toBeInstanceOf(BackNavigation);
});

test("multiselect sends initial values and returns the array", async () => {
  process.env.RT_UI_FAKE = JSON.stringify({ answer: { values: ["a", "b"] }, record });
  const v = await multiselect({ message: "Disable which hooks?", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }], initialValues: ["a"], required: true });
  expect(v).toEqual(["a", "b"]);
  expect(sent()).toEqual({ t: "prompt", protocol: 1, kind: "multiselect", title: "Disable which hooks?", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }], initial: ["a"], min: 1 });
});

test("confirm maps initialValue to default and exposes destructive", async () => {
  process.env.RT_UI_FAKE = JSON.stringify({ answer: { ok: false }, record });
  const ok = await confirm({ message: "Locate repo?", initialValue: false, destructive: true });
  expect(ok).toBe(false);
  expect(sent()).toEqual({ t: "prompt", protocol: 1, kind: "confirm", message: "Locate repo?", default: false, destructive: true });
});

test("textInput sends placeholder and initial, returns the text", async () => {
  process.env.RT_UI_FAKE = JSON.stringify({ answer: { text: "linear-tools" }, record });
  const v = await textInput({ message: "Plugin name (kebab-case)", placeholder: "my-plugin", defaultValue: "x" });
  expect(v).toBe("linear-tools");
  expect(sent()).toEqual({ t: "prompt", protocol: 1, kind: "text", title: "Plugin name (kebab-case)", placeholder: "my-plugin", initial: "x" });
});
