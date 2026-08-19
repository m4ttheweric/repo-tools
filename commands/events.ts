/**
 * rt events — optional event bus for panes and skills (RT-44).
 *
 *   rt events emit <topic> [--json '{...}']            publish
 *   rt events wait <pattern> [--after N] [--timeout D] blocking subscribe (long-poll)
 *   rt events tail <pattern> [--after N]               follow-mode NDJSON stream
 *   rt events list <pattern> [--after N] [--limit N]   read the journal
 *
 * All output is JSON (skills consume it). Cursors are caller-held: every
 * response carries `cursor`; pass it back via --after. Timeout exits 124.
 * Spec: docs/superpowers/specs/2026-08-18-rt-events-bus-design.md
 */

import { daemonQuery } from "../lib/daemon-client.ts";

const DAEMON_WAIT_MS = 240_000;          // daemon clamps to this too
const IPC_TIMEOUT_MS = DAEMON_WAIT_MS + 10_000; // client abort must outlive the daemon cap

export function parseDuration(s: string): number | null {
  const m = /^(\d+)(ms|s|m|h)?$/.exec(s.trim());
  if (!m) return null;
  const n = parseInt(m[1]!, 10);
  const unit = m[2] ?? "s";
  return n * (unit === "ms" ? 1 : unit === "s" ? 1000 : unit === "m" ? 60_000 : 3_600_000);
}

export function nextWaitMs(deadline: number | null, now: number): number {
  if (deadline == null) return DAEMON_WAIT_MS;
  return Math.max(0, Math.min(DAEMON_WAIT_MS, deadline - now));
}

function fail(msg: string): never {
  console.error(`rt events: ${msg}`);
  process.exit(1);
}

function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

// Index-based scan (not value comparison — a positional that EQUALS a flag's
// value, e.g. `rt events wait 42 --after 42`, must still parse).
const FLAGS_WITH_VALUES = new Set(["--json", "--after", "--timeout", "--limit"]);
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

export async function eventsEmit(args: string[]): Promise<void> {
  const topic = positional(args);
  if (!topic) fail("usage: rt events emit <topic> [--json '<json>']");
  let payload: unknown;
  const raw = flagValue(args, "--json");
  if (raw !== undefined) {
    try { payload = JSON.parse(raw); } catch { fail(`--json is not valid JSON: ${raw}`); }
  }
  const res = await daemonQuery("events:emit", { topic, payload }, 10_000);
  if (!res) fail("daemon unavailable — the event bus needs the rt daemon (rt daemon start)");
  if (!res.ok) fail(res.error ?? "emit failed");
  console.log(JSON.stringify({ ok: true, id: res.data.id }));
}

/** Shared poll loop for wait (one round) and tail (endless). */
async function pollOnce(pattern: string, after: number | undefined, waitMs: number) {
  const res = await daemonQuery("events:wait", { pattern, after, waitMs }, IPC_TIMEOUT_MS);
  if (!res) fail("daemon unavailable — the event bus needs the rt daemon (rt daemon start)");
  if (!res.ok) fail(res.error ?? "wait failed");
  return res.data as { events: any[]; cursor: number };
}

export async function eventsWait(args: string[]): Promise<void> {
  const pattern = positional(args);
  if (!pattern) fail("usage: rt events wait <pattern> [--after <cursor>] [--timeout <dur>]");
  let after = flagValue(args, "--after") !== undefined ? Number(flagValue(args, "--after")) : undefined;
  if (after !== undefined && !Number.isFinite(after)) fail("--after must be a number");
  let deadline: number | null = null;
  const t = flagValue(args, "--timeout");
  if (t !== undefined) {
    const ms = parseDuration(t);
    if (ms == null) fail(`--timeout: bad duration "${t}" (use 30s, 5m, 500ms, or bare seconds)`);
    deadline = Date.now() + ms;
  }

  while (true) {
    const waitMs = nextWaitMs(deadline, Date.now());
    if (waitMs === 0) {
      console.log(JSON.stringify({ ok: true, timedOut: true, cursor: after ?? null }));
      process.exit(124);
    }
    const data = await pollOnce(pattern, after, waitMs);
    after = data.cursor; // ALWAYS thread the cursor — empty responses included
    if (data.events.length) {
      console.log(JSON.stringify({ ok: true, events: data.events, cursor: data.cursor }));
      return;
    }
  }
}

export async function eventsList(args: string[]): Promise<void> {
  const pattern = positional(args);
  if (!pattern) fail("usage: rt events list <pattern> [--after <cursor>] [--limit <n>]");
  const payload: Record<string, unknown> = { pattern };
  const after = flagValue(args, "--after");
  if (after !== undefined) payload.after = Number(after);
  const limit = flagValue(args, "--limit");
  if (limit !== undefined) payload.limit = Number(limit);
  const res = await daemonQuery("events:list", payload, 10_000);
  if (!res) fail("daemon unavailable — the event bus needs the rt daemon (rt daemon start)");
  if (!res.ok) fail(res.error ?? "list failed");
  console.log(JSON.stringify({ ok: true, events: res.data.events, cursor: res.data.cursor }));
}

export async function eventsTail(args: string[]): Promise<void> {
  const pattern = positional(args);
  if (!pattern) fail("usage: rt events tail <pattern> [--after <cursor>]");
  let after = flagValue(args, "--after") !== undefined ? Number(flagValue(args, "--after")) : undefined;
  if (after !== undefined && !Number.isFinite(after)) fail("--after must be a number");

  // Catch-up via list, then the same poll loop as wait, forever.
  // No --after means START FROM NOW (same default as wait) — never dump the
  // whole journal on a follow-mode consumer. MAX_SAFE_INTEGER returns zero
  // events plus cursor = journal head (list computes cursor = maxId() for
  // untruncated results).
  const listAfter = after ?? Number.MAX_SAFE_INTEGER;
  const res = await daemonQuery("events:list", { pattern, after: listAfter }, 10_000);
  if (!res) fail("daemon unavailable — the event bus needs the rt daemon (rt daemon start)");
  if (!res.ok) fail(res.error ?? "tail failed");
  for (const ev of res.data.events) console.log(JSON.stringify(ev));
  after = res.data.cursor;

  while (true) {
    const data = await pollOnce(pattern, after, DAEMON_WAIT_MS);
    after = data.cursor;
    for (const ev of data.events) console.log(JSON.stringify(ev));
  }
}
