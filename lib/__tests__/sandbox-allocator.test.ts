import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  allocatePorts,
  createForwardSet,
  createSandboxSync,
  foldBearer,
  removeStateEntry,
  statePortsInUse,
  upsertStateEntry,
  type ForwardSpawn,
} from "../sandbox-allocator.ts";
import {
  readSandboxAnchor,
  writeSandboxAnchor,
  type SandboxClient,
  type SandboxDetail,
  type SandboxEvent,
  type SandboxProcess,
} from "../sandbox.ts";
import { sandboxAnchorDir } from "../rt-paths.ts";

const ORIG_HOME = process.env.HOME;
afterEach(() => { process.env.HOME = ORIG_HOME; });

const PROCESSES: SandboxProcess[] = [
  { name: "adjuster", port: 4001, localPorts: [4001, 5001, 6001] },
  { name: "backend", port: 4000, localPorts: [10400, 10401] },
];

// ─── allocatePorts ───────────────────────────────────────────────────────────

describe("allocatePorts", () => {
  test("picks the first free candidate per process", () => {
    const out = allocatePorts(PROCESSES, []);
    expect(out).toEqual({ ok: true, ports: { adjuster: 4001, backend: 10400 }, exhausted: [] });
  });

  test("skips taken ports (the pool is shared with local worktrees)", () => {
    const out = allocatePorts(PROCESSES, [4001, 10400]);
    expect(out).toEqual({ ok: true, ports: { adjuster: 5001, backend: 10401 }, exhausted: [] });
  });

  test("reuses the preferred previous allocation when still free", () => {
    const out = allocatePorts(PROCESSES, [], { adjuster: 6001, backend: 10401 });
    expect(out.ports).toEqual({ adjuster: 6001, backend: 10401 });
  });

  test("falls back to the pool when the preferred port is taken", () => {
    const out = allocatePorts(PROCESSES, [6001], { adjuster: 6001 });
    expect(out.ports.adjuster).toBe(4001);
  });

  test("pool exhaustion names the process and is not ok", () => {
    const out = allocatePorts(PROCESSES, [4001, 5001, 6001]);
    expect(out.ok).toBe(false);
    expect(out.exhausted).toEqual(["adjuster"]);
    expect(out.ports.backend).toBe(10400);
  });

  test("two processes never share one local port even with overlapping pools", () => {
    const overlapping: SandboxProcess[] = [
      { name: "a", port: 1, localPorts: [7001, 7002] },
      { name: "b", port: 2, localPorts: [7001, 7002] },
    ];
    const out = allocatePorts(overlapping, []);
    expect(out.ports).toEqual({ a: 7001, b: 7002 });
  });
});

// ─── Forward set ─────────────────────────────────────────────────────────────

describe("createForwardSet", () => {
  function recordingSpawn() {
    const spawned: Array<{ argv: string[]; killed: boolean }> = [];
    const spawn: ForwardSpawn = (argv) => {
      const entry = { argv, killed: false };
      spawned.push(entry);
      return { kill: () => { entry.killed = true; } };
    };
    return { spawn, spawned };
  }

  const MAPPING = { adjuster: { local: 5001, pod: 4001 }, backend: { local: 10401, pod: 4000 } };

  test("ensure spawns one kubectl port-forward per sandbox with all port pairs", () => {
    const { spawn, spawned } = recordingSpawn();
    const set = createForwardSet(spawn);
    set.ensure("sb-1", "sb-1", MAPPING);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.argv).toEqual([
      "kubectl", "-n", "mc-sandboxes", "port-forward", "pod/sb-1", "5001:4001", "10401:4000",
    ]);
  });

  test("ensure is idempotent for an unchanged mapping and respawns on change", () => {
    const { spawn, spawned } = recordingSpawn();
    const set = createForwardSet(spawn);
    set.ensure("sb-1", "sb-1", MAPPING);
    set.ensure("sb-1", "sb-1", MAPPING);
    expect(spawned).toHaveLength(1);
    set.ensure("sb-1", "sb-1", { adjuster: { local: 6001, pod: 4001 } });
    expect(spawned).toHaveLength(2);
    expect(spawned[0]!.killed).toBe(true);
  });

  test("stop kills the forward and clears active; activeLocals excludes a sandbox", () => {
    const { spawn, spawned } = recordingSpawn();
    const set = createForwardSet(spawn);
    set.ensure("sb-1", "sb-1", MAPPING);
    expect(set.active("sb-1")).toEqual(MAPPING);
    expect(set.activeLocals("sb-1")).toEqual([]);
    expect(set.activeLocals()).toEqual([5001, 10401]);
    set.stop("sb-1");
    expect(spawned[0]!.killed).toBe(true);
    expect(set.active("sb-1")).toBeNull();
    set.stop("sb-1"); // idempotent
  });
});

// ─── State-file mirroring ────────────────────────────────────────────────────

describe("state mirroring", () => {
  test("upsert writes a dev-ports-shaped entry: ports + ts, nothing else (byte-compat, pids omitted)", () => {
    const dir = mkdtempSync(join(tmpdir(), "sbx-state-"));
    const file = join(dir, "state.json");
    upsertStateEntry(file, "/anchor/sb-1", { adjuster: 5001, backend: 10401 });
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    const entry = parsed["/anchor/sb-1"];
    // The consumer contract fixture: a real local entry is
    // { adjuster, backend, ts, backendPid, adjusterPid, bearer, bearerTs, bearerExp };
    // a sandbox entry carries the same shape with pids omitted.
    expect(Object.keys(entry).sort()).toEqual(["adjuster", "backend", "ts"]);
    expect(entry.adjuster).toBe(5001);
    expect(entry.backend).toBe(10401);
    expect(typeof entry.ts).toBe("string");
    expect(Number.isNaN(Date.parse(entry.ts))).toBe(false);
  });

  test("upsert preserves other entries and an existing bearer on re-upsert", () => {
    const dir = mkdtempSync(join(tmpdir(), "sbx-state-"));
    const file = join(dir, "state.json");
    writeFileSync(file, JSON.stringify({
      "/wt/other": { adjuster: 4001, backend: 10400, ts: "t", backendPid: 1, adjusterPid: 2 },
    }));
    upsertStateEntry(file, "/anchor/sb-1", { adjuster: 5001 });
    foldBearer(file, "/anchor/sb-1", { bearer: "Bearer x", bearerTs: "t1", bearerExp: "t2" });
    upsertStateEntry(file, "/anchor/sb-1", { adjuster: 5001 });
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    expect(parsed["/wt/other"].backendPid).toBe(1);
    expect(parsed["/anchor/sb-1"]).toMatchObject({
      adjuster: 5001, bearer: "Bearer x", bearerTs: "t1", bearerExp: "t2",
    });
  });

  test("foldBearer creates the entry when mirroring raced it", () => {
    const dir = mkdtempSync(join(tmpdir(), "sbx-state-"));
    const file = join(dir, "state.json");
    foldBearer(file, "/anchor/sb-1", { bearer: "Bearer x" });
    expect(JSON.parse(readFileSync(file, "utf8"))["/anchor/sb-1"].bearer).toBe("Bearer x");
  });

  test("remove deletes only the given entry; statePortsInUse counts port fields only", () => {
    const dir = mkdtempSync(join(tmpdir(), "sbx-state-"));
    const file = join(dir, "state.json");
    writeFileSync(file, JSON.stringify({
      "/wt/a": { adjuster: 4001, backend: 10400, ts: "t", backendPid: 999, adjusterPid: 888 },
      "/anchor/sb-1": { adjuster: 5001, backend: 10401, ts: "t" },
    }));
    expect(statePortsInUse(file, ["adjuster", "backend"]).sort()).toEqual([10400, 10401, 4001, 5001].sort());
    expect(statePortsInUse(file, ["adjuster", "backend"], "/anchor/sb-1").sort()).toEqual([10400, 4001].sort());
    removeStateEntry(file, "/anchor/sb-1");
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    expect(Object.keys(parsed)).toEqual(["/wt/a"]);
    expect(statePortsInUse(join(dir, "missing.json"), ["adjuster"])).toEqual([]);
  });
});

// ─── Daemon sync (ground-truth reconcile + event fan-out) ────────────────────

interface SyncWorld {
  home: string;
  stateFile: string;
  detail: SandboxDetail;
  clientCalls: string[];
  eventsByCall: SandboxEvent[][];
  notifications: Array<{ title: string; category: string }>;
  spawned: Array<{ argv: string[]; killed: boolean }>;
  sync: { syncOnce(): Promise<void> };
  reachable: boolean;
}

function makeSyncWorld(): SyncWorld {
  const home = mkdtempSync(join(tmpdir(), "sbx-sync-home-"));
  process.env.HOME = home;
  const repoDir = join(home, ".rt", "repos", "acme-dev");
  mkdirSync(repoDir, { recursive: true });
  writeFileSync(join(repoDir, "config.json"), JSON.stringify({
    sandbox: {
      processes: [
        { name: "adjuster", port: 4001, localPorts: [4001, 5001, 6001] },
        { name: "backend", port: 4000, localPorts: [10400, 10401] },
      ],
      stateFile: "~/.acme/dev-ports.state.json",
    },
  }));
  const stateFile = join(home, ".acme", "dev-ports.state.json");
  mkdirSync(join(home, ".acme"), { recursive: true });
  // A local worktree already holds 4001/10400 — the pool is shared.
  writeFileSync(stateFile, JSON.stringify({
    "/wt/local": { adjuster: 4001, backend: 10400, ts: "t", backendPid: 1, adjusterPid: 2 },
  }));

  const world: SyncWorld = {
    home,
    stateFile,
    detail: {
      id: "sb-1", repoId: "acme-dev", branch: "cv-1-fix", imageTag: "img",
      state: "running", createdAt: "2026-08-07T00:00:00.000Z",
      ports: { adjuster: 4001, backend: 4000 }, lastEventSeq: 0,
      podPhase: "Running",
    },
    clientCalls: [],
    eventsByCall: [],
    notifications: [],
    spawned: [],
    sync: null as unknown as SyncWorld["sync"],
    reachable: true,
  };

  const client: SandboxClient = {
    async create() { throw new Error("unused"); },
    async list() {
      world.clientCalls.push("list");
      return world.detail.state === "destroyed" && world.detail.id === "gone"
        ? [] : [world.detail];
    },
    async get() { return world.detail; },
    async suspend() {}, async up() {}, async destroy() {},
    async events(id, since) {
      world.clientCalls.push(`events ${id} since=${since}`);
      return world.eventsByCall.shift() ?? [];
    },
    async mailbox() { return []; },
    async postMailbox() {},
    async requestEvidence() { throw new Error("unused"); },
    async listEvidence() { return []; },
    async getEvidence() { return null; },
    async fetchEvidenceArtifact() { return new Uint8Array(); },
    async cancelEvidence() {},
    async ackEvidenceSynced() {},
  };

  const spawn: ForwardSpawn = (argv) => {
    const entry = { argv, killed: false };
    world.spawned.push(entry);
    return { kill: () => { entry.killed = true; } };
  };

  world.sync = createSandboxSync({
    probe: async () => world.reachable,
    client,
    forwards: createForwardSet(spawn),
    notify: (title, _message, category) => world.notifications.push({ title, category }),
  });
  return world;
}

describe("createSandboxSync", () => {
  test("running sandbox: pool allocation avoids worktree ports, forward spawned, state entry mirrored", async () => {
    const world = makeSyncWorld();
    await world.sync.syncOnce();

    expect(world.spawned).toHaveLength(1);
    expect(world.spawned[0]!.argv).toEqual([
      "kubectl", "-n", "mc-sandboxes", "port-forward", "pod/sb-1", "5001:4001", "10401:4000",
    ]);
    const anchorDir = sandboxAnchorDir("acme-dev", "sb-1");
    const state = JSON.parse(readFileSync(world.stateFile, "utf8"));
    expect(Object.keys(state[anchorDir]).sort()).toEqual(["adjuster", "backend", "ts"]);
    expect(state[anchorDir].adjuster).toBe(5001);
    expect(state[anchorDir].backend).toBe(10401);
    const anchor = readSandboxAnchor("acme-dev", "sb-1")!;
    expect(anchor.localPorts).toEqual({ adjuster: 5001, backend: 10401 });
    expect(anchor.branch).toBe("cv-1-fix");
    // Steady state: a second pass changes nothing and spawns nothing new.
    await world.sync.syncOnce();
    expect(world.spawned).toHaveLength(1);
  });

  test("suspend releases: forward killed, state entry removed, allocation kept as resume preference", async () => {
    const world = makeSyncWorld();
    await world.sync.syncOnce();
    world.detail = { ...world.detail, state: "suspended", podPhase: undefined };
    await world.sync.syncOnce();

    expect(world.spawned[0]!.killed).toBe(true);
    const state = JSON.parse(readFileSync(world.stateFile, "utf8"));
    expect(Object.keys(state)).toEqual(["/wt/local"]);
    const anchor = readSandboxAnchor("acme-dev", "sb-1")!;
    expect(anchor.localPorts).toEqual({ adjuster: 5001, backend: 10401 });

    // Resume re-establishes the same allocation when free.
    world.detail = { ...world.detail, state: "running", podPhase: "Running" };
    await world.sync.syncOnce();
    expect(world.spawned).toHaveLength(2);
    expect(world.spawned[1]!.argv).toContain("5001:4001");
  });

  test("destroyed sandbox: forwards, state entry, and anchor all pruned", async () => {
    const world = makeSyncWorld();
    await world.sync.syncOnce();
    world.detail = { ...world.detail, state: "destroyed" };
    await world.sync.syncOnce();

    expect(world.spawned[0]!.killed).toBe(true);
    expect(existsSync(sandboxAnchorDir("acme-dev", "sb-1"))).toBe(false);
    expect(Object.keys(JSON.parse(readFileSync(world.stateFile, "utf8")))).toEqual(["/wt/local"]);
  });

  test("events fan out to notify, bearer folds into the state entry, seq persists across polls", async () => {
    const world = makeSyncWorld();
    world.eventsByCall = [[
      { seq: 1, ts: "t", sandboxId: "sb-1", type: "question", payload: { file: "question.md" } },
      {
        seq: 2, ts: "t", sandboxId: "sb-1", type: "captured",
        payload: { file: "bearer.json", content: JSON.stringify({ bearer: "Bearer z", bearerTs: "t1", bearerExp: "t2" }) },
      },
      { seq: 3, ts: "t", sandboxId: "sb-1", type: "process-dead", payload: { exitCode: 1 } },
    ]];
    await world.sync.syncOnce();

    expect(world.notifications.map(n => n.category)).toEqual([
      "sandbox_question", "sandbox_process_dead",
    ]);
    const state = JSON.parse(readFileSync(world.stateFile, "utf8"));
    const entry = state[sandboxAnchorDir("acme-dev", "sb-1")];
    expect(entry.bearer).toBe("Bearer z");
    expect(entry.bearerTs).toBe("t1");
    expect(entry.bearerExp).toBe("t2");
    expect(readSandboxAnchor("acme-dev", "sb-1")!.lastEventSeq).toBe(3);

    await world.sync.syncOnce();
    expect(world.clientCalls.filter(c => c.startsWith("events"))).toEqual([
      "events sb-1 since=0",
      "events sb-1 since=3",
    ]);
  });

  test("pool exhaustion: loud warning recorded on the anchor, notified once, no forward, no state entry", async () => {
    const world = makeSyncWorld();
    // All adjuster candidates taken by local worktrees.
    writeFileSync(world.stateFile, JSON.stringify({
      "/wt/a": { adjuster: 4001, backend: 1, ts: "t" },
      "/wt/b": { adjuster: 5001, backend: 2, ts: "t" },
      "/wt/c": { adjuster: 6001, backend: 3, ts: "t" },
    }));
    await world.sync.syncOnce();
    await world.sync.syncOnce();

    expect(world.notifications.filter(n => n.category === "sandbox_ports")).toHaveLength(1);
    expect(world.spawned).toHaveLength(0);
    const anchor = readSandboxAnchor("acme-dev", "sb-1")!;
    expect(anchor.allocationError).toContain("adjuster");
    expect(JSON.parse(readFileSync(world.stateFile, "utf8"))[sandboxAnchorDir("acme-dev", "sb-1")]).toBeUndefined();
  });

  test("unreachable controller: syncOnce is a silent no-op", async () => {
    const world = makeSyncWorld();
    world.reachable = false;
    await world.sync.syncOnce();
    expect(world.clientCalls).toEqual([]);
    expect(world.spawned).toHaveLength(0);
  });

  test("an anchor whose sandbox the controller no longer knows is pruned", async () => {
    const world = makeSyncWorld();
    writeSandboxAnchor({
      id: "sb-gone", repoId: "acme-dev", branch: "b", createdAt: "t", lastEventSeq: 0,
    });
    await world.sync.syncOnce();
    expect(existsSync(sandboxAnchorDir("acme-dev", "sb-gone"))).toBe(false);
  });
});
