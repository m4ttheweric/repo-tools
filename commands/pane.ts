/**
 * rt pane: herdr panes as rt sees them (joined to chat presence).
 *
 *   rt pane list [--json]                                         claude panes, presence joined
 *   rt pane peek <pane> [--lines 8] [--json]                      the last lines of a pane's screen
 *   rt pane spawn --cwd <path> [--account <a>] [--model <m>]
 *                 [--effort <e>] [--prompt <text>] [--workspace <label>] [--json]
 *   rt pane send <pane> --text <text>                             inject text into a pane (--text - reads stdin)
 *   rt pane accounts [--json]                                     cswap accounts with headroom
 *   rt pane directories [--q <text>] [--json]                     repos and worktrees for --cwd
 *
 * Every verb needs herdr; without it the daemon answers "herdr unavailable".
 */
import type { ChatPane, RtResponse } from "../packages/rt-client/src/index.ts";
import { BG_PREFIX, paneAccounts as paneAccountsRt, paneDirectories as paneDirectoriesRt, paneFocus as paneFocusRt, paneList as paneListRt, panePeek as panePeekRt, paneSend as paneSendRt, paneSpawn as paneSpawnRt } from "../packages/rt-client/src/index.ts";
import { selfPaneRef } from "../lib/self-pane.ts";

const FLAGS_WITH_VALUES = new Set(["--lines", "--cwd", "--account", "--model", "--effort", "--prompt", "--workspace", "--q", "--sock", "--text"]);

function positional(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("--")) {
      if (FLAGS_WITH_VALUES.has(a)) i++;
      continue;
    }
    return a;
  }
  return undefined;
}

function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

function fail(msg: string): never {
  console.error(`rt pane: ${msg}`);
  process.exit(1);
}

function unwrap<T>(res: RtResponse<T>, label: string): T {
  if (!res.ok || res.data === undefined) fail(res.error ?? `${label} failed`);
  return res.data;
}

function opts(args: string[]) {
  const sockPath = flagValue(args, "--sock");
  return sockPath ? { sockPath } : {};
}

function renderPane(p: ChatPane, idWidth: number): string {
  const who = p.presence ? `${p.presence.handle} (${p.presence.status})` : "not signed in";
  const where = [p.repo, p.branch].filter(Boolean).join(" · ");
  const title = p.title && p.title !== p.presence?.handle ? ` · ${p.title}` : "";
  const rooms = p.presence?.rooms.length ? `  #${p.presence.rooms.join(" #")}` : "";
  return `${p.paneId.padEnd(idWidth)} ${p.agentStatus.padEnd(8)} ${who.padEnd(22)} ${p.workspace}${title}${where ? `  ${where}` : ""}${rooms}`;
}

export async function paneList(args: string[]): Promise<void> {
  const data = unwrap(await paneListRt(opts(args)), "pane list");
  if (args.includes("--json")) return void console.log(JSON.stringify({ ok: true, panes: data.panes }));
  if (data.panes.length === 0) return void console.log("no claude panes");
  const idWidth = Math.max(...data.panes.map((p) => p.paneId.length));
  const visible = data.panes.filter((p) => !p.paneId.startsWith(BG_PREFIX));
  const bg = data.panes.filter((p) => p.paneId.startsWith(BG_PREFIX));
  const lines = visible.map((p) => renderPane(p, idWidth));
  if (bg.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push("background:");
    lines.push(...bg.map((p) => renderPane(p, idWidth)));
  }
  console.log(lines.join("\n"));
}

export async function panePeek(args: string[]): Promise<void> {
  const paneId = positional(args);
  if (!paneId) fail("usage: rt pane peek <pane> [--lines 8]");
  const linesRaw = flagValue(args, "--lines");
  let lines: number | undefined;
  if (linesRaw !== undefined) {
    lines = Number(linesRaw);
    if (!Number.isInteger(lines) || lines <= 0) fail(`--lines must be a positive integer (got "${linesRaw}")`);
  }
  const data = unwrap(await panePeekRt({ paneId, lines }, opts(args)), "pane peek");
  if (args.includes("--json")) return void console.log(JSON.stringify({ ok: true, ...data }));
  console.log(data.lines.join("\n"));
}

export async function paneSpawn(args: string[]): Promise<void> {
  const cwd = flagValue(args, "--cwd");
  if (!cwd) fail("usage: rt pane spawn --cwd <path> [--account <a>] [--model <m>] [--effort <e>] [--prompt <text>] [--workspace <label>]");
  const data = unwrap(
    await paneSpawnRt(
      { cwd, account: flagValue(args, "--account"), model: flagValue(args, "--model"), effort: flagValue(args, "--effort"), prompt: flagValue(args, "--prompt"), workspace: flagValue(args, "--workspace") },
      opts(args),
    ),
    "pane spawn",
  );
  if (args.includes("--json")) return void console.log(JSON.stringify({ ok: true, ...data }));
  console.log(`${data.ready ? "ready" : "not ready"}  ${renderPane(data.pane, data.pane.paneId.length)}`);
}

export async function paneSend(args: string[]): Promise<void> {
  const paneId = positional(args);
  const rawText = flagValue(args, "--text");
  if (!paneId || rawText === undefined) fail("usage: rt pane send <pane> --text <text>  (--text - reads stdin)");
  const text = rawText === "-" ? await new Response(Bun.stdin.stream()).text() : rawText;
  const callerPane = selfPaneRef();
  const data = unwrap(await paneSendRt({ paneId, text, ...(callerPane ? { callerPane } : {}) }, opts(args)), "pane send");
  if (args.includes("--json")) return void console.log(JSON.stringify({ ok: true, ...data }));
  console.log(`${data.paneId} ${data.delivered}${data.reason ? ` (${data.reason})` : ""}`);
}

export function renderPaneFocus(data: { paneId: string; focused: boolean; attendTab?: string }): string {
  if (data.attendTab) return `attached ${data.paneId} in tab ${data.attendTab}; detach with ctrl+b q, then close the tab`;
  return `${data.paneId} ${data.focused ? "focused" : "not focused"}`;
}

export async function paneFocus(args: string[]): Promise<void> {
  const paneId = positional(args);
  if (!paneId) fail("usage: rt pane focus <pane>");
  const callerWorkspace = process.env.HERDR_WORKSPACE_ID;
  const data = unwrap(await paneFocusRt({ paneId, ...(callerWorkspace ? { callerWorkspace } : {}) }, opts(args)), "pane focus");
  if (args.includes("--json")) return void console.log(JSON.stringify({ ok: true, ...data }));
  console.log(renderPaneFocus(data));
}

export async function paneAccounts(args: string[]): Promise<void> {
  const data = unwrap(await paneAccountsRt(opts(args)), "pane accounts");
  if (args.includes("--json")) return void console.log(JSON.stringify({ ok: true, accounts: data.accounts }));
  if (data.accounts.length === 0) return void console.log("no cswap accounts");
  console.log(data.accounts.map((a) => `${String(a.slot).padStart(2)}: ${a.alias ?? a.email}${a.alias ? `  ${a.email}` : ""}${a.headroom ? `  ${a.headroom}` : ""}`).join("\n"));
}

export async function paneDirectories(args: string[]): Promise<void> {
  const data = unwrap(await paneDirectoriesRt({ q: flagValue(args, "--q") }, opts(args)), "pane directories");
  if (args.includes("--json")) return void console.log(JSON.stringify({ ok: true, directories: data.directories }));
  console.log(data.directories.map((d) => `${d.path}  ${d.repo}${d.branch ? ` · ${d.branch}` : ""}`).join("\n"));
}
