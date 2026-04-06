/**
 * ExclusiveGroup — "at most one running" invariant for process groups.
 *
 * When a process in a group is activated, all other currently-running members
 * are suspended (SIGSTOP). The activated process is resumed if it was warm.
 *
 * Persists to ~/.rt/exclusive-groups.json so group membership survives
 * daemon restarts.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { SuspendManager } from "./suspend-manager.ts";
import type { StateStore } from "./state-store.ts";

interface GroupRecord {
  members: string[];
  active: string | null;
}

export class ExclusiveGroup {
  private groups = new Map<string, GroupRecord>();
  private suspendManager: SuspendManager;
  private stateStore: StateStore;
  private dataDir: string;

  constructor(deps: { suspendManager: SuspendManager; stateStore: StateStore; dataDir?: string }) {
    this.suspendManager = deps.suspendManager;
    this.stateStore = deps.stateStore;
    this.dataDir = deps.dataDir ?? join(homedir(), ".rt");
    this.load();
  }

  private get persistPath(): string {
    return join(this.dataDir, "exclusive-groups.json");
  }

  private load(): void {
    try {
      if (existsSync(this.persistPath)) {
        const raw = JSON.parse(readFileSync(this.persistPath, "utf8"));
        // Support both formats:
        //   array: [{id, members, active|activeId}, ...]
        //   object: {groupId: {members, active}, ...}
        const entries: [string, GroupRecord][] = Array.isArray(raw)
          ? raw.map((r: any) => [
              String(r.id),
              { members: r.members ?? [], active: r.active ?? r.activeId ?? null },
            ])
          : Object.entries(raw as Record<string, any>).map(([k, v]: [string, any]) => [
              k,
              { members: v.members ?? [], active: v.active ?? v.activeId ?? null },
            ]);
        for (const [groupId, record] of entries) {
          this.groups.set(groupId, record);
        }
      }
    } catch {
      // start fresh
    }
  }

  private persist(): void {
    try {
      mkdirSync(this.dataDir, { recursive: true });
      const obj: Record<string, GroupRecord> = {};
      for (const [groupId, record] of this.groups) obj[groupId] = record;
      writeFileSync(this.persistPath, JSON.stringify(obj, null, 2));
    } catch {
      // best-effort
    }
  }

  create(groupId: string): void {
    if (!this.groups.has(groupId)) {
      this.groups.set(groupId, { members: [], active: null });
      this.persist();
    }
  }

  remove(groupId: string): void {
    if (this.groups.delete(groupId)) this.persist();
  }

  addMember(groupId: string, processId: string): void {
    const group = this.groups.get(groupId);
    if (!group) throw new Error(`ExclusiveGroup: group "${groupId}" does not exist`);
    if (!group.members.includes(processId)) {
      group.members.push(processId);
      this.persist();
    }
  }

  removeMember(groupId: string, processId: string): void {
    const group = this.groups.get(groupId);
    if (!group) return;
    group.members = group.members.filter((m) => m !== processId);
    if (group.active === processId) group.active = null;
    this.persist();
  }

  /**
   * Activate a process in a group.
   *
   * mode "warm"   — SIGSTOP other running members (they stay in memory, instant resume)
   * mode "single" — kill other running/warm members (frees resources, cold start on switch)
   */
  async activate(groupId: string, processId: string, mode: "warm" | "single" = "warm"): Promise<void> {
    const group = this.groups.get(groupId);
    if (!group) throw new Error(`ExclusiveGroup: group "${groupId}" does not exist`);

    const otherPromises: Promise<void>[] = [];
    for (const memberId of group.members) {
      if (memberId === processId) continue;
      const state = this.stateStore.getState(memberId);
      if (mode === "single") {
        // Kill any running or warm members — free the resources
        if (state === "running" || state === "warm") {
          otherPromises.push(this.suspendManager.kill(memberId));
        }
      } else {
        // Suspend running members — keep them in memory for fast resume
        if (state === "running") {
          otherPromises.push(this.suspendManager.suspend(memberId));
        }
      }
    }
    await Promise.all(otherPromises);

    // Resume the target if it was warm (only relevant in "warm" mode)
    const targetState = this.stateStore.getState(processId);
    if (targetState === "warm") {
      await this.suspendManager.resume(processId);
    }

    group.active = processId;
    this.persist();
  }

  getActive(groupId: string): string | null {
    return this.groups.get(groupId)?.active ?? null;
  }

  get(groupId: string): GroupRecord | null {
    return this.groups.get(groupId) ?? null;
  }

  list(): { groupId: string; members: string[]; active: string | null }[] {
    return Array.from(this.groups.entries()).map(([groupId, record]) => ({
      groupId,
      ...record,
    }));
  }
}
