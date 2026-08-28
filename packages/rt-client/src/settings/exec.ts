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
  /** Set true only when the deadline fired before the child settled. */
  timedOut?: boolean;
}

/**
 * Run argv and capture stdout. Never throws: spawn failures and timeouts
 * surface as a non-zero exitCode with whatever stdout was collected.
 *
 * Children inherit the caller's live `process.env` unless `opts.env` overrides it.
 */
export async function runCapture(
  argv: [string, ...string[]],
  opts: {
    cwd?: string;
    timeoutMs?: number;
    stderr?: "ignore" | "pipe";
    env?: Record<string, string | undefined>;
  } = {},
): Promise<RunResult> {
  const captureStderr = opts.stderr === "pipe";
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(argv, {
      cwd: opts.cwd,
      // Bun.spawn ignores assignments made to process.env after startup, so an
      // inherited env strands a PATH resolved at boot and leaves
      // `#!/usr/bin/env node` shebangs unresolvable under launchd. execSync,
      // which this replaces, reads process.env per call.
      env: opts.env ?? { ...process.env },
      stdin: "ignore",
      stdout: "pipe",
      stderr: captureStderr ? "pipe" : "ignore",
    });
  } catch {
    return { stdout: "", stderr: "", exitCode: -1 };
  }

  const timeoutMs = opts.timeoutMs ?? 10_000;
  // SIGTERM at the deadline, SIGKILL a short grace later. A child that ignores
  // SIGTERM (or a D-state descendant) cannot be reaped in-band, so the read is
  // raced against the deadline below rather than awaited unconditionally: that
  // is what lets runCapture settle while a grandchild still holds the pipe.
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const term = setTimeout(() => {
    try { proc.kill("SIGTERM"); } catch { /* already exited */ }
    killTimer = setTimeout(() => {
      try { proc.kill("SIGKILL"); } catch { /* already exited */ }
    }, 2000);
  }, timeoutMs);

  const captured: Promise<RunResult> = (async () => {
    try {
      const stdoutPromise = new Response(proc.stdout as ReadableStream).text();
      const stderrPromise = captureStderr
        ? new Response(proc.stderr as ReadableStream).text()
        : Promise.resolve("");
      const [stdout, stderr, exitCode] = await Promise.all([
        stdoutPromise,
        stderrPromise,
        proc.exited,
      ]);
      return { stdout, stderr, exitCode };
    } catch {
      return { stdout: "", stderr: "", exitCode: -1 };
    }
  })();

  let deadlineTimer: ReturnType<typeof setTimeout>;
  const deadline: Promise<RunResult> = new Promise((resolve) => {
    deadlineTimer = setTimeout(() => resolve({ stdout: "", stderr: "", exitCode: -1, timedOut: true }), timeoutMs);
  });

  try {
    return await Promise.race([captured, deadline]);
  } finally {
    clearTimeout(term);
    clearTimeout(deadlineTimer!);
    // killTimer intentionally NOT cleared here: on the timeout path it must
    // survive this finally to fire SIGKILL against a child that ignored
    // SIGTERM. proc.kill is already try/catch guarded, so it is a harmless
    // no-op if the child exited before the 2s grace elapses.
  }
}
