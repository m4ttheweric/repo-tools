/**
 * Daemon-owned infra port-forwards (RT-22): the cluster-service endpoints
 * every rt cloud verb dials over localhost — the controller API (8080) and
 * the receiver git-ssh endpoint (2222) — held and healed by the daemon the
 * same way it holds per-sandbox pod forwards, so `rt sandbox create` works
 * with only the daemon running (no `rt validate`, no hand-held kubectl).
 */

import { spawnForward, type ForwardHandle, type ForwardSpawn } from "./sandbox-allocator.ts";
import { controllerUrl, receiverUrl } from "./validate-farm.ts";

/** The infra services live beside the controller, not with sandbox pods. */
export const INFRA_NAMESPACE = "mc-system";

export interface InfraForwardTarget {
  name: "controller" | "receiver";
  /** Kubernetes service name in INFRA_NAMESPACE. */
  service: string;
  /** Local port the endpoint URL dials. */
  localPort: number;
  /** The service's port inside the cluster. */
  servicePort: number;
}

/**
 * The port when the URL dials loopback, else null: the daemon only holds a
 * forward for an endpoint that actually lives behind localhost — a remote
 * MC_*_URL means the user routes elsewhere and a forward would shadow it.
 */
function loopbackPort(url: string, defaultPort: number): number | null {
  const match = url.match(/^[a-z+]+:\/\/(?:[^@/]+@)?([^:/]+)(?::(\d+))?/i);
  if (!match) return null;
  const host = match[1]!;
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") return null;
  return match[2] ? Number(match[2]) : defaultPort;
}

export function infraForwardTargets(): InfraForwardTarget[] {
  const targets: InfraForwardTarget[] = [];
  const controller = loopbackPort(controllerUrl(), 80);
  if (controller !== null) {
    targets.push({ name: "controller", service: "controller", localPort: controller, servicePort: 8080 });
  }
  const receiver = loopbackPort(receiverUrl(), 22);
  if (receiver !== null) {
    targets.push({ name: "receiver", service: "receiver", localPort: receiver, servicePort: 2222 });
  }
  return targets;
}

export type InfraOutcome = "spawned" | "respawned" | "kept" | "foreign";

export interface InfraForwardSet {
  /** One health pass: prune dead children, respawn what nothing serves. */
  ensureOnce(): Promise<Array<{ name: string; outcome: InfraOutcome }>>;
  stopAll(): void;
}

export interface InfraForwardDeps {
  targets?: InfraForwardTarget[];
  spawn?: ForwardSpawn;
  /** True when something accepts TCP on 127.0.0.1:port. */
  listens: (port: number) => Promise<boolean>;
  namespace?: string;
  log?: { info(obj: Record<string, unknown>, msg: string): void };
}

export function createInfraForwardSet(deps: InfraForwardDeps): InfraForwardSet {
  const targets = deps.targets ?? infraForwardTargets();
  const spawn = deps.spawn ?? spawnForward;
  const namespace = deps.namespace ?? INFRA_NAMESPACE;
  const held = new Map<string, ForwardHandle>();

  return {
    async ensureOnce() {
      const outcomes: Array<{ name: string; outcome: InfraOutcome }> = [];
      for (const target of targets) {
        const current = held.get(target.name);
        if (current) {
          if (!current.alive || current.alive()) {
            outcomes.push({ name: target.name, outcome: "kept" });
            continue;
          }
          held.delete(target.name);
        }
        // Nothing of ours holds the port (a dead child was pruned above and
        // listens no more). A listener there is a foreign holder (rt
        // validate's command-lifetime forward, a manual kubectl): spawning
        // would lose the bind race, so leave it alone. When it exits, the
        // next pass takes over.
        if (await deps.listens(target.localPort)) {
          outcomes.push({ name: target.name, outcome: "foreign" });
          continue;
        }
        const handle = spawn([
          "kubectl", "-n", namespace, "port-forward",
          `svc/${target.service}`, `${target.localPort}:${target.servicePort}`,
        ]);
        held.set(target.name, handle);
        const outcome: InfraOutcome = current ? "respawned" : "spawned";
        deps.log?.info(
          { target: target.name, local: target.localPort, service: `svc/${target.service}`, outcome },
          `infra forward ${outcome}`,
        );
        outcomes.push({ name: target.name, outcome });
      }
      return outcomes;
    },
    stopAll() {
      for (const handle of held.values()) handle.kill();
      held.clear();
    },
  };
}
