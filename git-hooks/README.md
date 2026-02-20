# git-hooks

Per-repo git hook overrides. Each subdirectory is named after the repo it targets and contains hooks that layer on top of whatever hook system the repo uses (husky, etc).

## Setup

1. Symlink the hook directory into the target repo:

```
ln -s /path/to/matts-utils/git-hooks/assured-dev /path/to/assured-dev/.local-hooks
```

2. Point git at it:

```
git config core.hooksPath .local-hooks
```

3. Add `.local-hooks` to the repo's `.gitignore` so the symlink isn't committed.

Note: if the repo uses husky with a `prepare` script, `pnpm install` will reset `core.hooksPath` back to `.husky`. Use the pnpm wrapper in `shell/pnpm-hooks.sh` to automatically restore it.

## assured-dev/

Hooks for the assured-dev monorepo. Chains to husky for anything the repo already does, and adds:

- **pre-commit** — runs prettier on staged files before committing
- **pre-push** — chains to husky's pre-push (lint check)
- **post-checkout** — chains to husky's post-checkout (node version check)
- **post-merge** — chains to husky's post-merge (node version check)
