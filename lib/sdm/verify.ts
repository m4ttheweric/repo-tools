/**
 * Connection verification. sdm lies twice: `sdm status` can report
 * connected while the session is dead, and the tunnel port accepts TCP
 * while queries fail. Only SELECT 1 is authoritative; the TCP probe exists
 * as the cheap first-line check.
 */

import { connect } from "node:net";
import { SQL } from "bun";

export type ProbeResult = { ok: true; latencyMs: number } | { ok: false; error: Error };

export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      v => { clearTimeout(timer); resolve(v); },
      e => { clearTimeout(timer); reject(e); },
    );
  });
}

export function probeTunnel(host: string, port: number, timeoutMs = 1_500): Promise<ProbeResult> {
  return new Promise(resolve => {
    const start = Date.now();
    const socket = connect({ host, port });
    let settled = false;
    const settle = (r: ProbeResult) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(r);
    };
    socket.setTimeout(timeoutMs);
    socket.on("connect", () => settle({ ok: true, latencyMs: Date.now() - start }));
    socket.on("timeout", () => settle({ ok: false, error: new Error(`TCP connect timed out after ${timeoutMs}ms`) }));
    socket.on("error", err => settle({ ok: false, error: err }));
  });
}

/**
 * The authoritative "can I run a query right now?" check: throwaway client,
 * SELECT 1, hard timeout, always closed. Never rejects.
 */
export async function probeQuery(url: string, timeoutMs: number): Promise<ProbeResult> {
  let sql: SQL;
  try {
    sql = new SQL({ url, max: 1, connectionTimeout: Math.max(1, Math.ceil(timeoutMs / 1000)) });
  } catch (e) {
    return { ok: false, error: e as Error };
  }
  const start = Date.now();
  try {
    await withTimeout(Promise.resolve(sql`SELECT 1`), timeoutMs, "SELECT 1 probe");
    return { ok: true, latencyMs: Date.now() - start };
  } catch (e) {
    return { ok: false, error: e as Error };
  } finally {
    await sql.close().catch(() => {});
  }
}

export interface VerifyOutcome {
  ok: boolean;
  attempts: number;
  latencyMs: number | null;
  lastError: Error | null;
}

export const VERIFY_ATTEMPT_TIMEOUT_MS = 4_000;
// First attempt immediately, then these waits between attempts (max 5 total).
const VERIFY_WAITS_MS = [1_000, 2_000, 3_000, 3_000];
const VERIFY_BUDGET_MS = 15_000;

/**
 * Retry schedule that absorbs SDM tunnel warm-up: a freshly bound tunnel
 * accepts TCP immediately but often cannot complete a Postgres handshake
 * for a few seconds. sleep/now are injectable for tests.
 */
export async function verifyWithRetries(
  probe: () => Promise<ProbeResult>,
  opts: {
    waitsMs?: number[];
    budgetMs?: number;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  } = {},
): Promise<VerifyOutcome> {
  const waits = opts.waitsMs ?? VERIFY_WAITS_MS;
  const budget = opts.budgetMs ?? VERIFY_BUDGET_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const start = now();

  let attempts = 0;
  let lastError: Error | null = null;
  for (;;) {
    attempts += 1;
    const result = await probe();
    if (result.ok) return { ok: true, attempts, latencyMs: result.latencyMs, lastError: null };
    lastError = result.error;
    const wait = waits[attempts - 1];
    if (wait === undefined || now() - start + wait >= budget) break;
    await sleep(wait);
  }
  return { ok: false, attempts, latencyMs: null, lastError };
}

/** No password: SDM authenticates at the gateway; the local tunnel is open. */
export function buildPostgresUrl(address: string, db?: { database?: string; user?: string }): string {
  const user = db?.user ?? "postgres";
  const database = db?.database ?? "postgres";
  return `postgres://${user}@${address}/${database}`;
}
