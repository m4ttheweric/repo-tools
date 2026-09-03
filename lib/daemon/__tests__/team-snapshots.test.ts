import { describe, test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { startTeamSnapshots } from "../team-snapshots.ts";
import type { SnapshotSpec } from "../home-snapshot.ts";
import { fakeProbes } from "../../setup/__tests__/fakes.ts";

function fakeLog() {
  const calls: { level: string; args: unknown[] }[] = [];
  const mk = (level: string) => (...args: unknown[]) => { calls.push({ level, args }); };
  return { calls, info: mk("info"), warn: mk("warn"), error: mk("error"), debug: mk("debug"), child: () => fakeLog() } as unknown as import("pino").Logger & { calls: typeof calls };
}

function clone(root: string, slug: string, withOrigin = true): string {
  const dir = join(root, slug);
  mkdirSync(join(dir, ".git"), { recursive: true });
  writeFileSync(join(dir, ".git", "config"), withOrigin ? `[remote "origin"]\n\turl = https://gitlab.com/acme/${slug}.git\n` : "");
  return dir;
}

/** One macrotask: the supervisor's rescans are `void`ed, so an assertion right after `emit`/`fireInterval` would race the promise chain that re-arms the next timer. */
const flush = () => new Promise<void>((resolve) => { globalThis.setTimeout(resolve, 0); });

const warned = (log: ReturnType<typeof fakeLog>, needle: string): boolean =>
  log.calls.some((c) => c.level === "warn" && JSON.stringify(c.args).includes(needle));

function harness() {
  const root = mkdtempSync(join(tmpdir(), "rt-team-snapshots-"));
  const started: { spec: SnapshotSpec; stopped: boolean }[] = [];
  const watchCalls: { path: string; options: { recursive: boolean } }[] = [];
  // Timers under 10s (the watch debounce) fire inline; anything longer is the
  // interval rescan, parked here so a test drives it via fireInterval().
  const pending: { cb: () => void; ms: number; id: number }[] = [];
  let nextTimerId = 1;
  let listener: ((ev: string, f: string | null) => void) | null = null;
  let watchThrows = false;
  const settings = { enabled: true, debounceSec: 20, pushDelaySec: 60, janitorThresholdHours: 6, janitorIntervalMin: 30, pullIntervalSec: 300 };
  const log = fakeLog();
  const deps = {
    log,
    broadcast: () => {},
    teamsDir: root,
    probes: fakeProbes({ home: root }),
    readSettings: () => ({ ...settings }),
    start: ((spec: SnapshotSpec) => {
      const entry = { spec, stopped: false };
      started.push(entry);
      return {
        stop: () => { entry.stopped = true; },
        runNow: async () => ({ committed: false, sha: null, paths: [], reason: "manual" as const }),
        pullNow: async () => ({ outcome: "up-to-date" as const, detail: null }),
        status: () => ({ id: spec.id, repoDir: spec.repoDir }),
        ready: Promise.resolve(),
      };
    }) as unknown as typeof import("../home-snapshot.ts").startSnapshot,
    watch: (path: string, options: { recursive: boolean }, l: (ev: string, f: string | null) => void) => {
      watchCalls.push({ path, options });
      if (watchThrows) throw new Error("ENOSPC: watch limit reached");
      listener = l;
      return { close() {} };
    },
    setTimeout: (cb: () => void, ms: number) => {
      const id = nextTimerId++;
      if (ms < 10_000) cb();
      else pending.push({ cb, ms, id });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout: (h: ReturnType<typeof setTimeout>) => {
      const i = pending.findIndex((t) => t.id === (h as unknown as number));
      if (i >= 0) pending.splice(i, 1);
    },
  };
  return {
    root, started, deps, log, settings, watchCalls, pending,
    breakWatch: () => { watchThrows = true; },
    emit: (f: string) => listener?.("rename", f),
    watchArmed: () => listener !== null,
    fireInterval: () => {
      const timer = pending.shift();
      if (!timer) throw new Error("no interval rescan is armed");
      timer.cb();
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe("startTeamSnapshots", () => {
  test("boot starts one instance per clone with an origin and skips one without", async () => {
    const h = harness();
    clone(h.root, "acme"); clone(h.root, "no-remote", false);
    const handle = startTeamSnapshots(h.deps);
    await handle.ready;
    expect(h.started.map((s) => s.spec.id)).toEqual(["team:acme"]);
    expect(warned(h.log, "no-remote")).toBe(true);
    handle.stop();
    expect(h.started[0]!.stopped).toBe(true);
    h.cleanup();
  });

  test("the teams/ watch is armed non-recursively, and a clone that appears fires a rescan on its own", async () => {
    const h = harness();
    const handle = startTeamSnapshots(h.deps);
    await handle.ready;
    expect(h.watchCalls).toEqual([{ path: h.root, options: { recursive: false } }]);
    expect(h.started).toHaveLength(0);

    const dir = clone(h.root, "late");
    h.emit("late");
    await flush();
    expect(h.started.map((s) => s.spec.id)).toEqual(["team:late"]);

    rmSync(dir, { recursive: true, force: true });
    h.emit("late");
    await flush();
    expect(h.started[0]!.stopped).toBe(true);
    handle.stop();
    h.cleanup();
  });

  test("a teams/ watch that cannot be armed warns and leaves the interval rescan as the only discovery path", async () => {
    const h = harness();
    h.breakWatch();
    clone(h.root, "acme");
    const handle = startTeamSnapshots(h.deps);
    await handle.ready;
    expect(h.started.map((s) => s.spec.id)).toEqual(["team:acme"]);
    expect(h.watchArmed()).toBe(false);
    expect(warned(h.log, "cannot watch")).toBe(true);
    expect(h.pending.map((t) => t.ms)).toEqual([300_000]);
    handle.stop();
    h.cleanup();
  });

  test("status lists every instance by slug and pullNow routes to it; an unknown slug is refused", async () => {
    const h = harness();
    clone(h.root, "acme");
    const handle = startTeamSnapshots(h.deps);
    await handle.ready;
    expect(handle.status().map((s) => s.slug)).toEqual(["acme"]);
    expect((await handle.pullNow("acme")).outcome).toBe("up-to-date");
    await expect(handle.pullNow("nope")).rejects.toThrow(/not cloned/);
    handle.stop();
    h.cleanup();
  });

  test("a clone whose origin arrives later (team publish --remote) starts on the interval rescan", async () => {
    const h = harness();
    const dir = clone(h.root, "late-origin", false);
    const handle = startTeamSnapshots(h.deps);
    await handle.ready;
    expect(h.started).toHaveLength(0);

    // The origin lands inside the clone's .git/config, which the non-recursive
    // teams/ watch never sees — only the interval rescan can find it.
    writeFileSync(join(dir, ".git", "config"), `[remote "origin"]\n\turl = https://gitlab.com/acme/late-origin.git\n`);
    h.fireInterval();
    await flush();
    expect(h.started.map((s) => s.spec.id)).toEqual(["team:late-origin"]);
    handle.stop();
    h.cleanup();
  });

  test("an interval rescan that throws warns once, re-arms, and the next one still discovers", async () => {
    const h = harness();
    const handle = startTeamSnapshots(h.deps);
    await handle.ready;
    expect(h.pending).toHaveLength(1);

    // teams/ replaced by a regular file: existsSync still passes, readdirSync throws ENOTDIR.
    rmSync(h.root, { recursive: true, force: true });
    writeFileSync(h.root, "not a directory");
    h.fireInterval();
    await flush();
    expect(warned(h.log, "could not scan")).toBe(true);
    expect(h.pending).toHaveLength(1);

    rmSync(h.root, { force: true });
    mkdirSync(h.root, { recursive: true });
    clone(h.root, "acme");
    h.fireInterval();
    await flush();
    expect(h.started.map((s) => s.spec.id)).toEqual(["team:acme"]);
    handle.stop();
    h.cleanup();
  });

  test("a teams/ that cannot be read at boot resolves ready and stays inert, never rejecting into the daemon's boot window", async () => {
    const h = harness();
    const notADir = join(h.root, "teams-as-a-file");
    writeFileSync(notADir, "not a directory");
    const rejections: unknown[] = [];
    const onRejection = (err: unknown) => rejections.push(err);
    process.on("unhandledRejection", onRejection);
    try {
      const handle = startTeamSnapshots({ ...h.deps, teamsDir: notADir });
      await handle.ready;
      await flush();
      expect(handle.status()).toEqual([]);
      expect(warned(h.log, "could not scan")).toBe(true);
      expect(rejections).toEqual([]);
      handle.stop();
    } finally {
      process.off("unhandledRejection", onRejection);
    }
    h.cleanup();
  });

  test("disabled: no instances, status empty, rescan stays inert", async () => {
    const h = harness();
    h.settings.enabled = false;
    clone(h.root, "acme");
    const handle = startTeamSnapshots(h.deps);
    await handle.ready;
    expect(h.started).toHaveLength(0);
    expect(handle.status()).toEqual([]);
    await handle.rescan();
    expect(h.started).toHaveLength(0);
    handle.stop();
    h.cleanup();
  });

  test("a supervisor that booted disabled still discovers once the setting is flipped back on", async () => {
    const h = harness();
    h.settings.enabled = false;
    clone(h.root, "acme");
    const handle = startTeamSnapshots(h.deps);
    await handle.ready;
    expect(h.started).toHaveLength(0);
    // Both discovery paths are armed while disabled, so no daemon restart is needed.
    expect(h.watchArmed()).toBe(true);
    expect(h.pending).toHaveLength(1);

    h.settings.enabled = true;
    h.emit("acme");
    await flush();
    expect(h.started.map((s) => s.spec.id)).toEqual(["team:acme"]);
    handle.stop();
    h.cleanup();
  });

  test("disabling after boot stops and drops every running instance", async () => {
    const h = harness();
    clone(h.root, "acme");
    const handle = startTeamSnapshots(h.deps);
    await handle.ready;
    expect(h.started).toHaveLength(1);

    h.settings.enabled = false;
    await handle.rescan();
    expect(h.started[0]!.stopped).toBe(true);
    expect(handle.status()).toEqual([]);
    handle.stop();
    h.cleanup();
  });

  for (const [label, bad] of [["NaN", NaN], ["a string", "abc"], ["null", null]] as const) {
    test(`a pullIntervalSec of ${label} falls back to the registry default instead of a NaN timer`, async () => {
      const h = harness();
      h.settings.pullIntervalSec = bad as unknown as number;
      clone(h.root, "acme");
      const handle = startTeamSnapshots(h.deps);
      await handle.ready;
      expect(h.started[0]!.spec.pull?.intervalSec).toBe(300);
      expect(h.pending.map((t) => t.ms)).toEqual([300_000]);
      handle.stop();
      h.cleanup();
    });
  }

  test("a pullIntervalSec below the floor is clamped to 30s on both the spec and the rescan timer", async () => {
    const h = harness();
    h.settings.pullIntervalSec = 5;
    clone(h.root, "acme");
    const handle = startTeamSnapshots(h.deps);
    await handle.ready;
    expect(h.started[0]!.spec.pull?.intervalSec).toBe(30);
    expect(h.pending.map((t) => t.ms)).toEqual([30_000]);
    handle.stop();
    h.cleanup();
  });
});
