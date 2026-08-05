import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { startNavWatch } from "../nav-watch.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Fake fs.watch: hands the test a trigger() to fire listener events by hand. */
function fakeWatch() {
  let listener: (() => void) | null = null;
  let closed = false;
  return {
    watch: (_dir: string, l: () => void) => {
      listener = l;
      return { close: () => { closed = true; } };
    },
    trigger: () => listener?.(),
    get closed() { return closed; },
  };
}

function fakePost() {
  const bodies: string[] = [];
  return {
    post: async (_sock: string, body: string) => { bodies.push(body); },
    bodies,
  };
}

function harness(render: () => string, initial = "INITIAL") {
  const dir = mkdtempSync(join(tmpdir(), "nav-watch-"));
  const w = fakeWatch();
  const p = fakePost();
  const listFile = join(dir, "list.txt");
  const handle = startNavWatch({
    dir,
    socketPath: join(dir, "s.sock"),
    listFile,
    initial,
    render,
    debounceMs: 10,
    deps: { watch: w.watch, post: p.post },
  });
  return { dir, w, p, handle, listFile, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("startNavWatch", () => {
  test("coalesces a burst of events into a single POST", async () => {
    const h = harness(() => "CHANGED");
    h.w.trigger(); h.w.trigger(); h.w.trigger();
    await sleep(40);
    expect(h.p.bodies.length).toBe(1);
    h.handle.stop();
    h.cleanup();
  });

  test("sends no POST when the rendered listing is unchanged", async () => {
    const h = harness(() => "INITIAL");
    h.w.trigger();
    await sleep(40);
    expect(h.p.bodies.length).toBe(0);
    h.handle.stop();
    h.cleanup();
  });

  test("POST body reloads from the list file and refreshes the preview", async () => {
    const h = harness(() => "CHANGED");
    h.w.trigger();
    await sleep(40);
    expect(h.p.bodies[0]).toContain("reload(cat ");
    expect(h.p.bodies[0]).toContain("+refresh-preview");
    expect(h.p.bodies[0]).toContain(h.listFile);
    h.handle.stop();
    h.cleanup();
  });

  test("writes the new listing to the list file before POSTing", async () => {
    const h = harness(() => "CHANGED");
    h.w.trigger();
    await sleep(40);
    expect(readFileSync(h.listFile, "utf8")).toBe("CHANGED");
    h.handle.stop();
    h.cleanup();
  });

  test("only POSTs again when the listing changes a second time", async () => {
    let current = "ONE";
    const h = harness(() => current);
    h.w.trigger();
    await sleep(40);
    h.w.trigger();
    await sleep(40);
    expect(h.p.bodies.length).toBe(1);
    current = "TWO";
    h.w.trigger();
    await sleep(40);
    expect(h.p.bodies.length).toBe(2);
    h.handle.stop();
    h.cleanup();
  });

  test("stop() closes the watcher and suppresses pending POSTs", async () => {
    const h = harness(() => "CHANGED");
    h.w.trigger();
    h.handle.stop();
    await sleep(40);
    expect(h.p.bodies.length).toBe(0);
    expect(h.w.closed).toBe(true);
    h.cleanup();
  });

  test("a throwing render reports through onError and sends no POST", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nav-watch-err-"));
    const w = fakeWatch();
    const p = fakePost();
    const errors: unknown[] = [];
    const handle = startNavWatch({
      dir,
      socketPath: join(dir, "s.sock"),
      listFile: join(dir, "list.txt"),
      initial: "INITIAL",
      render: () => { throw new Error("gone"); },
      debounceMs: 10,
      onError: (e) => errors.push(e),
      deps: { watch: w.watch, post: p.post },
    });
    w.trigger();
    await sleep(40);
    expect(errors.length).toBe(1);
    expect(p.bodies.length).toBe(0);
    handle.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  test("retries a failed POST on the next event instead of suppressing it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nav-watch-retry-"));
    const w = fakeWatch();
    let callCount = 0;
    const post = async (_sock: string, _body: string) => {
      callCount++;
      if (callCount === 1) {
        throw new Error("ECONNREFUSED");
      }
    };
    const handle = startNavWatch({
      dir,
      socketPath: join(dir, "s.sock"),
      listFile: join(dir, "list.txt"),
      initial: "INITIAL",
      // Same rendered content on both events: if a failed POST were wrongly
      // recorded as delivered, the "unchanged" guard would suppress the
      // second attempt and callCount would stay at 1.
      render: () => "CHANGED",
      debounceMs: 10,
      deps: { watch: w.watch, post },
    });
    w.trigger();
    await sleep(40);
    expect(callCount).toBe(1);
    w.trigger();
    await sleep(40);
    expect(callCount).toBe(2);
    handle.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  test("a failing watch registration reports through onError and does not throw", () => {
    const dir = mkdtempSync(join(tmpdir(), "nav-watch-nowatch-"));
    const errors: unknown[] = [];
    const handle = startNavWatch({
      dir,
      socketPath: join(dir, "s.sock"),
      listFile: join(dir, "list.txt"),
      initial: "INITIAL",
      render: () => "CHANGED",
      onError: (e) => errors.push(e),
      deps: {
        watch: () => { throw new Error("ENOSYS"); },
        post: async () => {},
      },
    });
    expect(errors.length).toBe(1);
    expect(() => handle.stop()).not.toThrow();
    rmSync(dir, { recursive: true, force: true });
  });
});
