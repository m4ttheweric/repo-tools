# repo-tools

Developer CLI for branch management, service orchestration, daemon, and notifications.

## Install

```bash
brew install m4ttheweric/tap/rt
```

Then configure your tokens:

```bash
rt settings linear token
rt settings gitlab token
```

Verify everything is working:

```bash
rt doctor
```

### What Gets Installed

| Component | Description |
|---|---|
| `rt` binary | Standalone CLI — branch management, runner, build, commit, port scanner |
| `rt-tray.app` | Menu bar tray app — daemon health, notifications, auto-updates |
| `rt-context` | VS Code/Cursor extension — branch + ticket info in status bar |
| Background daemon | Cache refresh, hooks guard, port scanning, workspace sync |
| Shell integration | `rtcd` alias for fast directory switching |
| Dependencies | `fzf` (required), `terminal-notifier`, `zellij` (recommended) |

### Upgrade

```bash
brew upgrade rt
```

The tray app also checks for updates automatically and notifies you.

---

## Layout

- **`link-repo-tools.ts`** — the main setup script. Run once per repo/worktree to wire all local tooling in with zero tracked footprint.
- **`repos/`** — per-repo config directories. Each contains a `link-specs.json` declaring what to symlink into that repo, plus the actual source files/directories being linked.
- **`mcp-servers/`** — MCP servers registered in Cursor.
- **`scripts/`** — standalone CLI tools.
- **`git-hooks/`** — legacy location for git hook reference docs (hooks now live in `repos/<name>/.local-hooks/`).
- **`shell/`** — shell config fragments meant to be sourced from `.zshrc`.

## link-repo-tools.ts

Interactive CLI that wires all tooling into a repo in one shot:

```bash
bun link-repo-tools.ts
```

For each repo, it reads `repos/<repo-name>/link-specs.json` and:
- Creates symlinks from the repo to the sources defined in the spec
- Registers all symlinks in `.git/info/exclude` (local-only gitignore — never committed)
- Sets `core.hooksPath = .local-hooks` to activate local git hooks
- Handles git worktrees transparently (resolves to the primary repo's config)

To add or remove specs, edit `repos/<repo-name>/link-specs.json` directly, or use the `link-repo-tools` MCP server.

## repos/

Each subdirectory matches a repo name and contains:

| File/Dir | Purpose |
|---|---|
| `link-specs.json` | Declarative list of symlinks to create in the repo |
| `matts-tools/` | Personal CLI tools symlinked in as `matts-tools/` |
| `.local-hooks/` | Git hooks symlinked in as `.local-hooks/` |
| `.cursor/rules/local.mdc` | Local Cursor rules (not tracked in the repo) |
| `Agents.MR_REVIEWS.md` | Personal MR review guidance for AI agents |
| `tsgo-type-check/` | tsgo fast type-check setup for `apps/backend` (see its README) |
| `.warp/workflows/` | Warp terminal workflow for `build-select`. Not in `link-specs.json` — needs symlinking to `~/.warp/workflows/` manually (home dir link, not a repo link) |

## mcp-servers/

MCP servers registered in Cursor:

| Server | Description |
|---|---|
| `link-repo-tools-mcp/` | Manages `link-specs.json` — add, remove, and list specs via AI. Registered globally as `link-repo-tools`. |
| `local-db-mcp/` | Queries the local Postgres development database. Registered in workspace `.cursor/mcp.json` as `local-db`. |

## scripts/

Standalone CLI tools:

| Tool | Description |
|---|---|
| `check-circular-deps.sh` | Checks for circular TS/TSX dependencies using `madge` |
| `cursor-dual-account.mjs` | Switches between multiple Cursor accounts/profiles |
| `set-app-icon.swift` / `tint-icon.swift` | macOS utilities for customizing app icons |

## shell/

Source `shell/pnpm-hooks.sh` from `.zshrc` to prevent `pnpm install` from resetting `core.hooksPath` (husky's `prepare` script resets it on every install):

```zsh
[ -f "$HOME/Documents/GitHub/repo-tools/shell/pnpm-hooks.sh" ] && . "$HOME/Documents/GitHub/repo-tools/shell/pnpm-hooks.sh"
```
