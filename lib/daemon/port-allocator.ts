/**
 * PortAllocator — tracks ephemeral port allocation for daemon-managed processes.
 *
 * Prevents two processes from receiving the same port by maintaining an explicit
 * allocation map. Persists to disk so ports survive daemon restarts (avoids
 * re-using a port that a just-killed process may still hold in TIME_WAIT).
 *
 * Does NOT probe TCP sockets — ports are tracked entirely by bookkeeping.
 * Scanning starts at 10000.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const START_PORT = 10000;
const END_PORT   = 65535;

export class PortAllocator {
  private allocated = new Map<number, string>(); // port → label
  private dataDir: string;

  constructor(dataDir?: string) {
    this.dataDir = dataDir ?? join(homedir(), ".rt");
    this.load();
  }

  private get persistPath(): string {
    return join(this.dataDir, "allocated-ports.json");
  }

  private load(): void {
    try {
      if (existsSync(this.persistPath)) {
        const raw = JSON.parse(readFileSync(this.persistPath, "utf8")) as Record<string, string>;
        for (const [portStr, label] of Object.entries(raw)) {
          const port = Number(portStr);
          if (Number.isInteger(port) && port > 0) {
            this.allocated.set(port, label);
          }
        }
      }
    } catch {
      // start fresh
    }
  }

  private persist(): void {
    try {
      mkdirSync(this.dataDir, { recursive: true });
      const obj: Record<string, string> = {};
      for (const [port, label] of this.allocated) obj[String(port)] = label;
      writeFileSync(this.persistPath, JSON.stringify(obj, null, 2));
    } catch {
      // best-effort
    }
  }

  /** Allocate a free port and associate it with `label`. */
  allocate(label: string): number {
    for (let port = START_PORT; port <= END_PORT; port++) {
      if (!this.allocated.has(port)) {
        this.allocated.set(port, label);
        this.persist();
        return port;
      }
    }
    throw new Error("PortAllocator: no free ports available");
  }

  /** Release a port by its number. No-op if not allocated. */
  release(port: number): void {
    if (this.allocated.delete(port)) {
      this.persist();
    }
  }

  /** Release a port by its label. Releases the first match. No-op if not found. */
  releaseByLabel(label: string): void {
    for (const [port, l] of this.allocated) {
      if (l === label) {
        this.allocated.delete(port);
        this.persist();
        return;
      }
    }
  }

  isAllocated(port: number): boolean {
    return this.allocated.has(port);
  }

  /**
   * Remove all allocations whose label is NOT in `validLabels`.
   * Call at daemon startup (with labels derived from persisted runner configs)
   * to purge orphaned ports left by removed entries or crashed restarts.
   */
  pruneToLabels(validLabels: Set<string>): number {
    let pruned = 0;
    for (const [port, label] of this.allocated) {
      if (!validLabels.has(label)) {
        this.allocated.delete(port);
        pruned++;
      }
    }
    if (pruned > 0) this.persist();
    return pruned;
  }

  list(): { port: number; label: string }[] {
    return Array.from(this.allocated.entries())
      .map(([port, label]) => ({ port, label }))
      .sort((a, b) => a.port - b.port);
  }
}
