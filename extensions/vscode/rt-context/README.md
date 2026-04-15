# RT Context

A VS Code / Cursor extension that keeps you oriented when working across multiple git worktrees. It shows the current worktree name, branch, and linked Linear ticket in the status bar — and lets you quickly switch between worktrees.

Part of the [repo-tools](https://github.com/m4ttheweric/repo-tools) suite.

## Features

### Status bar context

Always see which worktree you're in and what you're working on, right in the status bar:

```
📁 my-repo-main  │  🔖 PROJ-1287: Add user photo uploads
```

- **Worktree name** — the folder name of the current worktree
- **Branch name** — shown when no Linear ticket is detected
- **Linear ticket** — identifier, title, and status, resolved automatically from the branch name

Clicking the status bar item opens the linked Linear ticket.

### Worktree switcher

Click the **Worktrees** button in the status bar to see all your worktrees at a glance:

- Each worktree shows its folder name, branch, and Linear ticket info
- **Select a worktree** to open it in a new window
- **Click the link icon** on any row to open its Linear ticket
- Automatically opens `.code-workspace` files if present (remembers your preference)

### Linear ticket resolution

The extension extracts Linear ticket identifiers (e.g. `CV-1287`) from branch names using two strategies:

1. **Exact segment match** — `feature/cv-1287` matches directly
2. **Prefix match** — `feature/cv-1287-add-photos` extracts the `CV-1287` prefix

With a Linear API key configured, it fetches the full ticket title and status.

### GitLab MR fallback

For branches without a recognizable Linear ID in the name, the extension can look up the open merge request title on GitLab and extract the ticket ID from there (e.g. `[CV-1287] Add damage photos`).

## Install

Installed automatically with `brew install m4ttheweric/tap/rt`. To reinstall manually:

```bash
rt extension install
```

## Setup

### Configure API keys

Open the command palette and run:

- **RT Context: Set Linear API Key** — enables ticket title and status lookup
- **RT Context: Set GitLab Token** — enables MR title fallback for branches without a Linear ID

Both keys are stored securely in the editor's secret storage and shared with the rt CLI.

## Commands

| Command | Description |
|---------|-------------|
| `RT Context: Show All Worktrees` | Open the worktree switcher |
| `RT Context: Open Linear Ticket` | Open the current branch's Linear ticket |
| `RT Context: Switch Branch` | Switch to a different branch |
| `RT Context: Set Linear API Key` | Store your Linear personal API key |
| `RT Context: Set GitLab Token` | Store your GitLab personal access token |
| `RT Context: Refresh` | Clear caches and refresh the status bar |
| `RT Context: Reset Workspace File Preference` | Forget the saved `.code-workspace` file choice |

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `rtContext.maxTitleLength` | `50` | Max length for ticket titles in the status bar (0 = no limit) |
| `rtContext.statusBarPriority` | `200` | Status bar priority (higher = further left) |
| `rtContext.cacheTtlSeconds` | `300` | How long to cache Linear ticket info (seconds) |

## How it works

The extension uses the VS Code Git extension API to read the current branch, matching the repository to the workspace folder by `rootUri` so it picks the correct branch in multi-worktree setups. The worktree switcher shells out to `git worktree list` to discover all worktrees, since the Git API only exposes repositories open in the current window.

## License

[MIT](LICENSE)
