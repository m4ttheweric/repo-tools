import { describe, test, expect, afterEach } from "bun:test";
import { unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runCapture, outputTail, MAX_LOGGED_OUTPUT } from "../subprocess.ts";

const SENTINEL = "RT_SPAWN_ENV_SENTINEL";

describe("runCapture env", () => {
  afterEach(() => {
    delete process.env[SENTINEL];
  });

  test("children see values assigned to process.env after startup", async () => {
    process.env[SENTINEL] = "visible";

    const r = await runCapture(["/bin/sh", "-c", `printf %s "$${SENTINEL}"`]);

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("visible");
  });

  test("an explicit env replaces the inherited one", async () => {
    process.env[SENTINEL] = "inherited";

    const r = await runCapture(["/bin/sh", "-c", `printf %s "$${SENTINEL}"`], {
      env: { [SENTINEL]: "explicit" },
    });

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("explicit");
  });
});

describe("runCapture timeout enforcement", () => {
  test("resolves within the deadline even when a grandchild holds the pipe", async () => {
    // zsh exits after ~0.2s, but backgrounds `sleep 20` which inherits stdout.
    const t0 = Date.now();
    const r = await runCapture(
      ["/bin/zsh", "-c", "sleep 20 & echo started; sleep 0.2"],
      { timeoutMs: 1000 },
    );
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(4000); // must NOT wait for the 20s grandchild
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).toBe(-1);
  });

  test("a SIGTERM-ignoring child is bounded by SIGKILL escalation", async () => {
    // Timing alone doesn't prove the kill worked: the deadline race resolves
    // runCapture on schedule regardless of whether SIGKILL ever fires. So this
    // asserts the process is actually gone, via its own recorded pid.
    const pidFile = path.join(
      os.tmpdir(),
      `rt-subprocess-test-${Date.now()}-${Math.random().toString(36).slice(2)}.pid`,
    );
    try {
      const t0 = Date.now();
      const r = await runCapture(
        ["/bin/zsh", "-c", `echo $$ > ${pidFile}; trap '' TERM; sleep 20`],
        { timeoutMs: 500 },
      );
      expect(Date.now() - t0).toBeLessThan(4000);
      expect(r.timedOut).toBe(true);

      // Past the 2s SIGKILL grace, so the escalation has had time to land.
      await new Promise((resolve) => setTimeout(resolve, 2500));
      const pid = Number((await Bun.file(pidFile).text()).trim());
      let alive = true;
      try {
        process.kill(pid, 0);
      } catch {
        alive = false;
      }
      expect(alive).toBe(false);
    } finally {
      await unlink(pidFile).catch(() => {});
    }
  }, 8000);

  test("normal fast command still returns real stdout and exitCode 0", async () => {
    const r = await runCapture(["/bin/echo", "hello"], { timeoutMs: 5000 });
    expect(r.stdout.trim()).toBe("hello");
    expect(r.exitCode).toBe(0);
    expect(r.timedOut).toBeUndefined();
  });

  test("timed-out call reports exitCode -1 so callers treat it as failure", async () => {
    const r = await runCapture(["/bin/sleep", "20"], { timeoutMs: 500 });
    expect(r.exitCode).toBe(-1);
    expect(r.timedOut).toBe(true);
  });
});

describe("runCapture abort signal", () => {
  test("an already-aborted signal returns failure without waiting", async () => {
    const t0 = Date.now();
    const r = await runCapture(["/bin/sleep", "20"], { timeoutMs: 10_000, signal: AbortSignal.abort() });
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(r.exitCode).toBe(-1);
  });

  test("aborting mid-run kills the child and settles early", async () => {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 100);
    const t0 = Date.now();
    const r = await runCapture(["/bin/sleep", "20"], { timeoutMs: 10_000, signal: ctrl.signal });
    expect(Date.now() - t0).toBeLessThan(4000); // aborted well before the 10s deadline
    expect(r.exitCode).toBe(-1);
  });
});

describe("outputTail", () => {
  test("passes short output through, trimmed", () => {
    expect(outputTail("  env: node: No such file or directory\n", 2000))
      .toBe("env: node: No such file or directory");
  });

  test("keeps the tail, not the head, and marks the elision", () => {
    const output = `${"x".repeat(50)}THE-REAL-ERROR`;

    const tail = outputTail(output, 20);

    expect(tail.startsWith("…")).toBe(true);
    expect(tail.endsWith("THE-REAL-ERROR")).toBe(true);
    expect(tail.length).toBe(21);
  });

  test("MAX_LOGGED_OUTPUT is the shared cap", () => {
    expect(MAX_LOGGED_OUTPUT).toBe(2000);
  });
});
