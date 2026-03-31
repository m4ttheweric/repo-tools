import * as vscode from 'vscode';
import { exec } from 'child_process';
import { branchCache, branchListCache } from './cache';
import {
  initStatusBar,
  waitForGitAndStart,
  scheduleUpdate,
  clearUpdateTimer,
  getCurrentTicketUrl,
  getCurrentMrUrl,
  getCurrentWorktreePath,
  openLinearUrl,
} from './statusBar';
import { showBranchSwitcher } from './branchSwitcher';
import { showAllWorktrees } from './worktreePicker';

export function activate(context: vscode.ExtensionContext) {
  const config = vscode.workspace.getConfiguration('worktreeContext');
  const priority = config.get<number>('statusBarPriority', 200);

  branchCache.init(context);
  branchListCache.init(context);
  initStatusBar(context, priority);

  context.subscriptions.push(
    vscode.commands.registerCommand('worktreeContext.openTicket', async () => {
      interface ActionItem extends vscode.QuickPickItem {
        action: () => void;
      }

      const items: ActionItem[] = [];
      const ticketUrl = getCurrentTicketUrl();
      const mrUrl = getCurrentMrUrl();
      const worktreePath = getCurrentWorktreePath();

      if (ticketUrl) {
        items.push({
          label: '$(link-external) Open Linear Ticket',
          action: () => openLinearUrl(ticketUrl),
        });
      }

      if (mrUrl) {
        items.push({
          label: '$(git-merge) Open GitLab Merge Request',
          action: () => vscode.env.openExternal(vscode.Uri.parse(mrUrl)),
        });
      }

      if (worktreePath) {
        items.push({
          label: '$(folder-opened) Open in Finder',
          action: () => {
            exec(`open "${worktreePath}"`);
          },
        });
      }

      if (!items.length) {
        vscode.window.showInformationMessage('No actions available for this branch.');
        return;
      }

      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: 'Choose an action',
      });
      picked?.action();
    }),

    vscode.commands.registerCommand('worktreeContext.showAllWorktrees', () =>
      showAllWorktrees(context),
    ),

    vscode.commands.registerCommand('worktreeContext.switchBranch', () =>
      showBranchSwitcher(context),
    ),

    vscode.commands.registerCommand('worktreeContext.setLinearApiKey', async () => {
      const key = await vscode.window.showInputBox({
        prompt: 'Enter your Linear personal API key',
        placeHolder: 'lin_api_...',
        password: true,
        ignoreFocusOut: true,
      });
      if (key) {
        await context.secrets.store('worktreeContext.linearApiKey', key);
        vscode.window.showInformationMessage('Linear API key saved.');
        branchCache.clear();
        branchListCache.clear();
        scheduleUpdate(context);
      }
    }),

    vscode.commands.registerCommand('worktreeContext.setGitlabToken', async () => {
      const token = await vscode.window.showInputBox({
        prompt: 'Enter your GitLab personal access token (for MR title fallback)',
        placeHolder: 'glpat-...',
        password: true,
        ignoreFocusOut: true,
      });
      if (token) {
        await context.secrets.store('worktreeContext.gitlabToken', token);
        vscode.window.showInformationMessage('GitLab token saved.');
        branchCache.clear();
        branchListCache.clear();
        scheduleUpdate(context);
      }
    }),

    vscode.commands.registerCommand('worktreeContext.refresh', () => {
      branchCache.clear();
      branchListCache.clear();
      scheduleUpdate(context);
    }),

    vscode.commands.registerCommand('worktreeContext.resetWorkspacePref', async () => {
      await context.globalState.update('worktreeContext.preferredWorkspaceFile', {});
      vscode.window.showInformationMessage(
        'All workspace file preferences cleared. You will be prompted next time.',
      );
    }),
  );

  waitForGitAndStart(context);
}

export function deactivate() {
  clearUpdateTimer();
  branchCache.clear();
}
