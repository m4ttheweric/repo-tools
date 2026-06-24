// lib/daemon/herdr-process-manager.ts
import type { HerdrClient } from "./herdr/client.ts";
import { PaneMap, type PaneRef } from "./herdr/pane-map.ts";
import type { StateStore } from "./state-store.ts";
import { paneToRecord, type HerdrPane } from "./herdr/records.ts";
import type { ProcessRecord } from "./process-records.ts";
import type { WorktreeInfo } from "./resolve-worktree.ts";
import { appendedSuffix } from "./herdr/output-diff.ts";

export interface HerdrPMConfig { cmd: string; cwd: string; env?: Record<string, string>; kind?: "terminal" }

export class HerdrProcessManager {
  userPath: string | undefined;
  suspendManager?: { resume(id: string): Promise<void> };
  private client: HerdrClient;
  private paneMap: PaneMap;
  private stateStore: StateStore;
  private now: () => number;
  private outputHooks = new Map<string, Set<(chunk: Uint8Array) => void>>();

  constructor(deps: { client: HerdrClient; paneMap: PaneMap; stateStore: StateStore; now?: () => number }) {
    this.client = deps.client; this.paneMap = deps.paneMap; this.stateStore = deps.stateStore;
    this.now = deps.now ?? (() => Date.now());
  }

  async spawn(id: string, cmd: string, opts: { cwd: string; env?: Record<string, string>; kind?: "terminal" }): Promise<void> {
    this.stateStore.setState(id, "starting");
    try {
      // Create a fresh workspace/pane for this cwd, then run the command in it.
      // (Probe confirmed workspace.create returns root_pane{pane_id,terminal_id,workspace_id}.)
      const ws = await this.client.call("workspace.create", { cwd: opts.cwd, label: id, focus: false, env: opts.env });
      const paneId = ws.root_pane.pane_id as string;
      await this.client.call("pane.run", { pane_id: paneId, text: cmd });
      const ref: PaneRef = {
        id, workspaceId: ws.root_pane.workspace_id, paneId, terminalId: ws.root_pane.terminal_id,
        cwd: opts.cwd, cmd, env: opts.env, port: opts.env?.PORT ? Number(opts.env.PORT) : undefined, startedAt: this.now(),
      };
      this.paneMap.set(ref);
      this.stateStore.setPid(id, undefined);
      this.stateStore.setState(id, "running");
    } catch (err) {
      this.stateStore.setState(id, "stopped");
      throw err;
    }
  }

  async kill(id: string): Promise<void> {
    const ref = this.paneMap.get(id);
    this.stateStore.setState(id, "stopping");
    if (ref) { try { await this.client.call("pane.close", { pane_id: ref.paneId }); } catch { /* gone */ } }
    this.stateStore.setState(id, "stopped");
    this.paneMap.delete(id);
  }

  async respawn(id: string): Promise<void> {
    const ref = this.paneMap.get(id);
    if (!ref) return;
    await this.kill(id);
    await this.spawn(id, ref.cmd, { cwd: ref.cwd, env: ref.env });
  }

  remove(id: string): void { this.paneMap.delete(id); }

  list(): { id: string; config: HerdrPMConfig; startedAt?: number; exitCode?: number }[] {
    return this.paneMap.all().map((r) => ({
      id: r.id, config: { cmd: r.cmd, cwd: r.cwd, env: r.env }, startedAt: r.startedAt,
    }));
  }

  getSpawnConfig(id: string): HerdrPMConfig | undefined {
    const r = this.paneMap.get(id);
    return r ? { cmd: r.cmd, cwd: r.cwd, env: r.env } : undefined;
  }

  async getProcess(id: string): Promise<{ pid: number } | undefined> {
    const r = this.paneMap.get(id);
    if (!r) return undefined;
    try {
      // Real pane.process_info shape: result.process_info.{foreground_processes[].pid, shell_pid}
      const info = await this.client.call("pane.process_info", { pane_id: r.paneId });
      const pid = info?.process_info?.foreground_processes?.[0]?.pid ?? info?.process_info?.shell_pid;
      return typeof pid === "number" ? { pid } : undefined;
    } catch { return undefined; }
  }

  getExitCode(_id: string): number | undefined { return undefined; }

  private lastText = new Map<string, string>();
  private pollTimers = new Map<string, ReturnType<typeof setInterval>>();

  private async pollOutput(id: string): Promise<void> {
    const ref = this.paneMap.get(id);
    if (!ref) return;
    let text = "";
    try {
      const r = await this.client.call("pane.read", { pane_id: ref.paneId, source: "recent_unwrapped" });
      // Socket response shape: { type: "pane_read", read: { text: "...", ... } }
      // Fallback: r.text for mock clients in tests, or r itself if string.
      text = typeof r === "string" ? r : (r?.read?.text ?? r?.text ?? "");
    } catch { return; }
    const prev = this.lastText.get(id) ?? "";
    const appended = appendedSuffix(prev, text);
    this.lastText.set(id, text);
    if (appended) {
      const bytes = new TextEncoder().encode(appended);
      for (const cb of this.outputHooks.get(id) ?? []) { try { cb(bytes); } catch { /* best-effort */ } }
    }
  }

  subscribeToOutput(id: string, cb: (chunk: Uint8Array) => void): () => void {
    if (!this.outputHooks.has(id)) this.outputHooks.set(id, new Set());
    this.outputHooks.get(id)!.add(cb);
    if (!this.pollTimers.has(id)) {
      this.pollTimers.set(id, setInterval(() => void this.pollOutput(id), 1000));
    }
    return () => {
      const set = this.outputHooks.get(id);
      set?.delete(cb);
      if (set && set.size === 0) {
        clearInterval(this.pollTimers.get(id)!);
        this.pollTimers.delete(id);
        this.outputHooks.delete(id);
        this.lastText.delete(id);
      }
    };
  }

  emitNotice(id: string, text: string): void {
    const bytes = new TextEncoder().encode(text);
    for (const cb of this.outputHooks.get(id) ?? []) { try { cb(bytes); } catch { /* best-effort */ } }
  }

  getTerminal(_id: string): undefined { return undefined; }

  private normalizePane(p: any): HerdrPane {
    return {
      paneId: p.pane_id, terminalId: p.terminal_id, workspaceId: p.workspace_id,
      cwd: p.cwd ?? p.foreground_cwd ?? "", agentStatus: p.agent_status ?? "unknown",
      foregroundCmd: p.foreground_cmd ?? p.command,
    };
  }
  private refByPaneId(paneId: string) { return this.paneMap.all().find((r) => r.paneId === paneId); }

  async describe(worktrees: WorktreeInfo[]): Promise<ProcessRecord[]> {
    const res = await this.client.call("pane.list").catch(() => ({ panes: [] }));
    const panes: any[] = res?.panes ?? [];
    return panes.map((p) => { const np = this.normalizePane(p); return paneToRecord(np, this.refByPaneId(np.paneId), worktrees); });
  }

  async reconcileOnBoot(): Promise<void> {
    const res = await this.client.call("pane.list").catch(() => ({ panes: [] }));
    const live = new Set<string>((res?.panes ?? []).map((p: any) => p.pane_id));
    const dropped = this.paneMap.reconcile(live);
    for (const r of this.paneMap.all()) this.stateStore.setState(r.id, "running");
    for (const id of dropped) this.stateStore.setState(id, "stopped");
  }
}
