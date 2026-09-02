/**
 * rt nav on the events model: one runPick session per browse (descend,
 * toggle, sort, and live-refresh all patch that same session in place), with
 * a handful of actions that must own the real terminal (editor, Quick Look,
 * a spawned shell) closing the session and reopening a fresh one with
 * resumeValue/initialQuery so browsing picks back up where it left off. The
 * shell is the exception: it is a deliberate full exit, no reopen.
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { spawnSync as realSpawnSync } from "child_process";
import { installFakePick, type PickFakeStep, type PickFakeCall } from "../../lib/ui/pick-fake.ts";
import { __test__ as pickTest } from "../../lib/ui/pick.ts";
import type { PickCallbacks, PickHandle, PickImpl } from "../../lib/ui/pick.ts";
import type { PickEvent, PickRequest, PickResult, PickRow } from "../../lib/ui/protocol.ts";
import { navigate, type NavDeps } from "../nav.ts";
import type { DirWatchOpts } from "../../lib/nav-fs.ts";

let fake: ReturnType<typeof installFakePick> | undefined;

afterEach(() => {
  fake?.restore();
  fake = undefined;
});

function eventStep(action: string, value: string | null, query = ""): PickFakeStep {
  return { kind: "event", event: { action, value, query } };
}
function resultStep(action: string, value: string | null, query = ""): PickFakeStep {
  return { kind: "result", result: { action, value, query } };
}
function modalResultStep(value: string | null): PickFakeStep {
  return { kind: "modal-result", value };
}

/** Records every spawnSync call instead of touching a real process. */
function fakeSpawnSync(): { calls: Array<{ cmd: string; args: string[]; opts: unknown }>; fn: typeof realSpawnSync } {
  const calls: Array<{ cmd: string; args: string[]; opts: unknown }> = [];
  const fn = ((cmd: string, args?: readonly string[], opts?: unknown) => {
    calls.push({ cmd, args: args ? [...args] : [], opts });
    return { status: 0, signal: null, pid: 1, output: [], stdout: "", stderr: "" };
  }) as unknown as typeof realSpawnSync;
  return { calls, fn };
}

/** startDirWatch fake that never touches the real filesystem; hands the test a manual trigger. */
function fakeStartDirWatch(): { trigger(): void; fn: NavDeps["startDirWatch"] } {
  let onChange: (() => void) | null = null;
  const fn = ((opts: DirWatchOpts) => {
    onChange = opts.onChange;
    return { stop() {} };
  }) as NavDeps["startDirWatch"];
  return { trigger: () => onChange?.(), fn };
}

function baseDeps(overrides: Partial<NavDeps> = {}): Partial<NavDeps> {
  return {
    spawnSync: fakeSpawnSync().fn,
    startDirWatch: fakeStartDirWatch().fn,
    openDirectoryInEditor: async () => {},
    ...overrides,
  };
}

/**
 * Per-call sequencer: unlike installFakePick (whose one script replays for
 * every runPick() call), each entry here answers exactly one call, in order.
 * Needed for the exit-then-resume flows, where the resumed session's request
 * (its resumeValue/initialQuery) is what the test actually cares about, not
 * a repeat of the same script.
 */
function installSequentialFakePick(scripts: PickFakeStep[][]): { calls: PickFakeCall[]; restore(): void } {
  const calls: PickFakeCall[] = [];
  let callIndex = 0;

  const fakeImpl: PickImpl = (req: PickRequest, cb: PickCallbacks) => {
    const script = scripts[callIndex] ?? [];
    callIndex++;
    const call: PickFakeCall = { request: req, updates: [], modals: [] };
    calls.push(call);

    let resolveResult!: (r: PickResult) => void;
    const result = new Promise<PickResult>((res) => { resolveResult = res; });
    const pendingModals: Array<(v: string | null) => void> = [];
    let wakeModal: (() => void) | null = null;

    (async () => {
      let eventChain: Promise<void> = Promise.resolve();
      for (const step of script) {
        if (step.kind === "event") {
          const evt: PickEvent = { t: "event", ...step.event };
          eventChain = eventChain.then(() => cb.onEvent?.(evt));
          await eventChain;
        } else if (step.kind === "modal-result") {
          while (pendingModals.length === 0) {
            await new Promise<void>((resolve) => { wakeModal = resolve; });
          }
          wakeModal = null;
          pendingModals.shift()!(step.value);
        } else {
          await eventChain;
          resolveResult({ t: "result", ...step.result });
        }
      }
    })();

    return {
      update(patch) { call.updates.push(patch); },
      modal(message, rows) {
        call.modals.push({ message, rows });
        return new Promise<string | null>((resolve) => {
          pendingModals.push(resolve);
          wakeModal?.();
        });
      },
      result,
    } satisfies PickHandle;
  };

  pickTest.setImpl(fakeImpl);
  let restored = false;
  return {
    calls,
    restore() {
      if (restored) return;
      restored = true;
      pickTest.setImpl(undefined);
    },
  };
}

function withRealStdoutRestore<T>(run: () => Promise<T>): Promise<T> {
  const orig = process.stdout.write;
  return run().finally(() => { process.stdout.write = orig; });
}

describe("rt nav: descend in place", () => {
  test("enter on a folder re-lists in place: one runPick call, then an update", async () => {
    const root = mkdtempSync(join(tmpdir(), "nav-test-"));
    mkdirSync(join(root, "alpha"));
    writeFileSync(join(root, "alpha", "inner.txt"), "x");

    fake = installFakePick([
      eventStep("open", "d:alpha"),
      resultStep("cancel", null),
    ]);

    await withRealStdoutRestore(() => navigate([root], baseDeps()));

    expect(fake.calls.length).toBe(1);
    const updates = fake.calls[0]!.updates;
    expect(updates.length).toBeGreaterThanOrEqual(1);
    const rowsAfterDescend = updates.find((u) => u.rows?.some((r) => r.value === "f:inner.txt"));
    expect(rowsAfterDescend).toBeDefined();

    rmSync(root, { recursive: true, force: true });
  });

  test("a filter typed in the parent is reset on descend, and the header breadcrumb follows the new cwd", async () => {
    const root = mkdtempSync(join(tmpdir(), "nav-test-"));
    mkdirSync(join(root, "alpha"));
    writeFileSync(join(root, "alpha", "inner.txt"), "x");

    // query "al" stands in for a filter the user had typed against the
    // parent listing before hitting enter on "alpha".
    fake = installFakePick([
      eventStep("open", "d:alpha", "al"),
      resultStep("cancel", null),
    ]);

    await withRealStdoutRestore(() => navigate([root], baseDeps()));

    const updates = fake.calls[0]!.updates;
    const descendUpdate = updates.find((u) => u.rows?.some((r) => r.value === "f:inner.txt"));
    expect(descendUpdate).toBeDefined();
    expect(descendUpdate!.resetQuery).toBe(true);
    expect(descendUpdate!.breadcrumb).toEqual([join(root, "alpha")]);

    rmSync(root, { recursive: true, force: true });
  });

  test("ctrl-up resets the query and updates the breadcrumb to the parent directory", async () => {
    const root = mkdtempSync(join(tmpdir(), "nav-test-"));
    mkdirSync(join(root, "alpha"));
    writeFileSync(join(root, "top.txt"), "x");

    fake = installFakePick([
      eventStep("up", null, "fi"),
      resultStep("cancel", null),
    ]);

    await withRealStdoutRestore(() => navigate([join(root, "alpha")], baseDeps()));

    const updates = fake.calls[0]!.updates;
    const upUpdate = updates.find((u) => u.rows?.some((r) => r.value === "f:top.txt"));
    expect(upUpdate).toBeDefined();
    expect(upUpdate!.resetQuery).toBe(true);
    expect(upUpdate!.breadcrumb).toEqual([root]);

    rmSync(root, { recursive: true, force: true });
  });
});

describe("rt nav: hidden files default + ctrl-t toggle", () => {
  test("dotfiles show on the initial listing (the pre-cutover default)", async () => {
    const root = mkdtempSync(join(tmpdir(), "nav-test-"));
    writeFileSync(join(root, ".env"), "x");
    writeFileSync(join(root, "visible.txt"), "x");

    fake = installFakePick([resultStep("cancel", null)]);

    await withRealStdoutRestore(() => navigate([root], baseDeps()));

    const initialRows = fake.calls[0]!.request.rows;
    expect(initialRows.some((r: PickRow) => r.value === "f:.env")).toBe(true);
    expect(initialRows.some((r: PickRow) => r.value === "f:visible.txt")).toBe(true);
    const initialToggle = fake.calls[0]!.request.actions!.find((a) => a.id === "toggle-hidden")!;
    expect(initialToggle.label).toBe("hide hidden");
    // Filtering sees the bare filename: not the "f:" routing prefix, not a glyph.
    const visible = initialRows.find((r: PickRow) => r.value === "f:visible.txt")!;
    expect(visible.match).toBe("visible.txt");

    rmSync(root, { recursive: true, force: true });
  });

  test("ctrl-t flips rows and the action label in the same update", async () => {
    const root = mkdtempSync(join(tmpdir(), "nav-test-"));
    writeFileSync(join(root, ".env"), "x");
    writeFileSync(join(root, "visible.txt"), "x");

    fake = installFakePick([
      eventStep("toggle-hidden", null),
      resultStep("cancel", null),
    ]);

    await withRealStdoutRestore(() => navigate([root], baseDeps()));

    const updates = fake.calls[0]!.updates;
    const toggle = updates.find((u) => u.actions?.some((a) => a.id === "toggle-hidden"));
    expect(toggle).toBeDefined();
    // Starting shown, one ctrl-t press hides dotfiles and the label flips.
    expect(toggle!.rows?.some((r: PickRow) => r.value === "f:.env")).toBe(false);
    const toggleAction = toggle!.actions!.find((a) => a.id === "toggle-hidden")!;
    expect(toggleAction.label).toBe("show hidden");

    rmSync(root, { recursive: true, force: true });
  });
});

describe("rt nav: esc/cancel is silent", () => {
  test("esc at the top level prints nothing on stderr, even when it's a TTY", async () => {
    const root = mkdtempSync(join(tmpdir(), "nav-test-"));
    writeFileSync(join(root, "a.txt"), "x");
    fake = installFakePick([resultStep("cancel", null)]);

    const isTTYDescriptor = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");
    Object.defineProperty(process.stderr, "isTTY", { value: true, configurable: true });
    const stderrSpy = spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await withRealStdoutRestore(() => navigate([root], baseDeps()));
      expect(stderrSpy.mock.calls.flat().join("")).toBe("");
    } finally {
      stderrSpy.mockRestore();
      if (isTTYDescriptor) Object.defineProperty(process.stderr, "isTTY", isTTYDescriptor);
      else delete (process.stderr as { isTTY?: boolean }).isTTY;
    }

    rmSync(root, { recursive: true, force: true });
  });

  test("a deliberate quit (open terminal here) prints nothing either", async () => {
    const root = mkdtempSync(join(tmpdir(), "nav-test-"));
    mkdirSync(join(root, "sub"));
    fake = installFakePick([resultStep("terminal", "d:sub", "")]);

    const isTTYDescriptor = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");
    Object.defineProperty(process.stderr, "isTTY", { value: true, configurable: true });
    const stderrSpy = spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await withRealStdoutRestore(() => navigate([root], baseDeps()));
      expect(stderrSpy.mock.calls.flat().join("")).toBe("");
    } finally {
      stderrSpy.mockRestore();
      if (isTTYDescriptor) Object.defineProperty(process.stderr, "isTTY", isTTYDescriptor);
      else delete (process.stderr as { isTTY?: boolean }).isTTY;
    }

    rmSync(root, { recursive: true, force: true });
  });
});

describe("rt nav: ctrl-s sort", () => {
  test("opens the sort modal and pushes the sort suffix in the header message", async () => {
    const root = mkdtempSync(join(tmpdir(), "nav-test-"));
    writeFileSync(join(root, "a.txt"), "x");

    // installFakePick's single linear script can't express "the event handler
    // itself awaits a modal answer that a later script step would provide" --
    // the script's own for-loop is what's supposed to deliver that later
    // step, so it deadlocks waiting on itself. modal() here resolves
    // immediately instead, decoupling it from any step ordering.
    const modalCalls: Array<{ message: string; rows: PickRow[] }> = [];
    const updates: Array<{ rows?: PickRow[]; message?: string; actions?: unknown }> = [];
    let resolveResult!: (r: PickResult) => void;
    const result = new Promise<PickResult>((res) => { resolveResult = res; });

    const impl: PickImpl = (_req, cb) => {
      queueMicrotask(async () => {
        await cb.onEvent?.({ t: "event", action: "sort", value: null, query: "" });
        resolveResult({ t: "result", action: "cancel", value: null, query: "" });
      });
      return {
        update(patch) { updates.push(patch); },
        modal(message, rows) {
          modalCalls.push({ message, rows });
          return Promise.resolve("size");
        },
        result,
      } satisfies PickHandle;
    };

    pickTest.setImpl(impl);
    try {
      await withRealStdoutRestore(() => navigate([root], baseDeps()));
    } finally {
      pickTest.setImpl(undefined);
    }

    expect(modalCalls.length).toBe(1);
    expect(modalCalls[0]!.message).toBe("Sort by");

    const withSuffix = updates.find((u) => u.message?.includes("Size, largest first"));
    expect(withSuffix).toBeDefined();

    rmSync(root, { recursive: true, force: true });
  });
});

describe("rt nav: header idle count + faint sort suffix", () => {
  test("supplies the folders/files idle count on the initial request, and a faint sort suffix on the sort update", async () => {
    const root = mkdtempSync(join(tmpdir(), "nav-test-"));
    mkdirSync(join(root, "alpha"));
    mkdirSync(join(root, "beta"));
    writeFileSync(join(root, "notes.txt"), "x");

    const updates: Array<{ idleCount?: string; crumbSuffix?: string }> = [];
    let requestIdleCount: string | undefined;
    let requestCrumbSuffix: string | undefined;
    let resolveResult!: (r: PickResult) => void;
    const result = new Promise<PickResult>((res) => { resolveResult = res; });

    const impl: PickImpl = (req, cb) => {
      requestIdleCount = (req as PickRequest).idleCount;
      requestCrumbSuffix = (req as PickRequest).crumbSuffix;
      queueMicrotask(async () => {
        await cb.onEvent?.({ t: "event", action: "sort", value: null, query: "" });
        resolveResult({ t: "result", action: "cancel", value: null, query: "" });
      });
      return {
        update(patch) { updates.push(patch); },
        modal() { return Promise.resolve("size"); },
        result,
      } satisfies PickHandle;
    };

    pickTest.setImpl(impl);
    try {
      await withRealStdoutRestore(() => navigate([root], baseDeps()));
    } finally {
      pickTest.setImpl(undefined);
    }

    // Initial open: 2 folders, 1 file, default Name sort.
    expect(requestIdleCount).toBe("2 folders · 1 file");
    expect(requestCrumbSuffix).toBeUndefined();

    // The sort-to-Size update carries the faint suffix and keeps the count.
    const sorted = updates.find((u) => u.crumbSuffix !== undefined);
    expect(sorted).toBeDefined();
    expect(sorted!.crumbSuffix).toBe(" (Size, largest first)");
    expect(sorted!.idleCount).toBe("2 folders · 1 file");

    rmSync(root, { recursive: true, force: true });
  });
});

describe("rt nav: live-refresh watcher", () => {
  test("a debounced directory change pushes a rows update", async () => {
    const root = mkdtempSync(join(tmpdir(), "nav-test-"));
    writeFileSync(join(root, "a.txt"), "x");

    fake = installFakePick([resultStep("cancel", null)]);
    const watch = fakeStartDirWatch();

    const navPromise = withRealStdoutRestore(() =>
      navigate([root], baseDeps({ startDirWatch: watch.fn })),
    );

    // Synchronous: runs before any microtask, including the fake pick
    // script's own async processing, so this always lands mid-session.
    watch.trigger();

    await navPromise;

    expect(fake.calls[0]!.updates.length).toBeGreaterThanOrEqual(1);

    rmSync(root, { recursive: true, force: true });
  });
});

describe("rt nav: exits print the path on real stdout", () => {
  test("ctrl-h (cd here)", async () => {
    const root = mkdtempSync(join(tmpdir(), "nav-test-"));
    writeFileSync(join(root, "a.txt"), "x");
    fake = installFakePick([resultStep("cd-here", null)]);

    const writes: string[] = [];
    const orig = process.stdout.write;
    process.stdout.write = ((chunk: string) => { writes.push(String(chunk)); return true; }) as typeof process.stdout.write;

    try {
      await navigate([root], baseDeps());
    } finally {
      process.stdout.write = orig;
    }

    expect(writes).toContain(root + "\n");
    rmSync(root, { recursive: true, force: true });
  });

  test("ctrl-space (cd selected) on a folder", async () => {
    const root = mkdtempSync(join(tmpdir(), "nav-test-"));
    mkdirSync(join(root, "sub"));
    fake = installFakePick([resultStep("cd-selected", "d:sub")]);

    const writes: string[] = [];
    const orig = process.stdout.write;
    process.stdout.write = ((chunk: string) => { writes.push(String(chunk)); return true; }) as typeof process.stdout.write;

    try {
      await navigate([root], baseDeps());
    } finally {
      process.stdout.write = orig;
    }

    expect(writes).toContain(join(root, "sub") + "\n");
    rmSync(root, { recursive: true, force: true });
  });

  test("terminal fired with nothing under the cursor quits silently (no shell spawned)", async () => {
    const root = mkdtempSync(join(tmpdir(), "nav-test-"));
    fake = installFakePick([resultStep("terminal", null, "")]);
    const spawn = fakeSpawnSync();

    const isTTYDescriptor = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");
    Object.defineProperty(process.stderr, "isTTY", { value: true, configurable: true });
    const stderrSpy = spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await withRealStdoutRestore(() => navigate([root], baseDeps({ spawnSync: spawn.fn })));
      expect(stderrSpy.mock.calls.flat().join("")).toBe("");
      expect(spawn.calls).toHaveLength(0);
    } finally {
      stderrSpy.mockRestore();
      if (isTTYDescriptor) Object.defineProperty(process.stderr, "isTTY", isTTYDescriptor);
      else delete (process.stderr as { isTTY?: boolean }).isTTY;
    }

    rmSync(root, { recursive: true, force: true });
  });

  test("open-with fired with nothing under the cursor quits silently", async () => {
    const root = mkdtempSync(join(tmpdir(), "nav-test-"));
    fake = installFakePick([resultStep("open-with", null, "")]);

    const isTTYDescriptor = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");
    Object.defineProperty(process.stderr, "isTTY", { value: true, configurable: true });
    const stderrSpy = spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await withRealStdoutRestore(() => navigate([root], baseDeps()));
      expect(stderrSpy.mock.calls.flat().join("")).toBe("");
    } finally {
      stderrSpy.mockRestore();
      if (isTTYDescriptor) Object.defineProperty(process.stderr, "isTTY", isTTYDescriptor);
      else delete (process.stderr as { isTTY?: boolean }).isTTY;
    }

    rmSync(root, { recursive: true, force: true });
  });

  test("open-with cancelled at the app sub-picker resumes nav silently (no exit)", async () => {
    const root = mkdtempSync(join(tmpdir(), "nav-test-"));
    writeFileSync(join(root, "notes.txt"), "x");

    const seq = installSequentialFakePick([
      [resultStep("open-with", "f:notes.txt", "")],
      [resultStep("cancel", null)], // pickOpenWith's own app picker
      [resultStep("cancel", null)], // resumed nav session -- ends the test
    ]);

    const isTTYDescriptor = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");
    Object.defineProperty(process.stderr, "isTTY", { value: true, configurable: true });
    const stderrSpy = spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      await withRealStdoutRestore(() => navigate([root], baseDeps()));
      expect(seq.calls.length).toBe(3);
      expect(seq.calls[2]!.request.resumeValue).toBe("f:notes.txt");
      expect(stderrSpy.mock.calls.flat().join("")).toBe("");
    } finally {
      stderrSpy.mockRestore();
      if (isTTYDescriptor) Object.defineProperty(process.stderr, "isTTY", isTTYDescriptor);
      else delete (process.stderr as { isTTY?: boolean }).isTTY;
      seq.restore();
    }

    rmSync(root, { recursive: true, force: true });
  });
});

describe("rt nav: terminal-owning exits re-invoke with resume", () => {
  test("Quick Look closes the session, then a fresh one opens with resumeValue/initialQuery", async () => {
    const root = mkdtempSync(join(tmpdir(), "nav-test-"));
    writeFileSync(join(root, "notes.txt"), "x");

    const seq = installSequentialFakePick([
      [resultStep("quicklook", "f:notes.txt", "not")],
      [resultStep("cancel", null)],
    ]);

    await withRealStdoutRestore(() => navigate([root], baseDeps()));

    expect(seq.calls.length).toBe(2);
    expect(seq.calls[1]!.request.resumeValue).toBe("f:notes.txt");
    expect(seq.calls[1]!.request.initialQuery).toBe("not");

    seq.restore();
    rmSync(root, { recursive: true, force: true });
  });

  test("open terminal here fully exits: no resume, no second runPick call", async () => {
    const root = mkdtempSync(join(tmpdir(), "nav-test-"));
    mkdirSync(join(root, "sub"));

    const seq = installSequentialFakePick([
      [resultStep("terminal", "d:sub", "")],
    ]);
    const spawn = fakeSpawnSync();

    await withRealStdoutRestore(() => navigate([root], baseDeps({ spawnSync: spawn.fn })));

    expect(seq.calls.length).toBe(1);
    expect(spawn.calls.some((c) => c.opts && (c.opts as { cwd?: string }).cwd === join(root, "sub"))).toBe(true);

    seq.restore();
    rmSync(root, { recursive: true, force: true });
  });

  test("nav binds no ctrl-/ action: the ctrl-k menu is the discovery door", async () => {
    const root = mkdtempSync(join(tmpdir(), "nav-test-"));
    mkdirSync(join(root, "sub"));
    writeFileSync(join(root, "a.txt"), "x");

    fake = installFakePick([resultStep("cancel", null)]);

    await withRealStdoutRestore(() => navigate([root], baseDeps()));

    const actions = fake.calls[0]!.request.actions ?? [];
    expect(actions.find((a) => a.key === "ctrl-/")).toBeUndefined();
    expect(actions.find((a) => a.id === "expand")).toBeUndefined();

    rmSync(root, { recursive: true, force: true });
  });
});
