/**
 * Pane lifecycle for herd jobs, from herdr's own event stream. Only
 * `blocked` (debounced) and pane exit are forwarded to the room; the
 * working/idle flips herdr emits on every turn boundary are ignored, since
 * forwarding them is what trained shepherds to skip checks.
 */
import type { Logger } from "pino";
import type { EventsBus } from "./events-bus.ts";
import type { GatesStore } from "./gates-store.ts";
import type { HerdStore, HerdJobRow } from "./herd-store.ts";
import { subscribeHerdrEvents as defaultSubscribe, type HerdrEvent, type HerdrSubscription } from "../herdr/subscribe.ts";
import { SYSTEM_HANDLE } from "./handlers/herd.ts";

export interface HerdLifecycle {
  start(): void;
  stop(): void;
  watch(socket: string): void;
  connected(socket: string | null): boolean;
  handleEvent(socket: string | null, ev: HerdrEvent): Promise<void>;
  reconcilePanes(): void;
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

const LIVE: ReadonlySet<string> = new Set(["active", "at-gate", "at-milestone"]);
const WATCHED: ReadonlySet<string> = new Set(["spawning", "active", "at-gate", "at-milestone"]);
const RECONCILE_MS = 30_000;

export function createHerdLifecycle(opts: {
  store: HerdStore;
  gate: { "gate:close": (p: unknown) => Promise<any>; "gate:list": (p: unknown) => Promise<any> };
  chat: { "chat:post": (p: unknown) => Promise<any> };
  bus: Pick<EventsBus, "onBroadcast">;
  gateStore: Pick<GatesStore, "get">;
  defaultSocket: string;
  subscribe?: typeof defaultSubscribe;
  blockedDebounceMs?: number;
  setTimer?: (fn: () => void, ms: number) => { clear(): void };
  log: Logger;
}): HerdLifecycle {
  const { store, log } = opts;
  const subscribe = opts.subscribe ?? defaultSubscribe;
  const debounceMs = opts.blockedDebounceMs ?? 30_000;
  const setTimer = opts.setTimer ?? ((fn, ms) => { const t = setTimeout(fn, ms); return { clear: () => clearTimeout(t) }; });
  const subs = new Map<string, HerdrSubscription>();
  const paneSubs = new Map<string, HerdrSubscription>();
  const blockedTimers = new Map<string, { clear(): void }>();
  let unhookBus: (() => void) | undefined;
  let reconcileTimer: { clear(): void } | undefined;

  const socketKey = (s: string | null) => s ?? opts.defaultSocket;
  const paneKey = (socket: string | null, pane: string) => `${socketKey(socket)}|${pane}`;

  function watchPane(socket: string | null, pane: string): void {
    const key = paneKey(socket, pane);
    if (paneSubs.has(key)) return;
    paneSubs.set(key, subscribe({
      sockPath: socketKey(socket),
      subscriptions: paneStatusSubscription(pane),
      onEvent: (ev) => { void handleEvent(socket, ev); },
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

  function jobFor(socket: string | null, pane: string): { job: HerdJobRow; room: string; shepherd: string } | null {
    for (const job of store.jobsByPane(pane)) {
      const herd = store.get(job.herd);
      if (!herd || herd.status !== "active") continue;
      if (socketKey(herd.herdrSocket) !== socketKey(socket)) continue;
      return { job, room: herd.room, shepherd: herd.shepherdHandle };
    }
    return null;
  }

  async function post(room: string, shepherd: string, body: string): Promise<void> {
    const res = await opts.chat["chat:post"]({ room, handle: SYSTEM_HANDLE, body, mentions: [shepherd] });
    if (!res.ok) log.warn({ room, error: res.error }, "herd lifecycle: room post failed");
  }

  async function closeOpenGates(herdId: string, job: string): Promise<void> {
    const res = await opts.gate["gate:list"]({ open: true, subjectPrefix: `herd:${herdId}/${job}` });
    if (!res.ok) return;
    for (const g of res.data.gates as Array<{ id: string; subject: string }>) {
      if (g.subject !== `herd:${herdId}/${job}`) continue;
      await opts.gate["gate:close"]({ id: g.id, reason: "abandoned" });
    }
  }

  async function handleEvent(socket: string | null, ev: HerdrEvent): Promise<void> {
    const pane = typeof ev.pane_id === "string" ? ev.pane_id : undefined;
    if (!pane) return;
    const hit = jobFor(socket, pane);
    if (!hit) return;
    const { job, room, shepherd } = hit;
    const key = paneKey(socket, pane);

    if (ev.type === "pane.agent_detected") {
      if (job.status === "spawning") store.setJobStatus(job.herd, job.name, "active");
      watchPane(socket, pane);
      return;
    }
    if (ev.type === "pane.agent_status_changed") {
      if (ev.agent_status === "blocked") {
        if (blockedTimers.has(key) || job.status === "closed") return;
        blockedTimers.set(key, setTimer(() => {
          blockedTimers.delete(key);
          void post(room, shepherd, `${job.name} blocked (pane ${pane})`);
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
      if (LIVE.has(job.status) || job.status === "spawning") {
        store.setJobStatus(job.herd, job.name, "crashed");
        await closeOpenGates(job.herd, job.name);
        await post(room, shepherd, `${job.name} exited (pane ${pane})`);
      } else if (job.status !== "closed") {
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

  function watch(socket: string): void {
    if (subs.has(socket)) return;
    subs.set(socket, subscribe({
      sockPath: socket,
      subscriptions: WILDCARD_SUBSCRIPTIONS,
      onEvent: (ev) => { void handleEvent(socket === opts.defaultSocket ? null : socket, ev); },
      onState: (c) => log.debug({ socket, connected: c }, "herd lifecycle: herdr stream state"),
      log,
    }));
  }

  return {
    start() {
      watch(opts.defaultSocket);
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
  };
}
