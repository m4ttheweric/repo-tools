import { test, expect, afterEach } from "bun:test";
import { __test__ as gate } from "../../lib/ui/gate.ts";
import { __test__ as spawnTest, openSession } from "../../lib/ui/spawn.ts";
import { HerdrEngine } from "../../lib/runner/engine.ts";
import { buildRunnerDeps, runnerCommand } from "../runner.ts";

afterEach(() => {
  gate.setInteractive(undefined);
  spawnTest.setExit(undefined);
  delete process.env.HERDR_SOCKET_PATH;
});

test("off a TTY the command prints one line and exits 1 without touching herdr", async () => {
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

test("with herdr unreachable the command names the socket and exits 1", async () => {
  gate.setInteractive(() => true);
  process.env.HERDR_SOCKET_PATH = "/nonexistent/herdr.sock";
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
  expect(errs.join("")).toContain("/nonexistent/herdr.sock");
  expect(exits).toEqual([1]);
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
