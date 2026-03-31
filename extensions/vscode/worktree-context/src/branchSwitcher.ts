import * as vscode from 'vscode';
import { extractLinearId } from './branchParser';
import { fetchTicketsBatch, fetchMyTodoTickets } from './linear';
import { fetchMRInfoBatch } from './gitlab';
import { branchCache, branchListCache } from './cache';
import { scheduleUpdate, openLinearUrl } from './statusBar';
import {
  listAllBranches,
  getWorktreeBranches,
  hasUncommittedChanges,
  stashChanges,
  findDesktopStash,
  popStash,
  dropStash,
  getRemoteDefaultBranch,
  fetchRemoteBranch,
  createBranch,
  checkoutBranch,
  getGitApi,
  findWorkspaceRepo,
  getRemoteUrl,
} from './git';
import type { BranchInfo } from './types';

export async function showBranchSwitcher(context: vscode.ExtensionContext): Promise<void> {
  const gitApi = getGitApi();
  const repo = gitApi?.repositories.length
    ? findWorkspaceRepo(gitApi) ?? gitApi.repositories[0]!
    : null;

  if (!repo) {
    vscode.window.showInformationMessage('No git repository found in this workspace.');
    return;
  }

  const cwd = repo.rootUri.fsPath;
  const currentBranch = repo.state.HEAD?.name ?? null;

  // Use cached branch list for instant picker open; refresh in background
  const cached = branchListCache.get();
  let branches: BranchInfo[] = [];
  let branchNames: string[] = [];

  function applyBranchList(allBranches: BranchInfo[], worktreeBranchNames: string[]) {
    const worktreeSet = new Set(worktreeBranchNames);
    branches = allBranches.filter(
      (b) => b.name === currentBranch || !worktreeSet.has(b.name),
    );
    branchNames = branches.map((b) => b.name);
  }

  if (cached) {
    applyBranchList(cached.branches, cached.worktreeBranches);
  }

  const DEFAULT_BRANCH_NAMES = new Set(['master', 'main']);

  const config = vscode.workspace.getConfiguration('worktreeContext');
  const maxLen = config.get<number>('maxTitleLength', 50);

  interface BranchPickItem extends vscode.QuickPickItem {
    branch?: string;
    isCurrent?: boolean;
    isCreate?: boolean;
    isCreateFrom?: boolean;
    isLinearCreate?: boolean;
    ticketUrl?: string;
    mrUrl?: string;
  }

  const openTicketButton: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon('link-external'),
    tooltip: 'Open Linear ticket',
  };

  const openMrButton: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon('git-merge'),
    tooltip: 'Open GitLab merge request',
  };

  function buildBranchItem(info: BranchInfo): BranchPickItem {
    const branch = info.name;
    const isCurrent = branch === currentBranch;
    const cached = branchCache.get(branch);
    let linearId = extractLinearId(branch);
    if (!linearId && cached?.linearId) linearId = cached.linearId;

    let ticketLabel = '';
    let ticketUrl: string | undefined;
    let mrUrl: string | undefined = cached?.mrUrl ?? undefined;

    const ticket = cached?.ticket ?? null;
    if (linearId && ticket) {
      let title = ticket.title;
      if (maxLen > 0 && title.length > maxLen) title = title.slice(0, maxLen - 1) + '…';
      const status = ticket.stateName ? `  [${ticket.stateName}]` : '';
      ticketLabel = `$(bookmark) ${ticket.identifier}: ${title}${status}`;
      ticketUrl = ticket.url;
    } else if (linearId) {
      ticketLabel = `$(bookmark) ${linearId}`;
      ticketUrl = `https://linear.app/issue/${linearId}`;
    }

    const icon = isCurrent ? '$(check)' : info.isLocal ? '$(git-branch)' : '$(cloud)';
    const label = `${icon} ${branch}`;
    const description = isCurrent ? '(current)' : undefined;
    const detailParts: string[] = [];
    if (ticketLabel) detailParts.push(ticketLabel);
    if (mrUrl) detailParts.push('$(git-pull-request) MR');
    const detail = detailParts.length ? detailParts.join('  │  ') : undefined;
    const buttons: vscode.QuickInputButton[] = [];
    if (ticketUrl) buttons.push(openTicketButton);
    if (mrUrl) buttons.push(openMrButton);

    return { label, description, detail, branch, isCurrent, ticketUrl, mrUrl, buttons };
  }

  const createNewBranchItem: BranchPickItem = {
    label: '$(plus) Create new branch...',
    alwaysShow: true,
    isCreate: true,
  };

  const createNewBranchFromItem: BranchPickItem = {
    label: '$(plus) Create new branch from...',
    alwaysShow: true,
    isCreateFrom: true,
  };

  const createFromLinearItem: BranchPickItem = {
    label: '$(bookmark) Create branch from Linear ticket...',
    alwaysShow: true,
    isLinearCreate: true,
  };

  function buildAllItems(): BranchPickItem[] {
    const items: BranchPickItem[] = [
      createNewBranchItem,
      createNewBranchFromItem,
      createFromLinearItem,
    ];

    // --- Current branch ---
    const currentInfo = branches.find((b) => b.name === currentBranch);
    if (currentInfo) {
      items.push({ label: '', kind: vscode.QuickPickItemKind.Separator } as BranchPickItem);
      items.push(buildBranchItem(currentInfo));
    }

    // --- Local branches (sorted by recency, master/main hoisted to top) ---
    const localBranches = branches.filter((b) => b.isLocal && b.name !== currentBranch);
    // Hoist master/main to the front of the local group
    const hoisted: BranchInfo[] = [];
    const rest: BranchInfo[] = [];
    for (const b of localBranches) {
      if (DEFAULT_BRANCH_NAMES.has(b.name)) {
        hoisted.push(b);
      } else {
        rest.push(b);
      }
    }
    const sortedLocal = [...hoisted, ...rest];

    if (sortedLocal.length) {
      items.push({ label: 'Local Branches', kind: vscode.QuickPickItemKind.Separator } as BranchPickItem);
      for (const b of sortedLocal) {
        items.push(buildBranchItem(b));
      }
    }

    // --- Remote-only branches (sorted by recency) ---
    const remoteBranches = branches.filter((b) => !b.isLocal && b.name !== currentBranch);
    if (remoteBranches.length) {
      items.push({ label: 'Remote Branches', kind: vscode.QuickPickItemKind.Separator } as BranchPickItem);
      for (const b of remoteBranches) {
        items.push(buildBranchItem(b));
      }
    }

    return items;
  }

  const picker = vscode.window.createQuickPick<BranchPickItem>();
  picker.title = 'Switch Branch';
  picker.placeholder = 'Type to search branches or create a new one';
  picker.matchOnDescription = true;
  picker.matchOnDetail = true;
  picker.items = buildAllItems(); // Instant from cache (or just the create actions if no cache)
  picker.show();

  let pickerDisposed = false;

  // Background refresh: update branch list + MR/ticket data, then re-render
  const SKIP_MR_BRANCHES = new Set(['master', 'main', 'develop', 'development', 'staging', 'production']);
  const cacheTtl = config.get<number>('cacheTtlSeconds', 300) * 1000;

  (async () => {
    const now = Date.now();

    // 1. Always refresh the branch list from git (~50ms, fast)
    const [freshBranches, freshWorktreeSet] = await Promise.all([
      listAllBranches(cwd),
      getWorktreeBranches(cwd),
    ]);
    const freshWtNames = [...freshWorktreeSet];
    branchListCache.set(freshBranches, freshWtNames);
    applyBranchList(freshBranches, freshWtNames);
    branchNames = branches.map((b) => b.name);

    // 2. Check if ANY local branch has stale or missing cache
    const localBranchNames = branches.filter((b) => b.isLocal).map((b) => b.name);
    const hasStaleBranches = localBranchNames.some((branch) => {
      const linearId = extractLinearId(branch);
      if (!linearId) return false; // no ticket to fetch — not stale
      const existing = branchCache.get(branch);
      return !existing || (now - existing.fetchedAt) >= cacheTtl;
    });

    // If everything is fresh, just re-render from cache and stop — no network, no spinner
    if (!hasStaleBranches) {
      if (!pickerDisposed) {
        picker.items = buildAllItems();
        picker.busy = false;
      }
      return;
    }

    // 3. Some data is stale — show spinner and fetch
    if (!pickerDisposed) picker.busy = true;

    const fetchableBranches = localBranchNames.filter((b) => !SKIP_MR_BRANCHES.has(b));

    const [gitlabToken, apiKey] = await Promise.all([
      context.secrets.get('worktreeContext.gitlabToken'),
      context.secrets.get('worktreeContext.linearApiKey'),
    ]);
    const remoteUrl = getRemoteUrl(repo);

    // 4. Batch MR lookup — single API call for all local non-default branches
    let mrResults = new Map<string, { webUrl: string | null; linearId: string | null }>();
    if (gitlabToken && remoteUrl && fetchableBranches.length) {
      mrResults = await fetchMRInfoBatch(gitlabToken, remoteUrl, fetchableBranches);
    }

    // 5. Collect Linear IDs that actually need fetching (respect TTL)
    const staleLinearIds: string[] = [];
    const branchLinearMap = new Map<string, string>();

    for (const branch of localBranchNames) {
      const mrInfo = mrResults.get(branch);
      const linearId = extractLinearId(branch) ?? mrInfo?.linearId ?? null;
      if (!linearId) continue;

      branchLinearMap.set(branch, linearId);

      // Skip if cache is still fresh
      const existing = branchCache.get(branch);
      if (existing && (now - existing.fetchedAt) < cacheTtl) continue;

      staleLinearIds.push(linearId);
    }

    // 6. ONE batch request to Linear instead of N individual calls
    const uniqueIds = [...new Set(staleLinearIds)];
    let ticketMap = new Map<string, import('./linear').LinearTicket>();
    if (apiKey && uniqueIds.length) {
      ticketMap = await fetchTicketsBatch(apiKey, uniqueIds);
    }

    // 7. Update cache for local branches
    for (const branch of localBranchNames) {
      const mrInfo = mrResults.get(branch) ?? null;
      const linearId = branchLinearMap.get(branch) ?? null;
      const existing = branchCache.get(branch);
      const isFreshCache = existing && (now - existing.fetchedAt) < cacheTtl;

      // Use fresh ticket if we fetched one, otherwise keep cached ticket if TTL is still valid
      const freshTicket = linearId ? ticketMap.get(linearId) ?? null : null;
      const ticket = freshTicket ?? (isFreshCache ? existing?.ticket ?? null : null);

      branchCache.set(branch, {
        ticket,
        mrUrl: mrInfo?.webUrl ?? existing?.mrUrl ?? null,
        linearId: mrInfo?.linearId ?? existing?.linearId ?? null,
        fetchedAt: freshTicket ? now : (isFreshCache ? existing!.fetchedAt : now),
      });
    }

    // 8. Single re-render with all data
    if (!pickerDisposed) {
      picker.items = buildAllItems();
      picker.busy = false;
    }
  })();

  picker.onDidTriggerItemButton((e) => {
    const item = e.item as BranchPickItem;
    if (e.button === openTicketButton && item.ticketUrl) {
      openLinearUrl(item.ticketUrl);
    } else if (e.button === openMrButton && item.mrUrl) {
      vscode.env.openExternal(vscode.Uri.parse(item.mrUrl));
    }
  });

  picker.onDidAccept(async () => {
    const selected = picker.selectedItems[0];
    pickerDisposed = true;
    picker.dispose();
    if (!selected) return;

    if (selected.isLinearCreate) {
      await handleLinearCreate(context, cwd, currentBranch, maxLen);
      return;
    }

    if (selected.isCreate) {
      await handleCreateBranch(cwd, currentBranch, context);
      return;
    }

    if (selected.isCreateFrom) {
      await handleCreateBranchFrom(cwd, currentBranch, branches, context);
      return;
    }

    if (selected.branch && !selected.isCurrent) {
      await handleSwitchBranch(cwd, currentBranch, selected.branch, context);
    }
  });

  picker.onDidHide(() => {
    pickerDisposed = true;
    picker.dispose();
  });
}

// ── Branch creation / switch handlers ──

async function handleLinearCreate(
  context: vscode.ExtensionContext,
  cwd: string,
  currentBranch: string | null,
  maxLen: number,
): Promise<void> {
  const apiKey = await context.secrets.get('worktreeContext.linearApiKey');
  if (!apiKey) {
    vscode.window.showErrorMessage(
      'Linear API key not set. Run "Worktree Context: Set Linear API Key" first.',
    );
    return;
  }

  const tickets = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Fetching Linear tickets…' },
    () => fetchMyTodoTickets(apiKey),
  );

  if (!tickets.length) {
    vscode.window.showInformationMessage('No To Do tickets without a linked branch found.');
    return;
  }

  const ticketItems = tickets
    .filter((t) => t.branchName)
    .map((t) => {
      let title = t.title;
      if (maxLen > 0 && title.length > maxLen) title = title.slice(0, maxLen - 1) + '…';
      return {
        label: `$(bookmark) ${t.identifier}: ${title}`,
        description: t.stateName ?? undefined,
        detail: `$(git-branch) ${t.branchName}`,
        branchName: t.branchName!,
        ticket: t,
      };
    });

  if (!ticketItems.length) {
    vscode.window.showInformationMessage('No tickets with a suggested branch name found.');
    return;
  }

  const ticketChoice = await vscode.window.showQuickPick(ticketItems, {
    title: 'Create Branch from Linear Ticket',
    placeHolder: 'Select a ticket',
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!ticketChoice) return;

  // Ask where to base the new branch
  const baseRef = await pickBaseRef(cwd, currentBranch);
  if (baseRef === undefined) return; // user cancelled

  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Creating branch…' },
      async () => {
        if (baseRef) {
          const remoteName = baseRef.split('/')[0]!;
          const remoteBranch = baseRef.split('/').slice(1).join('/');
          await fetchRemoteBranch(cwd, remoteName, remoteBranch);
          await createBranch(cwd, ticketChoice.branchName, baseRef);
        } else {
          await createBranch(cwd, ticketChoice.branchName);
        }
      },
    );
    scheduleUpdate(context);
  } catch (err) {
    vscode.window.showErrorMessage(
      `Failed to create branch: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function handleCreateBranch(
  cwd: string,
  currentBranch: string | null,
  context: vscode.ExtensionContext,
): Promise<void> {
  const newBranch = await vscode.window.showInputBox({
    prompt: 'Branch name',
    placeHolder: 'feature/my-new-branch',
    ignoreFocusOut: true,
  });
  if (!newBranch?.trim()) return;

  const baseRef = await pickBaseRef(cwd, currentBranch);
  if (baseRef === undefined) return; // user cancelled

  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Creating branch…' },
      async () => {
        if (baseRef) {
          const remoteName = baseRef.split('/')[0]!;
          const remoteBranch = baseRef.split('/').slice(1).join('/');
          await fetchRemoteBranch(cwd, remoteName, remoteBranch);
          await createBranch(cwd, newBranch.trim(), baseRef);
        } else {
          await createBranch(cwd, newBranch.trim());
        }
      },
    );
    scheduleUpdate(context);
  } catch (err) {
    vscode.window.showErrorMessage(
      `Failed to create branch: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function handleCreateBranchFrom(
  cwd: string,
  currentBranch: string | null,
  branches: BranchInfo[],
  context: vscode.ExtensionContext,
): Promise<void> {
  const sourceItems = branches.map((b) => ({
    label: b.name === currentBranch ? `$(check) ${b.name}` : `$(git-branch) ${b.name}`,
    branch: b.name,
  }));
  const sourceChoice = await vscode.window.showQuickPick(sourceItems, {
    title: 'Create Branch From',
    placeHolder: 'Select source branch',
  });
  if (!sourceChoice) return;
  const newBranch = await vscode.window.showInputBox({
    prompt: `Branch name (from '${sourceChoice.branch}')`,
    placeHolder: 'feature/my-new-branch',
    ignoreFocusOut: true,
  });
  if (!newBranch?.trim()) return;
  try {
    await createBranch(cwd, newBranch.trim(), sourceChoice.branch);
    scheduleUpdate(context);
  } catch (err) {
    vscode.window.showErrorMessage(
      `Failed to create branch: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Branch switch handler — mirrors GitHub Desktop's exact behavior:
 *
 * 1. If clean → just `git checkout` (instant)
 * 2. If dirty → show "Leave my changes" / "Bring my changes" choice
 *    - "Leave" checks for existing stash and warns before overwriting
 *    - "Bring" just checks out, letting git carry uncommitted changes
 * 3. After checkout → check for Desktop-tagged stash on target branch
 *    - If found, show notification with Restore / Dismiss (no auto-pop)
 *
 * @see https://github.com/desktop/desktop/blob/development/app/src/ui/stash-changes/stash-and-switch-branch-dialog.tsx
 */
async function handleSwitchBranch(
  cwd: string,
  currentBranch: string | null,
  targetBranch: string,
  context: vscode.ExtensionContext,
): Promise<void> {
  // 1. Check if working tree is dirty
  const dirty = await hasUncommittedChanges(cwd);

  if (dirty && currentBranch) {
    // 2. Dirty — present the GitHub Desktop choice dialog
    const existingStash = await findDesktopStash(cwd, currentBranch);

    interface StashChoiceItem extends vscode.QuickPickItem {
      action: 'stash' | 'bring';
    }

    const items: StashChoiceItem[] = [
      {
        label: `$(archive) Leave my changes on ${currentBranch}`,
        description: 'Your in-progress work will be stashed on this branch for you to return to later',
        action: 'stash',
      },
      {
        label: `$(arrow-right) Bring my changes to ${targetBranch}`,
        description: 'Your in-progress work will follow you to the new branch',
        action: 'bring',
      },
    ];

    const choice = await vscode.window.showQuickPick(items, {
      title: 'Switch Branch',
      placeHolder: 'You have changes on this branch. What would you like to do with them?',
    });

    if (!choice) return; // user cancelled

    if (choice.action === 'stash') {
      // Warn if there's already a Desktop stash for this branch (matches GitHub Desktop)
      if (existingStash) {
        const confirm = await vscode.window.showWarningMessage(
          `Your current stash will be overwritten by creating a new stash on '${currentBranch}'.`,
          { modal: true },
          'Overwrite',
        );
        if (confirm !== 'Overwrite') return;
        try {
          await dropStash(cwd, existingStash.name);
        } catch {
          // If drop fails, continue anyway — push will still work
        }
      }

      try {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Switching to '${targetBranch}'…` },
          async () => {
            await stashChanges(cwd, currentBranch);
            await checkoutBranch(cwd, targetBranch);
          },
        );
      } catch (err) {
        vscode.window.showErrorMessage(
          `Failed to switch branch: ${err instanceof Error ? err.message : String(err)}`,
        );
        return;
      }
    } else {
      // "Bring my changes" — just checkout, let git carry uncommitted work
      try {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Switching to '${targetBranch}'…` },
          async () => {
            await checkoutBranch(cwd, targetBranch);
          },
        );
      } catch (err) {
        vscode.window.showErrorMessage(
          `Can't bring changes to '${targetBranch}': ${err instanceof Error ? err.message : String(err)}`,
        );
        return;
      }
    }
  } else {
    // 3. Clean working tree — just checkout instantly
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Switching to '${targetBranch}'…` },
        async () => {
          await checkoutBranch(cwd, targetBranch);
        },
      );
    } catch (err) {
      vscode.window.showErrorMessage(
        `Failed to switch branch: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
  }

  // 4. Post-checkout: update status bar immediately from cache
  scheduleUpdate(context);

  // 5. Check for stashed changes on the target branch (non-blocking)
  //    Show notification with Restore/Dismiss — never auto-pop (matches GitHub Desktop)
  const targetStash = await findDesktopStash(cwd, targetBranch);
  if (targetStash) {
    const action = await vscode.window.showInformationMessage(
      `You have stashed changes on '${targetBranch}'.`,
      'Restore',
      'Dismiss',
    );
    if (action === 'Restore') {
      try {
        await popStash(cwd, targetStash.name);
        vscode.window.showInformationMessage(`Restored stashed changes on '${targetBranch}'.`);
      } catch (err) {
        vscode.window.showWarningMessage(
          `Failed to restore stash: ${err instanceof Error ? err.message : String(err)}. Your stash is still saved.`,
        );
      }
    }
  }
}

/**
 * Prompt the user to pick a base ref for branch creation.
 * Returns null for "current branch", a string for a remote ref,
 * or undefined if the user cancelled.
 */
async function pickBaseRef(cwd: string, currentBranch: string | null): Promise<string | null | undefined> {
  const remoteDefault = await getRemoteDefaultBranch(cwd);
  const baseItems: { label: string; ref: string | null }[] = [
    {
      label: `$(git-branch) Current branch (${currentBranch ?? 'HEAD'})`,
      ref: null,
    },
  ];
  if (remoteDefault) {
    baseItems.push({
      label: `$(cloud) Remote default (${remoteDefault})`,
      ref: remoteDefault,
    });
  }

  if (baseItems.length <= 1) {
    return null; // only one option, use current branch
  }

  const baseChoice = await vscode.window.showQuickPick(baseItems, {
    title: 'Create Branch From',
    placeHolder: 'Where should this branch start?',
  });
  if (!baseChoice) return undefined; // user cancelled
  return baseChoice.ref;
}
