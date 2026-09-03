/**
 * rt gate — CLI over the gate facility (BOARD-20/21): human-decision gates
 * that pause a subject until answered, parked, or closed. Mirrors
 * commands/events.ts's arg parsing / --json payload / exit code idiom.
 *
 *   rt gate open --subject <s> --kind <k> --questions <json> [--meta <json>] [--agent <id>] [--pane <id>] [--nudge <json>]
 *   rt gate answer <id> --answers <json> --by <surface>
 *   rt gate wait <id> [--timeout <duration>]     # default: wait forever
 *   rt gate list [--open] [--subject-prefix <p>] [--kind <k>]
 *   rt gate park <id>
 *   rt gate close <id> --reason <abandoned|superseded|pruned>
 *   rt gate subscribe --subject-prefix <p> --session <addr>
 *   rt gate unsubscribe <id>
 */

import {
  gateOpen as clientOpen,
  gateAnswer as clientAnswer,
  gateWait as clientWait,
  gateList as clientList,
  gatePark as clientPark,
  gateClose as clientClose,
  gateSubscribe as clientSubscribe,
  gateUnsubscribe as clientUnsubscribe,
} from "../packages/rt-client/src/index.ts";
import type { Commands, GateRow, RtResponse } from "../packages/rt-client/src/index.ts";
import { parseDuration, nextWaitMs } from "./events.ts";

function fail(msg: string): never {
  console.error(`rt gate: ${msg}`);
  process.exit(1);
}

// Index-based scan, same reasoning as events.ts's positional(): a positional
// that equals a flag's value (e.g. an id that looks like "--by") must still
// parse as positional.
const FLAGS_WITH_VALUES = new Set([
  "--subject", "--kind", "--questions", "--meta", "--agent", "--pane", "--nudge",
  "--answers", "--by", "--timeout", "--subject-prefix", "--reason", "--session",
]);
function positional(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("--")) {
      if (FLAGS_WITH_VALUES.has(a)) i++; // skip the flag's value slot
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

function parseJsonFlag(args: string[], flag: string): unknown {
  const raw = flagValue(args, flag);
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    fail(`${flag} is not valid JSON: ${raw}`);
  }
}

function unwrap<T>(res: RtResponse<T>, label: string): T {
  if (!res.ok || res.data === undefined) fail(res.error ?? `${label} failed`);
  return res.data;
}

// ─── open ────────────────────────────────────────────────────────────────────

const OPEN_USAGE =
  "usage: rt gate open --subject <s> --kind <k> --questions <json> [--meta <json>] [--agent <id>] [--pane <id>] [--nudge <json>]";

export function buildOpenPayload(args: string[]): Commands["gate:open"]["payload"] {
  const subject = flagValue(args, "--subject");
  const kind = flagValue(args, "--kind");
  if (!subject) fail(OPEN_USAGE);
  if (!kind) fail(OPEN_USAGE);
  const questions = parseJsonFlag(args, "--questions");
  if (questions === undefined) fail(OPEN_USAGE);

  const payload: Commands["gate:open"]["payload"] = {
    subject, kind, questions: questions as Commands["gate:open"]["payload"]["questions"],
  };
  const meta = parseJsonFlag(args, "--meta");
  if (meta !== undefined) payload.meta = meta as Record<string, unknown>;
  const agent = flagValue(args, "--agent");
  if (agent !== undefined) payload.agent = agent;
  const pane = flagValue(args, "--pane");
  if (pane !== undefined) payload.pane = pane;
  const nudge = parseJsonFlag(args, "--nudge");
  if (nudge !== undefined) payload.nudge = nudge as { session: string };
  return payload;
}

export async function gateOpen(args: string[]): Promise<void> {
  const payload = buildOpenPayload(args);
  const res = await clientOpen(payload);
  const data = unwrap(res, "open");
  console.log(JSON.stringify({ ok: true, id: data.id, supersededId: data.supersededId }));
}

// ─── answer ──────────────────────────────────────────────────────────────────

const ANSWER_USAGE = "usage: rt gate answer <id> --answers <json> --by <surface>";

export function buildAnswerPayload(args: string[]): Commands["gate:answer"]["payload"] {
  const id = positional(args);
  const answers = parseJsonFlag(args, "--answers");
  const by = flagValue(args, "--by");
  if (!id) fail(ANSWER_USAGE);
  if (answers === undefined) fail(ANSWER_USAGE);
  if (!by) fail(ANSWER_USAGE);
  return { id, answers: answers as Commands["gate:answer"]["payload"]["answers"], by };
}

export async function gateAnswer(args: string[]): Promise<void> {
  const payload = buildAnswerPayload(args);
  const res = await clientAnswer(payload);
  const data = unwrap(res, "answer");
  // A CAS loss is a defined outcome (ok:true, conflict:true) carrying the
  // winning row, not an error — see packages/rt-client/src/commands.ts.
  if (data.conflict) console.error(`rt gate: answer lost — ${payload.id} was already answered; showing the winning row`);
  console.log(JSON.stringify({ ok: true, row: data.row, conflict: data.conflict ?? false }));
}

// ─── wait ────────────────────────────────────────────────────────────────────

const WAIT_USAGE = "usage: rt gate wait <id> [--timeout <duration>]";

type WaitFn = typeof clientWait;
type WaitOutcome =
  | { terminal: "answered" | "closed"; row: GateRow }
  | { terminal: "not-found" }
  | { terminal: "budget" };

/**
 * Wait-forever-by-default loop: gate:wait's daemon-side clamp (240s, see
 * gates-store.ts) means a single call can't honor an unbounded or long
 * --timeout, so this re-enters on `status: "timeout"` until `deadline` is
 * spent. not-found is terminal and never re-entered (the daemon told us
 * the id doesn't exist — retrying can't change that); answered/closed are
 * also terminal. `wait` is injectable so the loop is testable without a
 * daemon.
 */
export async function waitForGate(id: string, deadline: number | null, wait: WaitFn = clientWait): Promise<WaitOutcome> {
  while (true) {
    const waitMs = nextWaitMs(deadline, Date.now());
    if (waitMs === 0) return { terminal: "budget" };
    const res = await wait({ id, waitMs });
    if (!res.ok) {
      if (res.error === "not-found") return { terminal: "not-found" };
      fail(res.error ?? "wait failed");
    }
    const data = res.data!;
    if (data.status === "timeout") continue;
    return { terminal: data.status, row: data.row! };
  }
}

export async function gateWait(args: string[]): Promise<void> {
  const id = positional(args);
  if (!id) fail(WAIT_USAGE);
  let deadline: number | null = null;
  const t = flagValue(args, "--timeout");
  if (t !== undefined) {
    const ms = parseDuration(t);
    if (ms == null) fail(`--timeout: bad duration "${t}" (use 30s, 5m, 500ms, or bare seconds)`);
    deadline = Date.now() + ms;
  }

  const outcome = await waitForGate(id, deadline);
  if (outcome.terminal === "budget") {
    console.log(JSON.stringify({ ok: true, timedOut: true }));
    process.exit(124);
  }
  if (outcome.terminal === "not-found") fail(`gate not found: ${id}`);
  console.log(JSON.stringify({ ok: true, status: outcome.terminal, row: outcome.row }));
}

// ─── list ────────────────────────────────────────────────────────────────────

export function buildListPayload(args: string[]): Commands["gate:list"]["payload"] {
  const payload: Commands["gate:list"]["payload"] = {};
  if (args.includes("--open")) payload.open = true;
  const subjectPrefix = flagValue(args, "--subject-prefix");
  if (subjectPrefix !== undefined) payload.subjectPrefix = subjectPrefix;
  const kind = flagValue(args, "--kind");
  if (kind !== undefined) payload.kind = kind;
  return payload;
}

export async function gateList(args: string[]): Promise<void> {
  const payload = buildListPayload(args);
  const res = await clientList(payload);
  const data = unwrap(res, "list");
  console.log(JSON.stringify({ ok: true, gates: data.gates }));
}

// ─── park / close ────────────────────────────────────────────────────────────

export async function gatePark(args: string[]): Promise<void> {
  const id = positional(args);
  if (!id) fail("usage: rt gate park <id>");
  const res = await clientPark({ id });
  unwrap(res, "park");
  console.log(JSON.stringify({ ok: true }));
}

const CLOSE_REASONS = new Set(["abandoned", "superseded", "pruned"]);
const CLOSE_USAGE = "usage: rt gate close <id> --reason <abandoned|superseded|pruned>";

export async function gateClose(args: string[]): Promise<void> {
  const id = positional(args);
  const reason = flagValue(args, "--reason");
  if (!id) fail(CLOSE_USAGE);
  if (!reason || !CLOSE_REASONS.has(reason)) fail(CLOSE_USAGE);
  const res = await clientClose({ id, reason: reason as Commands["gate:close"]["payload"]["reason"] });
  unwrap(res, "close");
  console.log(JSON.stringify({ ok: true }));
}

// ─── subscribe / unsubscribe ────────────────────────────────────────────────

export async function gateSubscribe(args: string[]): Promise<void> {
  const subjectPrefix = flagValue(args, "--subject-prefix");
  const session = flagValue(args, "--session");
  if (!subjectPrefix || !session) fail("usage: rt gate subscribe --subject-prefix <p> --session <addr>");
  const res = await clientSubscribe({ subjectPrefix, session });
  const data = unwrap(res, "subscribe");
  console.log(JSON.stringify({ ok: true, id: data.id }));
}

export async function gateUnsubscribe(args: string[]): Promise<void> {
  const id = positional(args);
  if (!id) fail("usage: rt gate unsubscribe <id>");
  const res = await clientUnsubscribe({ id });
  const data = unwrap(res, "unsubscribe");
  console.log(JSON.stringify({ ok: true, removed: data.removed }));
}
