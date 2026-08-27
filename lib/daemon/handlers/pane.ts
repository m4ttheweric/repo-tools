/**
 * pane:* daemon handlers: herdr's panes joined to rt's presence.
 * lib/herdr/client.ts owns the socket; this module owns the join.
 */
import type { Database } from "bun:sqlite";
import { basename } from "path";
import type { AgentStatus, BuddyStatus, ChatPane, Commands, PaneDirectory } from "../../../packages/rt-client/src/commands.ts";
import { listCswapAccounts } from "../../cswap.ts";
import { HERDR_UNAVAILABLE, herdrRequest, waitTimeout, type HerdrResult } from "../../herdr/client.ts";
import { shellQuote } from "../../herdr-launch.ts";
import { repoLabel } from "../../repo-label.ts";
import { getSetting } from "../../settings/resolve.ts";
import { branchForCwd, repoForCwd } from "../../repo-for-cwd.ts";
import { listBuddies, listRooms, type PresenceRow } from "../../state/index.ts";
import { runCapture } from "../../subprocess.ts";
import { loadRegistry } from "../../worktree/registry.ts";
import type { CommandResult, TypedHandlers } from "./types.ts";

export interface HerdrPane {
  pane_id: string;
  workspace_id: string;
  tab_id: string;
  agent?: string;
  agent_status: AgentStatus;
  cwd?: string;
  foreground_cwd?: string;
  terminal_title?: string;
  terminal_title_stripped?: string;
  agent_session?: { source: string; agent: string; kind: "id" | "path"; value: string };
}

export interface HerdrWorkspace {
  workspace_id: string;
  label: string;
}

export interface HerdrSnapshot {
  workspaces: HerdrWorkspace[];
  panes: HerdrPane[];
}

export interface HerdrAgent extends HerdrPane {
  state_change_seq?: number;
}

export interface PaneRowContext {
  db: Database;
  repoIndex: () => Record<string, string>;
  exec: typeof runCapture;
  now: () => number;
  workspaces: Map<string, string>;
  bySession: Map<string, PresenceRow & { status: BuddyStatus }>;
  byPane: Map<string, PresenceRow & { status: BuddyStatus }>;
}

const STATUS_ORDER: Record<BuddyStatus | "none", number> = { live: 0, idle: 1, deaf: 2, offline: 3, none: 3 };

const REGISTER_BUDGET_MS = 10_000;
const REGISTER_POLL_MS = 250;
const IDLE_BUDGET_MS = 50_000;
const TRUST_BUDGET_MS = 15_000;
const PROMPT_BUDGET_MS = 5_000;
const SETTLED = ["idle", "done", "blocked"];

export function launchCommand(a: { cwd: string; account?: string; model?: string; effort?: string }): string {
  const claude = ["claude", ...(a.model ? ["--model", shellQuote(a.model)] : []), ...(a.effort ? ["--effort", shellQuote(a.effort)] : [])].join(" ");
  const launch = a.account ? `cswap run ${shellQuote(a.account)} --share-history -- ${claude}` : claude;
  return `cd ${shellQuote(a.cwd)} && ${launch}`;
}

export function herdrError(res: { ok: false; code: string; message: string }): { ok: false; error: string } {
  if (res.code === "unreachable" || res.code === "timeout") return { ok: false, error: res.message.startsWith(HERDR_UNAVAILABLE) ? res.message : `${HERDR_UNAVAILABLE}: ${res.message}` };
  return { ok: false, error: `${res.code}: ${res.message}` };
}

/** Presence maps built once per verb call; offline rows are not presence. */
export function presenceMaps(db: Database, now: number): Pick<PaneRowContext, "bySession" | "byPane"> {
  const bySession = new Map<string, PresenceRow & { status: BuddyStatus }>();
  const byPane = new Map<string, PresenceRow & { status: BuddyStatus }>();
  for (const row of listBuddies(now, db)) {
    if (row.status === "offline") continue;
    bySession.set(row.sessionId, row);
    if (row.pane) byPane.set(row.pane, row);
  }
  return { bySession, byPane };
}

export async function paneRow(pane: HerdrPane, ctx: PaneRowContext): Promise<ChatPane> {
  const sessionId = pane.agent_session?.kind === "id" ? pane.agent_session.value : undefined;
  const presence = (sessionId ? ctx.bySession.get(sessionId) : undefined) ?? ctx.byPane.get(pane.pane_id);
  const cwd = pane.foreground_cwd ?? pane.cwd;
  let repo = presence?.repo;
  let branch = presence?.branch;
  if (!presence && cwd) {
    repo = repoForCwd(cwd, ctx.repoIndex()) ?? undefined;
    branch = await branchForCwd(cwd, ctx.exec);
  }
  return {
    paneId: pane.pane_id,
    workspace: ctx.workspaces.get(pane.workspace_id) ?? pane.workspace_id,
    title: pane.terminal_title_stripped ?? pane.terminal_title,
    cwd,
    repo,
    branch,
    agentStatus: pane.agent_status,
    sessionId,
    presence: presence
      ? { handle: presence.handle, status: presence.status, rooms: listRooms(presence.handle, ctx.db).map((r) => r.room) }
      : undefined,
  };
}

export function sortPanes(panes: ChatPane[]): ChatPane[] {
  return panes
    .map((p, i) => ({ p, i }))
    .sort((a, b) => STATUS_ORDER[a.p.presence?.status ?? "none"] - STATUS_ORDER[b.p.presence?.status ?? "none"] || a.i - b.i)
    .map(({ p }) => p);
}

export function createPaneHandlers(opts: {
  db: Database;
  repoIndex: () => Record<string, string>;
  herdr?: typeof herdrRequest;
  exec?: typeof runCapture;
  now?: () => number;
  registry?: (repoName: string) => Array<{ path: string; branch: string | null | undefined }>;
}): Pick<TypedHandlers, "pane:list" | "pane:peek" | "pane:accounts" | "pane:directories" | "pane:spawn"> & { db: Database } {
  const { db, repoIndex } = opts;
  const herdr = opts.herdr ?? herdrRequest;
  const exec = opts.exec ?? runCapture;
  const now = opts.now ?? Date.now;
  const registry = opts.registry ?? ((name: string) => loadRegistry(name));

  async function snapshot(): Promise<HerdrResult<{ snapshot: HerdrSnapshot }>> {
    return herdr<{ snapshot: HerdrSnapshot }>("session.snapshot", {});
  }

  return {
    db,

    "pane:list": async (): Promise<CommandResult<"pane:list">> => {
      const snap = await snapshot();
      if (!snap.ok) return herdrError(snap);
      const ctx: PaneRowContext = {
        db, repoIndex, exec, now,
        workspaces: new Map(snap.result.snapshot.workspaces.map((w) => [w.workspace_id, w.label])),
        ...presenceMaps(db, now()),
      };
      const claude = snap.result.snapshot.panes.filter((p) => p.agent === "claude");
      const rows = await Promise.all(claude.map((p) => paneRow(p, ctx)));
      return { ok: true, data: { panes: sortPanes(rows) } };
    },

    "pane:peek": async (payload: Commands["pane:peek"]["payload"]): Promise<CommandResult<"pane:peek">> => {
      const params: Record<string, unknown> = { pane_id: payload.paneId, source: "visible" };
      if (payload.lines !== undefined) params.lines = payload.lines;
      const res = await herdr<{ read: { text: string } }>("pane.read", params);
      if (!res.ok) return herdrError(res);
      const lines = res.result.read.text.split("\n");
      while (lines.length && lines[lines.length - 1]!.trim() === "") lines.pop();
      return { ok: true, data: { paneId: payload.paneId, lines } };
    },

    "pane:accounts": async (): Promise<CommandResult<"pane:accounts">> => {
      return { ok: true, data: { accounts: await listCswapAccounts(exec) } };
    },

    "pane:directories": async (payload: Commands["pane:directories"]["payload"]): Promise<CommandResult<"pane:directories">> => {
      const q = payload.q?.toLowerCase();
      const seen = new Set<string>();
      const out: PaneDirectory[] = [];
      const push = (d: PaneDirectory) => {
        if (seen.has(d.path)) return;
        if (q && !d.path.toLowerCase().includes(q)) return;
        seen.add(d.path);
        out.push(d);
      };
      for (const [name, path] of Object.entries(repoIndex()).sort(([, a], [, b]) => a.localeCompare(b))) {
        const repo = repoLabel(name);
        push({ path, repo });
        // One repo's registry throwing (corrupt kv row, etc.) must not blank every other repo's listing.
        let trees: Array<{ path: string; branch: string | null | undefined }> = [];
        try {
          trees = registry(name);
        } catch {
          trees = [];
        }
        for (const tree of trees) push({ path: tree.path, repo, ...(tree.branch ? { branch: tree.branch } : {}) });
      }
      return { ok: true, data: { directories: out } };
    },

    "pane:spawn": async (payload: Commands["pane:spawn"]["payload"]): Promise<CommandResult<"pane:spawn">> => {
      const { cwd, account, model, effort, prompt } = payload;
      if (!cwd || !cwd.startsWith("/")) return { ok: false, error: "cwd must be an absolute path" };
      if (account) {
        const accounts = await listCswapAccounts(exec);
        const known = accounts.some((a) => a.alias === account || a.email === account || String(a.slot) === account);
        if (!known) return { ok: false, error: `unknown cswap account "${account}"` };
      }

      const label = payload.workspace ?? getSetting<string>("chat.herdrWorkspace").value ?? "chat";
      const list = await herdr<{ workspaces: HerdrWorkspace[] }>("workspace.list", {});
      if (!list.ok) return herdrError(list);
      let workspaceId = list.result.workspaces.find((w) => w.label === label)?.workspace_id;
      if (!workspaceId) {
        const created = await herdr<{ workspace: HerdrWorkspace }>("workspace.create", { label, focus: false });
        if (!created.ok) return herdrError(created);
        workspaceId = created.result.workspace.workspace_id;
      }

      const tab = await herdr<{ root_pane: HerdrPane }>("tab.create", { workspace_id: workspaceId, label: basename(cwd), cwd, focus: false });
      if (!tab.ok) return herdrError(tab);
      const paneId = tab.result.root_pane.pane_id;

      const sent = await herdr("pane.send_input", { pane_id: paneId, text: launchCommand({ cwd, account, model, effort }), keys: ["enter"] });
      if (!sent.ok) return herdrError(sent);

      // herdr registers the agent a few hundred ms after the shell starts claude.
      // Bound the wait by wall-clock, not a fixed attempt count: a slow-but-alive
      // herdr can make each agent.get take up to the plain socket timeout, so a
      // count of attempts would run many times the intended budget while pane:spawn
      // holds its caller.
      let registered = false;
      const registerDeadline = now() + REGISTER_BUDGET_MS;
      while (now() < registerDeadline) {
        const got = await herdr("agent.get", { target: paneId });
        if (got.ok) {
          registered = true;
          break;
        }
        await Bun.sleep(REGISTER_POLL_MS);
      }

      let status: AgentStatus = "unknown";
      let ready = false;
      if (registered) {
        const settled = await herdr<{ agent: HerdrAgent }>("agent.wait", { target: paneId, until: SETTLED, timeout_ms: IDLE_BUDGET_MS }, { timeoutMs: waitTimeout(IDLE_BUDGET_MS) });
        if (settled.ok) status = settled.result.agent.agent_status;
        if (status === "blocked") {
          const screen = await herdr<{ read: { text: string } }>("pane.read", { pane_id: paneId, source: "visible" });
          if (screen.ok && /trust/i.test(screen.result.read.text)) {
            await herdr("pane.send_keys", { pane_id: paneId, keys: ["enter"] });
            const again = await herdr<{ agent: HerdrAgent }>("agent.wait", { target: paneId, until: SETTLED, timeout_ms: TRUST_BUDGET_MS }, { timeoutMs: waitTimeout(TRUST_BUDGET_MS) });
            if (again.ok) status = again.result.agent.agent_status;
          }
        }
        ready = status === "idle" || status === "done";
      }

      if (ready && prompt) {
        await herdr("agent.prompt", { target: paneId, text: prompt, wait: { until: ["working"], timeout_ms: PROMPT_BUDGET_MS } }, { timeoutMs: waitTimeout(PROMPT_BUDGET_MS) });
      }

      const info = await herdr<{ pane: HerdrPane }>("pane.get", { pane_id: paneId });
      const raw: HerdrPane = info.ok ? info.result.pane : { ...tab.result.root_pane, agent: "claude", agent_status: status };
      const ctx: PaneRowContext = { db, repoIndex, exec, now, workspaces: new Map([[workspaceId, label]]), ...presenceMaps(db, now()) };
      const pane = await paneRow(raw, ctx);
      return { ok: true, data: { pane, ready } };
    },
  };
}
