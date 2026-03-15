# git-hooks

> **Note:** This directory is kept for reference. Git hooks are now managed via `link-repo-tools.ts` and live in `repos/<repo-name>/.local-hooks/`. The manual setup steps below are superseded.

Per-repo git hook overrides that layer on top of whatever hook system the repo uses (husky, etc.).

## Current setup (via link-repo-tools.ts)

Run `bun link-repo-tools.ts` from the repo-tools root. It will:
1. Symlink `repos/<repo>/.local-hooks` → `.local-hooks` in the target repo
2. Set `git config core.hooksPath .local-hooks`
3. Register `.local-hooks` in `.git/info/exclude`

## assured-dev hooks

Hooks live in `repos/assured-dev/.local-hooks/`. They chain to husky for anything the repo already handles, and add:

- **pre-commit** — runs prettier on staged files before committing
- **pre-push** — chains to husky's pre-push (node version check, lint), then checks changed TS/TSX files for circular dependencies
- **post-checkout** — chains to husky's post-checkout (node version check)
- **post-merge** — chains to husky's post-merge (node version check)

## pnpm install resetting core.hooksPath

Husky's `prepare` script resets `core.hooksPath` back to `.husky` on every `pnpm install`. Source `shell/pnpm-hooks.sh` from `.zshrc` to automatically restore it after each install.
