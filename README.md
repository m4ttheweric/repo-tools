# rt — repo tools

Personal developer CLI for branch management, service orchestration, git workflows, and notifications. Designed for monorepos with git worktrees.

## Install

```bash
brew install m4ttheweric/tap/rt
```

Complete setup (tray app, daemon, shell integration):

```bash
rt --post-install
```

Then configure your API tokens:

```bash
rt settings linear token   # Linear API key (for ticket lookup)
rt settings gitlab token   # GitLab PAT (for MR status)
```

Verify the installation:

```bash
rt verify
```

For detailed diagnostics (API tokens, repo context, etc.):

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
| `fzf` + `tmux` | Required dependencies (installed automatically) |
| Shell alias | `rtcd` — fast worktree directory switching |

### Upgrade

```bash
rt update
```

Or via Homebrew directly:

```bash
brew upgrade rt
```

The tray app also checks for updates automatically and can run `rt update` for you.

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

| Dependency | Notes |
|---|---|
| macOS | Required (Apple Silicon or Intel) |
| `fzf` | Auto-installed by Homebrew |
| `tmux` | Auto-installed by Homebrew |
| `zellij` | Optional — only needed for `rt x --zellij` mode (`brew install zellij`) |

---

## Development

This repo uses [Bun](https://bun.sh).

### Day-to-day dev (source mode)

The normal way to develop — no compile step, changes are instant:

```bash
git clone https://github.com/m4ttheweric/repo-tools.git
cd repo-tools
bun install
bun run cli.ts          # runs the CLI from source
bun run cli.ts doctor   # run any subcommand the same way
```

`rt --version` will report `dev` when running from source.

### Switching between dev and production

Once you have a Homebrew install alongside your source checkout, use the built-in toggle:

```bash
rt settings dev-mode        # interactive picker: dev ↔ prod
rt settings dev-mode dev    # switch to local source
rt settings dev-mode prod   # switch back to Homebrew binary
```

**How it works:**
- `dev` mode writes a wrapper script at `~/.local/bin/rt` that calls `bun run /path/to/cli.ts "$@"`
- `prod` mode removes that wrapper, letting `/opt/homebrew/bin/rt` take over
- `~/.local/bin` is added to your PATH automatically (in your shell rc file) during `brew install` and on first `dev-mode dev`
- The source path is remembered in `~/.rt/dev-mode.json` — no re-entry needed when toggling back

`rt --version` always tells you which is active: `dev` vs `v1.x.x`.

### Testing the installer

Run the post-install script manually to test the full setup flow on your machine:

```bash
rt --post-install
```

This is the same code that Homebrew calls after `brew install` or `brew upgrade`. It:
1. Copies `rt-tray.app` to `~/Applications`
2. Installs `rt-context.vsix` into all detected editors
3. Installs the daemon as a launchd agent
4. Writes shell integration to your rc file (PATH + rtcd, idempotent — supports zsh, bash, fish)

### Verifying an installation

```bash
rt verify           # human output, exits 1 on critical failures
rt verify --ci      # same output, no ANSI colors (for CI logs)
rt verify --json    # structured JSON for tooling
```

Critical checks: binary on PATH, fzf, tray app, vsix, daemon installed + running + API responding.

### Building a local compiled binary

Use this to test how the release binary behaves (compiled mode, no bun dependency):

```bash
bun build --compile ./cli.ts --outfile /tmp/rt-local
/tmp/rt-local --version
/tmp/rt-local doctor
```

### rt-context extension

```bash
cd extensions/vscode/rt-context
bun install
bun run watch       # live rebuild during development

# Package a .vsix manually
bun run package     # outputs rt-context-x.x.x.vsix

# Install into local editors
bun run install-local   # packages + installs into Cursor
# or via the CLI:
rt settings extension
```

### rt-tray

```bash
cd rt-tray
./build.sh debug    # build and open in Xcode simulator
./build.sh release  # build release .app
./build.sh install  # build + copy to ~/Applications
```

The tray app reads its version from `Info.plist` (`CFBundleShortVersionString`), which the CI build injects via `git describe`. Local builds report the version as whatever is in the plist at build time.

### Release process

Push a version tag — CI handles everything else:

```bash
git tag v1.2.3
git push --tags
```

GitHub Actions will:
1. Compile `rt` for arm64 + x64
2. Build `rt-tray.app` with version baked into `Info.plist`
3. Package `rt-context.vsix`
4. Create a GitHub Release with bundled tarballs
5. Update `m4ttheweric/homebrew-tap` formula with real URLs + SHA256s
6. Run `rt verify --ci` on a fresh `macos-latest` runner to confirm the install works

The formula's `post_install` is a single call: `rt --post-install`. All real setup logic lives in `commands/post-install.ts`.
