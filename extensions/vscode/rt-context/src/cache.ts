import * as vscode from 'vscode';
import type { CachedBranchData, BranchInfo, BranchListSnapshot } from './types';

const BRANCH_CACHE_KEY = 'rtContext.branchCache';
const BRANCH_LIST_CACHE_KEY = 'rtContext.branchListCache';

export class PersistedCache {
  private map = new Map<string, CachedBranchData>();
  private ctx: vscode.ExtensionContext | null = null;

  /** Hydrate from globalState. Call once during activate(). */
  init(context: vscode.ExtensionContext) {
    this.ctx = context;
    const stored = context.globalState.get<Record<string, CachedBranchData>>(BRANCH_CACHE_KEY);
    if (stored) {
      for (const [key, value] of Object.entries(stored)) {
        this.map.set(key, value);
      }
    }
  }

  get(key: string): CachedBranchData | undefined {
    return this.map.get(key);
  }

  set(key: string, value: CachedBranchData) {
    this.map.set(key, value);
    this.persist();
  }

  clear() {
    this.map.clear();
    this.persist();
  }

  private persist() {
    if (!this.ctx) return;
    const obj: Record<string, CachedBranchData> = {};
    for (const [key, value] of this.map) {
      obj[key] = value;
    }
    this.ctx.globalState.update(BRANCH_CACHE_KEY, obj);
  }
}

/** Lightweight cache for the branch list itself so the picker opens instantly. */
export class BranchListCache {
  private snapshot: BranchListSnapshot | null = null;
  private ctx: vscode.ExtensionContext | null = null;

  init(context: vscode.ExtensionContext) {
    this.ctx = context;
    const stored = context.globalState.get<BranchListSnapshot>(BRANCH_LIST_CACHE_KEY);
    if (stored) this.snapshot = stored;
  }

  get(): BranchListSnapshot | null {
    return this.snapshot;
  }

  set(branches: BranchInfo[], worktreeBranches: string[]) {
    this.snapshot = { branches, worktreeBranches, savedAt: Date.now() };
    this.ctx?.globalState.update(BRANCH_LIST_CACHE_KEY, this.snapshot);
  }

  clear() {
    this.snapshot = null;
    this.ctx?.globalState.update(BRANCH_LIST_CACHE_KEY, undefined);
  }
}

// Singleton instances
export const branchCache = new PersistedCache();
export const branchListCache = new BranchListCache();
