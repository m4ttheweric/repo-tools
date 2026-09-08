/**
 * rt herd ... CLI over the herd registry. Thin client, same idiom as
 * commands/gate.ts: parse args, call the wrapper, print a line or --json.
 *
 *   rt herd start --name <n> [--repo <path>] [--hidden]
 *   rt herd spawn --herd <id> --job <name> [--brief <file>] [--dir <path>] [--model M] [--effort E] [--account A] [--disposable]
 *   rt herd ask --questions <json> [--context <text>]
 *   rt herd milestone --artifact <path> [--summary <text>]
 *   rt herd answer <gate>
 *   rt herd report [--file <path>]
 *   rt herd gates [--herd <id>]
 *   rt herd status [--herd <id>]
 *   rt herd list [--all]
 *   rt herd resume [<id>]
 *   rt herd close <job> --herd <id>
 *   rt herd attend <job> --herd <id>
 *   rt herd wrap-up <id> [--close-panes] [--dispose <job>...] [--delete-job-dirs] [--archive-room]
 *   rt herd stop --hidden
 */
import { readFileSync } from "fs";
import { resolve } from "path";
import {
  herdStart, herdSpawn, herdAsk, herdMilestone, herdAnswer, herdReport, herdGates,
  herdStatus, herdList, herdResume, herdClose, herdAttend, herdWrapUp, herdStopHidden,
} from "../packages/rt-client/src/index.ts";
import type { Commands, HerdListRow, HerdStatusData, RtResponse } from "../packages/rt-client/src/index.ts";
import { resolveRepoArg, currentRepoIdentity } from "../lib/repo-arg.ts";

function fail(msg: string): never {
  console.error(`rt herd: ${msg}`);
  process.exit(1);
}

// Index-based scan, same reasoning as commands/gate.ts's positional(): a
// positional that equals a flag's value must still parse as positional.
const FLAGS_WITH_VALUES = new Set([
  "--name", "--repo", "--herd", "--job", "--brief", "--dir", "--model", "--effort",
  "--account", "--questions", "--context", "--artifact", "--summary", "--file",
  "--dispose", "--session",
]);

export function positional(args: string[]): string | undefined {
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

export function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

export function flagValues(args: string[], flag: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) if (args[i] === flag && args[i + 1]) out.push(args[++i]!);
  return out;
}

const has = (args: string[], flag: string) => args.includes(flag);

function unwrap<T>(res: RtResponse<T>, label: string): T {
  if (!res.ok || res.data === undefined) fail(res.error ?? `${label} failed`);
  return res.data;
}

function emit(json: boolean, data: unknown, line: string): void {
  console.log(json ? JSON.stringify(data, null, 2) : line);
}

/** The job's identity alone. Verbs that do not open a gate need this and no
    more: a session id they never send must not be a reason to refuse. */
export function jobEnv(env: Record<string, string | undefined>): { herd: string; job: string } {
  const herd = env.HERD_ID, job = env.HERD_JOB;
  if (!herd || !job) throw new Error("HERD_ID and HERD_JOB are not set; this verb runs inside a herd worker pane");
  return { herd, job };
}

export function workerEnv(env: Record<string, string | undefined>): { herd: string; job: string; session: string; pane?: string } {
  const { herd, job } = jobEnv(env);
  const session = env.CLAUDE_CODE_SESSION_ID;
  if (!session) throw new Error("CLAUDE_CODE_SESSION_ID is not set; this verb runs inside a Claude Code session");
  return { herd, job, session, ...(env.HERDR_PANE_ID && { pane: env.HERDR_PANE_ID }) };
}

export function buildAskPayload(args: string[], env: Record<string, string | undefined>): Commands["herd:ask"]["payload"] {
  const raw = flagValue(args, "--questions");
  if (!raw) throw new Error("usage: rt herd ask --questions <json> [--context <text>]");
  let questions: unknown;
  try {
    questions = JSON.parse(raw);
  } catch {
    throw new Error(`--questions is not valid JSON: ${raw}`);
  }
  if (!Array.isArray(questions)) throw new Error("--questions must be a JSON array");
  const w = workerEnv(env);
  const context = flagValue(args, "--context");
  return { ...w, questions: questions as Commands["herd:ask"]["payload"]["questions"], ...(context && { context }) };
}

export function buildSpawnPayload(args: string[]): Commands["herd:spawn"]["payload"] {
  const herd = flagValue(args, "--herd") ?? process.env.HERD_ID;
  const job = flagValue(args, "--job");
  if (!herd || !job) throw new Error("usage: rt herd spawn --herd <id> --job <name> [--brief <file>] [--dir <path>] [--model M] [--effort E] [--account A] [--disposable]");
  const briefFile = flagValue(args, "--brief");
  const brief = briefFile ? readFileSync(briefFile, "utf8") : undefined;
  const p: Commands["herd:spawn"]["payload"] = { herd, job };
  if (brief !== undefined) p.brief = brief;
  for (const k of ["dir", "model", "effort", "account"] as const) {
    const v = flagValue(args, `--${k}`);
    if (v) p[k] = v;
  }
  if (args.includes("--disposable")) p.disposable = true;
  return p;
}

export function buildWrapUpPayload(args: string[]): Commands["herd:wrap-up"]["payload"] {
  const herd = positional(args);
  if (!herd) throw new Error("usage: rt herd wrap-up <id> [--close-panes] [--dispose <job>...] [--delete-job-dirs] [--archive-room]");
  return {
    herd,
    closePanes: has(args, "--close-panes"),
    dispose: flagValues(args, "--dispose"),
    deleteJobDirs: has(args, "--delete-job-dirs"),
    archiveRoom: has(args, "--archive-room"),
  };
}

/** A shepherd usually runs one herd, and an id it could have looked up is
    friction; two or none is genuinely ambiguous and gets the usage instead. */
export function soleHerdId(herds: Array<{ id: string }>): string | null {
  return herds.length === 1 ? herds[0]!.id : null;
}

export function renderHerdRow(h: HerdListRow): string {
  return `${h.id}  ${h.status}  room ${h.room}  ${h.jobs} ${h.jobs === 1 ? "job" : "jobs"}`;
}

async function soleHerd(usage: string): Promise<string> {
  const id = soleHerdId(unwrap(await herdList({}), "list").herds);
  if (id) return id;
  fail(`${usage} (rt herd list shows the herds)`);
}

async function repoFor(args: string[]): Promise<string> {
  const arg = flagValue(args, "--repo");
  if (arg) return resolveRepoArg(arg, fail);
  const id = currentRepoIdentity();
  if (!id) fail("not inside a repo: pass --repo <path>");
  return id;
}

export async function start(args: string[]): Promise<void> {
  const json = has(args, "--json");
  const name = flagValue(args, "--name");
  if (!name) fail("usage: rt herd start --name <n> [--repo <path>] [--hidden]");
  const session = flagValue(args, "--session") ?? process.env.CLAUDE_CODE_SESSION_ID;
  if (!session) fail("run inside a Claude Code session (or pass --session <id>)");
  const data = unwrap(await herdStart({ name, repo: await repoFor(args), session, hidden: has(args, "--hidden") }), "start");
  emit(json, data, `herd ${data.herd}\nroom ${data.room}\nworkspace ${data.workspace}\nsubscription ${data.subscription}${data.hidden ? "\nhidden: yes" : ""}`);
}

export async function spawn(args: string[]): Promise<void> {
  const json = has(args, "--json");
  let payload: Commands["herd:spawn"]["payload"];
  try {
    payload = buildSpawnPayload(args);
  } catch (e) {
    fail((e as Error).message);
  }
  const data = unwrap(await herdSpawn(payload), "spawn");
  emit(json, data, `${data.job} pane ${data.pane} worktree ${data.worktree} session ${data.sessionId}`);
}

export async function ask(args: string[]): Promise<void> {
  const json = has(args, "--json");
  let payload: Commands["herd:ask"]["payload"];
  try {
    payload = buildAskPayload(args, process.env);
  } catch (e) {
    fail((e as Error).message);
  }
  const data = unwrap(await herdAsk(payload), "ask");
  emit(json, data, `holding at gate ${data.gate}`);
}

export async function milestone(args: string[]): Promise<void> {
  const json = has(args, "--json");
  const artifact = flagValue(args, "--artifact");
  if (!artifact) fail("usage: rt herd milestone --artifact <path> [--summary <text>]");
  let w: ReturnType<typeof workerEnv>;
  try {
    w = workerEnv(process.env);
  } catch (e) {
    fail((e as Error).message);
  }
  const summary = flagValue(args, "--summary");
  // The shepherd reads this path from its own cwd, which is never the worker's.
  const data = unwrap(await herdMilestone({ ...w, artifact: resolve(artifact), ...(summary && { summary }) }), "milestone");
  emit(json, data, `holding at gate ${data.gate}`);
}

/**
 * Every non-answered status has to read as "no answer exists", because the
 * worker's next move on seeing one is to keep waiting, not to proceed. An
 * `answered` row whose `answer` is null is the same case: rendering it as an
 * answer of `{}` would invite the worker to invent one.
 */
export function renderAnswer(gate: string, data: Commands["herd:answer"]["data"]): string {
  if (data.status === "open") return `gate ${gate} is still open`;
  if (data.status === "closed") return `gate ${gate} closed (${data.closedReason ?? "no reason"}); do not invent an answer`;
  if (data.status === "parked") return `gate ${gate} is parked; do not invent an answer, wait for it to be answered`;
  if (!data.answer) return `gate ${gate} is marked answered but carries no answer; do not invent one, ask the shepherd`;
  return `gate ${gate} answered by ${data.answer.by}:\n${JSON.stringify(data.answer.answers, null, 2)}`;
}

export async function answer(args: string[]): Promise<void> {
  const json = has(args, "--json");
  const gate = positional(args);
  if (!gate) fail("usage: rt herd answer <gate>");
  const data = unwrap(await herdAnswer({ gate }), "answer");
  emit(json, data, renderAnswer(gate, data));
}

export async function report(args: string[]): Promise<void> {
  const json = has(args, "--json");
  let w: ReturnType<typeof jobEnv>;
  try {
    w = jobEnv(process.env);
  } catch (e) {
    fail((e as Error).message);
  }
  const file = flagValue(args, "--file");
  let body: string;
  if (file) {
    try {
      body = readFileSync(file, "utf8");
    } catch (e) {
      fail((e as Error).message);
    }
  } else {
    body = await Bun.stdin.text();
  }
  if (!body.trim()) fail("empty report body (pass --file <path> or pipe the body on stdin)");
  const data = unwrap(await herdReport({ herd: w.herd, job: w.job, body }), "report");
  emit(json, data, `reported (message #${data.message})`);
}

export async function gates(args: string[]): Promise<void> {
  const json = has(args, "--json");
  const herd = flagValue(args, "--herd") ?? process.env.HERD_ID ?? await soleHerd("usage: rt herd gates --herd <id>");
  const data = unwrap(await herdGates({ herd }), "gates");
  if (json) {
    emit(true, data, "");
    return;
  }
  if (data.gates.length === 0) {
    console.log("no open gates");
    return;
  }
  for (const g of data.gates) console.log(`${g.id}  ${g.kind}  ${g.subject}  ${g.questions.map((q) => q.label).join(" | ")}`);
}

/** A missing subscription and an answered-but-undelivered gate are the two
    states the shepherd must act on, so both name their own remedy inline. */
export function renderStatus(data: HerdStatusData): string {
  const sub = data.subscription ? `subscription ${data.subscription.id}${data.subscription.dead ? " DEAD" : ""}` : "subscription MISSING (run rt herd resume)";
  const lines = [
    `${data.herd.id}  room ${data.herd.room}  unread ${data.unread}  lifecycle ${data.lifecycleConnected ? "connected" : "OFF"}${data.hiddenUp === null ? "" : `  hidden ${data.hiddenUp ? "up" : "DOWN"}`}  ${sub}`,
  ];
  for (const j of data.jobs) {
    const notWoken = j.lastGateStatus === "answered" && j.lastGateDelivery === "dead-pane" ? `  gate ${j.lastGate} answered, worker not woken: rt chat dm ${j.handle}` : "";
    lines.push(`  ${j.name.padEnd(24)} ${j.status.padEnd(13)} pane ${j.pane ?? "-"}  ${j.paneStatus ?? "-"}${j.openGate ? `  gate ${j.openGate}` : ""}${notWoken}`);
  }
  return lines.join("\n");
}

export async function status(args: string[]): Promise<void> {
  const json = has(args, "--json");
  const herd = flagValue(args, "--herd") ?? process.env.HERD_ID ?? await soleHerd("usage: rt herd status --herd <id>");
  const data = unwrap(await herdStatus({ herd }), "status");
  emit(json, data, renderStatus(data));
}

export async function list(args: string[]): Promise<void> {
  const json = has(args, "--json");
  const data = unwrap(await herdList({ all: has(args, "--all") }), "list");
  if (json) {
    emit(true, data, "");
    return;
  }
  if (data.herds.length === 0) {
    console.log("no herds");
    return;
  }
  for (const h of data.herds) console.log(renderHerdRow(h));
}

export async function resume(args: string[]): Promise<void> {
  const json = has(args, "--json");
  // HERD_ID deliberately not consulted: every worker pane carries it, and a
  // worker resuming would re-point the shepherd's subscription at itself.
  const herd = positional(args) ?? await soleHerd("usage: rt herd resume <id>");
  const session = flagValue(args, "--session") ?? process.env.CLAUDE_CODE_SESSION_ID;
  if (!session) fail("run inside a Claude Code session (or pass --session <id>)");
  const data = unwrap(await herdResume({ herd, session }), "resume");
  if (json) {
    emit(true, data, "");
    return;
  }
  console.log(`resumed ${herd} as ${data.handle}: subscription ${data.subscription}, ${data.gates.length} open gate(s), ${data.unread} unread`);
  for (const g of data.gates) console.log(`  ${g.id}  ${g.kind}  ${g.subject}`);
}

export async function close(args: string[]): Promise<void> {
  const json = has(args, "--json");
  const job = positional(args);
  const herd = flagValue(args, "--herd") ?? process.env.HERD_ID;
  if (!job || !herd) fail("usage: rt herd close <job> --herd <id>");
  const data = unwrap(await herdClose({ herd, job }), "close");
  emit(json, data, `${data.job} closed`);
}

export async function attend(args: string[]): Promise<void> {
  const json = has(args, "--json");
  const job = positional(args);
  const herd = flagValue(args, "--herd") ?? process.env.HERD_ID;
  const callerWorkspace = process.env.HERDR_WORKSPACE_ID;
  if (!job || !herd) fail("usage: rt herd attend <job> --herd <id>");
  if (!callerWorkspace) fail("HERDR_WORKSPACE_ID is not set; run from a herdr pane");
  const data = unwrap(await herdAttend({ herd, job, callerWorkspace }), "attend");
  emit(json, data, `attached in tab ${data.tab}; detach with ctrl+b q, then close the tab`);
}

export async function wrapUp(args: string[]): Promise<void> {
  const json = has(args, "--json");
  let payload: Commands["herd:wrap-up"]["payload"];
  try {
    payload = buildWrapUpPayload(args);
  } catch (e) {
    fail((e as Error).message);
  }
  const data = unwrap(await herdWrapUp(payload), "wrap-up");
  if (json) {
    emit(true, data, "");
    return;
  }
  console.log(`closed ${data.closed.length} pane(s)${data.workspaceClosed ? ", workspace closed" : ""}; disposed ${data.disposed.join(", ") || "none"}; job dirs ${data.deletedJobDirs ? "deleted" : "kept"}; room ${data.archived ? "archived" : "kept"}`);
  for (const r of data.refused) console.log(`  refused ${r.tree}: ${r.reason}`);
}

export async function stop(args: string[]): Promise<void> {
  if (!has(args, "--hidden")) fail("usage: rt herd stop --hidden");
  const data = unwrap(await herdStopHidden({}), "stop");
  emit(has(args, "--json"), data, "hidden herd session stopped");
}
