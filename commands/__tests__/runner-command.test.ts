import { test, expect, afterEach } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { __test__ as gate } from "../../lib/ui/gate.ts";
import { __test__ as spawnTest, openSession } from "../../lib/ui/spawn.ts";
import { HerdrEngine } from "../../lib/runner/engine.ts";
import { TmuxEngine } from "../../lib/runner/tmux-engine.ts";
import { buildRunnerDeps, buildTmuxRunnerDeps, runnerCommand, runSeededBoard, tmuxAvailable } from "../runner.ts";

const REAL_PATH = process.env.PATH ?? "";

afterEach(() => {
  gate.setInteractive(undefined);
  spawnTest.setExit(undefined);
  delete process.env.HERDR_SOCKET_PATH;
  process.env.PATH = REAL_PATH;
});

test("off a TTY the command prints one line and exits 1 without touching herdr or tmux", async () => {
  gate.setInteractive(() => false);
  const exits: number[] = [];
  spawnTest.setExit((code) => { exits.push(code); throw new Error(`exit ${code}`); });
  const errs: string[] = [];
  const real = process.stderr.write;
  process.stderr.write = ((c: string | Uint8Array) => { errs.push(String(c)); return true; }) as typeof process.stderr.write;
  try {
    await expect(runnerCommand([], {} as never)).rejects.toThrow("exit 1");
  } finally {
    process.stderr.write = real;
  }
  expect(exits).toEqual([1]);
  expect(errs.join("")).toContain("interactive terminal");
});

test("with --herdr and herdr unreachable the command names the socket and exits 1", async () => {
  gate.setInteractive(() => true);
  process.env.HERDR_SOCKET_PATH = "/nonexistent/herdr.sock";
  const exits: number[] = [];
  spawnTest.setExit((code) => { exits.push(code); throw new Error(`exit ${code}`); });
  const errs: string[] = [];
  const real = process.stderr.write;
  process.stderr.write = ((c: string | Uint8Array) => { errs.push(String(c)); return true; }) as typeof process.stderr.write;
  try {
    await expect(runnerCommand(["--herdr"], {} as never)).rejects.toThrow("exit 1");
  } finally {
    process.stderr.write = real;
  }
  expect(errs.join("")).toContain("/nonexistent/herdr.sock");
  expect(exits).toEqual([1]);
});

test("with no backend flag and tmux off PATH the command names it and exits 1 without touching herdr", async () => {
  gate.setInteractive(() => true);
  process.env.PATH = "/nonexistent-empty-dir";
  const exits: number[] = [];
  spawnTest.setExit((code) => { exits.push(code); throw new Error(`exit ${code}`); });
  const errs: string[] = [];
  const real = process.stderr.write;
  process.stderr.write = ((c: string | Uint8Array) => { errs.push(String(c)); return true; }) as typeof process.stderr.write;
  try {
    await expect(runnerCommand([], {} as never)).rejects.toThrow("exit 1");
  } finally {
    process.stderr.write = real;
  }
  expect(exits).toEqual([1]);
  expect(errs.join("")).toContain("tmux on PATH");
});

// Both branches run against a PATH this test builds. Asserting the true case
// against the machine's own PATH made the result depend on whether tmux
// happened to be installed, which is false on a CI runner.
test("tmuxAvailable reports false for a PATH without tmux, true for one with it", () => {
  const dir = mkdtempSync(join(tmpdir(), "rt-tmux-path-"));
  try {
    expect(tmuxAvailable(dir)).toBe(false);
    const bin = join(dir, "tmux");
    writeFileSync(bin, "#!/bin/sh\nexit 0\n");
    chmodSync(bin, 0o755);
    expect(tmuxAvailable(dir)).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildRunnerDeps assembles the success-path RunnerDeps", () => {
  const deps = buildRunnerDeps(["x", "--resolve-only"], {} as never, "/tmp/sock");
  expect(deps.engine).toBeInstanceOf(HerdrEngine);
  expect(deps.openSession).toBe(openSession);
  expect(deps.now()).toBeInstanceOf(Date);
  expect(typeof deps.sleep).toBe("function");
  expect(typeof deps.resolve).toBe("function");
  expect(deps.workspaceLabel).toMatch(/^rt-runner-[0-9a-f]{4}$/);
});

test("buildRunnerDeps carries the seed through", () => {
  const seed = [{ name: "dev", command: "bun run dev", cwd: "/repo/web", pkg: "web", repo: "acme" }];
  const deps = buildRunnerDeps([], {} as never, "/tmp/sock", seed);
  expect(deps.seed).toEqual(seed);
});

test("buildTmuxRunnerDeps assembles the success-path RunnerDeps on the tmux backend", () => {
  const deps = buildTmuxRunnerDeps(["x", "--resolve-only"], {} as never);
  expect(deps.engine).toBeInstanceOf(TmuxEngine);
  expect(deps.openSession).toBe(openSession);
  expect(deps.now()).toBeInstanceOf(Date);
  expect(typeof deps.sleep).toBe("function");
  expect(typeof deps.resolve).toBe("function");
  expect(deps.workspaceLabel).toMatch(/^rt-runner-[0-9a-f]{4}$/);
});

test("buildTmuxRunnerDeps carries the seed through", () => {
  const seed = [{ name: "dev", command: "bun run dev", cwd: "/repo/web", pkg: "web", repo: "acme" }];
  const deps = buildTmuxRunnerDeps([], {} as never, seed);
  expect(deps.seed).toEqual(seed);
});

test("runSeededBoard exits 1 with one line when tmux is off PATH (its default backend)", async () => {
  gate.setInteractive(() => true);
  process.env.PATH = "/nonexistent-empty-dir";
  const exits: number[] = [];
  spawnTest.setExit((code) => { exits.push(code); throw new Error(`exit ${code}`); });
  const errs: string[] = [];
  const real = process.stderr.write;
  process.stderr.write = ((c: string | Uint8Array) => { errs.push(String(c)); return true; }) as typeof process.stderr.write;
  const seed = [{ name: "dev", command: "bun run dev", cwd: "/repo/web", pkg: "web", repo: "acme" }];
  try {
    await expect(runSeededBoard(seed, {} as never)).rejects.toThrow("exit 1");
  } finally {
    process.stderr.write = real;
  }
  expect(exits).toEqual([1]);
  expect(errs).toHaveLength(1);
  expect(errs[0]).toContain("tmux on PATH");
});
