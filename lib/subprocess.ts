/**
 * Async subprocess capture — the daemon-safe replacement for execSync.
 *
 * execSync blocks Bun's event loop for the entire child lifetime; on the
 * daemon that freeze shows up as timed-out status polls (red tray dot).
 * Everything that runs on a daemon timer must go through here instead.
 */

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** Set true only when the deadline fired before the child settled. */
  timedOut?: boolean;
}

/** Longest slice of a failed step's output carried into a log line. */
export const MAX_LOGGED_OUTPUT = 2000;

/** The tail of a step's output — a failing install reports at the end, not the start. */
export function outputTail(output: string, maxChars: number): string {
  const trimmed = output.trim();
  return trimmed.length <= maxChars ? trimmed : `…${trimmed.slice(-maxChars)}`;
}

/**
 * Run argv and capture stdout. Never throws: spawn failures and timeouts
 * surface as a non-zero exitCode with whatever stdout was collected.
 *
 * stderr is discarded by default (`opts.stderr` defaults to `"ignore"`); pass
 * `"pipe"` to capture it for callers that need failure detail (e.g. git).
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
      // inherited env strands the PATH the daemon resolves at boot
      // (lib/daemon.ts) and leaves `#!/usr/bin/env node` shebangs unresolvable
      // under launchd. execSync, which this replaces, reads process.env per call.
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
