/**
 * Daemon status classification.
 *
 * `daemonQuery` collapses several distinct outcomes into `null` — including the
 * case it has already proven the daemon is alive (see the socket-exists check
 * in `daemon-client.ts`, which returns null on a timed-out query rather than
 * attempting a restart). A caller that reads "no usable response" as "the
 * daemon is down" then tells the user to start a daemon that is already
 * running. This maps the raw outcome onto what is actually known.
 */

import type { DaemonResponse } from "./daemon-client.ts";

export type DaemonStatusVerdict =
  | { state: "not-installed" }
  | { state: "running"; data: any }
  /** Up — proven by an answer or a ping — but `status` itself did not deliver. */
  | { state: "degraded"; reason: "error" | "unresponsive"; detail?: string; pid: number | null }
  | { state: "not-running"; pid: number | null };

export interface DaemonStatusInputs {
  installed: boolean;
  /** The `status` reply, or null if the transport gave up. */
  response: DaemonResponse | null;
  /** Result of a `ping` probe. Only meaningful when `response` is null. */
  alive: boolean;
  /** Last recorded pid, for the operator to act on. */
  pid: number | null;
}

export function classifyDaemonStatus(opts: DaemonStatusInputs): DaemonStatusVerdict {
  const { installed, response, alive, pid } = opts;

  if (!installed) return { state: "not-installed" };

  if (response?.ok) return { state: "running", data: response.data };

  // A reply — any reply — is proof of life. The daemon is up and the `status`
  // command is what failed, so surface its error instead of hiding it behind
  // "not running".
  if (response) {
    return { state: "degraded", reason: "error", detail: response.error, pid };
  }

  // No reply. Ping is the only ground truth left: a daemon busy enough to blow
  // the status timeout still answers a trivial ping.
  if (alive) return { state: "degraded", reason: "unresponsive", pid };

  return { state: "not-running", pid };
}

/**
 * Whether a `ping` round-trip is needed to classify. Any answer already settles
 * liveness, so the probe is only worth paying for on a null response.
 */
classifyDaemonStatus.needsLivenessProbe = (response: DaemonResponse | null): boolean =>
  response === null;
