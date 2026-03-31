import * as vscode from 'vscode';
import * as path from 'path';
import { existsSync, promises as fs } from 'fs';
import { extractLinearId } from './branchParser';
import { branchCache } from './cache';
import { fetchBranchData, openLinearUrl } from './statusBar';
import { listWorktrees, getGitApi, findWorkspaceRepo, getRemoteUrl, getWorktreeName } from './git';

const WORKSPACE_PREF_KEY = 'worktreeContext.preferredWorkspaceFile';

function getWorkspacePrefs(context: vscode.ExtensionContext): Record<string, string> {
  return context.globalState.get<Record<string, string>>(WORKSPACE_PREF_KEY, {});
}

async function setWorkspacePref(
  context: vscode.ExtensionContext,
  worktreePath: string,
  filename: string | undefined,
): Promise<void> {
  const prefs = { ...getWorkspacePrefs(context) };
  if (filename) {
    prefs[worktreePath] = filename;
  } else {
    delete prefs[worktreePath];
  }
  await context.globalState.update(WORKSPACE_PREF_KEY, prefs);
}

/**
 * Given a worktree directory, figure out what to open:
 *   1. If a preferred .code-workspace filename is saved for this worktree and exists → use it
 *   2. If exactly one .code-workspace file exists → use it (and save pref)
 *   3. If multiple exist → prompt the user to pick, save their choice
 *   4. If none exist → open the bare folder
 *
 * Preferences are stored per worktree directory so each worktree can have
 * its own workspace file choice.
 */
export async function resolveOpenTarget(
  context: vscode.ExtensionContext,
  dirPath: string,
): Promise<vscode.Uri | null> {
  const prefs = getWorkspacePrefs(context);
  const savedName = prefs[dirPath];

  if (savedName) {
    const candidate = path.join(dirPath, savedName);
    if (existsSync(candidate)) {
      return vscode.Uri.file(candidate);
    }
  }

  let wsFiles: string[];
  try {
    const entries = await fs.readdir(dirPath);
    wsFiles = entries.filter((f) => f.endsWith('.code-workspace')).sort();
  } catch {
    return vscode.Uri.file(dirPath);
  }

  if (wsFiles.length === 0) {
    return vscode.Uri.file(dirPath);
  }

  if (wsFiles.length === 1) {
    await setWorkspacePref(context, dirPath, wsFiles[0]);
    return vscode.Uri.file(path.join(dirPath, wsFiles[0]!));
  }

  const items = [
    ...wsFiles.map((f) => ({ label: `$(file) ${f}`, filename: f })),
    { label: '$(folder) Open folder without workspace file', filename: null as string | null },
  ];

  const picked = await vscode.window.showQuickPick(items, {
    title: 'Multiple workspace files found',
    placeHolder: 'Choose which workspace file to use (this will be remembered)',
  });

  if (!picked) return null;

  if (picked.filename) {
    await setWorkspacePref(context, dirPath, picked.filename);
    return vscode.Uri.file(path.join(dirPath, picked.filename));
  }

  await setWorkspacePref(context, dirPath, undefined);
  return vscode.Uri.file(dirPath);
}

export async function showAllWorktrees(context: vscode.ExtensionContext): Promise<void> {
  const gitApi = getGitApi();
  const repo = gitApi && gitApi.repositories.length
    ? findWorkspaceRepo(gitApi) ?? gitApi.repositories[0]!
    : null;

  if (!repo) {
    vscode.window.showInformationMessage('No git repository found in this workspace.');
    return;
  }

  const cwd = repo.rootUri.fsPath;
  const worktrees = await listWorktrees(cwd);

  if (!worktrees.length) {
    vscode.window.showInformationMessage('No worktrees found.');
    return;
  }

  const config = vscode.workspace.getConfiguration('worktreeContext');
  const maxLen = config.get<number>('maxTitleLength', 50);

  interface WorktreePickItem extends vscode.QuickPickItem {
    dirPath: string;
    isCurrent?: boolean;
    ticketUrl?: string;
    mrUrl?: string;
    buttons?: vscode.QuickInputButton[];
  }

  const openTicketButton: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon('link-external'),
    tooltip: 'Open Linear ticket',
  };

  const openMrButton: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon('git-merge'),
    tooltip: 'Open GitLab merge request',
  };

  const currentWorktree = worktrees.find((wt) => wt.isCurrent);
  const otherWorktrees = worktrees.filter((wt) => !wt.isCurrent);

  if (!otherWorktrees.length && !currentWorktree) {
    vscode.window.showInformationMessage('No worktrees found.');
    return;
  }

  // Build items from cache first (instant), then re-fetch in background
  function buildPickItem(wt: import('./types').WorktreeEntry): WorktreePickItem {
    const branch = wt.branch ?? '(detached)';
    const cached = wt.branch ? branchCache.get(wt.branch) : null;
    let linearId = wt.branch ? extractLinearId(wt.branch) : null;
    if (!linearId && cached?.linearId) linearId = cached.linearId;

    let ticketLabel = '';
    let ticketUrl: string | undefined;
    let mrUrl: string | undefined = cached?.mrUrl ?? undefined;

    const ticket = cached?.ticket ?? null;
    if (linearId && ticket) {
      let title = ticket.title;
      if (maxLen > 0 && title.length > maxLen) {
        title = title.slice(0, maxLen - 1) + '…';
      }
      const status = ticket.stateName ? `  [${ticket.stateName}]` : '';
      ticketLabel = `$(bookmark) ${ticket.identifier}: ${title}${status}`;
      ticketUrl = ticket.url;
    } else if (linearId) {
      ticketLabel = `$(bookmark) ${linearId}`;
      ticketUrl = `https://linear.app/issue/${linearId}`;
    }

    const label = wt.isCurrent ? `$(check) ${wt.name}` : `$(folder) ${wt.name}`;
    const description = wt.isCurrent ? `$(git-branch) ${branch}  (current)` : `$(git-branch) ${branch}`;
    const detailParts: string[] = [];
    if (ticketLabel) detailParts.push(ticketLabel);
    if (mrUrl) detailParts.push(`$(git-pull-request) MR`);
    const detail = detailParts.length ? detailParts.join('  │  ') : undefined;
    const buttons: vscode.QuickInputButton[] = [];
    if (ticketUrl) buttons.push(openTicketButton);
    if (mrUrl) buttons.push(openMrButton);

    return { label, description, detail, dirPath: wt.dirPath, isCurrent: wt.isCurrent, ticketUrl, mrUrl, buttons };
  }

  // Build the list: current worktree first (disabled), then a separator, then others
  const allItems: (WorktreePickItem | vscode.QuickPickItem)[] = [];
  if (currentWorktree) {
    allItems.push(buildPickItem(currentWorktree));
    allItems.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
  }
  const otherItems = otherWorktrees.map(buildPickItem);
  allItems.push(...otherItems);

  const picker = vscode.window.createQuickPick<WorktreePickItem>();
  picker.title = 'All Worktrees';
  picker.placeholder = 'Select a worktree to open in a new window';
  picker.items = allItems as WorktreePickItem[];
  picker.matchOnDescription = true;
  picker.matchOnDetail = true;
  picker.busy = true;
  picker.show();

  let pickerDisposed = false;

  // Background re-fetch: update picker items if data changes
  const allWorktreesToFetch = currentWorktree ? [currentWorktree, ...otherWorktrees] : otherWorktrees;
  Promise.all(
    allWorktreesToFetch.map(async (wt) => {
      if (!wt.branch) return;
      const fresh = await fetchBranchData(context, wt.branch);
      if (fresh) branchCache.set(wt.branch, fresh);
    }),
  ).then(() => {
    if (pickerDisposed) return;
    const refreshedAll: (WorktreePickItem | vscode.QuickPickItem)[] = [];
    if (currentWorktree) {
      refreshedAll.push(buildPickItem(currentWorktree));
      refreshedAll.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
    }
    const refreshedOther = otherWorktrees.map(buildPickItem);
    refreshedAll.push(...refreshedOther);
    picker.items = refreshedAll as WorktreePickItem[];
    picker.busy = false;
  });

  picker.onDidTriggerItemButton((e) => {
    const item = e.item as WorktreePickItem;
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
    if (selected && !selected.isCurrent) {
      const target = await resolveOpenTarget(context, selected.dirPath);
      if (target) {
        vscode.commands.executeCommand('vscode.openFolder', target, { forceNewWindow: true });
      }
    }
  });

  picker.onDidHide(() => {
    pickerDisposed = true;
    picker.dispose();
  });
}
