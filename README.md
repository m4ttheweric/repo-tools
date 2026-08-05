# rt: repo tools

rt is a developer CLI for git-worktree-based monorepo workflows: worktree
navigation, smart git rebase/reset, a live MR status dashboard, port
scanning, and StrongDM connections, all backed by a background daemon. It
ships alongside a macOS menu bar tray app for daemon health and
notifications, a VS Code/Cursor extension that shows your branch and linked
ticket in the status bar, and a plugin system for adding your own commands
that can never crash rt itself.

Full documentation: **https://rt.cool**

![rt --help output](docs/assets/rt-help.png)

## Install

```bash
brew install m4ttheweric/tap/rt
rt verify                  # completes first-run setup, then verifies everything
```

`rt verify` runs setup on first use (tray app, daemon, editor extensions, shell
integration) and then reports the health of each piece: use it any time you
want to confirm the install is in good shape.

Then configure your API tokens:

```bash
rt settings linear token   # Linear API key (for ticket lookup)
rt settings gitlab token   # GitLab PAT (for MR status)
```

For detailed diagnostics:

```bash
rt verify
```

### What Gets Installed

| Component | Description |
|---|---|
| `rt` binary | Standalone CLI on your PATH |
| `rt-tray.app` | Menu bar app: daemon health, notifications, auto-updates |
| `rt-context` extension | VS Code/Cursor: branch + ticket in status bar |
| Background daemon | Caches MR/branch data, scans ports, guards git hooks |
| `fzf` + `tmux` | Required dependencies (installed automatically) |
| Shell alias | `rtcd`: fast worktree directory switching |

### Upgrade

```bash
rt update
```

The tray app checks for new releases automatically and, when one is available,
prompts you to run `rt update` from your terminal (it never runs the upgrade
itself). `rt update` also re-runs post-install so the tray app, daemon, and
editor extensions are refreshed in a single step.

---

## Highlights

- **Worktree-first navigation**: `rt cd` and the `rtcd` shell alias are a
  fuzzy picker across every repo and worktree on disk.
- **Smart git operations**: `rt git rebase` auto-resolves what it safely can
  onto `origin/master`; `rt sync` rebases and pushes the current worktree in
  one step.
- **Live MR dashboard**: `rt status` shows pipeline and review status with
  inline MR actions, backed by a background daemon that keeps GitLab data
  warm.
- **Zero-config port scanning**: `rt port` finds and kills processes on
  stale dev ports without any setup.
- **macOS tray app**: `rt-tray` shows daemon health at a glance and delivers
  native notifications.
- **Editor status bar**: the `rt-context` VS Code/Cursor extension shows
  your worktree, branch, and linked Linear ticket.
- **Safe plugin system**: drop a folder under `~/.rt/plugins/` to add your
  own commands; a broken plugin is skipped with a warning and can never
  crash rt itself.
- **StrongDM integration**: `rt sdm connect` reads your real StrongDM
  catalog and connects with friendly names, no maintained list required.

---

## Onboarding a repo

There's no explicit "add repo" step: any git repo with an `origin` remote is
picked up automatically the first time you run an `rt` command inside it:

```bash
cd ~/code/my-repo
rt status            # or rt cd, rt branch switch, anything repo-aware
```

On first invocation rt will:

1. Derive the repo name from `git remote get-url origin`
2. Register the repo in `~/.rt/repos.json`
3. Create a data dir at `~/.rt/<repo-name>/`
4. Start the daemon watching it for MR / branch / port state

If the daemon was already running, the next refresh cycle picks it up (MR data
refreshes every 5 min, port scans every ~30s). From then on `rt status`,
`rt runner`, ticket lookup, port scanning, and MR notifications all work from
anywhere on your machine.

### Optional per-repo config

| Command | When you need it |
|---|---|
| `rt hooks` | Repo uses husky and you want a quick on/off toggle |
| `rt workspace sync` | Repo has a `.code-workspace` file you want synced across worktrees |
| `rt settings extension` | Install the `rt-context` status-bar extension into local editors |

### Global settings that affect every repo

Set these once; they apply to all repos:

```bash
rt settings gitlab token       # required for rt status, MR actions, notifications
rt settings linear token       # required for ticket lookup in rt status / branch names
rt settings linear team        # only needed if you use `rt branch create` to file new tickets
rt settings notifications      # pick which events fire native macOS notifications
```

---

## Commands

Run `rt` with no arguments for an interactive menu. All commands support direct invocation:

```bash
rt <command> [subcommand] [args]
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

### Run

```bash
rt run                    # Interactive script runner: repo → worktree → package → script
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



### Status

```bash
rt status                 # Live branch dashboard: MR actions, pipeline & review status
rt port                   # Port scanner + killer (daemon-powered, zero-config)
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
rt settings dev-mode          # Toggle between local source and Homebrew binary
```

### Other

```bash
rt x                      # Script runner with setup/teardown lifecycle
rt build                  # Interactive turbo build selector
rt hooks                  # Toggle git hooks on/off
rt verify                 # Installation verification
rt version                # Print version + mode (dev/prod)
rt update                 # Upgrade to the latest release via Homebrew
rt --version              # Print version (short)
```

---

## User plugins

Add your own commands to rt. A plugin is a folder under `~/.rt/plugins/<name>/`
with a `plugin.json` manifest and TypeScript files (or existing executables).
Plugin commands get rt's navigation, repo/worktree context resolution, arg
forms, and logging for free, and a broken plugin can never break rt itself.

```bash
rt plugin new my-tool     # scaffold + IDE types (autocomplete on ctx.rt.*)
rt my-tool                # run it: edit ~/.rt/plugins/my-tool/my-tool.ts and rerun
rt plugin list            # see installed plugins and their health
rt plugin validate        # deep checks: files exist, modules import, exports match
```

A command is TypeScript (`"module": "./my-tool.ts"`, gets the injected `ctx.rt`
API: pick/prompt/confirm, scoped storage, logging) or any executable
(`"exec": "./scripts/deploy.sh"`, gets `RT_*` env vars). Commands merge into
the root tree; name collisions are flagged and built-ins always win. Notes:

- Runtime contract: standard library + injected API only (no npm deps in v1).
- Plugin code runs in-process with rt's privileges. Only install plugin
  directories you trust; reading a third-party plugin before installing it is
  reading the code you are about to run.
- `apiVersion: 1` is required in every manifest.

Full guide (manifest reference, injected API, exec env vars, troubleshooting): [docs/plugins.md](docs/plugins.md)

---

## StrongDM

`rt sdm` is a StrongDM auth-and-connect module: it logs you in, lists the datasources you can reach, and connects you fast with friendly names.

```bash
rt sdm connect            # pick a datasource and connect (auto-logs-in if your session expired)
rt sdm status             # StrongDM auth health + connected tunnels
rt sdm login              # log in (browser popup, terminal fallback)
rt sdm set-email <email>  # set the email rt logs in with
rt sdm refresh            # re-scan the catalog
rt sdm enrichment [init]  # show or scaffold the enrichment map
```

rt reads your resources straight from the StrongDM CLI (`sdm access catalog` + `sdm status`), so there is nothing to configure and no list to maintain. Every real datasource you can reach shows up in the picker. If `rt sdm connect` only shows recents, your session expired; it logs you back in automatically before listing.

### Enrichment (optional, declarative)

Raw StrongDM names (`example-alpha-staging`) work as-is, but you can give them nicer labels, group them by tier, and set connect defaults with a **declarative file you own** at `~/.rt/sdm/enrichment.jsonc`. Nothing runs to enrich; rt just reads this JSON and overlays it on the live catalog.

Scaffold it from your current catalog, then fill in the labels:

```bash
rt sdm enrichment init    # writes ~/.rt/sdm/enrichment.jsonc: every resource, blank labels
rt sdm enrichment         # show the file path + how many resources are enriched vs raw
```

```jsonc
{
  // map a StrongDM resource name to a nicer label + connect metadata
  "example-alpha-staging": { "label": "alpha staging", "tier": "staging",    "db": { "schema": "public" } },
  "example-alpha-prod":    { "label": "alpha prod",    "tier": "production", "production": true }
}
```

| field | meaning |
|-------|---------|
| `label` | shown in the picker (defaults to the raw resource name) |
| `tier` | `development` / `qa` / `staging` / `production` / anything: groups the picker |
| `production` | `true` adds a confirm guard before connecting |
| `reasonSuggestion` | prefill for the access-request reason prompt |
| `db` | `{ database, schema, user }` hints used to verify the tunnel after connecting |

A resource missing from the file just shows its raw name and connects with Postgres defaults. Keep the file in your own repo and copy or symlink it to `~/.rt/sdm/enrichment.jsonc` to share it with your team.

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

- **Green dot**: daemon running normally
- **Yellow dot**: daemon starting
- **Orange dot**: pending notifications
- **Red dot**: daemon not reachable

From the menu you can restart the daemon, stop it, toggle launch-at-login, and check for updates.

---

## Requirements

| Dependency | Notes |
|---|---|
| macOS | Required (Apple Silicon or Intel) |
| `fzf` | 0.71.0 or newer (`--listen` and `--id-nth`, used by `rt nav`'s live refresh); auto-installed by Homebrew |
| `tmux` | Auto-installed by Homebrew |
| `zellij` | Optional, only needed for `rt x --zellij` mode (`brew install zellij`) |
| `chafa` | Optional, renders image previews in `rt nav` as colored character art (`brew install chafa`) |
| `kitten` | Optional, upgrades `rt nav` image previews to true pixels on Kitty-protocol terminals such as Ghostty. Ships with Kitty (`brew install --cask kitty`) |

---

## Development

This repo uses [Bun](https://bun.sh).


### Day-to-day dev (source mode)

The normal way to develop: no compile step, changes are instant.

```bash
git clone https://github.com/m4ttstack/rt.git
cd rt
bun install
bun run cli.ts          # runs the CLI from source
bun run cli.ts verify   # run any subcommand the same way
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
- The source path is remembered in `~/.rt/dev-mode.json`, so there's no re-entry needed when toggling back

`rt version` tells you which is active (and the source path in dev mode);
`rt --version` is the short form that just prints the version string.

### Testing the installer

Run the post-install script manually to test the full setup flow on your machine:

```bash
rt --post-install
```

This is the same code that `rt` auto-runs on its first invocation (and that
`rt update` re-runs after a Homebrew upgrade). It:
1. Copies `rt-tray.app` to `~/Applications`
2. Installs `rt-context.vsix` into all detected editors
3. Installs the daemon as a launchd agent
4. Writes shell integration to your rc file (PATH + rtcd, idempotent, supports zsh, bash, fish)

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
/tmp/rt-local verify
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

Push a version tag; CI handles everything else:

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

The formula has **no** `post_install` hook: Homebrew runs formula hooks in a
sandbox that can't write to `~/Applications`, `~/.rt`, or shell rc files, so
setup is deferred to the binary itself. `cli.ts` detects a missing
`~/.rt/daemon.json` on first invocation and transparently runs
`commands/post-install.ts`, which is also what `rt --post-install` and the
post-upgrade step of `rt update` invoke.
