/**
 * SuspendManager — SIGSTOP/SIGCONT for process trees.
 *
 * Uses `pgrep -P <pid>` recursively to walk the full process tree so that
 * child processes (e.g. webpack watchers spawned by `pnpm run dev`) are also
 * frozen/thawed. Signals each PID individually in a best-effort try/catch —
 * this avoids the exit-code issue with multi-pid `kill` when a descendant
 * exits between `pgrep` and the signal.
 */

import type { ProcessManager } from "./process-manager.ts";
import type { StateStore } from "./state-store.ts";

export class SuspendManager {
  private processManager: ProcessManager;
  private stateStore: StateStore;

  constructor(deps: { processManager: ProcessManager; stateStore: StateStore }) {
    this.processManager = deps.processManager;
    this.stateStore = deps.stateStore;
  }

  /** Recursively collect all PIDs in the process tree rooted at `rootPid`. */
  private async getDescendants(rootPid: number): Promise<number[]> {
    const pids: number[] = [rootPid];
    const queue: number[] = [rootPid];

    while (queue.length > 0) {
      const parent = queue.shift()!;
      try {
        const result = Bun.spawnSync(["pgrep", "-P", String(parent)]);
        const children = new TextDecoder()
          .decode(result.stdout)
          .trim()
          .split("\n")
          .map(Number)
          .filter((n) => !isNaN(n) && n > 0);
        pids.push(...children);
        queue.push(...children);
      } catch {
        // pgrep exits non-zero if no children — that's fine
      }
    }

    return pids;
  }

  private sendSignalToTree(pids: number[], signal: NodeJS.Signals): void {
    for (const pid of pids) {
      try {
        process.kill(pid, signal);
      } catch {
        // PID may have already exited — best-effort
      }
    }
  }

  async suspend(processId: string): Promise<void> {
    const proc = this.processManager.getProcess(processId);
    if (!proc?.pid) return;

    const pids = await this.getDescendants(proc.pid);
    this.sendSignalToTree(pids, "SIGSTOP");
    this.stateStore.setState(processId, "warm");
  }

  async resume(processId: string): Promise<void> {
    const proc = this.processManager.getProcess(processId);
    if (!proc?.pid) return;

    const pids = await this.getDescendants(proc.pid);
    this.sendSignalToTree(pids, "SIGCONT");
    this.stateStore.setState(processId, "running");
  }
}
