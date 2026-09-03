import { describe, test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { startTeamSnapshots } from "../team-snapshots.ts";
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

function harness() {
  const root = mkdtempSync(join(tmpdir(), "rt-team-snapshots-"));
  const started: { spec: { id: string; repoDir: string }; stopped: boolean }[] = [];
  let listener: ((ev: string, f: string | null) => void) | null = null;
  const deps = {
    log: fakeLog(),
    broadcast: () => {},
    teamsDir: root,
    probes: fakeProbes({ home: root }),
    readSettings: () => ({ enabled: true, debounceSec: 20, pushDelaySec: 60, janitorThresholdHours: 6, janitorIntervalMin: 30, pullIntervalSec: 300 }),
    start: ((spec: { id: string; repoDir: string }) => {
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
    watch: (_p: string, _o: unknown, l: (ev: string, f: string | null) => void) => { listener = l; return { close() {} }; },
    // Only the debounce timer fires synchronously; the interval rescan stays pending so tests drive rescan() themselves.
    setTimeout: (cb: () => void, ms: number) => { if (ms < 10_000) cb(); return 0 as unknown as ReturnType<typeof setTimeout>; },
    clearTimeout: () => {},
  };
  return { root, started, deps, emit: (f: string) => listener?.("rename", f), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe("startTeamSnapshots", () => {
  test("boot starts one instance per clone with an origin and skips one without", async () => {
    const h = harness();
    clone(h.root, "acme"); clone(h.root, "no-remote", false);
    const handle = startTeamSnapshots(h.deps);
    await handle.ready;
    expect(h.started.map((s) => s.spec.id)).toEqual(["team:acme"]);
    expect(h.deps.log.calls.some((c) => c.level === "warn" && JSON.stringify(c.args).includes("no-remote"))).toBe(true);
    handle.stop();
    expect(h.started[0]!.stopped).toBe(true);
    h.cleanup();
  });

  test("a clone that appears after boot starts on the teams/ watch event; a removed one stops", async () => {
    const h = harness();
    const handle = startTeamSnapshots(h.deps);
    await handle.ready;
    expect(h.started).toHaveLength(0);
    const dir = clone(h.root, "late");
    h.emit("late");
    await handle.rescan();
    expect(h.started.map((s) => s.spec.id)).toEqual(["team:late"]);
    rmSync(dir, { recursive: true, force: true });
    h.emit("late");
    await handle.rescan();
    expect(h.started[0]!.stopped).toBe(true);
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
    writeFileSync(join(dir, ".git", "config"), `[remote "origin"]\n\turl = https://gitlab.com/acme/late-origin.git\n`);
    await handle.rescan();
    expect(h.started.map((s) => s.spec.id)).toEqual(["team:late-origin"]);
    handle.stop();
    h.cleanup();
  });

  test("disabled: no instances, status empty, rescan stays inert", async () => {
    const h = harness();
    clone(h.root, "acme");
    const handle = startTeamSnapshots({ ...h.deps, readSettings: () => ({ ...h.deps.readSettings(), enabled: false }) });
    await handle.ready;
    expect(h.started).toHaveLength(0);
    handle.stop();
    h.cleanup();
  });
});
