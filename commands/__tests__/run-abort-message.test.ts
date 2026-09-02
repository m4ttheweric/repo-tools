/**
 * rt run's cancellation path (RunAborted -> resolveRun "cancelled" ->
 * runCommand's process.exit) leaves only the reason on stderr, TTY or not:
 * a cancel itself is silent everywhere in rt.
 */
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { closeStateDb } from "../../lib/state/index.ts";
import { runCommand } from "../run.ts";
import type { CommandContext } from "../../lib/command-tree.ts";

// Satisfies ensureHistoryHook's idempotency marker so runCommand's best-effort
// setup call is a no-op read, never a write into a real shell rc file.
const HOOK_INSTALLED_RC = "# rt — shell history hook\n";

const origHome = process.env.HOME;
const origShell = process.env.SHELL;
const origCwd = process.cwd();
let home: string;
let scratch: string;

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "rt-run-abort-home-")));
  scratch = realpathSync(mkdtempSync(join(tmpdir(), "rt-run-abort-scratch-")));
  process.env.HOME = home;
  process.env.SHELL = "/bin/zsh";
  writeFileSync(join(home, ".zshrc"), HOOK_INSTALLED_RC);
  closeStateDb();
  // Not a git repo, and no known repos in this fresh HOME -- resolveRun's
  // first gate (empty repo index) cancels immediately with no picker needed.
  process.chdir(scratch);
});

afterEach(() => {
  process.chdir(origCwd);
  process.env.HOME = origHome;
  process.env.SHELL = origShell;
  closeStateDb();
  rmSync(home, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
});

async function runCapturingExit(
  isTTY: boolean,
  fn: () => Promise<void>,
): Promise<{ exitCode: number | undefined; stderr: string }> {
  const isTTYDescriptor = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");
  Object.defineProperty(process.stderr, "isTTY", { value: isTTY, configurable: true });

  let stderr = "";
  const exitSpy = spyOn(process, "exit").mockImplementation(() => {
    throw new Error("process.exit sentinel");
  });
  const stderrSpy = spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
    stderr += String(chunk);
    return true;
  });
  try {
    await fn();
    return { exitCode: undefined, stderr };
  } catch {
    const exitCode = exitSpy.mock.calls.at(-1)?.[0] as number | undefined;
    return { exitCode, stderr };
  } finally {
    exitSpy.mockRestore();
    stderrSpy.mockRestore();
    if (isTTYDescriptor) Object.defineProperty(process.stderr, "isTTY", isTTYDescriptor);
    else delete (process.stderr as { isTTY?: boolean }).isTTY;
  }
}

test("a no-known-repos cancellation exits 1 with only the reason on stderr, even on a TTY", async () => {
  const ctx: CommandContext = { identity: undefined };
  const result = await runCapturingExit(true, () => runCommand([], ctx));

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("No known repos");
  expect(result.stderr).not.toContain("aborted");
});

test("the same cancellation reads the same off a TTY", async () => {
  const ctx: CommandContext = { identity: undefined };
  const result = await runCapturingExit(false, () => runCommand([], ctx));

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("No known repos");
  expect(result.stderr).not.toContain("aborted");
});
