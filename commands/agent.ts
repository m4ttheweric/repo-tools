/**
 * rt agent: hand a prompt to a Claude Code agent and keep the receipt.
 *
 *   rt agent start  [--repo <path>] [--prompt <text> | --prompt-file <path>]
 *                   [--surface herdr|headless] [--model M] [--effort E]
 *                   [--account A] [--label L] [--caller C]
 *                   [--workspace W] [--tab T] [--extra-args "<tail>"] [--json]
 *   rt agent resume <id|session-uuid> [--prompt <text>] [--surface herdr|headless]
 *                   [--workspace W] [--tab T] [--json]
 *   rt agent show   <id|session-uuid> [--json]
 *   rt agent list   [--repo <path>] [--json]
 *
 * Thin client over agent:* daemon handlers; the daemon owns spawning,
 * session-uuid minting, and the record. Spec:
 * docs/superpowers/specs/2026-08-25-rt-agent-handoff-design.md
 */

import { readFileSync, realpathSync } from "fs";
import { isDaemonRunning } from "../lib/daemon-client.ts";
import { currentRepoIdentity, repoLabel, resolveRepoArg } from "../lib/repo-arg.ts";
import {
  agentGet, agentList, agentResume, agentStart,
  type AgentRecord, type AgentSurface,
} from "../packages/rt-client/src/index.ts";
import type { RtResponse } from "../packages/rt-client/src/index.ts";

const FLAGS_WITH_VALUES = new Set([
  "--repo", "--prompt", "--prompt-file", "--surface", "--model", "--effort",
  "--account", "--label", "--caller", "--workspace", "--tab", "--extra-args",
]);

function fail(msg: string): never {
  console.error(`rt agent: ${msg}`);
  process.exit(1);
}

function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

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

function unwrap<T>(res: RtResponse<T>, label: string): T {
  if (!res.ok || res.data === undefined) fail(res.error ?? `${label} failed: is the rt daemon running?`);
  return res.data;
}

// Daemon-optional: the herdr and read verbs run in-process when the daemon is
// down. Headless is refused inside the fallback. The fallback
// module is imported lazily so a daemon-up call never loads daemon-side code.
async function dispatch<T>(
  command: "agent:start" | "agent:resume" | "agent:get" | "agent:list",
  payload: Record<string, unknown>,
  wrapper: () => Promise<RtResponse<T>>,
): Promise<RtResponse<T>> {
  if (await isDaemonRunning()) return wrapper();
  const { runAgentFallback } = await import("./agent-fallback.ts");
  try {
    return await runAgentFallback<T>(command, payload);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function parseSurface(s: string | undefined): AgentSurface | undefined {
  if (s === undefined) return undefined;
  if (s !== "herdr" && s !== "headless") throw new Error(`invalid surface "${s}": expected herdr or headless`);
  return s;
}

interface StartArgs {
  prompt?: string; surface?: AgentSurface; model?: string; effort?: string;
  account?: string; label?: string; caller?: string; workspace?: string;
  tab?: string; extraArgs?: string;
}

function parseStartArgs(args: string[]): StartArgs {
  const prompt = flagValue(args, "--prompt");
  const promptFile = flagValue(args, "--prompt-file");
  if (prompt !== undefined && promptFile !== undefined) throw new Error("pass one of --prompt / --prompt-file, not both");
  const out: StartArgs = {};
  const resolved = promptFile !== undefined ? readFileSync(promptFile, "utf8").trim() : prompt;
  if (resolved !== undefined) out.prompt = resolved;
  const surface = parseSurface(flagValue(args, "--surface"));
  if (surface !== undefined) out.surface = surface;
  for (const [flag, key] of [
    ["--model", "model"], ["--effort", "effort"], ["--account", "account"],
    ["--label", "label"], ["--caller", "caller"], ["--workspace", "workspace"],
    ["--tab", "tab"], ["--extra-args", "extraArgs"],
  ] as const) {
    const v = flagValue(args, flag);
    if (v !== undefined) out[key] = v;
  }
  return out;
}

function parseResumeArgs(args: string[]): { id: string; prompt?: string; surface?: AgentSurface; workspace?: string; tab?: string } {
  const id = positional(args);
  if (!id) throw new Error("missing id: rt agent resume <id|session-uuid>");
  const out: { id: string; prompt?: string; surface?: AgentSurface; workspace?: string; tab?: string } = { id };
  const prompt = flagValue(args, "--prompt");
  if (prompt !== undefined) out.prompt = prompt;
  const surface = parseSurface(flagValue(args, "--surface"));
  if (surface !== undefined) out.surface = surface;
  const workspace = flagValue(args, "--workspace");
  if (workspace !== undefined) out.workspace = workspace;
  const tab = flagValue(args, "--tab");
  if (tab !== undefined) out.tab = tab;
  return out;
}

async function repoAndCwd(args: string[]): Promise<{ repo: string; cwd: string }> {
  const repoArg = flagValue(args, "--repo");
  if (repoArg) {
    // start/resume need a real cwd, so --repo must be a directory here;
    // list accepts names because it never derives a cwd.
    let cwd: string;
    try {
      cwd = realpathSync(repoArg);
    } catch {
      fail(`--repo must be a directory path for this verb, got "${repoArg}"`);
    }
    return { repo: await resolveRepoArg(repoArg, fail), cwd };
  }
  const identity = currentRepoIdentity();
  if (!identity) fail("not inside a repo: pass --repo <path>");
  return { repo: identity, cwd: process.cwd() };
}

function renderRecord(r: AgentRecord): string {
  const bits = [
    `${r.id}  ${repoLabel(r.repo)}  ${r.surface}`,
    `session ${r.sessionId}`,
    r.handle && `handle ${r.handle}`,
    r.model && `model ${r.model}`,
    r.account && `account ${r.account}`,
    r.paneId && `pane ${r.paneId}`,
    r.finishedAt !== undefined && `exit ${r.exitCode}`,
    r.lastResumedAt !== undefined && "resumed",
  ].filter(Boolean);
  return bits.join("  |  ");
}

async function runStart(args: string[]): Promise<void> {
  let parsed: StartArgs;
  try {
    parsed = parseStartArgs(args);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
  const { repo, cwd } = await repoAndCwd(args);
  const payload = { repo, cwd, ...parsed };
  const data = unwrap(await dispatch("agent:start", payload, () => agentStart(payload)), "start");
  if (args.includes("--json")) {
    console.log(JSON.stringify({ ok: true, agent: data }));
    return;
  }
  console.log(renderRecord(data));
}

async function runResume(args: string[]): Promise<void> {
  let parsed: { id: string; prompt?: string; surface?: AgentSurface };
  try {
    parsed = parseResumeArgs(args);
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
  const data = unwrap(await dispatch("agent:resume", parsed, () => agentResume(parsed)), "resume");
  if (args.includes("--json")) {
    console.log(JSON.stringify({ ok: true, agent: data }));
    return;
  }
  console.log(renderRecord(data));
}

async function runShow(args: string[]): Promise<void> {
  const id = positional(args);
  if (!id) fail("missing id: rt agent show <id|session-uuid>");
  const data = unwrap(await dispatch("agent:get", { id }, () => agentGet({ id })), "show");
  if (args.includes("--json")) {
    console.log(JSON.stringify({ ok: true, agent: data }));
    return;
  }
  console.log(renderRecord(data));
}

async function runList(args: string[]): Promise<void> {
  const repoArg = flagValue(args, "--repo");
  const repo = repoArg ? await resolveRepoArg(repoArg, fail) : currentRepoIdentity();
  const data = unwrap(await dispatch("agent:list", repo ? { repo } : {}, () => agentList(repo ? { repo } : {})), "list");
  if (args.includes("--json")) {
    console.log(JSON.stringify({ ok: true, agents: data.agents }));
    return;
  }
  if (data.agents.length === 0) {
    console.log("no agent handoffs recorded");
    return;
  }
  for (const r of data.agents) console.log(renderRecord(r));
}

const USAGE = "usage: rt agent <start|resume|show|list> ...";

const VERBS: Record<string, (args: string[]) => Promise<void>> = {
  start: runStart, resume: runResume, show: runShow, list: runList,
};

const VERB_HINTS: Record<string, string> = {
  start: "hand a prompt to a new agent",
  resume: "resume a handoff",
  show: "show a handoff / session",
  list: "list handoffs",
};

async function pickAgentVerb(): Promise<string | null> {
  const { filterableSelect } = await import("../lib/pick-wrappers.ts");
  return filterableSelect({
    message: "rt agent",
    options: Object.keys(VERBS).map((v) => ({ value: v, label: v, hint: VERB_HINTS[v] ?? "" })),
  });
}

export async function agent(args: string[]): Promise<void> {
  let [verb, ...rest] = args;
  if (!verb) {
    // Non-TTY / --json callers keep the usage error and exit code; only an
    // interactive terminal gets the verb picker.
    if (process.stdin.isTTY && !args.includes("--json") && !process.env.RT_BATCH) {
      const picked = await pickAgentVerb();
      if (!picked) process.exit(0);
      verb = picked;
    } else {
      fail(USAGE);
    }
  }
  const handler = VERBS[verb];
  if (!handler) fail(`unknown verb "${verb}": ${USAGE}`);
  await handler(rest);
}

export const __test__ = { parseStartArgs, parseResumeArgs };
