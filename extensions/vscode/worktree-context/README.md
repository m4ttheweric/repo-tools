# Worktree Context

A VS Code / Cursor extension that keeps you oriented when working across multiple git worktrees. It shows the current worktree name, branch, and linked Linear ticket in the status bar — and lets you quickly switch between worktrees.

## Features

### Status bar context

Always see which worktree you're in and what you're working on, right in the status bar:

```
📁 assured-primary  │  🔖 CV-1287: Add damage photo uploads
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

### Cursor

```bash
curl -L https://github.com/m4ttheweric/worktree-context/releases/latest/download/worktree-context.vsix -o /tmp/worktree-context.vsix && cursor --install-extension /tmp/worktree-context.vsix
```

### VS Code

```bash
curl -L https://github.com/m4ttheweric/worktree-context/releases/latest/download/worktree-context.vsix -o /tmp/worktree-context.vsix && code --install-extension /tmp/worktree-context.vsix
```

### Build from source

```bash
git clone https://github.com/m4ttheweric/worktree-context.git
cd worktree-context
pnpm install
pnpm package
cursor --install-extension worktree-context-0.1.0.vsix
```

## Setup

### Configure API keys

Open the command palette and run:

- **Worktree Context: Set Linear API Key** — enables ticket title and status lookup
- **Worktree Context: Set GitLab Token** — enables MR title fallback for branches without a Linear ID

Both keys are stored securely in the editor's secret storage.

## Commands

| Command | Description |
|---------|-------------|
| `Worktree Context: Show All Worktrees` | Open the worktree switcher |
| `Worktree Context: Open Linear Ticket` | Open the current branch's Linear ticket |
| `Worktree Context: Set Linear API Key` | Store your Linear personal API key |
| `Worktree Context: Set GitLab Token` | Store your GitLab personal access token |
| `Worktree Context: Refresh` | Clear caches and refresh the status bar |
| `Worktree Context: Reset Workspace File Preference` | Forget the saved `.code-workspace` file choice |

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `worktreeContext.maxTitleLength` | `50` | Max length for ticket titles in the status bar (0 = no limit) |
| `worktreeContext.statusBarPriority` | `200` | Status bar priority (higher = further left) |
| `worktreeContext.cacheTtlSeconds` | `300` | How long to cache Linear ticket info (seconds) |

## How it works

The extension uses the VS Code Git extension API to read the current branch, matching the repository to the workspace folder by `rootUri` so it picks the correct branch in multi-worktree setups. The worktree switcher shells out to `git worktree list` to discover all worktrees, since the Git API only exposes repositories open in the current window.

## License

[MIT](LICENSE)
