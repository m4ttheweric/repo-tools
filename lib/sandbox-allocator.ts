/**
 * The daemon-side sandbox machinery: local port allocation from the
 * overlay's registered pools, kubectl port-forwards held for running
 * sandboxes, dev-ports state-file mirroring (the existing consumer contract,
 * byte-compatible), and the ground-truth reconcile + typed-event fan-out
 * loop (see .local-dev/2026-08-07-sandbox-controller-design.md).
 *
 * Everything is unit-testable with injected spawn/client fakes; the real
 * kubectl port-forward leg is cluster-verify pending. The reconcile follows
 * the event-driven-UI rule: local state (forwards, state entries, anchors)
 * is derived from controller ground truth every pass, never from timers or
 * assumed transitions.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { sandboxAnchorDir } from "./rt-paths.ts";
import { kubectlEnv } from "./cloud-secrets.ts";
import {
  ATTENDED_SSH_POD_PORT,
  ATTENDED_SSH_PROCESS_NAME,
  SANDBOX_NAMESPACE,
  listSandboxAnchors,
  listSandboxOverlays,
  readSandboxAnchor,
  removeSandboxAnchor,
  writeSandboxAnchor,
  type EvidenceState,
  type SandboxAnchor,
  type SandboxClient,
  type SandboxDetail,
  type SandboxEvent,
  type SandboxOverlayConfig,
  type SandboxProcess,
} from "./sandbox.ts";
import type { EvidenceLedger, LedgerState } from "./daemon/evidence-ledger.ts";

// ─── Attended ssh (MAT-235) ──────────────────────────────────────────────────

export { ATTENDED_SSH_POD_PORT, ATTENDED_SSH_PROCESS_NAME };

/**
 * Local candidate ports for attended ssh forwards. Unlike browser-facing
 * pools these carry no Auth0 registration constraint — the pool exists only
 * so concurrent attended sandboxes get distinct, predictable locals that
 * `rt sandbox attach` can pin in ~/.ssh/config Host blocks.
 */
export const ATTENDED_SSH_LOCAL_PORTS = [24221, 24222, 24223, 24224, 24225, 24226, 24227, 24228, 24229, 24230] as const;

/** The ssh pseudo-process an attended sandbox adds to its allocation. */
function attendedSshProcess(): SandboxProcess {
  return {
    name: ATTENDED_SSH_PROCESS_NAME,
    port: ATTENDED_SSH_POD_PORT,
    localPorts: [...ATTENDED_SSH_LOCAL_PORTS],
  };
}

// ─── Port allocation ─────────────────────────────────────────────────────────

export interface AllocationOutcome {
  ok: boolean;
  /** Successful allocations (partial when exhausted). */
  ports: Record<string, number>;
  /** Process names whose pool had no free candidate. */
  exhausted: string[];
}

/**
 * Allocate one local port per process from its candidate pool, skipping
 * `taken` (ports held by local worktrees and other sandboxes — the
 * Auth0-registered pool is shared, a hard ceiling by design). A `preferred`
 * previous allocation is reused when its port is still free, so resume
 * re-establishes the same allocation when possible.
 */
export function allocatePorts(
  processes: SandboxProcess[],
  taken: Iterable<number>,
  preferred?: Record<string, number>,
): AllocationOutcome {
  const used = new Set(taken);
  const ports: Record<string, number> = {};
  const exhausted: string[] = [];
  for (const proc of processes) {
    const prev = preferred?.[proc.name];
    const candidates = prev !== undefined && proc.localPorts.includes(prev)
      ? [prev, ...proc.localPorts.filter(p => p !== prev)]
      : proc.localPorts;
    const free = candidates.find(p => !used.has(p));
    if (free === undefined) {
      exhausted.push(proc.name);
      continue;
    }
    used.add(free);
    ports[proc.name] = free;
  }
  return { ok: exhausted.length === 0, ports, exhausted };
}

// ─── Port-forward set ────────────────────────────────────────────────────────

export interface ForwardHandle {
  kill(): void;
  /** False once the child exited on its own; absent means always-alive (fakes). */
  alive?(): boolean;
}

/** Injected spawner so the kubectl leg is unit-testable off-cluster. */
export type ForwardSpawn = (argv: string[]) => ForwardHandle;

export type ForwardMapping = Record<string, { local: number; pod: number }>;

export interface ForwardSet {
  /**
   * Hold `kubectl port-forward` for the sandbox. "kept" when a live forward
   * already covers the mapping; a dead child or a mapping change respawns.
   */
  ensure(sandboxId: string, podName: string, mapping: ForwardMapping): "spawned" | "respawned" | "kept";
  /** True when a forward was actually held (and is now stopped). */
  stop(sandboxId: string): boolean;
  active(sandboxId: string): ForwardMapping | null;
  /** Local ports held by forwards, optionally excluding one sandbox's. */
  activeLocals(exceptSandboxId?: string): number[];
  /** Sandbox ids a forward is currently held for. */
  heldIds(): string[];
  stopAll(): void;
}

/** Real spawner. Cluster-verify pending: needs a live cluster to prove. */
export const spawnForward: ForwardSpawn = (argv) => {
  const proc = Bun.spawn(argv, { env: kubectlEnv(), stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  let exited = false;
  proc.exited.then(() => { exited = true; }, () => { exited = true; });
  return {
    kill: () => {
      try { proc.kill(); } catch { /* already exited */ }
    },
    alive: () => !exited,
  };
};

/**
 * True when something accepts a TCP connection on 127.0.0.1:port — the real
 * deps.listens for squatter detection (also the CLI's qa-tunnel probe).
 */
export async function probeLocalListener(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 1500);
    Bun.connect({
      hostname: "127.0.0.1",
      port,
      socket: {
        open(socket) { clearTimeout(timer); socket.end(); resolve(true); },
        error() { clearTimeout(timer); resolve(false); },
        data() {},
        close() {},
      },
    }).catch(() => { clearTimeout(timer); resolve(false); });
  });
}

export function createForwardSet(
  spawn: ForwardSpawn = spawnForward,
  namespace: string = SANDBOX_NAMESPACE,
): ForwardSet {
  const held = new Map<string, { mapping: ForwardMapping; handle: ForwardHandle }>();

  function mappingKey(mapping: ForwardMapping): string {
    return Object.entries(mapping).map(([name, m]) => `${name}=${m.local}:${m.pod}`).sort().join(",");
  }

  /** Drop entries whose child died on its own — a dead forward holds nothing. */
  function pruneDead(): void {
    for (const [id, { handle }] of [...held]) {
      if (handle.alive && !handle.alive()) held.delete(id);
    }
  }

  return {
    ensure(sandboxId, podName, mapping) {
      const wasHeld = held.has(sandboxId);
      pruneDead();
      const current = held.get(sandboxId);
      if (current && mappingKey(current.mapping) === mappingKey(mapping)) return "kept";
      current?.handle.kill();
      const pairs = Object.values(mapping).map(m => `${m.local}:${m.pod}`);
      const handle = spawn(["kubectl", "-n", namespace, "port-forward", `pod/${podName}`, ...pairs]);
      held.set(sandboxId, { mapping, handle });
      return wasHeld ? "respawned" : "spawned";
    },
    stop(sandboxId) {
      const current = held.get(sandboxId);
      current?.handle.kill();
      held.delete(sandboxId);
      return current !== undefined;
    },
    active(sandboxId) {
      pruneDead();
      return held.get(sandboxId)?.mapping ?? null;
    },
    activeLocals(exceptSandboxId) {
      pruneDead();
      const out: number[] = [];
      for (const [id, { mapping }] of held) {
        if (id === exceptSandboxId) continue;
        for (const m of Object.values(mapping)) out.push(m.local);
      }
      return out;
    },
    heldIds() {
      pruneDead();
      return [...held.keys()];
    },
    stopAll() {
      for (const { handle } of held.values()) handle.kill();
      held.clear();
    },
  };
}

// ─── Dev-ports state-file mirroring ──────────────────────────────────────────

/**
 * The consumer contract: entries in the overlay-configured state file are
 * `{ <process>: <localPort>..., ts, bearer?, bearerTs?, bearerExp? }` keyed
 * by directory path — byte-compatible with what local worktrees write
 * (pids omitted for sandboxes). Existing bearer fields survive a port
 * re-upsert; ports survive a bearer fold.
 */
type StateFile = Record<string, Record<string, unknown>>;

function readStateFile(path: string): StateFile {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as StateFile;
  } catch {
    return {};
  }
}

function writeStateFile(path: string, state: StateFile): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2));
}

export function upsertStateEntry(
  stateFilePath: string,
  key: string,
  ports: Record<string, number>,
): void {
  const state = readStateFile(stateFilePath);
  const existing = state[key] ?? {};
  const bearerFields: Record<string, unknown> = {};
  for (const field of ["bearer", "bearerTs", "bearerExp"]) {
    if (existing[field] !== undefined) bearerFields[field] = existing[field];
  }
  state[key] = { ...ports, ts: new Date().toISOString(), ...bearerFields };
  writeStateFile(stateFilePath, state);
}

export function foldBearer(
  stateFilePath: string,
  key: string,
  bearer: { bearer: string; bearerTs?: string; bearerExp?: string },
): void {
  const state = readStateFile(stateFilePath);
  state[key] = { ...(state[key] ?? {}), ...bearer };
  writeStateFile(stateFilePath, state);
}

export function removeStateEntry(stateFilePath: string, key: string): void {
  const state = readStateFile(stateFilePath);
  if (!(key in state)) return;
  delete state[key];
  writeStateFile(stateFilePath, state);
}

/**
 * Local ports in use across all entries, counting only the named process
 * fields (never pids or timestamps). `exceptKey` skips one entry so a
 * sandbox's own previous allocation doesn't read as taken.
 */
export function statePortsInUse(
  stateFilePath: string,
  processNames: string[],
  exceptKey?: string,
): number[] {
  const state = readStateFile(stateFilePath);
  const out: number[] = [];
  for (const [key, entry] of Object.entries(state)) {
    if (key === exceptKey) continue;
    for (const name of processNames) {
      const value = entry[name];
      if (typeof value === "number") out.push(value);
    }
  }
  return out;
}

// ─── Ground-truth reconcile + event fan-out ──────────────────────────────────

export interface SandboxSyncDeps {
  /** True when the controller answers (cheap healthz probe). */
  probe(): Promise<boolean>;
  client: SandboxClient;
  forwards: ForwardSet;
  notify(title: string, message: string, category: string): void;
  /**
   * True when something listens on 127.0.0.1:port. Used for stale-squatter
   * detection: a listener on a port our live forwards do not hold is foreign
   * (orphan kubectl from a dead daemon, unrelated process), so the allocation
   * moves to the next pool port instead of spawning a forward that loses the
   * bind race. Absent = no probing (tests that don't care).
   */
  listens?(port: number): Promise<boolean>;
  /** Spawn/reap diagnostics — the daemon wires its sandbox-sync module logger. */
  log?: { info(obj: Record<string, unknown>, msg: string): void };
  /** Overlay enumeration, injectable for tests; defaults to ~/.rt/repos. */
  overlays?(): Array<{ repoId: string; config: SandboxOverlayConfig }>;
  /**
   * Daemon-owned infra forwards (RT-22: controller 8080 + receiver 2222).
   * Ensured at the TOP of every pass, before the controller probe gate —
   * an unreachable controller is exactly when the 8080 forward must come
   * up, and the receiver forward is what `rt sandbox create`'s push dials
   * whether or not any sandbox is running.
   */
  infra?: { ensureOnce(): Promise<unknown> };
  /** Evidence fold-in, wired by lib/daemon/sandbox-sync.ts; absent when a repo has no evidence overlay. */
  evidence?: {
    ledger: EvidenceLedger;
    sync(requestId: string): Promise<void>;
  };
}

/**
 * One reconcile pass. For every sandbox the controller reports: poll typed
 * events since the anchor's seq and fan them out, materialize ledger entries
 * for controller evidence requests the ledger has never seen, then converge
 * local state on the controller's — running sandboxes get an allocation +
 * forward + state entry; suspended ones release all three (allocation kept
 * as resume preference); destroyed/unknown ones are pruned entirely. Errors
 * from one sandbox never block the rest.
 */
export function createSandboxSync(deps: SandboxSyncDeps): { syncOnce(): Promise<void> } {
  const overlays = deps.overlays ?? listSandboxOverlays;

  async function fanOut(anchor: SandboxAnchor, stateFile: string | undefined, events: SandboxEvent[]): Promise<void> {
    const id = anchor.id;
    for (const event of events) {
      const payload = (event.payload ?? {}) as Record<string, unknown>;
      switch (event.type) {
        case "question":
          deps.notify("Sandbox question", `${id}: question.md — answer with rt sandbox answer ${id}`, "sandbox_question");
          break;
        case "report":
          deps.notify("Sandbox report", `${id}: report.md written`, "sandbox_report");
          break;
        case "blocked":
          deps.notify("Sandbox blocked", `${id}: blocked.md written`, "sandbox_blocked");
          break;
        case "process-dead":
          deps.notify("Sandbox agent died", `${id}: agent container terminated`, "sandbox_process_dead");
          break;
        case "state":
          if (payload.state === "error") {
            deps.notify("Sandbox error", `${id}: ${payload.message ?? "entered error state"}`, "sandbox_error");
          }
          break;
        case "captured":
          if (payload.file === "bearer.json" && typeof payload.content === "string" && stateFile) {
            try {
              const bearer = JSON.parse(payload.content) as { bearer: string; bearerTs?: string; bearerExp?: string };
              if (bearer.bearer) foldBearer(stateFile, sandboxAnchorDir(anchor.repoId, id), bearer);
            } catch { /* malformed capture — the next capture event retries */ }
          }
          break;
        case "evidence-started": {
          // in-pod agents can enqueue without rt: materialize a ledger entry on first sight
          const requestId = payload.requestId as string;
          if (deps.evidence && requestId && !deps.evidence.ledger.read(requestId)) {
            const detail = await deps.client.getEvidence(requestId).catch(() => null);
            if (detail) deps.evidence.ledger.upsert({
              requestId, executor: "sidecar", sandboxId: anchor.id, repoId: anchor.repoId,
              branch: anchor.branch, caseId: detail.caseId, view: detail.view, recipe: detail.recipe,
              slot: detail.slot, state: "requested", requestedAt: detail.createdAt,
            });
          }
          break;
        }
        case "evidence-ready": {
          if (deps.evidence) {
            const requestId = payload.requestId as string;
            if (deps.evidence.ledger.read(requestId)) deps.evidence.ledger.setState(requestId, "captured");
            await deps.evidence.sync(requestId).catch(() => { /* next poll or rt evidence pull retries */ });
          }
          break;
        }
        case "evidence-failed": {
          if (deps.evidence) {
            const requestId = payload.requestId as string;
            if (deps.evidence.ledger.read(requestId)) {
              deps.evidence.ledger.setState(requestId, "failed", { error: payload.error });
            }
            deps.notify("Evidence capture failed", `${anchor.branch}: ${requestId}`, "evidence_failed");
          }
          break;
        }
      }
    }
  }

  async function pollEvents(anchor: SandboxAnchor, stateFile: string | undefined): Promise<void> {
    const events = await deps.client.events(anchor.id, anchor.lastEventSeq);
    if (events.length === 0) return;
    await fanOut(anchor, stateFile, events);
    anchor.lastEventSeq = Math.max(...events.map(e => e.seq));
    writeSandboxAnchor(anchor);
  }

  /** Controller request state → ledger state for a materialized entry. */
  const LEDGER_STATE_FOR: Record<EvidenceState, LedgerState> = {
    queued: "requested",
    running: "requested",
    captured: "captured",
    failed: "failed",
  };

  /**
   * Reconcile the ledger against the controller's request list: a request
   * the ledger has never seen (e.g. its event fold-in failed transiently)
   * gets a materialized entry with the state the controller reports, so it
   * is no longer orphaned ("unknown requestId" on pull). Existing entries
   * are never touched — creation only, so decidedAt and friends keep their
   * stamps and the pass stays idempotent. Artifacts sync on the normal path
   * afterwards (evidence-ready fan-out or rt evidence pull).
   */
  async function reconcileEvidence(anchor: SandboxAnchor): Promise<void> {
    if (!deps.evidence) return;
    const requests = await deps.client.listEvidence(anchor.id);
    for (const req of requests) {
      if (deps.evidence.ledger.read(req.id)) continue;
      deps.evidence.ledger.upsert({
        requestId: req.id, executor: "sidecar", sandboxId: anchor.id, repoId: anchor.repoId,
        branch: anchor.branch, caseId: req.caseId, view: req.view, recipe: req.recipe,
        slot: req.slot, state: LEDGER_STATE_FOR[req.state], requestedAt: req.createdAt,
        ...(req.error != null ? { error: req.error } : {}),
      });
    }
  }

  async function reconcileRunning(
    sandbox: SandboxDetail,
    config: SandboxOverlayConfig,
  ): Promise<void> {
    const anchor: SandboxAnchor = readSandboxAnchor(sandbox.repoId, sandbox.id) ?? {
      id: sandbox.id,
      repoId: sandbox.repoId,
      branch: sandbox.branch,
      createdAt: sandbox.createdAt,
      lastEventSeq: 0,
    };
    const anchorDir = sandboxAnchorDir(sandbox.repoId, sandbox.id);
    // Attended sandboxes forward sshd too — a pseudo-process outside the
    // overlay, so the daemon holds the tunnel `rt sandbox attach` points at.
    const processes = sandbox.attended
      ? [...config.processes, attendedSshProcess()]
      : config.processes;
    const processNames = config.processes.map(p => p.name);
    const taken = new Set<number>(deps.forwards.activeLocals(sandbox.id));
    if (config.stateFile) {
      for (const port of statePortsInUse(config.stateFile, processNames, anchorDir)) taken.add(port);
    }

    const preferred = anchor.localPorts ?? anchor.preferredPorts;
    let allocation = allocatePorts(processes, taken, preferred);
    if (deps.listens) {
      // Ports our own live forward for this sandbox holds are never squatted;
      // everything else we're about to bind gets probed. Each round marks the
      // squatted ports taken and re-allocates, so the pass converges on free
      // pool ports (or falls into the exhaustion branch below).
      const ours = new Set(Object.values(deps.forwards.active(sandbox.id) ?? {}).map(m => m.local));
      while (allocation.ok) {
        const squatted: number[] = [];
        for (const port of Object.values(allocation.ports)) {
          if (!ours.has(port) && (await deps.listens(port))) squatted.push(port);
        }
        if (squatted.length === 0) break;
        for (const port of squatted) taken.add(port);
        deps.log?.info({ sandboxId: sandbox.id, ports: squatted }, "local ports squatted by a foreign listener; re-allocating");
        allocation = allocatePorts(processes, taken, preferred);
      }
    }
    if (!allocation.ok) {
      // Loud, not silent: an unregistered local port cannot complete Auth0
      // login, so a partial forward would be a lying success.
      const message = `port pool exhausted for ${allocation.exhausted.join(", ")} — suspend a sandbox or stop a local worktree's dev servers`;
      const alreadyWarned = anchor.allocationError !== undefined;
      anchor.allocationError = message;
      delete anchor.localPorts;
      writeSandboxAnchor(anchor);
      deps.forwards.stop(sandbox.id);
      if (config.stateFile) removeStateEntry(config.stateFile, anchorDir);
      if (!alreadyWarned) deps.notify("Sandbox port pool exhausted", `${sandbox.id}: ${message}`, "sandbox_ports");
      return;
    }

    delete anchor.allocationError;
    delete anchor.preferredPorts;
    anchor.localPorts = allocation.ports;
    writeSandboxAnchor(anchor);

    const mapping: ForwardMapping = {};
    for (const proc of processes) {
      mapping[proc.name] = { local: allocation.ports[proc.name]!, pod: proc.port };
    }
    // Pod name == sandbox id (contract note in lib/sandbox.ts).
    const outcome = deps.forwards.ensure(sandbox.id, sandbox.id, mapping);
    if (outcome !== "kept") {
      deps.log?.info({ sandboxId: sandbox.id, mapping, outcome }, `forward ${outcome}`);
    }
    // The state entry mirrors overlay processes ONLY: it is a consumer
    // contract (skills key on process-name fields), so the ssh pseudo-port
    // stays on the anchor and out of the file.
    if (config.stateFile) {
      const overlayPorts = Object.fromEntries(config.processes.map(p => [p.name, allocation.ports[p.name]!]));
      upsertStateEntry(config.stateFile, anchorDir, overlayPorts);
    }
  }

  function release(repoId: string, sandboxId: string, config: SandboxOverlayConfig): void {
    if (deps.forwards.stop(sandboxId)) {
      deps.log?.info({ sandboxId }, "forward reaped (sandbox left running)");
    }
    if (config.stateFile) removeStateEntry(config.stateFile, sandboxAnchorDir(repoId, sandboxId));
    // The anchor must not claim ports it no longer holds (attach reads
    // localPorts as ground truth); the allocation survives as a preference.
    const anchor = readSandboxAnchor(repoId, sandboxId);
    if (anchor?.localPorts) {
      anchor.preferredPorts = anchor.localPorts;
      delete anchor.localPorts;
      writeSandboxAnchor(anchor);
    }
  }

  async function syncOnce(): Promise<void> {
    try {
      await deps.infra?.ensureOnce();
    } catch { /* a kubectl spawn failure must not block the pod reconcile */ }
    if (!(await deps.probe())) return;
    let all: SandboxDetail[];
    try {
      all = await deps.client.list();
    } catch {
      return; // transient controller failure — next pass retries
    }
    const byId = new Map(all.map(s => [s.id, s]));

    for (const { repoId, config } of overlays()) {
      // Anchors drive event polling and pruning; the controller list drives
      // everything else. Events first, so a final report still fans out
      // before a destroyed sandbox's anchor is pruned.
      const anchors = new Map(listSandboxAnchors(repoId).map(a => [a.id, a]));
      for (const sandbox of all) {
        if (sandbox.repoId === repoId && !anchors.has(sandbox.id) && sandbox.state !== "destroyed") {
          anchors.set(sandbox.id, {
            id: sandbox.id, repoId, branch: sandbox.branch,
            createdAt: sandbox.createdAt, lastEventSeq: 0,
          });
        }
      }

      for (const anchor of anchors.values()) {
        try {
          if (byId.has(anchor.id)) await pollEvents(anchor, config.stateFile);
        } catch { /* one sandbox's poll failure must not block the rest */ }
        try {
          if (byId.has(anchor.id) && byId.get(anchor.id)!.state !== "destroyed") {
            await reconcileEvidence(anchor);
          }
        } catch { /* transient controller failure — next pass retries */ }

        const sandbox = byId.get(anchor.id);
        if (!sandbox || sandbox.state === "destroyed") {
          release(repoId, anchor.id, config);
          removeSandboxAnchor(repoId, anchor.id);
          continue;
        }
        if (sandbox.state === "running") {
          await reconcileRunning(sandbox, config);
        } else {
          // creating / suspended / error: nothing should be forwarded or
          // mirrored; the allocation stays on the anchor as a preference.
          release(repoId, anchor.id, config);
        }
      }
    }

    // Orphan sweep: the loop above only visits anchors, so a forward whose
    // anchor is already gone (rt sandbox destroy prunes it immediately) or
    // whose sandbox left the controller list would leak a kubectl child
    // forever (MAT-273 live repro). Ground truth: only running sandboxes
    // keep a forward.
    for (const id of deps.forwards.heldIds()) {
      const state = byId.get(id)?.state;
      if (state !== "running" && deps.forwards.stop(id)) {
        deps.log?.info({ sandboxId: id, state: state ?? "absent" }, "forward reaped (orphan)");
      }
    }
  }

  return { syncOnce };
}
