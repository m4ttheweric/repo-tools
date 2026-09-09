/**
 * pane:* daemon handlers: herdr's panes joined to rt's presence.
 * lib/herdr/client.ts owns the socket; this module owns the join.
 */
import type { Database } from "bun:sqlite";
import { basename } from "path";
import type { AgentStatus, BuddyStatus, ChatPane, Commands, PaneDirectory } from "../../../packages/rt-client/src/commands.ts";
import { formatPaneRef, parsePaneRef } from "../../../packages/rt-client/src/index.ts";
import { listCswapAccounts } from "../../cswap.ts";
import { herdrRequest, waitTimeout, type HerdrResult } from "../../herdr/client.ts";
import { trayRequest } from "../../daemon-client.ts";
import { herdrError, injectIntoPane } from "../inject.ts";
import { resolvePaneRef } from "../pane-ref-socket.ts";
import { attendPane } from "../attend.ts";
import { BG_SESSION, bgSocketPath, type BgService } from "../bg-service.ts";
import type { HerdrRunner } from "../../agent-herdr.ts";
import { shellQuote } from "../../herdr-launch.ts";
import { repoLabel } from "../../repo-label.ts";
import { getSetting } from "../../settings/resolve.ts";
import { branchForCwd, repoForCwd } from "../../repo-for-cwd.ts";
import { listBuddies, listRooms, type PresenceRow, type RegistryDeps } from "../../state/index.ts";
import { runCapture } from "../../subprocess.ts";
import { loadRegistry } from "../../worktree/registry.ts";
import type { CommandResult } from "./types.ts";

const FOCUS_NO_WORKSPACE = "focus for a background pane must run from a herdr pane; HERDR_WORKSPACE_ID is unset";

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
  focused?: boolean;
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

const STATUS_ORDER: Record<BuddyStatus | "none", number> = { live: 0, idle: 1, offline: 2, none: 2 };

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

export { herdrError } from "../inject.ts";

/** Presence maps built once per verb call; offline rows are not presence. */
export function presenceMaps(db: Database, now: number, deps?: RegistryDeps): Pick<PaneRowContext, "bySession" | "byPane"> {
  const bySession = new Map<string, PresenceRow & { status: BuddyStatus }>();
  const byPane = new Map<string, PresenceRow & { status: BuddyStatus }>();
  for (const row of listBuddies(now, db, deps)) {
    if (row.status === "offline") continue;
    bySession.set(row.sessionId, row);
    if (row.pane) byPane.set(row.pane, row);
  }
  return { bySession, byPane };
}

/**
 * `presenceRef` defaults to the bare id (a visible-server lookup) but a bg
 * row must pass its `bg:`-formatted ref: presence.pane is bound in ref space
 * (round-trip rule, spec "Addressing"), so a bare-id lookup against a bg
 * pane's row in `ctx.byPane` would always miss even though it is the same
 * pane.
 */
export async function paneRow(pane: HerdrPane, ctx: PaneRowContext, presenceRef: string = pane.pane_id): Promise<ChatPane> {
  const sessionId = pane.agent_session?.kind === "id" ? pane.agent_session.value : undefined;
  const presence = (sessionId ? ctx.bySession.get(sessionId) : undefined) ?? ctx.byPane.get(presenceRef);
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
    focused: pane.focused ?? false,
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
  tray?: typeof trayRequest;
  exec?: typeof runCapture;
  now?: () => number;
  registry?: (repoName: string) => Array<{ path: string; branch: string | null | undefined }>;
  /** The registry probe behind buddyStatus, fakeable the same way lib/daemon/handlers/chat.ts's registryDeps is. */
  registryDeps?: RegistryDeps;
  /** The bg server pane:list appends when up, and pane:focus attends into for a `bg:` ref. Omitted in tests that never touch either. */
  bg?: BgService;
  /** attendPane's herdr-CLI runner factory, wired the same way herd:attend gets it (lib/daemon/command-router.ts). */
  herdrRunnerFor?: (socket: string | null) => HerdrRunner;
}):
  // Declared as direct `unknown`-payload members (not `Pick<TypedHandlers, ...>`)
  // rather than the narrower per-command payload types the catalog would
  // otherwise force: a wider `unknown` param still satisfies TypedHandlers'
  // narrower one at the command-router.ts assembly site (function parameter
  // contravariance).
  & { "pane:list": (payload: unknown) => Promise<CommandResult<"pane:list">> }
  & { "pane:peek": (payload: unknown) => Promise<CommandResult<"pane:peek">> }
  & { "pane:accounts": (payload: unknown) => Promise<CommandResult<"pane:accounts">> }
  & { "pane:directories": (payload: unknown) => Promise<CommandResult<"pane:directories">> }
  & { "pane:send": (payload: unknown) => Promise<CommandResult<"pane:send">> }
  & { "pane:focus": (payload: unknown) => Promise<CommandResult<"pane:focus">> }
  & { "pane:spawn": (payload: unknown, signal?: AbortSignal) => Promise<CommandResult<"pane:spawn">> } {
  const { db, repoIndex } = opts;
  const herdr = opts.herdr ?? herdrRequest;
  const tray = opts.tray ?? trayRequest;
  const exec = opts.exec ?? runCapture;
  const now = opts.now ?? Date.now;
  const registry = opts.registry ?? ((name: string) => loadRegistry(name));
  const registryDeps = opts.registryDeps;
  const bg = opts.bg;
  const herdrRunnerFor = opts.herdrRunnerFor;

  async function snapshot(sockPath?: string): Promise<HerdrResult<{ snapshot: HerdrSnapshot }>> {
    return herdr<{ snapshot: HerdrSnapshot }>("session.snapshot", {}, { sockPath });
  }

  return {
    "pane:list": async (_payload: unknown): Promise<CommandResult<"pane:list">> => {
      const snap = await snapshot();
      if (!snap.ok) return herdrError(snap);
      const presence = presenceMaps(db, now(), registryDeps);
      const ctx: PaneRowContext = {
        db, repoIndex, exec, now,
        workspaces: new Map(snap.result.snapshot.workspaces.map((w) => [w.workspace_id, w.label])),
        ...presence,
      };
      const claude = snap.result.snapshot.panes.filter((p) => p.agent === "claude");
      const rows = await Promise.all(claude.map((p) => paneRow(p, ctx)));

      // Ensure-on-touch never applies here (spec "The bg service"): a
      // read-shaped list only looks when the server is already up, never
      // starts one just to find it empty.
      const bgRows: ChatPane[] = [];
      if (bg && (await bg.up())) {
        const bgSnap = await snapshot(bg.socketPath());
        if (bgSnap.ok) {
          const bgCtx: PaneRowContext = {
            db, repoIndex, exec, now,
            workspaces: new Map(bgSnap.result.snapshot.workspaces.map((w) => [w.workspace_id, w.label])),
            ...presence,
          };
          const bgClaude = bgSnap.result.snapshot.panes.filter((p) => p.agent === "claude");
          for (const p of bgClaude) {
            const row = await paneRow(p, bgCtx, formatPaneRef(p.pane_id, "bg"));
            bgRows.push({ ...row, paneId: formatPaneRef(row.paneId, "bg") });
          }
        }
        // A snapshot failure here (server went down between up() and the
        // call) degrades to "no bg panes this round" rather than failing
        // the whole list -- the visible section is still good news.
      }
      return { ok: true, data: { panes: sortPanes([...rows, ...bgRows]) } };
    },

    "pane:peek": async (rawPayload: unknown): Promise<CommandResult<"pane:peek">> => {
      const payload = rawPayload as Commands["pane:peek"]["payload"];
      const { paneId, sockPath } = resolvePaneRef(payload.paneId);
      const params: Record<string, unknown> = { pane_id: paneId, source: "visible" };
      if (payload.lines !== undefined) params.lines = payload.lines;
      const res = await herdr<{ read: { text: string } }>("pane.read", params, { sockPath });
      if (!res.ok) return herdrError(res);
      const lines = res.result.read.text.split("\n");
      while (lines.length && lines[lines.length - 1]!.trim() === "") lines.pop();
      return { ok: true, data: { paneId: payload.paneId, lines } };
    },

    "pane:accounts": async (_payload: unknown): Promise<CommandResult<"pane:accounts">> => {
      return { ok: true, data: { accounts: await listCswapAccounts(exec) } };
    },

    "pane:directories": async (rawPayload: unknown): Promise<CommandResult<"pane:directories">> => {
      const payload = rawPayload as Commands["pane:directories"]["payload"];
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

    "pane:spawn": async (rawPayload: unknown, signal?: AbortSignal): Promise<CommandResult<"pane:spawn">> => {
      const payload = rawPayload as Commands["pane:spawn"]["payload"];
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

      // pane:spawn's summed worst-case budget (register + idle wait + a
      // blocked-trust retry + the opening prompt) can run longer than
      // rt-client's own client-side timeout for this call. Once the caller
      // has given up, continuing to spend the daemon's budget only risks a
      // retry racing a second claude pane into the same cwd — so every step
      // past tab creation checks the signal first and returns the pane
      // already created (not-ready) rather than pressing on for a client
      // that is no longer listening.
      const earlyReturn = async (status: AgentStatus): Promise<CommandResult<"pane:spawn">> => {
        const ctx: PaneRowContext = { db, repoIndex, exec, now, workspaces: new Map([[workspaceId!, label]]), ...presenceMaps(db, now(), registryDeps) };
        const pane = await paneRow({ ...tab.result.root_pane, agent: "claude", agent_status: status }, ctx);
        return { ok: true, data: { pane, ready: false } };
      };

      const sent = await herdr("pane.send_input", { pane_id: paneId, text: launchCommand({ cwd, account, model, effort }), keys: ["enter"] });
      if (!sent.ok) return herdrError(sent);
      if (signal?.aborted) return earlyReturn("unknown");

      // herdr registers the agent a few hundred ms after the shell starts claude.
      // Bound the wait by wall-clock, not a fixed attempt count: a slow-but-alive
      // herdr can make each agent.get take up to the plain socket timeout, so a
      // count of attempts would run many times the intended budget while pane:spawn
      // holds its caller.
      let registered = false;
      const registerDeadline = now() + REGISTER_BUDGET_MS;
      while (now() < registerDeadline && !signal?.aborted) {
        const got = await herdr("agent.get", { target: paneId });
        if (got.ok) {
          registered = true;
          break;
        }
        await Bun.sleep(REGISTER_POLL_MS);
      }
      if (signal?.aborted) return earlyReturn("unknown");

      let status: AgentStatus = "unknown";
      let ready = false;
      if (registered) {
        const settled = await herdr<{ agent: HerdrAgent }>("agent.wait", { target: paneId, until: SETTLED, timeout_ms: IDLE_BUDGET_MS }, { timeoutMs: waitTimeout(IDLE_BUDGET_MS) });
        if (settled.ok) status = settled.result.agent.agent_status;
        if (signal?.aborted) return earlyReturn(status);
        if (status === "blocked") {
          const screen = await herdr<{ read: { text: string } }>("pane.read", { pane_id: paneId, source: "visible" });
          if (screen.ok && /trust/i.test(screen.result.read.text)) {
            await herdr("pane.send_keys", { pane_id: paneId, keys: ["enter"] });
            if (signal?.aborted) return earlyReturn(status);
            const again = await herdr<{ agent: HerdrAgent }>("agent.wait", { target: paneId, until: SETTLED, timeout_ms: TRUST_BUDGET_MS }, { timeoutMs: waitTimeout(TRUST_BUDGET_MS) });
            if (again.ok) status = again.result.agent.agent_status;
          }
        }
        ready = status === "idle" || status === "done";
      }
      if (signal?.aborted) return earlyReturn(status);

      if (ready && prompt) {
        await herdr("agent.prompt", { target: paneId, text: prompt, wait: { until: ["working"], timeout_ms: PROMPT_BUDGET_MS } }, { timeoutMs: waitTimeout(PROMPT_BUDGET_MS) });
      }

      const info = await herdr<{ pane: HerdrPane }>("pane.get", { pane_id: paneId });
      const raw: HerdrPane = info.ok ? info.result.pane : { ...tab.result.root_pane, agent: "claude", agent_status: status };
      const ctx: PaneRowContext = { db, repoIndex, exec, now, workspaces: new Map([[workspaceId, label]]), ...presenceMaps(db, now(), registryDeps) };
      const pane = await paneRow(raw, ctx);
      return { ok: true, data: { pane, ready } };
    },

    "pane:send": async (rawPayload: unknown): Promise<CommandResult<"pane:send">> => {
      const payload = rawPayload as Commands["pane:send"]["payload"];
      const { paneId, sockPath } = resolvePaneRef(payload.paneId);
      const res = await injectIntoPane({ paneId, text: payload.text, callerPane: payload.callerPane, herdr, sockPath });
      if (!res.ok) return res;
      // Echo the ref the caller passed in, not the bare id injectIntoPane
      // resolved against: the round-trip rule -- whatever a caller sends
      // addressably, every verb (including this one's own reply) prints
      // addressably back.
      return { ok: true, data: { ...res.data, paneId: payload.paneId } };
    },

    // The tray owns focusing: herdr's socket has no `pane focus`, and raising
    // the hosting terminal window is native macOS the daemon cannot do. The
    // daemon and tray always ship together, so this just routes the id over
    // tray.sock; a down tray is a clean error, never a degraded fallback.
    //
    // A `bg:` ref forks entirely: herdr has no focus, so there is no window
    // to raise -- focus for a background pane IS the attend flow instead.
    "pane:focus": async (rawPayload: unknown): Promise<CommandResult<"pane:focus">> => {
      const payload = rawPayload as Commands["pane:focus"]["payload"];
      const { server, paneId } = parsePaneRef(payload.paneId);
      if (server === "bg") {
        if (!payload.callerWorkspace) return { ok: false, error: FOCUS_NO_WORKSPACE };
        if (!herdrRunnerFor) return { ok: false, error: "attend is not configured on this daemon" };
        const res = await attendPane({
          socket: bgSocketPath(), paneId, session: BG_SESSION, label: paneId,
          callerWorkspace: payload.callerWorkspace, herdrRunnerFor,
        });
        if (!res.ok) return res;
        return { ok: true, data: { paneId: payload.paneId, focused: true, attendTab: res.tab } };
      }
      // The tray does four sequential herdr spawns (list + process-info +
      // workspace/tab focus) behind this call, so trayRequest's 2s default
      // would misreport a slow-but-working tray as down; sit under paneFocus's
      // 10s rt-client budget.
      const reply = await tray<{ ok?: boolean; focused?: boolean; error?: string }>("/pane/focus", {
        method: "POST",
        body: { paneId: payload.paneId },
        timeoutMs: 8_000,
      });
      if (reply.status === 0) return { ok: false, error: "tray unavailable" };
      if (reply.status < 200 || reply.status >= 300 || reply.json?.ok === false)
        return { ok: false, error: reply.json?.error ?? `tray focus failed (${reply.status})` };
      return { ok: true, data: { paneId: payload.paneId, focused: reply.json?.focused ?? true } };
    },
  };
}
