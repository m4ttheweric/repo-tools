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
 *  - no TTLs — a claim is live iff its pid is alive or its port is listening,
 *    regardless of how old the claim's timestamp is.
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
import { parseListeningLsof } from "../port-scanner.ts";
import { runCapture } from "../subprocess.ts";

// ─── Probes ──────────────────────────────────────────────────────────────────

export interface Probes {
  listeners: Set<number>; // ports currently LISTENing
  pidAlive(pid: number | undefined): boolean; // kill(0); EPERM counts alive
  canBind(port: number): boolean; // bind-probe (DECK-9)
}

// ─── Liveness ────────────────────────────────────────────────────────────────

/** A claim is live iff its port is listening or its recorded pid is alive. No TTLs. */
export function isLiveClaim(c: EndpointClaim, probes: Probes): boolean {
  return probes.listeners.has(c.port) || probes.pidAlive(c.pid);
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
): { claims: EndpointClaim[]; pruned: boolean } {
  const kept = claims.filter((c) => c.worktree === selfWorktree || isLiveClaim(c, probes));
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
  const nextClaims = selfClaim
    ? pruned.map((c) => (c === selfClaim ? { ...c, port: winningPort!, pid, ts } : c))
    : [...pruned, { worktree, role, port: winningPort!, pid, ts }];

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
export async function defaultProbes(): Promise<Probes> {
  const res = await runCapture(["lsof", "-nP", "-iTCP", "-sTCP:LISTEN"], { timeoutMs: 5000 });
  const listeners = new Set(parseListeningLsof(res.stdout).map((l) => l.port));

  return {
    listeners,
    pidAlive(pid) {
      if (pid === undefined) return false;
      try {
        process.kill(pid, 0);
        return true;
      } catch (err) {
        return (err as NodeJS.ErrnoException).code === "EPERM";
      }
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
