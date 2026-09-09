/**
 * Endpoint port allocator — sticky, lowest-available, probe-verified.
 *
 * Ports for `endpoint/config.ts` `RoleConfig.pool` are claimed from
 * `endpoint/store.ts`'s persisted `EndpointClaim` rows. Pure allocation logic
 * lives here; probes (who's listening, is a pid alive, can we actually bind)
 * are injected so the logic is testable without touching the network or
 * process table.
 *
 * These are the same lessons the old dev-ports shim learned the hard way:
 *  - no TTLs for a start-time-verified claim: live iff its pid is alive and
 *    its process start-time still matches what was recorded at claim time
 *    (S068: a pid whose start-time has changed was recycled after a reboot,
 *    not the claim's owner). A legacy claim with no recorded start-time
 *    falls back to trusting a live pid only within CLAIM_TRUST_TTL_MS.
 *  - boot window — a claim can be live (pid alive) before its port actually
 *    starts listening, so a competing worktree must still treat it as taken.
 *  - self-claim survival — a worktree's own claim is never pruned as dead,
 *    even if it looks dead by every probe, and its own listening port is
 *    always reusable on restart.
 *  - bind-probe veto — even a port nobody has claimed and nothing is
 *    listening on can still fail to bind (owned by something outside our
 *    bookkeeping), so an actual bind attempt is the final check.
 */

import type { RoleConfig } from "./config.ts";
import type { EndpointClaim } from "./store.ts";
import { parseCwdMap, parseListeningLsof } from "../port-scanner.ts";
import { runCapture } from "../subprocess.ts";

// ─── Probes ──────────────────────────────────────────────────────────────────

export interface Probes {
  listeners: Set<number>; // ports currently LISTENing
  listenerOf(port: number): { pid: number; command: string } | undefined; // who holds the LISTEN (RT-115)
  pidCwd(pid: number): Promise<string | undefined>; // async: a fresh lsof per call, paid only by lookup's owner attribution
  pidAlive(pid: number | undefined): boolean; // kill(0); EPERM counts alive
  pidStartTime(pid: number | undefined): string | undefined; // S068: recycled-pid detection
  canBind(port: number): boolean; // bind-probe (DECK-9)
}

// ─── Liveness ────────────────────────────────────────────────────────────────

/**
 * A legacy claim (written before S068's start_time column) has no start-time
 * to compare, so a live pid is trusted only for this long after the claim's
 * own timestamp: long enough to outlive any ordinary dev-server session,
 * short enough that a reboot's pid recycling stops mattering once every
 * legacy row has aged out.
 */
export const CLAIM_TRUST_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * A claim is live iff its port is listening, or its recorded pid is alive AND
 * (for a start-time-bearing row) that pid's current start-time still matches
 * what was recorded at claim time: a mismatch means the pid number was
 * recycled by a different process after a reboot, which is not the claim's
 * owner. A legacy row with no start-time falls back to CLAIM_TRUST_TTL_MS.
 */
export function isLiveClaim(c: EndpointClaim, probes: Probes, now: number = Date.now()): boolean {
  if (probes.listeners.has(c.port)) return true;
  if (!probes.pidAlive(c.pid)) return false;
  if (c.startTime === undefined) {
    const age = now - Date.parse(c.ts);
    return Number.isFinite(age) && age < CLAIM_TRUST_TTL_MS;
  }
  return probes.pidStartTime(c.pid) === c.startTime;
}

/**
 * Drops claims that are neither live nor owned by `selfWorktree`. A
 * worktree's own claim is always spared, even when it looks dead by every
 * probe — losing your own claim mid-boot would hand your port to someone
 * else.
 */
export function pruneDeadClaims(
  claims: EndpointClaim[],
  selfWorktree: string,
  probes: Probes,
  now: number = Date.now(),
): { claims: EndpointClaim[]; pruned: boolean } {
  const kept = claims.filter((c) => c.worktree === selfWorktree || isLiveClaim(c, probes, now));
  return { claims: kept, pruned: kept.length !== claims.length };
}

// ─── Allocation ──────────────────────────────────────────────────────────────

export interface ClaimResult {
  port: number;
  claims: EndpointClaim[];
  changed: boolean;
}

export function resolveClaim(
  claims: EndpointClaim[],
  role: string,
  roleCfg: RoleConfig,
  worktree: string,
  pid: number | undefined,
  probes: Probes,
): ClaimResult | { error: string } {
  if (roleCfg.fixedPort !== undefined) {
    return { port: roleCfg.fixedPort, claims, changed: false };
  }

  const { claims: pruned } = pruneDeadClaims(claims, worktree, probes);
  const selfClaim = pruned.find((c) => c.worktree === worktree && c.role === role);

  // Ports held by OTHER worktrees' live claims.
  const blocked = new Set<number>();
  for (const c of pruned) {
    if (c.worktree !== worktree && isLiveClaim(c, probes)) blocked.add(c.port);
  }
  // Anything actually listening, except the self-claim's own port (which, if
  // listening, is ours to reuse rather than a block).
  for (const p of probes.listeners) {
    if (p !== selfClaim?.port) blocked.add(p);
  }

  let winningPort: number | undefined;
  // Counts ports that actually passed the bind probe, not just ports that
  // weren't blocked by claim/listener bookkeeping — a candidate that every
  // canBind call vetoes is not "free", so the exhaustion message below must
  // not call it that.
  let bindableCount = 0;

  if (selfClaim !== undefined && !blocked.has(selfClaim.port)) {
    winningPort = selfClaim.port;
  } else {
    const candidates = roleCfg.pool.filter((p) => !blocked.has(p));
    for (const p of candidates) {
      if (probes.canBind(p)) {
        bindableCount++;
        winningPort = p;
        break;
      }
    }
    if (winningPort === undefined) {
      return {
        error: `no free port in pool for role "${role}" (${roleCfg.pool.length} declared, ${bindableCount} free)`,
      };
    }
  }

  const ts = new Date().toISOString();
  // ps failing or timing out this round must never downgrade a claim that
  // was already pid-recycle verified: a live-but-unproven pid falls back to
  // the previous verified startTime rather than overwriting it with
  // undefined (which would silently drop to CLAIM_TRUST_TTL_MS trust).
  const startTime = pid !== undefined ? (probes.pidStartTime(pid) ?? selfClaim?.startTime) : undefined;
  const nextClaims = selfClaim
    ? pruned.map((c) => (c === selfClaim ? { ...c, port: winningPort!, pid, ts, startTime } : c))
    : [...pruned, { worktree, role, port: winningPort!, pid, ts, startTime }];

  return { port: winningPort!, claims: nextClaims, changed: true };
}

export function releaseWorktree(
  claims: EndpointClaim[],
  worktree: string,
  role?: string,
): { claims: EndpointClaim[]; released: EndpointClaim[] } {
  const released: EndpointClaim[] = [];
  const remaining: EndpointClaim[] = [];
  for (const c of claims) {
    if (c.worktree === worktree && (role === undefined || c.role === role)) {
      released.push(c);
    } else {
      remaining.push(c);
    }
  }
  return { claims: remaining, released };
}

// ─── Real probes ─────────────────────────────────────────────────────────────

/**
 * Real-world probes: listeners via an async `lsof` spawn (never sync — this
 * runs on the daemon thread), pid liveness via `kill(pid, 0)`, and bind
 * ability via an actual `Bun.listen` attempt immediately torn down.
 */

/**
 * Parses `ps -axo pid=,lstart=` output into pid → start-time string. `lstart`
 * is a multi-word date (`Thu Aug 28 10:23:45 2026`), so only the FIRST
 * whitespace run separates the pid column from it: splitting on all
 * whitespace would shred the date itself.
 */
function parsePidStartTimes(psOutput: string): Map<number, string> {
  const startTimes = new Map<number, string>();
  for (const line of psOutput.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const spaceIdx = trimmed.indexOf(" ");
    if (spaceIdx === -1) continue;
    const pid = Number(trimmed.slice(0, spaceIdx));
    if (!Number.isInteger(pid)) continue;
    startTimes.set(pid, trimmed.slice(spaceIdx + 1).trim());
  }
  return startTimes;
}

export async function defaultProbes(): Promise<Probes> {
  const [lsofRes, psRes] = await Promise.all([
    runCapture(["lsof", "-nP", "-iTCP", "-sTCP:LISTEN"], { timeoutMs: 5000 }),
    runCapture(["ps", "-axo", "pid=,lstart="], { timeoutMs: 5000 }),
  ]);
  const listening = parseListeningLsof(lsofRes.stdout);
  const listeners = new Set(listening.map((l) => l.port));
  // First LISTEN per port wins — a port bound on both stacks (IPv4 + IPv6)
  // or via SO_REUSEPORT is still one owner for attribution purposes.
  const byPort = new Map<number, { pid: number; command: string }>();
  for (const l of listening) {
    if (!byPort.has(l.port)) byPort.set(l.port, { pid: l.pid, command: l.command });
  }
  const startTimes = parsePidStartTimes(psRes.stdout);

  return {
    listeners,
    listenerOf(port) {
      return byPort.get(port);
    },
    async pidCwd(pid) {
      const res = await runCapture(["lsof", "-a", "-p", String(pid), "-d", "cwd", "-Fpn"], { timeoutMs: 5000 });
      return parseCwdMap(res.stdout).get(pid);
    },
    pidAlive(pid) {
      if (pid === undefined) return false;
      try {
        process.kill(pid, 0);
        return true;
      } catch (err) {
        return (err as NodeJS.ErrnoException).code === "EPERM";
      }
    },
    pidStartTime(pid) {
      return pid === undefined ? undefined : startTimes.get(pid);
    },
    canBind(port) {
      try {
        // `socket` MUST carry at least a `data` (or `drain`) handler: Bun
        // rejects an empty handler object with a synchronous
        // ERR_INVALID_ARG_TYPE *before* it ever attempts the bind, which would
        // make this probe answer "taken" for every port in the pool and fail
        // every allocation with "no free port". The handler itself is dead
        // code — the listener is stopped before it can ever accept anything;
        // it exists purely to get past that argument check so the real
        // EADDRINUSE signal comes through.
        const server = Bun.listen({ hostname: "127.0.0.1", port, socket: { data() {} } });
        server.stop();
        return true;
      } catch {
        return false;
      }
    },
  };
}
