# shell

Shell config fragments meant to be sourced from `.zshrc`.

## Setup

Add this to `~/.zshrc`:

```
[ -f "$HOME/Documents/GitHub/matts-utils/shell/pnpm-hooks.sh" ] && . "$HOME/Documents/GitHub/matts-utils/shell/pnpm-hooks.sh"
```

## pnpm-hooks.sh

Wraps the `pnpm` command so that `pnpm install` (and `pnpm i`) automatically restores `core.hooksPath` to `.local-hooks` when that directory exists in the current repo. This counteracts husky's `prepare` script which resets the hooks path on every install.

Only activates in repos that have a `.local-hooks` directory. No effect elsewhere.
