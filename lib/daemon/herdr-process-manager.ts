// lib/daemon/herdr-process-manager.ts
import type { HerdrClient } from "./herdr/client.ts";
import { PaneMap, type PaneRef } from "./herdr/pane-map.ts";
import type { StateStore } from "./state-store.ts";

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
  }

  async kill(id: string): Promise<void> {
    const ref = this.paneMap.get(id);
    this.stateStore.setState(id, "stopping");
    if (ref) { try { await this.client.call("pane.close", { pane_id: ref.paneId }); } catch { /* gone */ } }
    this.paneMap.delete(id);
    this.stateStore.setState(id, "stopped");
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

  // Filled in Tasks 8-9 (output feed + write/resize). Stubs keep consumers compiling.
  subscribeToOutput(id: string, cb: (chunk: Uint8Array) => void): () => void {
    if (!this.outputHooks.has(id)) this.outputHooks.set(id, new Set());
    this.outputHooks.get(id)!.add(cb);
    return () => { this.outputHooks.get(id)?.delete(cb); };
  }
  getTerminal(_id: string): undefined { return undefined; }
  emitNotice(_id: string, _text: string): void { /* TODO Task 8 */ }
}
