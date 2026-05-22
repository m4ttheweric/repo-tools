/**
 * TunnelManager — owns the single cloudflared child per runner board.
 *
 * Lifecycle is driven entirely by `apply(boardName, lanes)`:
 *   - any enabled lane && no running cloudflared  → write YAML, spawn
 *   - any enabled lane && already running         → rewrite YAML, SIGHUP
 *   - no enabled lanes && already running         → kill (stop sharing)
 *   - no enabled lanes && not running             → no-op
 *
 * SIGHUP relies on cloudflared's documented graceful-reload behavior; on reload
 * cloudflared re-reads --config and applies new ingress rules without dropping
 * connections to unchanged hostnames.
 */

import { writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import type { ProcessManager } from "./process-manager.ts";
import type { LaneConfig } from "../runner-store.ts";
import { loadTunnelConfig, runtimeYamlPath } from "../tunnel-config.ts";
import { generateIngressYaml } from "../tunnel-ingress.ts";
import { getDaemonLogger } from "../daemon-logger.ts";
const log = (await getDaemonLogger()).childLogger("tunnel");

export type TunnelStatus =
  | { state: "stopped" }
  | { state: "running"; hostnames: string[]; yamlPath: string };

export interface TunnelManagerDeps {
  processManager: Pick<ProcessManager, "spawn" | "kill" | "getProcess" | "getSpawnConfig">;
}

/** Daemon process id used to register the cloudflared child for a board. */
export function tunnelProcessId(boardName: string): string {
  return `tunnel-${boardName}`;
}

export class TunnelManager {
  private deps: TunnelManagerDeps;
  private lastHostnames = new Map<string, string[]>();

  constructor(deps: TunnelManagerDeps) {
    this.deps = deps;
  }

  /** Bring cloudflared's running state into agreement with `lanes`. */
  async apply(boardName: string, lanes: LaneConfig[]): Promise<void> {
    const enabledLanes = lanes.filter((l) => l.tunnel?.enabled === true);

    if (enabledLanes.length === 0) {
      const id = tunnelProcessId(boardName);
      if (this.deps.processManager.getSpawnConfig(id)) {
        await this.deps.processManager.kill(id);
        log.info(`stopped cloudflared for board ${boardName} (no lanes enabled)`);
      }
      this.lastHostnames.delete(boardName);
      return;
    }

    const cfg = loadTunnelConfig();
    if (!cfg || !cfg.tunnelId) {
      throw new Error("Cloudflare tunnel not configured — run setup first (rt pick-tunnel)");
    }

    const yamlPath = runtimeYamlPath(boardName);
    const yaml = generateIngressYaml(cfg, lanes);
    mkdirSync(dirname(yamlPath), { recursive: true });
    writeFileSync(yamlPath, yaml);

    const id = tunnelProcessId(boardName);
    const running = this.deps.processManager.getProcess(id);
    if (running) {
      try { process.kill(running.pid as number, "SIGHUP"); } catch (err) {
        // SIGHUP can fail if the process exited between getProcess() and kill() —
        // this is expected when cloudflared restarted on its own.
        log.debug({ err }, `SIGHUP failed for board ${boardName} (process may have already exited)`);
      }
      log.info(`reloaded cloudflared for board ${boardName}`);
    } else {
      const cmd = `cloudflared tunnel --no-autoupdate --config ${shellEscape(yamlPath)} run`;
      await this.deps.processManager.spawn(id, cmd, { cwd: process.env.HOME ?? "/" });
      log.info(`spawned cloudflared for board ${boardName}`);
    }

    this.lastHostnames.set(boardName, enabledLanes.map((l) =>
      `${cfg.hostnamePrefix}${l.canonicalPort}.${cfg.baseDomain}`));
  }

  status(boardName: string): TunnelStatus {
    const id = tunnelProcessId(boardName);
    const running = this.deps.processManager.getProcess(id);
    if (!running) return { state: "stopped" };
    return {
      state: "running",
      hostnames: this.lastHostnames.get(boardName) ?? [],
      yamlPath: runtimeYamlPath(boardName),
    };
  }

  async stop(boardName: string): Promise<void> {
    const id = tunnelProcessId(boardName);
    if (this.deps.processManager.getSpawnConfig(id)) {
      await this.deps.processManager.kill(id);
    }
    this.lastHostnames.delete(boardName);
  }
}

function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}
