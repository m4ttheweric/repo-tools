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

/** Grab a free TCP port by binding port 0 and releasing it. */
function freePort(): number {
  const srv = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = srv.port;
  srv.stop(true);
  if (!port) throw new Error("failed to allocate a free port");
  return port;
}

// Assigned in beforeAll; every spawned rt process (daemon and CLI) shares it.
let apiPort = 0;
// Every spawned child, so afterAll can reap waiters orphaned by a mid-test
// assertion failure instead of leaving them to their own --timeout.
const children: Array<ReturnType<typeof Bun.spawn>> = [];

function runRt(args: string[], home: string) {
  // Hermetic env mirroring e2e/harness.ts run() — no ambient process.env
  // leaking into children (that class of leak is what caused the original
  // port-9401 collision).
  const bunDir = join(process.execPath, "..");
  const proc = Bun.spawn([RT_BINARY, ...args], {
    env: {
      HOME: home,
      PATH: `${join(RT_BINARY, "..")}:${bunDir}:/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin`,
      TERM: "xterm-256color",
      RT_SKIP_SETUP: "1",
      CI: "true",
      RT_API_PORT: String(apiPort),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  children.push(proc);
  return proc;
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
    // The spawned foreground daemon binds its HTTP/WS server on RT_API_PORT
    // (RT-45): a per-run free port, so this suite is hermetic and never
    // collides with a live local rt daemon on the default 9401.
    apiPort = freePort();
    ({ path: home, cleanup } = createTestHome());
    daemon = runRt(["--daemon"], home);
    await waitForSocket(join(home, ".rt", "rt.sock"));
    if (daemon.exitCode !== null) {
      throw new Error(
        `daemon process exited (code ${daemon.exitCode}) right after creating its socket — ` +
          `port ${apiPort} collision or daemon boot crash; check the daemon's stderr.`,
      );
    }
  });

  afterAll(async () => {
    // Reap every child (waiters orphaned by failed assertions included).
    for (const child of children) {
      try { child.kill(); } catch { /* already gone */ }
    }
    await Promise.all(children.map((c) => c.exited));
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
