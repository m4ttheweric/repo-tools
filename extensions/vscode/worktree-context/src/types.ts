import type * as vscode from 'vscode';

// ── Cached data interfaces ──

export interface CachedBranchData {
  ticket: import('./linear').LinearTicket | null;
  mrUrl: string | null;
  linearId: string | null;
  fetchedAt: number;
}

export interface BranchListSnapshot {
  branches: BranchInfo[];
  worktreeBranches: string[];
  savedAt: number;
}

// ── Git data interfaces ──

export interface BranchInfo {
  name: string;
  ref: string;
  isLocal: boolean;
  commitEpoch: number;
}

export interface WorktreeEntry {
  dirPath: string;
  name: string;
  branch: string | null;
  isCurrent: boolean;
}

// ── VS Code Git extension type stubs ──

export interface GitExtensionExports {
  getAPI(version: 1): GitAPI;
}

export interface GitAPI {
  repositories: GitRepository[];
  onDidOpenRepository: vscode.Event<GitRepository>;
}

export interface GitRepository {
  rootUri: vscode.Uri;
  state: GitRepositoryState;
}

export interface GitRepositoryState {
  HEAD: { name?: string } | undefined;
  remotes: Array<{ name: string; fetchUrl?: string; pushUrl?: string }>;
  onDidChange: vscode.Event<void>;
}
