/**
 * herd:* ... the shepherd's run registry. Every verb is a composition of
 * existing handlers (gate, chat, agent, worktree) so the herd owns no
 * delivery, CAS, or spawn semantics of its own.
 */
import { join } from "path";
import type { Logger } from "pino";
import type { Commands, GateRow, HerdStatusData } from "../../../packages/rt-client/src/commands.ts";
import type { CommandResult } from "./types.ts";
import type { HerdStore, HerdJobRow } from "../herd-store.ts";
import { herdSubject, mintHerdId } from "../herd-store.ts";
import type { GatesStore } from "../gates-store.ts";
import type { createGateHandlers } from "./gate.ts";
import type { createChatHandlers } from "./chat.ts";
import type { createAgentHandlers } from "./agent.ts";
import type { herdrRequest } from "../../herdr/client.ts";
import type { HerdrRunner } from "../../agent-herdr.ts";
import { slugifyChatName } from "../../chat-room-name.ts";

export interface HerdDeps {
  store: HerdStore;
  gateStore: Pick<GatesStore, "get">;
  gate: Pick<ReturnType<typeof createGateHandlers>, "gate:open" | "gate:list" | "gate:close" | "gate:subscribe" | "gate:subscriptions">;
  chat: Pick<ReturnType<typeof createChatHandlers>, "chat:sign-in" | "chat:join" | "chat:post" | "chat:archive" | "chat:rooms">;
  agent: Pick<ReturnType<typeof createAgentHandlers>, "agent:start">;
  worktree: { "worktree:provision": (payload: any) => Promise<any>; "worktree:dispose": (payload: any) => Promise<any> };
  runWorktree: (runId: string) => string | null;
  /** The chat handle a session already holds, or null; wired from `presenceForSession` in lib/state/presence-store.ts. */
  presenceHandleForSession: (session: string) => string | null;
  herdr: typeof herdrRequest;
  herdrRunnerFor: (socket: string | null) => HerdrRunner;
  lifecycle: { connected(socket: string | null): boolean; watch(socket: string): void };
  hidden: { socketPath(): string; ensure(): Promise<string>; up(): Promise<boolean>; stop(): Promise<void> };
  jobsRoot: string;
  log: Logger;
}

export const SHEPHERD_HANDLE = "shepherd";
export const SYSTEM_HANDLE = "herdr";
export const MILESTONE_OPTIONS = ["Approve", "Revise", "Spawn a reviewer"] as const;

const HERD_NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);

export function workspaceLabel(herdId: string): string { return `herd: ${herdId}`; }
export function roomName(herdId: string): string { return slugifyChatName(`herd-${herdId}`); }
export function jobDir(jobsRoot: string, herdId: string, job: string): string { return join(jobsRoot, herdId, job); }

export function createHerdHandlers(deps: HerdDeps) {
  const { store, log } = deps;

  async function subscribeShepherd(herdId: string, session: string): Promise<CommandResult<"gate:subscribe">> {
    return deps.gate["gate:subscribe"]({ subjectPrefix: `herd:${herdId}/`, session });
  }

  async function paneStatuses(socket: string | null): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const snap = await deps.herdr<{ snapshot: { panes?: Array<{ pane_id: string; agent_status?: string }> } }>("session.snapshot", {}, socket ? { sockPath: socket } : {});
    if (!snap.ok) return out;
    for (const p of snap.result.snapshot.panes ?? []) if (p.agent_status) out.set(p.pane_id, p.agent_status);
    return out;
  }

  async function unreadFor(handle: string, room: string): Promise<number> {
    const res = await deps.chat["chat:rooms"]({ handle });
    if (!res.ok) return 0;
    const row = (res.data.rooms as Array<{ room: string; unread: number }>).find((r) => r.room === room);
    return row?.unread ?? 0;
  }

  async function openHerdGates(herdId: string): Promise<GateRow[]> {
    const res = await deps.gate["gate:list"]({ open: true, subjectPrefix: `herd:${herdId}/` });
    return res.ok ? res.data.gates : [];
  }

  async function statusData(herdId: string): Promise<HerdStatusData | null> {
    const herd = store.get(herdId);
    if (!herd) return null;
    const [panes, gates, unread, subs] = await Promise.all([
      paneStatuses(herd.herdrSocket), openHerdGates(herdId), unreadFor(herd.shepherdHandle, herd.room),
      deps.gate["gate:subscriptions"]({ session: herd.shepherdSession, live: true }),
    ]);
    const jobs = store.jobs(herdId).map((j: HerdJobRow) => {
      const last = j.lastGate ? deps.gateStore.get(j.lastGate) : null;
      return {
        ...j,
        openGate: gates.find((g) => g.subject === herdSubject(herdId, j.name))?.id ?? null,
        paneStatus: j.pane ? (panes.get(j.pane) ?? null) : null,
        lastGateStatus: last?.status ?? null,
        lastGateDelivery: last?.delivery?.outcome ?? null,
      };
    });
    const subRow = subs.ok ? subs.data.subscriptions.find((s) => s.subjectPrefix === `herd:${herdId}/`) ?? null : null;
    return {
      herd, jobs, unread,
      lifecycleConnected: deps.lifecycle.connected(herd.herdrSocket),
      hiddenUp: herd.hidden ? await deps.hidden.up() : null,
      subscription: subRow ? { id: subRow.id, dead: subRow.dead, lastDelivery: subRow.lastDelivery } : null,
    };
  }

  /** Never throws: a pane that cannot be closed (herdr gone, stale binary,
      non-zero exit) must not block the caller's own bookkeeping. */
  async function closePane(socket: string | null, pane: string, context: Record<string, unknown>): Promise<boolean> {
    try {
      const r = await deps.herdrRunnerFor(socket)(["pane", "close", pane]);
      if (r.exitCode === 0) return true;
      log.warn({ ...context, pane, exitCode: r.exitCode }, "herd: pane close failed");
    } catch (err) {
      log.warn({ err, ...context, pane }, "herd: pane close threw");
    }
    return false;
  }

  function uniqueHerdId(name: string): string {
    const base = mintHerdId(name);
    if (!store.get(base)) return base;
    for (let n = 2; ; n++) { const id = `${base}-${n}`; if (!store.get(id)) return id; }
  }

  return {
    "herd:start": async (raw: unknown): Promise<CommandResult<"herd:start">> => {
      const p = raw as Commands["herd:start"]["payload"] | undefined;
      const name = str(p?.name); const repo = str(p?.repo); const session = str(p?.session);
      if (!name || !HERD_NAME_RE.test(name)) return { ok: false, error: `invalid herd name "${p?.name ?? ""}" (must match ${HERD_NAME_RE})` };
      if (!repo) return { ok: false, error: "missing repo" };
      if (!session) return { ok: false, error: "missing session (run inside a Claude Code session, or pass --session)" };
      const hidden = p?.hidden === true;
      const id = uniqueHerdId(name);
      const room = roomName(id);
      let herdrSocket: string | null = null;
      // Awaited before the store row exists, so a failed hidden start leaves
      // no half-registered herd behind.
      if (hidden) herdrSocket = await deps.hidden.ensure();

      let handle = deps.presenceHandleForSession(session);
      if (!handle) {
        const signIn = await deps.chat["chat:sign-in"]({ sessionId: session, baseHandle: SHEPHERD_HANDLE, noRoom: true });
        if (!signIn.ok) return signIn;
        handle = signIn.data.handle;
      }
      const join = await deps.chat["chat:join"]({ room, handle });
      if (!join.ok) return join;

      const sub = await subscribeShepherd(id, session);
      if (!sub.ok) return sub;
      store.create({ id, repo, room, workspace: workspaceLabel(id), shepherdSession: session, shepherdHandle: handle, herdrSocket, hidden });
      if (herdrSocket) deps.lifecycle.watch(herdrSocket);
      log.info({ herd: id, room, hidden }, "herd started");
      return { ok: true, data: { herd: id, room, workspace: workspaceLabel(id), subscription: sub.data.id, handle, hidden } };
    },

    "herd:resume": async (raw: unknown): Promise<CommandResult<"herd:resume">> => {
      const p = raw as Commands["herd:resume"]["payload"] | undefined;
      const herdId = str(p?.herd); const session = str(p?.session);
      if (!herdId || !session) return { ok: false, error: "herd and session are required" };
      const herd = store.get(herdId);
      if (!herd) return { ok: false, error: `unknown herd "${herdId}"` };
      const sub = await subscribeShepherd(herdId, session);
      if (!sub.ok) return sub;
      store.setShepherd(herdId, { session, handle: herd.shepherdHandle });
      const status = (await statusData(herdId))!;
      return { ok: true, data: { subscription: sub.data.id, gates: await openHerdGates(herdId), unread: status.unread, status } };
    },

    "herd:status": async (raw: unknown): Promise<CommandResult<"herd:status">> => {
      const herdId = str((raw as { herd?: unknown } | undefined)?.herd);
      if (!herdId) return { ok: false, error: "herd is required" };
      const data = await statusData(herdId);
      return data ? { ok: true, data } : { ok: false, error: `unknown herd "${herdId}"` };
    },

    "herd:close": async (raw: unknown): Promise<CommandResult<"herd:close">> => {
      const p = raw as Commands["herd:close"]["payload"] | undefined;
      const herdId = str(p?.herd); const name = str(p?.job);
      if (!herdId || !name) return { ok: false, error: "herd and job are required" };
      const herd = store.get(herdId);
      const job = herd ? store.getJob(herdId, name) : null;
      if (!herd || !job) return { ok: false, error: `unknown job "${name}" in herd "${herdId}"` };
      if (job.pane) await closePane(herd.herdrSocket, job.pane, { herd: herdId, job: name });
      store.setJobStatus(herdId, name, "closed");
      return { ok: true, data: { job: name, status: "closed" } };
    },
  };
}
