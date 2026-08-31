import { test, expect } from "bun:test";
import { deriveState, filterTail, isRunning, newEntry, parseExitSentinel, toModel } from "../state.ts";

const info = (fg: number | null, shell: number | null) => ({ foregroundPgid: fg, shellPid: shell, foreground: [] });

test("isRunning: the foreground group differs from the shell's", () => {
  expect(isRunning(info(4242, 4000))).toBe(true);
  expect(isRunning(info(4000, 4000))).toBe(false);
  expect(isRunning(info(null, 4000))).toBe(false);
  expect(isRunning(info(4242, null))).toBe(false);
});

test("parseExitSentinel reads the last sentinel line only", () => {
  expect(parseExitSentinel("noise\n__rt_exit 0\n")).toBe(0);
  expect(parseExitSentinel("__rt_exit 1\nmore\n__rt_exit 130\n% ")).toBe(130);
  expect(parseExitSentinel("no sentinel here")).toBeNull();
});

test("filterTail drops the sentinel, trailing blanks and a trailing prompt, and stamps lines", () => {
  const lines = filterTail("VITE ready\n➜ Local: http://localhost:5173/\n__rt_exit 0\n\nmatt@mbp web % \n");
  expect(lines.map((l) => l.text)).toEqual(["VITE ready", "➜ Local: http://localhost:5173/"]);
  expect(lines[0]!.ts).toMatch(/^\d\d:\d\d:\d\d$/);
});

test("deriveState: running beats everything; stopped on 0/130; crashed otherwise; starting holds until the shell has left", () => {
  const e = newEntry(1, "dev", "bun run dev", "/repo/web", "web", "acme");
  expect(deriveState({ ...e, state: "starting" }, info(4242, 4000), "")).toEqual({ state: "running", exitCode: null });
  expect(deriveState({ ...e, state: "running" }, info(4000, 4000), "x\n__rt_exit 0\n")).toEqual({ state: "stopped", exitCode: 0 });
  expect(deriveState({ ...e, state: "stopping" }, info(4000, 4000), "__rt_exit 130\n")).toEqual({ state: "stopped", exitCode: 130 });
  expect(deriveState({ ...e, state: "running" }, info(4000, 4000), "__rt_exit 1\n")).toEqual({ state: "crashed", exitCode: 1 });
  expect(deriveState({ ...e, state: "starting" }, info(4000, 4000), "")).toEqual({ state: "starting", exitCode: null });
  expect(deriveState({ ...e, state: "running" }, info(4000, 4000), "")).toEqual({ state: "stopped", exitCode: null });
});

test("deriveState: stopping holds through the sentinel's I/O lag, not just starting", () => {
  const e = newEntry(1, "dev", "bun run dev", "/repo/web", "web", "acme");
  expect(deriveState({ ...e, state: "stopping" }, info(4000, 4000), "")).toEqual({ state: "stopping", exitCode: null });
});

test("toModel emits domain fields only, ISO startedAt, and tail for the one entry that has it", () => {
  const a = { ...newEntry(1, "dev", "bun run dev", "/r/web", "web", "acme"), state: "running" as const, startedAt: new Date("2026-08-29T22:38:26Z"), tail: [{ ts: "22:41:07", text: "hi" }] };
  const b = newEntry(2, "api", "bun run api", "/r/api", "backend", "acme");
  const m = toModel("rt-runner-a3f9", [a, b]);
  expect(m).toEqual({
    workspace: "rt-runner-a3f9",
    entries: [
      { id: "e1", name: "dev", command: "bun run dev", pkg: "web", repo: "acme", state: "running", startedAt: "2026-08-29T22:38:26.000Z", exitCode: null, error: null, url: null, tail: [{ ts: "22:41:07", text: "hi" }] },
      { id: "e2", name: "api", command: "bun run api", pkg: "backend", repo: "acme", state: "starting", startedAt: null, exitCode: null, error: null, url: null, tail: null },
    ],
  });
  expect(JSON.stringify(m)).not.toContain("paneId");
});

test("newEntry starts with a null url and toModel carries it", () => {
  const e = newEntry(1, "dev", "bun run dev", "/repo/web", "web", "acme");
  expect(e.url).toBeNull();
  e.url = "http://localhost:3000";
  const m = toModel("ws", [e]);
  expect(m.entries[0]!.url).toBe("http://localhost:3000");
});
