import * as vscode from 'vscode';
import { exec, execFile } from 'child_process';
import { existsSync } from 'fs';
import { extractLinearId } from './branchParser';
import { fetchTicket, type LinearTicket } from './linear';
import { fetchMRInfo } from './gitlab';
import { branchCache } from './cache';
import { daemonQuery } from './daemonClient';
import { getSecret } from './secrets';
import type { CachedBranchData, GitExtensionExports } from './types';
import { getGitApi, findWorkspaceRepo, getRemoteUrl, getWorktreeName } from './git';

// ── Module state ──

let statusBarItem: vscode.StatusBarItem;
let allWorktreesItem: vscode.StatusBarItem;
let branchSwitcherItem: vscode.StatusBarItem;
let currentTicketUrl: string | null = null;
let currentMrUrl: string | null = null;
let currentWorktreePath: string | null = null;
let updateTimer: ReturnType<typeof setTimeout> | undefined;

// ── Public getters for extension command handlers ──

export function getCurrentTicketUrl(): string | null { return currentTicketUrl; }
export function getCurrentMrUrl(): string | null { return currentMrUrl; }
export function getCurrentWorktreePath(): string | null { return currentWorktreePath; }

// ── Initialization ──

export function initStatusBar(context: vscode.ExtensionContext, priority: number) {
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, priority);
  statusBarItem.command = 'worktreeContext.openTicket';
  context.subscriptions.push(statusBarItem);

  allWorktreesItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, priority - 1);
  allWorktreesItem.command = 'worktreeContext.showAllWorktrees';
  allWorktreesItem.text = '$(list-tree) Worktrees';
  allWorktreesItem.tooltip = 'Show all worktrees';
  context.subscriptions.push(allWorktreesItem);

  branchSwitcherItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, priority - 2);
  branchSwitcherItem.command = 'worktreeContext.switchBranch';
  branchSwitcherItem.tooltip = 'Switch branch';
  context.subscriptions.push(branchSwitcherItem);
}

export function showStatusBarItems() {
  statusBarItem.show();
  allWorktreesItem.show();
  branchSwitcherItem.show();
}

// ── Git watching ──

export function waitForGitAndStart(context: vscode.ExtensionContext) {
  const gitExtension = vscode.extensions.getExtension<import('./types').GitExtensionExports>('vscode.git');
  if (!gitExtension) {
    statusBarItem.text = '$(folder) ' + getWorktreeName();
    showStatusBarItems();
    return;
  }

  const startWatching = (gitApi: import('./types').GitAPI) => {
    scheduleUpdate(context);

    for (const repo of gitApi.repositories) {
      context.subscriptions.push(repo.state.onDidChange(() => scheduleUpdate(context)));
    }

    context.subscriptions.push(
      gitApi.onDidOpenRepository((repo) => {
        context.subscriptions.push(repo.state.onDidChange(() => scheduleUpdate(context)));
        scheduleUpdate(context);
      }),
    );
  };

  if (gitExtension.isActive) {
    startWatching(gitExtension.exports.getAPI(1));
  } else {
    gitExtension.activate().then((exports) => startWatching(exports.getAPI(1)));
  }
}

// ── Update scheduling ──

export function scheduleUpdate(context: vscode.ExtensionContext) {
  if (updateTimer) clearTimeout(updateTimer);
  updateTimer = setTimeout(() => updateStatusBar(context), 300);
}

export function clearUpdateTimer() {
  if (updateTimer) clearTimeout(updateTimer);
}

// ── Status bar rendering ──

async function updateStatusBar(context: vscode.ExtensionContext) {
  const worktreeName = getWorktreeName();
  const gitApi = getGitApi();

  // Store the worktree folder path for the Finder action
  const folders = vscode.workspace.workspaceFolders;
  currentWorktreePath = folders?.length ? folders[0]!.uri.fsPath : null;

  if (!gitApi || !gitApi.repositories.length) {
    statusBarItem.text = `$(folder) ${worktreeName}`;
    statusBarItem.tooltip = `Worktree: ${worktreeName}\nNo git repository found`;
    statusBarItem.command = 'worktreeContext.openTicket';
    branchSwitcherItem.text = '$(git-branch)';
    currentTicketUrl = null;
    currentMrUrl = null;
    showStatusBarItems();
    return;
  }

  const repo = findWorkspaceRepo(gitApi) ?? gitApi.repositories[0]!;
  const branch = repo.state.HEAD?.name;

  if (!branch) {
    statusBarItem.text = `$(folder) ${worktreeName}  │  $(git-branch) (detached)`;
    statusBarItem.tooltip = `Worktree: ${worktreeName}\nDetached HEAD`;
    statusBarItem.command = 'worktreeContext.openTicket';
    branchSwitcherItem.text = '$(git-branch) (detached)';
    currentTicketUrl = null;
    currentMrUrl = null;
    showStatusBarItems();
    return;
  }

  branchSwitcherItem.text = `$(git-branch) ${branch}`;

  const linearIdFromBranch = extractLinearId(branch);
  const cached = branchCache.get(branch);

  // Check if cache is fresh enough to render immediately (skip spinner)
  const config = vscode.workspace.getConfiguration('worktreeContext');
  const cacheTtl = config.get<number>('cacheTtlSeconds', 300) * 1000;
  const isFreshCache = cached && (Date.now() - cached.fetchedAt) < cacheTtl;

  if (isFreshCache) {
    // Render from cache immediately — no spinner, clickable right away
    renderFinalState(worktreeName, branch, cached, linearIdFromBranch);

    // Silent background refresh (fire and forget, updates cache for next time)
    fetchBranchData(context, branch).then((fresh) => {
      if (fresh) branchCache.set(branch, fresh);
    }).catch(() => {});
    return;
  }

  // ── Cache is stale or missing — show loading state and fetch ──
  statusBarItem.command = undefined;
  statusBarItem.tooltip = 'Refreshing…';

  if (cached) {
    const linearId = cached.linearId ?? linearIdFromBranch;
    if (linearId && cached.ticket) {
      const maxLen = config.get<number>('maxTitleLength', 50);
      let title = cached.ticket.title;
      if (maxLen > 0 && title.length > maxLen) {
        title = title.slice(0, maxLen - 1) + '…';
      }
      statusBarItem.text = `$(folder) ${worktreeName}  │  $(loading~spin) ${cached.ticket.identifier}: ${title}`;
    } else if (linearId) {
      statusBarItem.text = `$(folder) ${worktreeName}  │  $(loading~spin) ${linearId}`;
    } else {
      statusBarItem.text = `$(folder) ${worktreeName}  │  $(loading~spin) ${branch}`;
    }
  } else {
    const linearId = linearIdFromBranch;
    if (linearId) {
      statusBarItem.text = `$(folder) ${worktreeName}  │  $(loading~spin) ${linearId}`;
    } else {
      statusBarItem.text = `$(folder) ${worktreeName}  │  $(loading~spin) ${branch}`;
    }
  }
  showStatusBarItems();

  // ── Fetch and render ──
  let fresh: CachedBranchData | null = null;
  try {
    const FETCH_TIMEOUT_MS = 15_000;
    fresh = await Promise.race([
      fetchBranchData(context, branch),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), FETCH_TIMEOUT_MS)),
    ]);

    if (fresh) {
      branchCache.set(branch, fresh);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    vscode.window.showErrorMessage(`Worktree Context: Failed to refresh — ${msg}`);
  } finally {
    const effectiveData = fresh ?? cached ?? null;
    renderFinalState(worktreeName, branch, effectiveData, linearIdFromBranch);
  }
}

/** Render the status bar in its final, clickable state from the given data. */
function renderFinalState(
  worktreeName: string,
  branch: string,
  data: CachedBranchData | null,
  linearIdFromBranch: string | null,
) {
  statusBarItem.command = 'worktreeContext.openTicket';
  const effectiveLinearId = data?.linearId ?? linearIdFromBranch;

  if (effectiveLinearId && data?.ticket) {
    renderTicket(worktreeName, branch, data.ticket, data.mrUrl);
  } else if (effectiveLinearId) {
    statusBarItem.text = `$(folder) ${worktreeName}  │  $(bookmark) ${effectiveLinearId}`;
    statusBarItem.tooltip =
      `Worktree: ${worktreeName}\nBranch: ${branch}\nTicket: ${effectiveLinearId}\n\nClick for options`;
    currentTicketUrl = data?.ticket?.url ?? `https://linear.app/issue/${effectiveLinearId}`;
    currentMrUrl = data?.mrUrl ?? null;
    showStatusBarItems();
  } else {
    statusBarItem.text = `$(folder) ${worktreeName}  │  $(git-branch) ${branch}`;
    statusBarItem.tooltip = `Worktree: ${worktreeName}\nBranch: ${branch}\nClick for options`;
    currentTicketUrl = null;
    currentMrUrl = data?.mrUrl ?? null;
    showStatusBarItems();
  }
}

/**
 * Fetch all data for a branch (MR info + Linear ticket).
 *
 * Strategy:
 *  1. Try daemon cache first (instant, no network) — daemon already has
 *     enriched data from its background refresh loop.
 *  2. Fall back to direct API calls if daemon is unavailable.
 *
 * Returns null if nothing useful could be fetched.
 */
export async function fetchBranchData(
  context: vscode.ExtensionContext,
  branch: string,
): Promise<CachedBranchData | null> {
  // ── Daemon-first path ──
  try {
    const response = await daemonQuery('cache:read', { branches: [branch] });
    if (response?.ok && response.data) {
      const entry = response.data[branch];
      if (entry) {
        return {
          ticket: entry.ticket ?? null,
          mrUrl: entry.mr?.webUrl ?? null,
          linearId: entry.linearId || null,
          fetchedAt: entry.fetchedAt ?? Date.now(),
        };
      }
    }
  } catch {
    // Daemon not available — fall through to direct fetch
  }

  // ── Direct API fallback (daemon not running) ──
  return fetchBranchDataDirect(context, branch);
}

/**
 * Direct API fetch — used when daemon is not available.
 * Makes independent Linear/GitLab calls from the extension itself.
 */
async function fetchBranchDataDirect(
  context: vscode.ExtensionContext,
  branch: string,
): Promise<CachedBranchData | null> {
  let linearId = extractLinearId(branch);
  let mrUrl: string | null = null;
  let mrLinearId: string | null = null;

  // Skip MR lookup for default/trunk branches — they never have an associated MR
  // and the query can hang or return huge result sets
  const DEFAULT_BRANCHES = new Set(['master', 'main', 'develop', 'development', 'staging', 'production']);
  const shouldLookupMR = !DEFAULT_BRANCHES.has(branch);

  // Fetch MR info
  if (shouldLookupMR) {
    const gitlabToken = await getSecret(context, 'gitlabToken');
    if (gitlabToken) {
      const gitApi = getGitApi();
      const repo = gitApi?.repositories.length
        ? findWorkspaceRepo(gitApi) ?? gitApi.repositories[0]!
        : null;
      if (repo) {
        const remoteUrl = getRemoteUrl(repo);
        if (remoteUrl) {
          try {
            const mrInfo = await fetchMRInfo(gitlabToken, remoteUrl, branch);
            if (mrInfo) {
              mrUrl = mrInfo.webUrl;
              mrLinearId = mrInfo.linearId;
            }
          } catch {
            // MR lookup failed
          }
        }
      }
    }
  }

  // Use MR title as fallback for Linear ID
  if (!linearId && mrLinearId) {
    linearId = mrLinearId;
  }

  // Fetch Linear ticket
  let ticket: LinearTicket | null = null;
  if (linearId) {
    const apiKey = await getSecret(context, 'linearApiKey');
    if (apiKey) {
      try {
        ticket = await fetchTicket(apiKey, linearId);
      } catch {
        // Linear fetch failed
      }
    }
  }

  return {
    ticket,
    mrUrl,
    linearId: mrLinearId,
    fetchedAt: Date.now(),
  };
}

function renderTicket(
  worktreeName: string,
  branch: string,
  ticket: LinearTicket | null,
  mrUrl: string | null,
) {
  if (!ticket) {
    statusBarItem.text = `$(folder) ${worktreeName}  │  $(bookmark) ${extractLinearId(branch) ?? branch}`;
    statusBarItem.tooltip = `Worktree: ${worktreeName}\nBranch: ${branch}\n\nTicket not found in Linear`;
    currentTicketUrl = null;
    currentMrUrl = mrUrl;
    showStatusBarItems();
    return;
  }

  const config = vscode.workspace.getConfiguration('worktreeContext');
  const maxLen = config.get<number>('maxTitleLength', 50);
  let title = ticket.title;
  if (maxLen > 0 && title.length > maxLen) {
    title = title.slice(0, maxLen - 1) + '…';
  }

  statusBarItem.text = `$(folder) ${worktreeName}  │  $(bookmark) ${ticket.identifier}: ${title}`;

  const tooltipLines = [
    `Worktree: ${worktreeName}`,
    `Branch: ${branch}`,
    `Ticket: ${ticket.identifier} — ${ticket.title}`,
  ];
  if (ticket.stateName) tooltipLines.push(`Status: ${ticket.stateName}`);
  if (mrUrl) tooltipLines.push(`MR: ${mrUrl}`);
  tooltipLines.push('', 'Click for options');
  statusBarItem.tooltip = tooltipLines.join('\n');

  currentTicketUrl = ticket.url;
  currentMrUrl = mrUrl;
  showStatusBarItems();
}

// ── Utilities ──

const LINEAR_APP_PATH = '/Applications/Linear.app';

export function openLinearUrl(url: string) {
  if (process.platform === 'darwin' && existsSync(LINEAR_APP_PATH)) {
    exec(`open -a Linear "${url}"`);
  } else {
    vscode.env.openExternal(vscode.Uri.parse(url));
  }
}
