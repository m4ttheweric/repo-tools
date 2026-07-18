/**
 * Async subprocess capture — the daemon-safe replacement for execSync.
 *
 * execSync blocks Bun's event loop for the entire child lifetime; on the
 * daemon that freeze shows up as timed-out status polls (red tray dot).
 * Everything that runs on a daemon timer must go through here instead.
 */

export interface RunResult {
  stdout: string;
  exitCode: number;
}

/**
 * Run argv and capture stdout. Never throws: spawn failures and timeouts
 * surface as a non-zero exitCode with whatever stdout was collected.
 */
export async function runCapture(
  argv: [string, ...string[]],
  opts: { cwd?: string; timeoutMs?: number } = {},
): Promise<RunResult> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(argv, {
      cwd: opts.cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    });
  } catch {
    return { stdout: "", exitCode: -1 };
  }

  const timer = setTimeout(() => {
    try { proc.kill(); } catch { /* already exited */ }
  }, opts.timeoutMs ?? 10_000);

  try {
    const stdout = await new Response(proc.stdout as ReadableStream).text();
    const exitCode = await proc.exited;
    return { stdout, exitCode };
  } catch {
    return { stdout: "", exitCode: -1 };
  } finally {
    clearTimeout(timer);
  }
}
