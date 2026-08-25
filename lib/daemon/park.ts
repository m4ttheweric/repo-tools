/**
 * Flavor park (spec: flavor-exclusivity §2). Runs at the TOP of
 * lib/daemon.ts module scope: everything below it arms live subsystems
 * (cron, the home-snapshot auto-committer, sweeps) and startDaemon()
 * SIGTERMs the shared rt.pid — so a daemon that is not this machine's
 * intended flavor must never get past this function. Parking is a loop,
 * not an exit: KeepAlive={SuccessfulExit:false} on both flavor plists
 * means exiting would respawn-churn, and staying alive lets a toggle
 * flip convert this process into the serving daemon within one cycle.
 */
import type { IntendedMode } from "../dev-mode.ts";
import { resolveIntendedMode } from "../dev-mode.ts";
import { DAEMON_SOCK_PATH } from "../daemon-config.ts";

declare const RT_VERSION: string | undefined;

export function daemonFlavor(): "dev" | "prod" {
  return typeof RT_VERSION !== "undefined" ? "prod" : "dev";
}

export interface SocketHolder {
  flavor: string;
  pid: number | null;
}

export interface ParkDeps {
  myFlavor: "dev" | "prod";
  resolveIntent: () => IntendedMode;
  probeHolder: () => Promise<SocketHolder | null>;
  sleep: (ms: number) => Promise<void>;
  log: { info: (o: unknown, m: string) => void; warn: (o: unknown, m: string) => void };
}

const PARK_INTERVAL_MS = 30_000;

export async function parkUntilIntended(deps: ParkDeps): Promise<void> {
  let intent: IntendedMode = { mode: deps.myFlavor, provenance: "derived-from-wrapper" };
  let announcedPark = false;
  let announcedStandoff = false;

  for (;;) {
    try {
      intent = deps.resolveIntent();
    } catch (err) {
      deps.log.warn({ err }, "intent read failed — keeping previous decision");
    }

    if (intent.mode !== deps.myFlavor) {
      if (!announcedPark) {
        deps.log.info(
          { myFlavor: deps.myFlavor, intended: intent.mode, provenance: intent.provenance },
          `parked: this machine's intended mode is ${intent.mode} — rechecking every ${PARK_INTERVAL_MS / 1000}s (flip with: rt settings dev-mode ${deps.myFlavor})`,
        );
        announcedPark = true;
      }
      await deps.sleep(PARK_INTERVAL_MS);
      continue;
    }

    const holder = await deps.probeHolder();
    if (holder) {
      if (!announcedStandoff) {
        deps.log.info(
          { holderFlavor: holder.flavor, holderPid: holder.pid },
          `standoff: rt.sock held by ${holder.flavor} pid ${holder.pid ?? "?"} — waiting for it to drain`,
        );
        announcedStandoff = true;
      }
      await deps.sleep(PARK_INTERVAL_MS);
      continue;
    }

    return;
  }
}

/** CONNECT to rt.sock and ask who answers. A dead/leaked socket file returns null (the boot path's unlink+bind handles it). */
export async function probeSocketHolder(sockPath: string = DAEMON_SOCK_PATH): Promise<SocketHolder | null> {
  try {
    const res = await fetch("http://localhost/ping", { unix: sockPath, signal: AbortSignal.timeout(1500) });
    const body = (await res.json()) as { pid?: number; flavor?: string };
    return { flavor: body.flavor ?? "unknown flavor", pid: body.pid ?? null };
  } catch {
    return null;
  }
}
