/**
 * Pane lifecycle for herd jobs, from herdr's own event stream. Only
 * `blocked` (debounced) and pane exit are forwarded to the room; the
 * working/idle flips herdr emits on every turn boundary are ignored, since
 * forwarding them is what trained shepherds to skip checks.
 */
import type { Logger } from "pino";
import { formatPaneRef, parsePaneRef } from "../../packages/rt-client/src/index.ts";
import type { EventsBus } from "./events-bus.ts";
import type { GatesStore } from "./gates-store.ts";
import { herdSubject, type HerdStore, type HerdJobRow } from "./herd-store.ts";
import { subscribeHerdrEvents as defaultSubscribe, type HerdrEvent, type HerdrSubscription } from "../herdr/subscribe.ts";
import { herdrRequest as defaultHerdrRequest } from "../herdr/client.ts";
import { safeTimeout } from "./safe-timers.ts";
import { SYSTEM_HANDLE } from "./handlers/herd.ts";
import type { BgClaimsStore } from "./bg-claims-store.ts";

export interface HerdLifecycle {
  start(): void;
  stop(): void;
  watch(socket: string): void;
  connected(socket: string | null): boolean;
  handleEvent(socket: string | null, ev: HerdrEvent): Promise<void>;
  reconcilePanes(): void;
  /** Reconciles the bg claims registry against reality: a claimed `bg:` pane
      missing from a live snapshot releases (crashed/closed pane the event
      stream missed), and a `runner:<pid>` claim whose process is gone
      releases too. Inert when bgSocket/bgClaims are not configured. */
  sweepClaims(): Promise<void>;
}

// herdr rejects a whole events.subscribe request when a
// pane.agent_status_changed entry carries no pane_id, so agent status is a
// per-pane stream and never rides the wildcard one.
export const WILDCARD_SUBSCRIPTIONS = [
  { type: "pane.agent_detected" },
  { type: "pane.closed" },
  { type: "pane.exited" },
];
export const paneStatusSubscription = (pane: string) => [{ type: "pane.agent_status_changed", pane_id: pane }];

const WATCHED: ReadonlySet<string> = new Set(["spawning", "active", "at-gate", "at-milestone"]);
const RECONCILE_MS = 30_000;
const TIMER_LABEL = "herd-lifecycle-reconcile";

export function createHerdLifecycle(opts: {
  store: HerdStore;
  gate: { "gate:close": (p: unknown) => Promise<any>; "gate:list": (p: unknown) => Promise<any> };
  chat: { "chat:post": (p: unknown) => Promise<any> };
  bus: Pick<EventsBus, "onBroadcast">;
  gateStore: Pick<GatesStore, "get">;
  defaultSocket: string;
  /** The bg server's own socket path (spec "The bg service"); an agent pane launched onto it is never a herd job, so its claim must release on this socket's own pane.closed/pane.exited before jobFor's early return. Omitted, this hook is inert. */
  bgSocket?: string;
  bgClaims?: Pick<BgClaimsStore, "releaseByPane" | "list" | "release">;
  subscribe?: typeof defaultSubscribe;
  herdr?: typeof defaultHerdrRequest;
  blockedDebounceMs?: number;
  setTimer?: (fn: () => void, ms: number) => { clear(): void };
  log: Logger;
}): HerdLifecycle {
  const { store, log } = opts;
  const subscribe = opts.subscribe ?? defaultSubscribe;
  const herdr = opts.herdr ?? defaultHerdrRequest;
  const debounceMs = opts.blockedDebounceMs ?? 30_000;
  // A reconcile tick reads sqlite and opens subscriptions; a synchronous
  // throw in a bare setTimeout callback is an uncaughtException, which
  // installCrashHandlers exits the daemon on.
  const setTimer = opts.setTimer ?? ((fn, ms) => { const t = safeTimeout(fn, ms, TIMER_LABEL, log); return { clear: () => clearTimeout(t) }; });
  const subs = new Map<string, HerdrSubscription>();
  const paneSubs = new Map<string, HerdrSubscription>();
  const blockedTimers = new Map<string, { clear(): void }>();
  let unhookBus: (() => void) | undefined;
  let reconcileTimer: { clear(): void } | undefined;

  const socketKey = (s: string | null) => s ?? opts.defaultSocket;
  const paneKey = (socket: string | null, pane: string) => `${socketKey(socket)}|${pane}`;

  // Every event path is driven from a socket callback or a timer, so an
  // escaping rejection would be an unhandled rejection, fatal while booting
  // (installCrashHandlers) since the streams open in a boot stage.
  const fireAndForget = (p: Promise<void>, context: Record<string, unknown>): void => {
    p.catch((err) => log.warn({ err, ...context }, "herd lifecycle: event handling failed"));
  };

  function watchPane(socket: string | null, pane: string): void {
    const key = paneKey(socket, pane);
    if (paneSubs.has(key)) return;
    paneSubs.set(key, subscribe({
      sockPath: socketKey(socket),
      subscriptions: paneStatusSubscription(pane),
      onEvent: (ev) => { fireAndForget(handleEvent(socket, ev), { socket, pane }); },
      log,
    }));
  }

  function unwatchPane(socket: string | null, pane: string): void {
    const key = paneKey(socket, pane);
    paneSubs.get(key)?.stop();
    paneSubs.delete(key);
  }

  function reconcilePanes(): void {
    const wanted = new Map<string, { socket: string | null; pane: string }>();
    for (const herd of store.list({ status: "active" })) {
      for (const job of store.jobs(herd.id)) {
        if (job.pane && WATCHED.has(job.status)) wanted.set(paneKey(herd.herdrSocket, job.pane), { socket: herd.herdrSocket, pane: job.pane });
      }
    }
    for (const key of [...paneSubs.keys()]) {
      if (!wanted.has(key)) { paneSubs.get(key)?.stop(); paneSubs.delete(key); }
    }
    for (const { socket, pane } of wanted.values()) watchPane(socket, pane);
  }

  function scheduleReconcile(): void {
    reconcileTimer = setTimer(() => { reconcilePanes(); scheduleReconcile(); }, RECONCILE_MS);
  }

  /** A pane id is reused across a herd's lifetime and `jobsByPane` is
      unordered, so a finished row can shadow the job the event is really
      about; a watched row always wins over one that is not. */
  function jobFor(socket: string | null, pane: string): { job: HerdJobRow; room: string; shepherd: string; hidden: boolean } | null {
    let stale: { job: HerdJobRow; room: string; shepherd: string; hidden: boolean } | null = null;
    for (const job of store.jobsByPane(pane)) {
      const herd = store.get(job.herd);
      if (!herd || herd.status !== "active") continue;
      if (socketKey(herd.herdrSocket) !== socketKey(socket)) continue;
      const hit = { job, room: herd.room, shepherd: herd.shepherdHandle, hidden: herd.hidden };
      if (WATCHED.has(job.status)) return hit;
      stale ??= hit;
    }
    return stale;
  }

  async function post(room: string, shepherd: string, body: string): Promise<void> {
    const res = await opts.chat["chat:post"]({ room, handle: SYSTEM_HANDLE, body, mentions: [shepherd] });
    if (!res.ok) log.warn({ room, error: res.error }, "herd lifecycle: room post failed");
  }

  async function closeOpenGates(herdId: string, job: string): Promise<void> {
    const subject = herdSubject(herdId, job);
    const res = await opts.gate["gate:list"]({ open: true, subjectPrefix: subject });
    if (!res.ok) return;
    for (const g of res.data.gates as Array<{ id: string; subject: string }>) {
      if (g.subject !== subject) continue;
      await opts.gate["gate:close"]({ id: g.id, reason: "abandoned" });
    }
  }

  async function handleEvent(socket: string | null, ev: HerdrEvent): Promise<void> {
    const pane = typeof ev.pane_id === "string" ? ev.pane_id : undefined;
    if (!pane) return;
    // Runs before jobFor's early return: a bg-launched agent pane is never a
    // herd job, so jobFor always misses it and would otherwise swallow the
    // release along with the "not mine" no-op.
    if ((ev.type === "pane.closed" || ev.type === "pane.exited") && opts.bgSocket && socket === opts.bgSocket) {
      opts.bgClaims?.releaseByPane(formatPaneRef(pane, "bg"));
    }
    const hit = jobFor(socket, pane);
    if (!hit) return;
    const { job, room, shepherd, hidden } = hit;
    const key = paneKey(socket, pane);
    const ref = formatPaneRef(pane, hidden ? "bg" : "visible");

    if (ev.type === "pane.agent_detected") {
      if (job.status === "spawning") store.setJobStatus(job.herd, job.name, "active");
      watchPane(socket, pane);
      return;
    }
    if (ev.type === "pane.agent_status_changed") {
      if (ev.agent_status === "blocked") {
        if (blockedTimers.has(key) || !WATCHED.has(job.status)) return;
        blockedTimers.set(key, setTimer(() => {
          blockedTimers.delete(key);
          fireAndForget(post(room, shepherd, `${job.name} blocked (pane ${ref})`), { socket, pane });
        }, debounceMs));
      } else {
        blockedTimers.get(key)?.clear();
        blockedTimers.delete(key);
      }
      return;
    }
    if (ev.type === "pane.closed" || ev.type === "pane.exited") {
      blockedTimers.get(key)?.clear();
      blockedTimers.delete(key);
      unwatchPane(socket, pane);
      if (WATCHED.has(job.status)) {
        store.setJobStatus(job.herd, job.name, "crashed");
        await closeOpenGates(job.herd, job.name);
        await post(room, shepherd, `${job.name} exited (pane ${ref})`);
      } else if (job.status === "done") {
        // herdr sends exited and closed for one pane teardown; anything but a
        // clean finish keeps the marker the first of the pair set.
        store.setJobStatus(job.herd, job.name, "closed");
      }
    }
  }

  function onGateEvent(type: string, data: unknown): void {
    if (type !== "event") return;
    const frame = data as { topic?: string; payload?: { id?: string; subject?: string } };
    const topic = frame.topic ?? "";
    if (!topic.startsWith("gate/answered/") && !topic.startsWith("gate/closed/")) return;
    const subject = frame.payload?.subject;
    if (!subject) return;
    const job = store.jobBySubject(subject);
    if (!job) return;
    if (job.status === "at-gate" || job.status === "at-milestone") store.setJobStatus(job.herd, job.name, "active");
  }

  /** Reconciliation, not the event path: a claim can go stale by a route the
      wildcard subscription never covers (missed while disconnected, a pane
      that never actually spawned, a runner that died without herdr ever
      seeing its pane). Pane claims only sweep against a snapshot that
      actually answered; a snapshot failure skips that half rather than
      reading "unreachable" as "every pane is gone". */
  async function sweepClaims(): Promise<void> {
    const { bgSocket, bgClaims } = opts;
    if (!bgSocket || !bgClaims) return;
    // Captured once, before the snapshot RPC -- same reasoning as the pid
    // loop below, extended to the round trip: a claim registered while
    // session.snapshot is in flight (a concurrent agent:start --bg, or a
    // peer's own ensure/reconnect sweep) is invisible to that snapshot's
    // view of live panes, so judging it against `live` would read "not in
    // the snapshot" as "gone" and release a claim on a pane that is still
    // being spawned. Re-listing after the await was exactly this bug; a
    // claim that shows up mid-flight simply waits for the next sweep.
    const candidates = bgClaims.list();
    const released: string[] = [];
    for (const claim of candidates) {
      if (claim.pane || !claim.owner.startsWith("runner:")) continue;
      const pid = Number(claim.owner.slice("runner:".length));
      if (!Number.isFinite(pid)) continue;
      try {
        process.kill(pid, 0);
      } catch {
        if (bgClaims.release(claim.owner)) released.push(claim.owner);
      }
    }
    const snap = await herdr<{ snapshot?: { panes?: Array<{ pane_id: string }> } }>("session.snapshot", {}, { sockPath: bgSocket });
    const panes = snap.ok ? snap.result?.snapshot?.panes : undefined;
    if (!snap.ok || !Array.isArray(panes)) {
      // An ok reply's shape is still herdr's to get wrong (same rule as
      // paneStatuses in handlers/herd.ts): degrade like !snap.ok, never
      // substitute an empty live set -- that would release every pane claim.
      log.warn({ sockPath: bgSocket, error: snap.ok ? "malformed snapshot body" : snap.message }, "herd lifecycle: bg claim sweep could not snapshot the bg server; pane claims not swept this round");
    } else {
      const live = new Set(panes.map((p) => p.pane_id));
      for (const claim of candidates) {
        if (!claim.pane) continue;
        const ref = parsePaneRef(claim.pane);
        if (ref.server !== "bg" || live.has(ref.paneId)) continue;
        released.push(...bgClaims.releaseByPane(claim.pane));
      }
    }
    if (released.length > 0) log.info({ released }, "herd lifecycle: bg claim sweep released stale claims");
  }

  function watch(socket: string): void {
    if (subs.has(socket)) return;
    subs.set(socket, subscribe({
      sockPath: socket,
      subscriptions: WILDCARD_SUBSCRIPTIONS,
      onEvent: (ev) => { fireAndForget(handleEvent(socket === opts.defaultSocket ? null : socket, ev), { socket, pane: ev.pane_id }); },
      onState: (c) => {
        log.debug({ socket, connected: c }, "herd lifecycle: herdr stream state");
        if (c && socket === opts.bgSocket) fireAndForget(sweepClaims(), { socket });
      },
      log,
    }));
  }

  return {
    start() {
      watch(opts.defaultSocket);
      if (opts.bgSocket) watch(opts.bgSocket);
      for (const herd of store.list({ status: "active" })) if (herd.herdrSocket) watch(herd.herdrSocket);
      unhookBus = opts.bus.onBroadcast(onGateEvent);
      reconcilePanes();
      scheduleReconcile();
    },
    stop() {
      unhookBus?.();
      reconcileTimer?.clear();
      for (const s of subs.values()) s.stop();
      subs.clear();
      for (const s of paneSubs.values()) s.stop();
      paneSubs.clear();
      for (const t of blockedTimers.values()) t.clear();
      blockedTimers.clear();
    },
    watch,
    connected: (socket) => subs.get(socketKey(socket))?.connected() ?? false,
    handleEvent,
    reconcilePanes,
    sweepClaims,
  };
}
