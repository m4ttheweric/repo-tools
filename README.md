# rt — repo tools

Personal developer CLI for branch management, service orchestration, git workflows, and notifications. Designed for monorepos with git worktrees.

## Install

```bash
brew install m4ttheweric/tap/rt
```

Then configure your API tokens:

```bash
rt settings linear token   # Linear API key (for ticket lookup)
rt settings gitlab token   # GitLab PAT (for MR status)
```

Verify everything is working:

```bash
rt doctor
```

### What Gets Installed

| Component | Description |
|---|---|
| `rt` binary | Standalone CLI on your PATH |
| `rt-tray.app` | Menu bar app — daemon health, notifications, auto-updates |
| `rt-context` extension | VS Code/Cursor — branch + ticket in status bar |
| Background daemon | Caches MR/branch data, scans ports, guards git hooks |
| `fzf` | Required for all fuzzy pickers |
| Shell alias | `rtcd` — fast worktree directory switching |

### Upgrade

```bash
brew upgrade rt
```

The tray app also checks for updates automatically and can run the upgrade for you.

---

## Commands

Run `rt` with no arguments for an interactive menu. All commands support direct invocation:

```bash
rt <command> [subcommand] [args]
```

### Branch

```bash
rt branch switch          # Checkout with automatic stash handling
rt branch create          # Create from a Linear ticket or scratch
rt branch clean           # Interactively delete stale branches
```

`rt branch switch` and `rt branch create` are also available as `rt git branch switch/create`.

### Git

```bash
rt git rebase             # Smart rebase onto origin/master with auto-resolve
rt git rebase onto        # Rebase onto a specific branch
rt git reset origin       # Sync with origin after a remote rebase
rt git reset soft         # Soft reset to HEAD (unstage files)
rt git reset hard         # Hard reset to HEAD (discard all changes)
rt git commit             # Interactive staging + commit with live diff preview
rt git backup             # Back up current branch to a backup ref
rt git restore            # Restore from a backup branch
```

### Sync

```bash
rt sync                   # Rebase current worktree onto master + push
rt sync all               # Sync all worktrees in the repo
```

### Runner

```bash
rt runner                 # Multiplexed service runner dashboard (fullscreen TUI)
rt attach                 # Attach terminal to a daemon-managed process
rt run                    # Interactive script runner — repo → worktree → package → script
```

The runner dashboard manages multiple long-running processes across worktrees with live output streaming and port tracking.

### Status

```bash
rt status                 # Live branch dashboard — MR actions, pipeline & review status
rt port                   # Port scanner + killer (daemon-powered, zero-config)
```

### Navigation

```bash
rt cd                     # Fuzzy worktree/repo directory picker
rt code                   # Open a worktree in your preferred editor
```

Shell alias added by install:
```bash
rtcd                      # cd into a picked worktree (wraps rt cd)
```

### Open

```bash
rt open mr                # Open the current branch's GitLab MR
rt open pipeline          # Open GitLab CI pipelines (alias: rt open ci)
rt open repo              # Open the repository page
rt open ticket            # Open the Linear ticket for this branch
```

### Workspace

```bash
rt workspace sync         # Auto-sync a .code-workspace file across all worktrees
```

Keeps per-worktree settings (`peacock.color`, etc.) while syncing shared config.

### Daemon

The daemon runs in the background, caching MR data, scanning ports, and guarding git hooks.

```bash
rt daemon install         # Install and start the daemon (launchd or background process)
rt daemon uninstall       # Stop and remove the daemon
rt daemon start           # Start the daemon
rt daemon stop            # Stop the daemon
rt daemon restart         # Restart the daemon
rt daemon status          # Show daemon status (pid, uptime, repos, ports)
rt daemon logs            # Tail daemon log
```

### Settings

```bash
rt settings linear token      # Set Linear API key
rt settings linear team       # Set default Linear team
rt settings gitlab token      # Set GitLab personal access token
rt settings extension         # Install RT Context extension into local editors
rt settings notifications     # Toggle notification preferences
rt settings uninstall         # Remove all rt data for this repo
```

### Other

```bash
rt x                      # Script runner with setup/teardown lifecycle
rt build                  # Interactive turbo build selector
rt hooks                  # Toggle git hooks on/off
rt doctor                 # Environment health check
rt --version              # Print version
```

---

## RT Context Extension

The `rt-context` VS Code/Cursor extension shows your current worktree, branch, and linked Linear ticket in the status bar. It's installed automatically by Homebrew.

To reinstall or install into additional editors:

```bash
rt settings extension
```

This opens a fuzzy picker to select which editors (Cursor, VS Code, Antigravity, etc.) to install into.

### Status Bar

```
📁 main-worktree  │  🔖 CV-1287: Add damage photo uploads
```

Clicking the item opens the linked Linear ticket directly.

---

## RT Tray App

The `rt-tray` menu bar app shows daemon health and delivers native notifications.

- **Green dot** — daemon running normally
- **Yellow dot** — daemon starting
- **Orange dot** — pending notifications
- **Red dot** — daemon not reachable

From the menu you can restart the daemon, stop it, toggle launch-at-login, and check for updates.

---

## Requirements

| Dependency | Required | Install |
|---|---|---|
| `fzf` | ✅ Required | `brew install fzf` |
| `zellij` | Recommended | `brew install zellij` |
| `terminal-notifier` | Recommended | `brew install terminal-notifier` |

---

## Development

This repo uses [Bun](https://bun.sh). Clone and run directly from source:

```bash
git clone https://github.com/m4ttheweric/repo-tools.git
cd repo-tools
bun install
bun run cli.ts
```

To build a local compiled binary:

```bash
bun build --compile ./cli.ts --outfile rt
./rt --version
```

To install rt-tray locally:

```bash
cd rt-tray
./build.sh install
```

### Release Process

Push a version tag — CI handles everything else:

```bash
git tag v1.2.3
git push --tags
```

GitHub Actions will:
1. Compile `rt` for arm64 + x64
2. Build `rt-tray.app` with version baked in
3. Package `rt-context.vsix`
4. Create a GitHub Release with bundled tarballs
5. Update `m4ttheweric/homebrew-tap` formula with new URLs and SHA256s
