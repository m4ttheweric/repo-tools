import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ATTENDED_SSH_LOCAL_PORTS,
  ATTENDED_SSH_PROCESS_NAME,
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
  removeSandboxAnchor,
  writeSandboxAnchor,
  type EvidenceDetail,
  type EvidenceRequestRecord,
  type SandboxClient,
  type SandboxDetail,
  type SandboxEvent,
  type SandboxProcess,
} from "../sandbox.ts";
import { sandboxAnchorDir } from "../rt-paths.ts";
import { createEvidenceLedger } from "../daemon/evidence-ledger.ts";
import type { EvidenceLedger } from "../daemon/evidence-ledger.ts";

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
    const spawned: Array<{ argv: string[]; killed: boolean; dead: boolean }> = [];
    const spawn: ForwardSpawn = (argv) => {
      const entry = { argv, killed: false, dead: false };
      spawned.push(entry);
      return { kill: () => { entry.killed = true; }, alive: () => !entry.killed && !entry.dead };
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

  test("ensure reports its outcome and respawns a forward whose child died", () => {
    const { spawn, spawned } = recordingSpawn();
    const set = createForwardSet(spawn);
    expect(set.ensure("sb-1", "sb-1", MAPPING)).toBe("spawned");
    expect(set.ensure("sb-1", "sb-1", MAPPING)).toBe("kept");
    // The kubectl child died on its own (pod recycle, network blip): the
    // unchanged mapping must NOT read as "kept" — respawn it.
    spawned[0]!.dead = true;
    expect(set.ensure("sb-1", "sb-1", MAPPING)).toBe("respawned");
    expect(spawned).toHaveLength(2);
    expect(spawned[1]!.argv).toEqual(spawned[0]!.argv);
  });

  test("a dead forward is not active and its locals are not held", () => {
    const { spawn, spawned } = recordingSpawn();
    const set = createForwardSet(spawn);
    set.ensure("sb-1", "sb-1", MAPPING);
    spawned[0]!.dead = true;
    expect(set.active("sb-1")).toBeNull();
    expect(set.activeLocals()).toEqual([]);
    expect(set.heldIds()).toEqual([]);
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
  spawned: Array<{ argv: string[]; killed: boolean; dead: boolean }>;
  /** Local ports with a foreign listener (squatter fake for deps.listens). */
  listeners: Set<number>;
  logs: Array<{ obj: Record<string, unknown>; msg: string }>;
  sync: { syncOnce(): Promise<void> };
  reachable: boolean;
  /** When set, the client fake's list() returns this instead of [detail]. */
  listResult: SandboxDetail[] | null;
  /** Set by evidence tests before syncOnce; read by the client fake's getEvidence. */
  evidenceDetail: EvidenceDetail | null;
  /** Controller request list the client fake's listEvidence returns. */
  evidenceRequests: EvidenceRequestRecord[];
  /** When set, the client fake's listEvidence throws with this message. */
  evidenceListError?: string;
  evidenceLedger?: EvidenceLedger;
  evidenceSyncCalls: string[];
}

function makeSyncWorld(opts?: { withEvidence?: boolean }): SyncWorld {
  const home = mkdtempSync(join(tmpdir(), "sbx-sync-home-"));
  process.env.HOME = home;
  const repoDir = join(home, ".rt", "repos", "acme-dev");
  mkdirSync(repoDir, { recursive: true });
  writeFileSync(join(repoDir, "sandbox.jsonc"), JSON.stringify({
    processes: [
      { name: "adjuster", port: 4001, localPorts: [4001, 5001, 6001] },
      { name: "backend", port: 4000, localPorts: [10400, 10401] },
    ],
    stateFile: "~/.acme/dev-ports.state.json",
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
    listeners: new Set(),
    logs: [],
    sync: null as unknown as SyncWorld["sync"],
    reachable: true,
    listResult: null,
    evidenceDetail: null,
    evidenceRequests: [],
    evidenceSyncCalls: [],
  };

  const client: SandboxClient = {
    async create() { throw new Error("unused"); },
    async list() {
      world.clientCalls.push("list");
      return world.listResult ?? [world.detail];
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
    async listEvidence(sandboxId) {
      world.clientCalls.push(`listEvidence ${sandboxId}`);
      if (world.evidenceListError) throw new Error(world.evidenceListError);
      return world.evidenceRequests;
    },
    async getEvidence(requestId) {
      world.clientCalls.push(`getEvidence ${requestId}`);
      return world.evidenceDetail;
    },
    async fetchEvidenceArtifact() { return new Uint8Array(); },
    async cancelEvidence() {},
    async ackEvidenceSynced() {},
  };

  const spawn: ForwardSpawn = (argv) => {
    const entry = { argv, killed: false, dead: false };
    world.spawned.push(entry);
    return { kill: () => { entry.killed = true; }, alive: () => !entry.killed && !entry.dead };
  };

  if (opts?.withEvidence) {
    world.evidenceLedger = createEvidenceLedger(join(mkdtempSync(join(tmpdir(), "rt-evl-")), "l.json"));
  }

  world.sync = createSandboxSync({
    probe: async () => world.reachable,
    client,
    forwards: createForwardSet(spawn),
    notify: (title, _message, category) => world.notifications.push({ title, category }),
    listens: async (port) => world.listeners.has(port),
    log: { info: (obj, msg) => world.logs.push({ obj, msg }) },
    evidence: world.evidenceLedger ? {
      ledger: world.evidenceLedger,
      sync: async (requestId: string) => { world.evidenceSyncCalls.push(requestId); },
    } : undefined,
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

  test("suspend releases: forward killed, state entry removed, localPorts cleared but kept as resume preference", async () => {
    const world = makeSyncWorld();
    await world.sync.syncOnce();
    world.detail = { ...world.detail, state: "suspended", podPhase: undefined };
    await world.sync.syncOnce();

    expect(world.spawned[0]!.killed).toBe(true);
    const state = JSON.parse(readFileSync(world.stateFile, "utf8"));
    expect(Object.keys(state)).toEqual(["/wt/local"]);
    // The anchor must not claim live ports it no longer has (attach reads
    // localPorts as ground truth); the allocation survives as a preference.
    const anchor = readSandboxAnchor("acme-dev", "sb-1")!;
    expect(anchor.localPorts).toBeUndefined();
    expect(anchor.preferredPorts).toEqual({ adjuster: 5001, backend: 10401 });

    // Resume re-establishes the same allocation when free.
    world.detail = { ...world.detail, state: "running", podPhase: "Running" };
    await world.sync.syncOnce();
    expect(world.spawned).toHaveLength(2);
    expect(world.spawned[1]!.argv).toContain("5001:4001");
    const resumed = readSandboxAnchor("acme-dev", "sb-1")!;
    expect(resumed.localPorts).toEqual({ adjuster: 5001, backend: 10401 });
    expect(resumed.preferredPorts).toBeUndefined();
  });

  test("error state releases the forward and clears the anchor's localPorts", async () => {
    const world = makeSyncWorld();
    await world.sync.syncOnce();
    world.detail = { ...world.detail, state: "error", podPhase: undefined };
    await world.sync.syncOnce();

    expect(world.spawned[0]!.killed).toBe(true);
    expect(readSandboxAnchor("acme-dev", "sb-1")!.localPorts).toBeUndefined();
    expect(Object.keys(JSON.parse(readFileSync(world.stateFile, "utf8")))).toEqual(["/wt/local"]);
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

  test("a destroyed sandbox whose anchor the CLI already pruned still gets its forward reaped", async () => {
    // Live repro (MAT-273 #1): `rt sandbox destroy` removes the anchor
    // immediately, so the next pass has no anchor to visit — the held
    // kubectl port-forward must still be reaped from controller ground truth.
    const world = makeSyncWorld();
    await world.sync.syncOnce();
    removeSandboxAnchor("acme-dev", "sb-1");
    world.detail = { ...world.detail, state: "destroyed" };
    await world.sync.syncOnce();
    expect(world.spawned[0]!.killed).toBe(true);
  });

  test("a forward for a sandbox absent from the controller list is reaped", async () => {
    const world = makeSyncWorld();
    await world.sync.syncOnce();
    removeSandboxAnchor("acme-dev", "sb-1");
    world.listResult = [];
    await world.sync.syncOnce();
    expect(world.spawned[0]!.killed).toBe(true);
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

  // ─── Evidence event fold-in ────────────────────────────────────────────────

  test("evidence-started materializes a ledger entry on first sight via client.getEvidence", async () => {
    const world = makeSyncWorld({ withEvidence: true });
    world.evidenceDetail = {
      id: "r1", sandboxId: "sb-1", caseId: "c1", view: "v1", recipe: "rec1",
      args: {}, slot: "after", state: "captured", requestedBy: "agent",
      forceBefore: false, error: null, createdAt: "2026-08-08T00:00:00.000Z",
      updatedAt: "2026-08-08T00:00:01.000Z", syncedAt: null, artifacts: [],
    };
    world.eventsByCall = [[
      { seq: 1, ts: "t", sandboxId: "sb-1", type: "evidence-started", payload: { requestId: "r1" } },
    ]];
    await world.sync.syncOnce();

    const entry = world.evidenceLedger!.read("r1")!;
    expect(entry).toMatchObject({
      requestId: "r1", executor: "sidecar", sandboxId: "sb-1", repoId: "acme-dev",
      branch: "cv-1-fix", caseId: "c1", view: "v1", recipe: "rec1", slot: "after",
      state: "requested", requestedAt: "2026-08-08T00:00:00.000Z",
    });
    expect(world.clientCalls).toContain("getEvidence r1");

    // Second sight: the ledger already has the entry, so no re-fetch/upsert.
    world.eventsByCall = [[
      { seq: 2, ts: "t", sandboxId: "sb-1", type: "evidence-started", payload: { requestId: "r1" } },
    ]];
    const callsBefore = world.clientCalls.filter(c => c === "getEvidence r1").length;
    await world.sync.syncOnce();
    expect(world.clientCalls.filter(c => c === "getEvidence r1").length).toBe(callsBefore);
  });

  test("evidence-ready sets captured and awaits deps.evidence.sync", async () => {
    const world = makeSyncWorld({ withEvidence: true });
    world.evidenceLedger!.upsert({
      requestId: "r1", executor: "sidecar", sandboxId: "sb-1", repoId: "acme-dev",
      branch: "cv-1-fix", caseId: "c1", view: "v1", recipe: "rec1", slot: "after",
      state: "requested", requestedAt: "2026-08-08T00:00:00.000Z",
    });
    world.eventsByCall = [[
      {
        seq: 1, ts: "t", sandboxId: "sb-1", type: "evidence-ready",
        payload: { requestId: "r1", summary: "ok", artifacts: [{ name: "base.png", size: 2 }] },
      },
    ]];
    await world.sync.syncOnce();

    expect(world.evidenceLedger!.read("r1")!.state).toBe("captured");
    expect(world.evidenceSyncCalls).toEqual(["r1"]);
  });

  test("evidence-failed sets failed state with error and notifies evidence_failed", async () => {
    const world = makeSyncWorld({ withEvidence: true });
    world.evidenceLedger!.upsert({
      requestId: "r1", executor: "sidecar", sandboxId: "sb-1", repoId: "acme-dev",
      branch: "cv-1-fix", caseId: "c1", view: "v1", recipe: "rec1", slot: "after",
      state: "captured", requestedAt: "2026-08-08T00:00:00.000Z",
    });
    world.eventsByCall = [[
      { seq: 1, ts: "t", sandboxId: "sb-1", type: "evidence-failed", payload: { requestId: "r1", error: "boom" } },
    ]];
    await world.sync.syncOnce();

    const entry = world.evidenceLedger!.read("r1")!;
    expect(entry.state).toBe("failed");
    expect(entry.error).toBe("boom");
    expect(world.notifications).toContainEqual({ title: "Evidence capture failed", category: "evidence_failed" });
  });

  // ─── Evidence materialize-on-sync ──────────────────────────────────────────

  function controllerRequest(overrides: Partial<EvidenceRequestRecord>): EvidenceRequestRecord {
    return {
      id: "r?", sandboxId: "sb-1", caseId: "c1", view: "v1", recipe: "rec1",
      args: {}, slot: "after", state: "queued", requestedBy: "agent",
      forceBefore: false, error: null, createdAt: "2026-08-08T00:00:00.000Z",
      updatedAt: "2026-08-08T00:00:01.000Z", syncedAt: null,
      ...overrides,
    };
  }

  test("sync pass materializes ledger entries for controller requests the ledger has never seen", async () => {
    const world = makeSyncWorld({ withEvidence: true });
    world.evidenceRequests = [
      controllerRequest({ id: "r1", state: "queued" }),
      controllerRequest({ id: "r2", state: "running" }),
      controllerRequest({ id: "r3", state: "captured" }),
      controllerRequest({ id: "r4", state: "failed", error: "boom" }),
    ];
    await world.sync.syncOnce();

    expect(world.clientCalls).toContain("listEvidence sb-1");
    const states = ["r1", "r2", "r3", "r4"].map((id) => world.evidenceLedger!.read(id)!.state);
    expect(states).toEqual(["requested", "requested", "captured", "failed"]);
    const r3 = world.evidenceLedger!.read("r3")!;
    expect(r3).toMatchObject({
      executor: "sidecar", sandboxId: "sb-1", repoId: "acme-dev", branch: "cv-1-fix",
      caseId: "c1", view: "v1", recipe: "rec1", slot: "after",
      requestedAt: "2026-08-08T00:00:00.000Z",
    });
    expect(world.evidenceLedger!.read("r4")!.error).toBe("boom");
    // Materialize-only: the pass never syncs artifacts itself (normal path
    // — evidence-ready fan-out or rt evidence pull — owns that).
    expect(world.evidenceSyncCalls).toEqual([]);
  });

  test("materialize is creation-only: existing entries keep their state and stamps across passes", async () => {
    const world = makeSyncWorld({ withEvidence: true });
    world.evidenceRequests = [controllerRequest({ id: "r1", state: "captured" })];
    await world.sync.syncOnce();

    // Locally the request has since been decided; the controller still
    // reports it captured — the next pass must not touch it.
    world.evidenceLedger!.setState("r1", "synced");
    world.evidenceLedger!.setState("r1", "approved");
    const decided = world.evidenceLedger!.read("r1")!.decidedAt!;
    await world.sync.syncOnce();

    const entry = world.evidenceLedger!.read("r1")!;
    expect(entry.state).toBe("approved");
    expect(entry.decidedAt).toBe(decided);
  });

  test("a listEvidence failure is swallowed and never blocks the rest of the pass", async () => {
    const world = makeSyncWorld({ withEvidence: true });
    world.evidenceListError = "controller hiccup";
    await world.sync.syncOnce();
    // The running sandbox still reconciled: forward spawned despite the throw.
    expect(world.clientCalls).toContain("listEvidence sb-1");
    expect(world.spawned).toHaveLength(1);
  });
});

// ─── Attended lanes: ssh forward (MAT-235) ───────────────────────────────────

describe("attended ssh forward", () => {
  test("an attended sandbox's forward gains local:2422 for sshd; ssh stays out of the dev-ports state entry", async () => {
    const world = makeSyncWorld();
    world.detail = { ...world.detail, attended: true };
    await world.sync.syncOnce();

    expect(world.spawned).toHaveLength(1);
    expect(world.spawned[0]!.argv).toEqual([
      "kubectl", "-n", "mc-sandboxes", "port-forward", "pod/sb-1",
      "5001:4001", "10401:4000", `${ATTENDED_SSH_LOCAL_PORTS[0]}:2422`,
    ]);
    const anchor = readSandboxAnchor("acme-dev", "sb-1")!;
    expect(anchor.localPorts).toEqual({
      adjuster: 5001, backend: 10401, [ATTENDED_SSH_PROCESS_NAME]: ATTENDED_SSH_LOCAL_PORTS[0]!,
    });
    // The dev-ports state file is a consumer contract (skills key on process
    // names) — the ssh port must never appear there.
    const state = JSON.parse(readFileSync(world.stateFile, "utf8"));
    const entry = state[sandboxAnchorDir("acme-dev", "sb-1")];
    expect(Object.keys(entry).sort()).toEqual(["adjuster", "backend", "ts"]);
  });

  test("two attended sandboxes never share one local ssh port", async () => {
    const world = makeSyncWorld();
    world.detail = { ...world.detail, attended: true };
    await world.sync.syncOnce();
    // A second attended sandbox's ssh allocation must skip the held local.
    const out = allocatePorts(
      [{ name: ATTENDED_SSH_PROCESS_NAME, port: 2422, localPorts: [...ATTENDED_SSH_LOCAL_PORTS] }],
      [ATTENDED_SSH_LOCAL_PORTS[0]!],
    );
    expect(out.ports[ATTENDED_SSH_PROCESS_NAME]).toBe(ATTENDED_SSH_LOCAL_PORTS[1]!);
  });

  test("a headless sandbox's forward is unchanged (no ssh mapping)", async () => {
    const world = makeSyncWorld();
    await world.sync.syncOnce();
    expect(world.spawned[0]!.argv.join(" ")).not.toContain("2422");
    expect(readSandboxAnchor("acme-dev", "sb-1")!.localPorts).toEqual({ adjuster: 5001, backend: 10401 });
  });
});

// ─── Forward-spawn robustness (MAT-273 A2) ───────────────────────────────────

describe("forward-spawn robustness", () => {
  test("a dead forward child is respawned on the next pass with the same mapping", async () => {
    const world = makeSyncWorld();
    await world.sync.syncOnce();
    world.spawned[0]!.dead = true;
    await world.sync.syncOnce();
    expect(world.spawned).toHaveLength(2);
    expect(world.spawned[1]!.argv).toEqual(world.spawned[0]!.argv);
  });

  test("a stale squatter on the chosen local port moves the allocation to the next pool port", async () => {
    const world = makeSyncWorld();
    // Something we do not hold already listens on adjuster's first free
    // candidate (orphan kubectl from a dead daemon, unrelated process).
    world.listeners.add(5001);
    await world.sync.syncOnce();
    expect(world.spawned).toHaveLength(1);
    expect(world.spawned[0]!.argv).toContain("6001:4001");
    expect(readSandboxAnchor("acme-dev", "sb-1")!.localPorts!.adjuster).toBe(6001);

    // Our own live forward now listens on 6001 — that is not a squatter;
    // steady state keeps the allocation and spawns nothing new.
    world.listeners.add(6001);
    await world.sync.syncOnce();
    expect(world.spawned).toHaveLength(1);
    expect(readSandboxAnchor("acme-dev", "sb-1")!.localPorts!.adjuster).toBe(6001);
  });

  test("post-daemon-restart: a squatted previous ssh port converges to the next pool port", async () => {
    const world = makeSyncWorld();
    world.detail = { ...world.detail, attended: true };
    // The previous daemon's anchor survives the restart; its kubectl child
    // (never reaped — it crashed) still squats the old ssh local.
    writeSandboxAnchor({
      id: "sb-1", repoId: "acme-dev", branch: "cv-1-fix", createdAt: "t", lastEventSeq: 0,
      localPorts: { adjuster: 5001, backend: 10401, ssh: ATTENDED_SSH_LOCAL_PORTS[0]! },
    });
    world.listeners.add(ATTENDED_SSH_LOCAL_PORTS[0]!);
    await world.sync.syncOnce();
    expect(world.spawned).toHaveLength(1);
    expect(world.spawned[0]!.argv).toContain(`${ATTENDED_SSH_LOCAL_PORTS[1]}:2422`);
    expect(readSandboxAnchor("acme-dev", "sb-1")!.localPorts).toEqual({
      adjuster: 5001, backend: 10401, [ATTENDED_SSH_PROCESS_NAME]: ATTENDED_SSH_LOCAL_PORTS[1]!,
    });
  });

  test("every spawn and reap emits a daemon log line (silence is diagnosable)", async () => {
    const world = makeSyncWorld();
    await world.sync.syncOnce();
    expect(world.logs.some(l => l.msg.includes("spawn") && l.obj.sandboxId === "sb-1")).toBe(true);

    world.detail = { ...world.detail, state: "destroyed" };
    await world.sync.syncOnce();
    expect(world.logs.some(l => l.msg.includes("reap") && l.obj.sandboxId === "sb-1")).toBe(true);
  });
});
