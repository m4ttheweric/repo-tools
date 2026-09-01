---
name: rt:worktree
description: Use when work needs an isolated git worktree on a machine rt manages ... starting ticket or feature work outside a shared checkout, cleaning up a tree after a merge, recovering a disposed tree's branch or unpushed commits, listing or freshening trees ... or before hand-rolling `git worktree add` in a repo that `rt worktree list` knows.
---

# rt worktree

rt owns the worktree lifecycle in registered repos: it names trees, places
them, registers them with the daemon, and cleans them up. In a repo that
`rt worktree list` knows, never hand-roll `git worktree add` ... an
unregistered tree gets none of the guarded disposal, freshening, or
auto-cleanup.

`rt worktree --help` is the live reference: the bare usage lists every verb,
and `rt worktree <cmd> --help` carries the current flags. Trust that output
over anything remembered or written here.

## The lifecycle

- **Start work**: `rt worktree provision` (with a ticket or branch) claims a
  tree and prints its path. Repos can opt into a warm pool ("on-deck" trees)
  that makes claiming instant; without one, provision creates fresh. `create`
  pre-warms the pool; it is not the start-work verb.
- **Finish**: trees claimed with the default `merge` disposal auto-dispose
  after their MR merges, so cleanup usually needs no command. `rt worktree
  dispose` is the manual path; it refuses dirty or unpushed trees, and it is
  soft ... the tree is retained in trash for a window.
- **Undo**: `rt worktree restore --list` shows what is recoverable; `restore
  <tree>` rebuilds the tree, its branch, and retained untracked files. Reach
  for this before git plumbing when a disposed tree is missed.

## Driving it as an agent

- Pass explicit args and `--json`. Omitted args open interactive pickers in a
  TTY and exit with usage otherwise.
- `rt worktree list --json` is ground truth for what exists and where. Tree
  kinds: `main`, `claimed`, `on-deck`, `unmanaged`.
- If provision or list reports team `ready` steps held pending approval, a
  human must run `rt worktree ready-approve <repo>`; surface it to Matt
  rather than working around it.
