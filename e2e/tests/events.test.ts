import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync } from "fs";
import { join } from "path";
import { createTestHome, RT_BINARY } from "../harness.ts";

async function waitForSocket(sockPath: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(sockPath)) {
    if (Date.now() > deadline) throw new Error(`daemon socket never appeared at ${sockPath}`);
    await Bun.sleep(100);
  }
}

function runRt(args: string[], home: string) {
  return Bun.spawn([RT_BINARY, ...args], {
    env: { ...process.env, HOME: home, RT_SKIP_SETUP: "1", CI: "true" },
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function finished(proc: ReturnType<typeof runRt>) {
  const exitCode = await proc.exited;
  return {
    exitCode,
    stdout: await new Response(proc.stdout).text(),
    stderr: await new Response(proc.stderr).text(),
  };
}

describe("rt events (bus e2e)", () => {
  let home: string;
  let cleanup: () => void;
  let daemon: ReturnType<typeof runRt>;

  beforeAll(async () => {
    // Requires TCP port 9401 free — lib/daemon-config.ts hardcodes API_PORT
    // with no env override, so this foreground daemon EADDRINUSEs (and the
    // process dies) if a real local rt daemon is already running, even
    // though the (HOME-scoped) Unix socket below comes up fine first. Stop
    // any locally running rt daemon before this suite (`rt daemon stop`,
    // restart after) — see RT-44 follow-up.
    ({ path: home, cleanup } = createTestHome());
    daemon = runRt(["--daemon"], home);
    await waitForSocket(join(home, ".rt", "rt.sock"));
    if (daemon.exitCode !== null) {
      throw new Error(
        `daemon process exited (code ${daemon.exitCode}) right after creating its socket — ` +
          `likely a port-9401 collision with a real local rt daemon. Run \`rt daemon stop\` ` +
          `before this suite, then \`rt daemon start\` after.`,
      );
    }
  });

  afterAll(async () => {
    daemon.kill();
    await daemon.exited;
    cleanup();
  });

  test("emit → blocked wait → wake across two processes", async () => {
    const waiter = runRt(["events", "wait", "job/e2e/*", "--timeout", "20s"], home);
    await Bun.sleep(500); // let the waiter register (blocked, not yet resolved)

    const emit = await finished(runRt(["events", "emit", "job/e2e/report", "--json", '{"n":1}'], home));
    expect(emit.exitCode).toBe(0);
    const emitted = JSON.parse(emit.stdout);
    expect(emitted.ok).toBe(true);

    const woke = await finished(waiter);
    expect(woke.exitCode).toBe(0);
    const result = JSON.parse(woke.stdout);
    expect(result.events).toHaveLength(1);
    expect(result.events[0].topic).toBe("job/e2e/report");
    expect(result.events[0].payload).toEqual({ n: 1 });
    expect(result.cursor).toBe(result.events[0].id);
  }, 30_000);

  // 12s deliberately crosses Bun.serve's implicit 10s idleTimeout default —
  // this test proves socket-server's idleTimeout: 255 is honored at runtime
  // (a @ts-expect-error suppresses a bun-types gap there; if the option were
  // silently ignored, this held request would be reaped at 10s and the CLI
  // would exit 1, not 124).
  test("wait --timeout expires with exit 124 and a cursor", async () => {
    const res = await finished(runRt(["events", "wait", "job/nobody/*", "--timeout", "12s"], home));
    expect(res.exitCode).toBe(124);
    const out = JSON.parse(res.stdout);
    expect(out.timedOut).toBe(true);
  }, 25_000);

  test("cursor replay: a late consumer sees events emitted while it was away", async () => {
    const first = await finished(runRt(["events", "emit", "job/replay/a"], home));
    const firstId = JSON.parse(first.stdout).id;
    await finished(runRt(["events", "emit", "job/replay/b"], home));

    const res = await finished(runRt(["events", "list", "job/replay/*", "--after", String(firstId - 1)], home));
    expect(res.exitCode).toBe(0);
    const out = JSON.parse(res.stdout);
    expect(out.events.map((e: any) => e.topic)).toEqual(["job/replay/a", "job/replay/b"]);
  }, 15_000);

  test("journal survives a daemon restart; wait resumes from a held cursor", async () => {
    const pre = await finished(runRt(["events", "emit", "job/restart/before"], home));
    const cursor = JSON.parse(pre.stdout).id;

    daemon.kill();
    await daemon.exited;
    daemon = runRt(["--daemon"], home);
    await waitForSocket(join(home, ".rt", "rt.sock"));

    const waiter = runRt(["events", "wait", "job/restart/*", "--after", String(cursor), "--timeout", "20s"], home);
    await Bun.sleep(500);
    await finished(runRt(["events", "emit", "job/restart/after"], home));

    const woke = await finished(waiter);
    expect(woke.exitCode).toBe(0);
    const out = JSON.parse(woke.stdout);
    expect(out.events.map((e: any) => e.topic)).toEqual(["job/restart/after"]);
  }, 45_000);
});
