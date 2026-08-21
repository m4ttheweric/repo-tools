/**
 * Async subprocess capture, duplicated from repo-tools/lib/subprocess.ts:
 * rt-client has no dependency on rt's lib/, so this can't import runCapture
 * from there. lib/subprocess.ts is the authority — change there first,
 * mirror here.
 *
 * execSync blocks the event loop for the entire child lifetime; identity
 * derivation must stay safe to call from daemon contexts, hence this instead.
 */

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Run argv and capture stdout. Never throws: spawn failures and timeouts
 * surface as a non-zero exitCode with whatever stdout was collected.
 */
export async function runCapture(
  argv: [string, ...string[]],
  opts: { cwd?: string; timeoutMs?: number; stderr?: "ignore" | "pipe" } = {},
): Promise<RunResult> {
  const captureStderr = opts.stderr === "pipe";
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(argv, {
      cwd: opts.cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: captureStderr ? "pipe" : "ignore",
    });
  } catch {
    return { stdout: "", stderr: "", exitCode: -1 };
  }

  const timer = setTimeout(() => {
    try { proc.kill(); } catch { /* already exited */ }
  }, opts.timeoutMs ?? 10_000);

  try {
    const stdoutPromise = new Response(proc.stdout as ReadableStream).text();
    const stderrPromise = captureStderr
      ? new Response(proc.stderr as ReadableStream).text()
      : Promise.resolve("");
    const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
    const exitCode = await proc.exited;
    return { stdout, stderr, exitCode };
  } catch {
    return { stdout: "", stderr: "", exitCode: -1 };
  } finally {
    clearTimeout(timer);
  }
}
