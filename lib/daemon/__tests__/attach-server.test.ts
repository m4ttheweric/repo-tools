/**
 * AttachServer unit tests.
 *
 * Exercises the Unix-socket per-process attach server. Uses a hand-rolled
 * FakeProcessManager to observe subscribeToOutput wiring and a real
 * Bun.Terminal (with monkey-patched resize/write) to observe the PTY-side
 * calls driven by client socket messages. A real LogBuffer is seeded for
 * the history-replay test.
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { AttachServer } from "../attach-server.ts";
import { LogBuffer } from "../log-buffer.ts";
import type { ProcessManager } from "../process-manager.ts";

function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

/**
 * Minimal ProcessManager stub — AttachServer only calls `subscribeToOutput`.
 * Captures every subscription so tests can drive fake PTY output through it.
 */
class FakeProcessManager {
  public subscribers = new Map<string, Set<(chunk: Uint8Array) => void>>();
  public calls: Array<{ id: string }> = [];

  subscribeToOutput(id: string, cb: (chunk: Uint8Array) => void): () => void {
    this.calls.push({ id });
    if (!this.subscribers.has(id)) this.subscribers.set(id, new Set());
    this.subscribers.get(id)!.add(cb);
    return () => this.subscribers.get(id)?.delete(cb);
  }

  /** Helper: push a chunk to every subscriber of an id. */
  emit(id: string, chunk: Uint8Array): void {
    for (const cb of this.subscribers.get(id) ?? []) cb(chunk);
  }
}

/**
 * Build a terminal-like object shaped enough for AttachServer. We instantiate
 * a real Bun.Terminal (so the type satisfies AttachServer's signature) and
 * monkey-patch resize/write to record calls.
 */
function makeSpyTerminal() {
  const term = new Bun.Terminal({ cols: 80, rows: 24, data() { /* noop */ } });
  const writes: Uint8Array[] = [];
  const resizes: Array<[number, number]> = [];
  const origWrite = term.write.bind(term);
  const origResize = term.resize.bind(term);
  // Cast through `any` — we only need to observe calls, and Bun's Terminal
  // method signatures (`number`-returning write) are stricter than what we
  // need for a simple spy.
  (term as any).write = (data: Uint8Array | string) => {
    writes.push(typeof data === "string" ? new TextEncoder().encode(data) : data);
    try { origWrite(data as any); } catch { /* ignore */ }
    return (data as any).length ?? 0;
  };
  (term as any).resize = (cols: number, rows: number) => {
    resizes.push([cols, rows]);
    try { origResize(cols, rows); } catch { /* ignore */ }
  };
  return { term, writes, resizes };
}

/** Connect a client to a unix socket and collect received bytes. */
async function openClient(sockPath: string) {
  const received: Uint8Array[] = [];
  const sock = await Bun.connect({
    unix: sockPath,
    socket: {
      data(_s, chunk) {
        received.push(chunk);
      },
      close() { /* */ },
      error(_s, err) { console.error("client err", err); },
    },
  });
  return {
    sock,
    received,
    /** Wait until total received byte count reaches `min`. */
    async waitFor(min: number, timeoutMs = 1000) {
      const start = Date.now();
      while (received.reduce((n, c) => n + c.length, 0) < min) {
        if (Date.now() - start > timeoutMs) break;
        await sleep(20);
      }
    },
  };
}

let dataDir: string;
let logBuffer: LogBuffer;
let server: AttachServer;
let fakePm: FakeProcessManager;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "rt-attach-server-test-"));
  logBuffer = new LogBuffer();
  server = new AttachServer({ logBuffer, dataDir });
  fakePm = new FakeProcessManager();
  server.setProcessManager(fakePm as unknown as ProcessManager);
});

afterEach(() => {
  server.closeAll();
  rmSync(dataDir, { recursive: true, force: true });
});

// ── socket lifecycle ─────────────────────────────────────────────────────────

describe("socket lifecycle", () => {
  test("open(id) creates a listening unix socket at socketPath(id)", () => {
    const { term } = makeSpyTerminal();
    const expected = server.socketPath("lane-1");
    expect(expected).toBe(join(dataDir, "attach-lane-1.sock"));

    server.open("lane-1", term);
    expect(existsSync(expected)).toBe(true);
  });

  test("closeAll() closes every open socket and clears internal state", async () => {
    const t1 = makeSpyTerminal();
    const t2 = makeSpyTerminal();
    server.open("a", t1.term);
    server.open("b", t2.term);

    expect(existsSync(server.socketPath("a"))).toBe(true);
    expect(existsSync(server.socketPath("b"))).toBe(true);

    server.closeAll();
    expect(existsSync(server.socketPath("a"))).toBe(false);
    expect(existsSync(server.socketPath("b"))).toBe(false);

    // After closeAll, opening the same id again should succeed (fresh socket).
    const t3 = makeSpyTerminal();
    server.open("a", t3.term);
    expect(existsSync(server.socketPath("a"))).toBe(true);
  });

  test("opening the same id twice recreates the socket (close first)", () => {
    const t1 = makeSpyTerminal();
    const t2 = makeSpyTerminal();
    server.open("x", t1.term);
    server.open("x", t2.term); // should replace, not throw
    expect(existsSync(server.socketPath("x"))).toBe(true);
  });
});

// ── client messages → PTY ────────────────────────────────────────────────────

describe("client → PTY", () => {
  test("JSON {type:resize,cols,rows} triggers terminal.resize()", async () => {
    const { term, resizes } = makeSpyTerminal();
    server.open("p1", term);

    const c = await openClient(server.socketPath("p1"));
    c.sock.write(JSON.stringify({ type: "resize", cols: 132, rows: 43 }));
    await sleep(100);
    c.sock.end();

    expect(resizes).toEqual([[132, 43]]);
  });

  test("non-JSON input is forwarded to terminal.write()", async () => {
    const { term, writes } = makeSpyTerminal();
    server.open("p1", term);

    const c = await openClient(server.socketPath("p1"));
    c.sock.write("hello world\n");
    await sleep(100);
    c.sock.end();

    const total = writes.map((w) => new TextDecoder().decode(w)).join("");
    expect(total).toContain("hello world");
  });

  test("malformed JSON starting with { falls back to terminal.write()", async () => {
    const { term, writes, resizes } = makeSpyTerminal();
    server.open("p1", term);

    const c = await openClient(server.socketPath("p1"));
    // Starts with `{` so we enter the try/catch branch, but it's not valid JSON.
    c.sock.write("{not-actually-json");
    await sleep(100);
    c.sock.end();

    expect(resizes).toEqual([]);
    const total = writes.map((w) => new TextDecoder().decode(w)).join("");
    expect(total).toContain("{not-actually-json");
  });
});

// ── history replay ──────────────────────────────────────────────────────────

describe("history replay", () => {
  test("first-attach client receives buffered lines before live output", async () => {
    // Seed LogBuffer with a few lines of history
    logBuffer.append("p1", "line-A\nline-B\nline-C\n");
    expect(logBuffer.getLastLines("p1")).toEqual(["line-A", "line-B", "line-C"]);

    const { term } = makeSpyTerminal();
    server.open("p1", term);

    const c = await openClient(server.socketPath("p1"));

    // Wait for history bytes to arrive
    await c.waitFor(20);

    const seenSoFar = c.received.map((u) => new TextDecoder().decode(u)).join("");
    expect(seenSoFar).toContain("line-A");
    expect(seenSoFar).toContain("line-B");
    expect(seenSoFar).toContain("line-C");

    // Now push live output through the subscriber hook — should also arrive.
    fakePm.emit("p1", new TextEncoder().encode("LIVE1\n"));
    await c.waitFor(seenSoFar.length + 5);

    const afterLive = c.received.map((u) => new TextDecoder().decode(u)).join("");
    expect(afterLive).toContain("LIVE1");

    // History must have been delivered before the live byte (ordering check).
    const liveIdx = afterLive.indexOf("LIVE1");
    const lineAIdx = afterLive.indexOf("line-A");
    expect(lineAIdx).toBeGreaterThanOrEqual(0);
    expect(lineAIdx).toBeLessThan(liveIdx);

    c.sock.end();
  });

  test("subscribeToOutput is called with the correct id on client connect", async () => {
    const { term } = makeSpyTerminal();
    server.open("p1", term);

    const c = await openClient(server.socketPath("p1"));
    await sleep(50);

    expect(fakePm.calls.some((x) => x.id === "p1")).toBe(true);

    c.sock.end();
  });
});
