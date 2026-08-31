/**
 * The runner's tmux backend: one detached tmux server per runner (its own
 * socket), one session named "rt", one window per tab, one pane per window.
 * Only focusTab touches herdr (splitting a pane that attaches the session);
 * every other method is a pure tmux/ps call, so a runner in tmux mode never
 * needs a herdr socket to launch, poll, or tear down.
 */
import { mkdirSync } from "fs";
import { randomBytes } from "crypto";
import { dirname, join } from "path";
import { herdrRequest } from "../herdr/client.ts";
import { rtDir } from "../rt-paths.ts";
import { EngineError, wrapCommand, type Engine, type ProcessInfo } from "./engine.ts";
import { isRunning } from "./state.ts";

export const TMUX_SESSION = "rt";

type ShResult = { code: number; stdout: string; stderr: string };
type ShFn = (argv: string[]) => Promise<ShResult>;
type HerdrFn = (
  method: string,
  params: Record<string, unknown>,
) => Promise<{ ok: true; result: any } | { ok: false; code: string; message: string }>;

export interface TmuxEngineDeps {
  socket: string;
  sh: ShFn;
  herdr?: HerdrFn;
  env?: NodeJS.ProcessEnv;
  sleep?: (ms: number) => Promise<void>;
}

/** Parses the "-P -F '#{window_id}|#{pane_id}'" reply every create verb shares. */
function parseIdPair(stdout: string, context: string): { tabId: string; paneId: string } {
  const [tabId, paneId] = stdout.trim().split("|");
  if (!tabId || !paneId) throw new EngineError("bad_reply", `${context}: unparseable tmux reply "${stdout}"`);
  return { tabId, paneId };
}

export class TmuxEngine implements Engine {
  constructor(private readonly deps: TmuxEngineDeps) {}

  private tmux(args: string[]): Promise<ShResult> {
    return this.deps.sh(["tmux", "-S", this.deps.socket, ...args]);
  }

  private sleeper(): (ms: number) => Promise<void> {
    return this.deps.sleep ?? ((ms) => Bun.sleep(ms));
  }

  async createWorkspace(label: string) {
    const r = await this.tmux(["new-session", "-d", "-s", TMUX_SESSION, "-n", label, "-x", "220", "-y", "50", "-P", "-F", "#{window_id}|#{pane_id}"]);
    if (r.code !== 0) throw new EngineError("tmux_new_session", r.stderr || `tmux new-session exited ${r.code}`);
    const { tabId, paneId } = parseIdPair(r.stdout, "new-session");
    return { workspaceId: this.deps.socket, tabId, paneId };
  }

  async createTab(_workspaceId: string, label: string) {
    const r = await this.tmux(["new-window", "-t", TMUX_SESSION, "-n", label, "-P", "-F", "#{window_id}|#{pane_id}"]);
    if (r.code !== 0) throw new EngineError("tmux_new_window", r.stderr || `tmux new-window exited ${r.code}`);
    return parseIdPair(r.stdout, "new-window");
  }

  async renameTab(tabId: string, label: string): Promise<void> {
    const r = await this.tmux(["rename-window", "-t", tabId, label]);
    if (r.code !== 0) throw new EngineError("tmux_rename_window", r.stderr || `tmux rename-window exited ${r.code}`);
  }

  async focusTab(tabId: string): Promise<void> {
    const paneId = this.deps.env?.HERDR_PANE_ID;
    if (!paneId) throw new EngineError("no_herdr", "focus needs herdr: run the board inside a herdr pane");
    const herdr = this.deps.herdr;
    if (!herdr) throw new EngineError("no_herdr", "focus needs herdr");

    // An attached client always shows the session's current window, so the
    // only thing worth splitting a NEW pane for is having no client attached
    // at all (the runner's own herdr pane was closed).
    const clients = (await this.tmux(["list-clients", "-t", TMUX_SESSION])).stdout.trim();
    if (!clients) {
      const s = await herdr("pane.split", { pane_id: paneId, direction: "right", focus: true });
      if (!s.ok) throw new EngineError(s.code, s.message);
      const newPane = s.result?.pane?.pane_id;
      if (!newPane) throw new EngineError("bad_reply", "pane.split returned no pane_id");
      await herdr("pane.send_text", { pane_id: newPane, text: `tmux -S '${this.deps.socket}' attach -t ${TMUX_SESSION}` });
      await herdr("pane.send_keys", { pane_id: newPane, keys: ["enter"] });
      await this.sleeper()(400);
    }
    await this.tmux(["select-window", "-t", tabId]);
  }

  async run(paneId: string, cwd: string, command: string): Promise<void> {
    // Keystrokes sent while the pane's shell is still starting are lost, not
    // queued: wait for the shell to own its own foreground before injecting.
    await this.waitIdle(paneId, 4000);
    const r1 = await this.tmux(["send-keys", "-t", paneId, "-l", wrapCommand(cwd, command)]);
    if (r1.code !== 0) throw new EngineError("tmux_send_keys", r1.stderr || `tmux send-keys exited ${r1.code}`);
    const r2 = await this.tmux(["send-keys", "-t", paneId, "Enter"]);
    if (r2.code !== 0) throw new EngineError("tmux_send_keys", r2.stderr || `tmux send-keys exited ${r2.code}`);
  }

  private async waitIdle(paneId: string, timeoutMs: number): Promise<void> {
    const sleep = this.sleeper();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!isRunning(await this.processInfo(paneId))) return;
      await sleep(150);
    }
    // Timed out: send anyway, best-effort. A restart racing this long is
    // already reporting itself broken through other means.
  }

  async interrupt(paneId: string): Promise<void> {
    const r = await this.tmux(["send-keys", "-t", paneId, "C-c"]);
    if (r.code !== 0) throw new EngineError("tmux_send_keys", r.stderr || `tmux send-keys exited ${r.code}`);
  }

  async processInfo(paneId: string): Promise<ProcessInfo> {
    const dead: ProcessInfo = { foregroundPgid: null, shellPid: null, foreground: [] };
    const r = await this.tmux(["display-message", "-p", "-t", paneId, "#{pane_pid}|#{pane_tty}|#{pane_dead}"]);
    if (r.code !== 0) return dead;
    const [pidStr, tty, deadStr] = r.stdout.trim().split("|");
    const shellPid = Number(pidStr);
    if (deadStr === "1" || !shellPid || shellPid <= 0) return dead;

    // Every process on a tty shares its tpgid; a shell mid-startup can print
    // more than one row, so the first is the one to trust.
    const ttyBase = (tty ?? "").replace(/^\/dev\//, "");
    const ps = await this.deps.sh(["ps", "-t", ttyBase, "-o", "tpgid="]);
    const tpgid = Number(ps.stdout.split("\n")[0]?.trim());
    const foregroundPgid = Number.isFinite(tpgid) && tpgid > 0 ? tpgid : null;
    return { foregroundPgid, shellPid, foreground: [] };
  }

  async read(paneId: string, lines: number): Promise<string> {
    const r = await this.tmux(["capture-pane", "-p", "-J", "-t", paneId, "-S", `-${lines}`]);
    return r.code === 0 ? r.stdout : "";
  }

  async closeWorkspace(_workspaceId: string): Promise<void> {
    // Best-effort: the runner may close a workspace whose server is already
    // gone, and a spawn-level failure here must never break teardown.
    try {
      await this.tmux(["kill-server"]);
    } catch {
      // server already gone
    }
  }
}

export function defaultTmuxSocket(): string {
  // A macOS unix socket path must stay under ~104 chars; keep this shallow.
  return join(rtDir(), "runner", "tmux", `${randomBytes(4).toString("hex")}.sock`);
}

async function realSh(argv: string[]): Promise<ShResult> {
  const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, stdout: stdout.replace(/\n$/, ""), stderr: stderr.replace(/\n$/, "") };
}

export function createTmuxEngine(socket: string = defaultTmuxSocket()): TmuxEngine {
  mkdirSync(dirname(socket), { recursive: true });
  return new TmuxEngine({
    socket,
    sh: realSh,
    herdr: (m, p) => herdrRequest(m, p),
    env: process.env,
    sleep: (ms) => Bun.sleep(ms),
  });
}

/** Best-effort teardown for an orphaned runner's tmux server (see workspace-registry's planTmuxReconcile). */
export async function killTmuxServer(socket: string, sh: ShFn = realSh): Promise<void> {
  try {
    await sh(["tmux", "-S", socket, "kill-server"]);
  } catch {
    // the server may already be gone
  }
}
