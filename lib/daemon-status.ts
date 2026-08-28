/**
 * Daemon status classification.
 *
 * `daemonQuery` collapses several distinct outcomes into `null` — including the
 * case it has already proven the daemon is alive (see the socket-exists check
 * in `daemon-client.ts`, which returns null on a timed-out query rather than
 * attempting a restart). A caller that reads "no usable response" as "the
 * daemon is down" then tells the user to start a daemon that is already
 * running. This maps the raw outcome onto what is actually known.
 *
 * Below that, a second tier answers a harder question: rt.sock isn't
 * answering at all, but is the daemon actually down, or alive-and-stuck?
 * `pidAlive`/`breadcrumb`/`supervision` (Task 9's supervision-state.ts) are
 * the only signals that can tell, and per Ruling P1 (2026-08-28 p0-supervision
 * ledger) the breadcrumb FILE is the sole record a pre-state.db boot failure
 * leaves. `supervision` (the kv tier) can be absent even when `breadcrumb`
 * is present, and classification must still resolve to something useful from
 * the breadcrumb alone.
 */

import type { DaemonResponse } from "./daemon-client.ts";
import { isCrashLooping, type BootPhase, type SupervisionState } from "./daemon/supervision-state.ts";

export type DaemonStatusVerdict =
  | { state: "not-installed" }
  | { state: "running"; data: any }
  /** Up — proven by an answer or a ping — but `status` itself did not deliver. */
  | { state: "degraded"; reason: "error" | "unresponsive"; detail?: string; pid: number | null; eventLoop?: StatusEventLoop }
  /** Ping fails, a live pid exists, and it's parked waiting for a different
   *  flavor to hold rt.sock (park.ts): a flavor standoff, not a stuck boot. */
  | { state: "parked"; pid: number; holderFlavor?: string }
  /** Ping fails but the pid is alive: still mid-boot, stuck after reaching
   *  ready, alive-but-quarantined (recovered from a corrupt db), or stalled
   *  (reached ready but the heartbeat file has gone stale). */
  | { state: "alive-not-serving"; pid: number; detail: "booting" | "wedged" | "quarantined" | "stalled"; stalledForMs?: number }
  /** No live pid, and the kv failure record shows >= N failures within the window. */
  | { state: "crash-looping"; failures: number; reason: string }
  /** No live pid, and the most recent recorded exit was a boot throw (fewer than N failures). */
  | { state: "boot-failed"; reason: string; phase: string }
  | { state: "not-running"; pid: number | null };

/** Structural match for the daemon's heartbeat-file record; not imported from
 *  its owning module to avoid a cycle. */
export interface HeartbeatInput {
  at: number;
  seq: number;
}

/** Structural match for the ping-supplied event-loop summary, passed through
 *  on the degraded verdict for display. */
export interface StatusEventLoop {
  maxLagMs: number;
  lastStallAt: number | null;
  lastStallCmd: string | null;
  stalls: number;
}

/** The boot breadcrumb (`daemon-boot.json`), as classifyDaemonStatus needs it. Not
 *  imported from supervision-state.ts, since that module's `Breadcrumb` interface is
 *  intentionally unexported, and this shape only needs to be structurally
 *  compatible with it. */
export interface DaemonBreadcrumbInput {
  phase: BootPhase;
  flavor?: "dev" | "prod";
  pid?: number;
  at?: number;
}

export interface DaemonStatusInputs {
  installed: boolean;
  /** The `status` reply, or null/absent if the transport gave up. */
  response?: DaemonResponse | null;
  /** Result of a `ping` probe. Only meaningful when `response` is absent. */
  pingOk?: boolean;
  /** Last recorded pid, for the operator to act on. */
  pid: number | null;
  /** Raw OS-level liveness of `pid` (process.kill(pid,0), or a pgrep-found
   *  stand-in), independent of rt.sock. Only worth gathering once `pingOk`
   *  has already come back false; see `classifyDaemonStatus.needsPidProbe`. */
  pidAlive?: boolean;
  /** This machine's currently-intended flavor (`resolveIntendedMode().mode`).
   *  A live pid whose own breadcrumb flavor disagrees with this is parked
   *  (park.ts), not stuck: the same signal `parkUntilIntended` itself acts on. */
  intendedFlavor?: "dev" | "prod";
  /** The socket holder's flavor, when the caller managed to learn it (best
   *  effort: probing rt.sock again after a failed ping/status round rarely
   *  succeeds, since a parked pid never binds it). Display-only. */
  holderFlavor?: string | null;
  breadcrumb?: DaemonBreadcrumbInput | null;
  /** Task 9's kv tier. Can be absent even when `breadcrumb` is present: a
   *  pre-state.db failure leaves only the breadcrumb file (Ruling P1). */
  supervision?: SupervisionState;
  /** Injected for deterministic crash-loop window checks under test; defaults to Date.now(). */
  now?: number;
  /** The daemon's heartbeat-file record, when the caller read one. */
  heartbeat?: HeartbeatInput | null;
  /** How old `heartbeat` must be to count as stale. Defaults to 6000ms. */
  heartbeatStaleMs?: number;
  /** Ping's event-loop summary, passed through onto a `degraded` verdict. */
  pingEventLoop?: StatusEventLoop;
}

const PHASE_ORDER: BootPhase[] = ["start", "events-db", "state-db", "api", "socket", "ready"];

function classifyAliveNotServingDetail(
  breadcrumb: DaemonBreadcrumbInput | null | undefined,
  supervision: SupervisionState | undefined,
  heartbeat: HeartbeatInput | null | undefined,
  heartbeatStaleMs: number,
  now: number,
): { detail: "booting" | "wedged" | "quarantined" | "stalled"; stalledForMs?: number } {
  const phase = breadcrumb?.phase;
  if (!phase || PHASE_ORDER.indexOf(phase) < PHASE_ORDER.indexOf("ready")) return { detail: "booting" };
  // A live heartbeat gone stale outranks the boot-failed check below: it is
  // ground truth that the process stopped ticking, not a record of a past
  // recovery it may be running fine behind.
  if (heartbeat && now - heartbeat.at > heartbeatStaleMs) {
    return { detail: "stalled", stalledForMs: now - heartbeat.at };
  }
  // Reached ready this run, but a prior attempt is on record as boot-failed,
  // most likely a corrupt-db quarantine (lib/state/db.ts, events-bus.ts) it
  // recovered from and is now stuck behind for an unrelated reason.
  if (supervision?.lastExit?.kind === "boot-failed") return { detail: "quarantined" };
  return { detail: "wedged" };
}

function countRecentFailures(supervision: SupervisionState, now: number, windowMs = 5 * 60_000): number {
  const floor = now - windowMs;
  return supervision.recentFailures.filter((f) => f.at > floor).length;
}

export function classifyDaemonStatus(opts: DaemonStatusInputs): DaemonStatusVerdict {
  const { installed, response, pingOk, pid, pidAlive, intendedFlavor, holderFlavor, breadcrumb, supervision } = opts;

  if (!installed) return { state: "not-installed" };

  if (response?.ok) return { state: "running", data: response.data };

  // A reply — any reply — is proof of life. The daemon is up and the `status`
  // command is what failed, so surface its error instead of hiding it behind
  // "not running".
  if (response) {
    return { state: "degraded", reason: "error", detail: response.error, pid };
  }

  // No reply. A plain ping is the next ground truth: a daemon busy enough to
  // blow the status timeout still answers a trivial ping.
  if (pingOk) return { state: "degraded", reason: "unresponsive", pid, eventLoop: opts.pingEventLoop };

  // Ping failed too. From here, only pidAlive/breadcrumb/supervision (new
  // signals) can say more than "not running"; absent them, fall straight
  // through to the pre-existing not-running verdict.
  if (pidAlive && pid !== null) {
    if (breadcrumb?.flavor && intendedFlavor && breadcrumb.flavor !== intendedFlavor) {
      return { state: "parked", pid, ...(holderFlavor ? { holderFlavor } : {}) };
    }
    const now = opts.now ?? Date.now();
    const d = classifyAliveNotServingDetail(breadcrumb, supervision, opts.heartbeat, opts.heartbeatStaleMs ?? 6000, now);
    return { state: "alive-not-serving", pid, detail: d.detail, ...(d.stalledForMs !== undefined ? { stalledForMs: d.stalledForMs } : {}) };
  }

  if (supervision) {
    const now = opts.now ?? Date.now();
    if (isCrashLooping(supervision, now)) {
      const reason = supervision.lastExit?.kind === "boot-failed"
        ? supervision.lastExit.reason
        : (supervision.recentFailures.at(-1)?.reason ?? "unknown");
      return { state: "crash-looping", failures: countRecentFailures(supervision, now), reason };
    }
    if (supervision.lastExit?.kind === "boot-failed") {
      const phase = supervision.recentFailures.at(-1)?.phase ?? "unknown";
      return { state: "boot-failed", reason: supervision.lastExit.reason, phase };
    }
  }

  return { state: "not-running", pid };
}

/**
 * Whether a `ping` round-trip is needed to classify. Any answer already settles
 * liveness, so the probe is only worth paying for on a null response.
 */
classifyDaemonStatus.needsLivenessProbe = (response: DaemonResponse | null): boolean =>
  response === null;

/**
 * Whether the pid/breadcrumb/supervision probes are worth paying for: only
 * once both `status` and a plain `ping` have failed to answer.
 */
classifyDaemonStatus.needsPidProbe = (response: DaemonResponse | null, pingOk: boolean): boolean =>
  response === null && !pingOk;
