/**
 * The runner's only door to herdr: the socket API, one request per
 * connection. No CLI spawns, no daemon. Every method throws EngineError on a
 * herdr error or an unreachable socket so the runner can pin the failure to
 * an entry instead of dying.
 */
import { herdrRequest, herdrSocketPath } from "../herdr/client.ts";
import { shellQuote } from "../herdr-launch.ts";

export class EngineError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "EngineError";
  }
}

export interface ProcessInfo {
  foregroundPgid: number | null;
  shellPid: number | null;
  foreground: { pid: number; name: string; cmdline: string | null }[];
}

export interface Engine {
  createWorkspace(label: string): Promise<{ workspaceId: string; tabId: string; paneId: string }>;
  createTab(workspaceId: string, label: string): Promise<{ tabId: string; paneId: string }>;
  renameTab(tabId: string, label: string): Promise<void>;
  focusTab(tabId: string): Promise<void>;
  run(paneId: string, cwd: string, command: string): Promise<void>;
  interrupt(paneId: string): Promise<void>;
  processInfo(paneId: string): Promise<ProcessInfo>;
  read(paneId: string, lines: number): Promise<string>;
  closeWorkspace(workspaceId: string): Promise<void>;
}

/** The exit sentinel is the only way to learn a pane command's exit code: process_info reports none. */
export const EXIT_SENTINEL = "__rt_exit";

export function wrapCommand(cwd: string, command: string): string {
  return `cd ${shellQuote(cwd)} && ${command}; printf '\\n${EXIT_SENTINEL} %s\\n' $?`;
}

export class HerdrEngine implements Engine {
  constructor(private readonly sockPath: string = herdrSocketPath()) {}

  private async call<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const res = await herdrRequest<T>(method, params, { sockPath: this.sockPath });
    if (!res.ok) throw new EngineError(res.code, res.message);
    return res.result;
  }

  private async paneOfTab(workspaceId: string, tabId: string): Promise<string> {
    const r = await this.call<{ panes?: { pane_id: string; tab_id: string }[] }>("pane.list", { workspace_id: workspaceId });
    const pane = (r.panes ?? []).find((p) => p.tab_id === tabId);
    if (!pane) throw new EngineError("no_pane", `tab ${tabId} has no pane`);
    return pane.pane_id;
  }

  async createWorkspace(label: string) {
    const r = await this.call<{ workspace?: { workspace_id: string }; tab?: { tab_id: string }; root_pane?: { pane_id: string; tab_id: string } }>("workspace.create", { label, focus: false });
    const workspaceId = r.workspace?.workspace_id;
    if (!workspaceId) throw new EngineError("bad_reply", "workspace.create returned no workspace_id");
    if (r.root_pane?.pane_id && r.root_pane.tab_id) {
      return { workspaceId, tabId: r.root_pane.tab_id, paneId: r.root_pane.pane_id };
    }
    const panes = await this.call<{ panes?: { pane_id: string; tab_id: string }[] }>("pane.list", { workspace_id: workspaceId });
    const first = panes.panes?.[0];
    if (!first) throw new EngineError("no_pane", `workspace ${workspaceId} has no pane`);
    return { workspaceId, tabId: first.tab_id, paneId: first.pane_id };
  }

  async createTab(workspaceId: string, label: string) {
    const r = await this.call<{ tab?: { tab_id: string }; root_pane?: { pane_id: string } }>("tab.create", { workspace_id: workspaceId, label, focus: false });
    const tabId = r.tab?.tab_id;
    if (!tabId) throw new EngineError("bad_reply", "tab.create returned no tab_id");
    if (r.root_pane?.pane_id) return { tabId, paneId: r.root_pane.pane_id };
    return { tabId, paneId: await this.paneOfTab(workspaceId, tabId) };
  }

  async renameTab(tabId: string, label: string) {
    await this.call("tab.rename", { tab_id: tabId, label });
  }

  async focusTab(tabId: string) {
    await this.call("tab.focus", { tab_id: tabId });
  }

  async run(paneId: string, cwd: string, command: string) {
    await this.call("pane.send_text", { pane_id: paneId, text: wrapCommand(cwd, command) });
    await this.call("pane.send_keys", { pane_id: paneId, keys: ["enter"] });
  }

  async interrupt(paneId: string) {
    await this.call("pane.send_keys", { pane_id: paneId, keys: ["ctrl+c"] });
  }

  async processInfo(paneId: string): Promise<ProcessInfo> {
    const r = await this.call<{ process_info?: { foreground_process_group_id?: number | null; shell_pid?: number | null; foreground_processes?: { pid: number; name: string; cmdline?: string | null }[] } }>("pane.process_info", { pane_id: paneId });
    const p = r.process_info ?? {};
    return {
      foregroundPgid: p.foreground_process_group_id ?? null,
      shellPid: p.shell_pid ?? null,
      foreground: (p.foreground_processes ?? []).map((x) => ({ pid: x.pid, name: x.name, cmdline: x.cmdline ?? null })),
    };
  }

  async read(paneId: string, lines: number): Promise<string> {
    const r = await this.call<{ read?: { text?: string } }>("pane.read", { pane_id: paneId, source: "recent_unwrapped", lines, strip_ansi: true, format: "text" });
    return r.read?.text ?? "";
  }

  async closeWorkspace(workspaceId: string) {
    await this.call("workspace.close", { workspace_id: workspaceId });
  }
}
