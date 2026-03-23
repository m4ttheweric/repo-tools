# rt Roadmap

## `rt x` — Generic Script Runner

Replace `rt dev` and `rt typecheck` with a single flexible command: `rt x`.

- **Pick from package.json scripts** or write a custom command
- **Setup + teardown steps** — e.g. start a watcher, run a build, clean up
- `rt typecheck` becomes just an `rt x` script, not a standalone command
- Scripts are saveable and reusable across sessions
- multiplexing should be a configurable option (tmux vs zellij vs concurrently)
- if you have multiple apps launching, an optional flag to change multiplexer
- if you have multiple apps launching, an optional flag to show an app picker before launching so you can pick which ones to launch

## Script Storage: Team vs User

| Scope         | Location                | Versioned?     |
| ------------- | ----------------------- | -------------- |
| Team/shared   | `.rt/` in the repo root | ✅ git-tracked |
| User/personal | `~/.rt/<repo>/scripts/` | ❌ local only  |

Team scripts live in the repo so everyone gets them. User scripts stay private.

## Git Operation Wrappers

Scaffold common git operations with rich TUI:

- **`rt checkout`** — autocomplete picker for local branches (enriched labels!)
- Leverage the centralized [enrichBranches()](file:///Users/matthew/Documents/GitHub/repo-tools/lib/enrich.ts#207-247) for consistent display everywhere

## `rt status` — Working Branch Dashboard

A quick-glance view of everything you're working on. Two data sources:

1. **Worktree branches** — every branch checked out across your worktrees
2. **Local branches with open MRs** — branches that aren't checked out but have active MRs

For each branch, show the full MR dashboard data from glance-sdk:

| Field                                   | Source                                                                                      |
| --------------------------------------- | ------------------------------------------------------------------------------------------- |
| Branch name + Linear ticket             | [enrichBranches()](file:///Users/matthew/Documents/GitHub/repo-tools/lib/enrich.ts#207-247) |
| MR state (open/draft/merged)            | `PullRequest.state`, `.draft`                                                               |
| Pipeline status (✓/✗/⟳) + job breakdown | `PullRequest.pipeline`                                                                      |
| Approvals (2/3 approved)                | `approvalsLeft`, `approved`, `approvedBy`                                                   |
| Conflicts / needs rebase                | `conflicts`, `shouldBeRebased`                                                              |
| Unresolved threads                      | `unresolvedThreadCount`                                                                     |
| Merge readiness                         | `getMRDashboardProps()` → `status`, `blockers`                                              |

- under the hood this would use the forge-glance createDashboard() feature.

### Modes

- **`rt status`** — one-shot snapshot, print and exit
- **`rt status --watch`** — live-updating dashboard via `createDashboard()` (real-time `MRDashboardProps` + `MRDashboardActions` — same engine as Glance Forge)

## `rt run` — Monorepo Package Runner

Shorthand for running scripts in monorepo packages. Auto-discovers packages and their scripts.

```
rt run backend start     →  pnpm --filter app/backend start
rt run frontend build    →  pnpm --filter app/frontend build
rt run                   →  interactive picker: package → script
```

- Auto-discover packages from [pnpm-workspace.yaml](file:///Users/matthew/Documents/GitHub/worktree-context/pnpm-workspace.yaml) / `workspaces` field
- Tab-complete package names and script names
- No more remembering filter syntax
- **Turbo integration** — detect `turbo.json`, run tasks through turbo with proper `--filter` syntax, respect dependency graphs without users needing to know turbo CLI flags

## Workflow Automation

- **`rt branch clean`** — find merged/stale branches, offer to delete + remove worktrees
- **`rt branch sync`** — fetch + rebase current branch
- **`rt branch create`** — create a new branch from a linear ticket

## Context Awareness

- **`rt env`** — manage `.env` files across worktrees (copy from template, diff between worktrees)
- **`rt log`** — enriched git log linking commits to Linear tickets and MRs
- **`rt who`** — reviewer workload across your repo's MRs (who's overloaded, what's stale)
- **`rt mr/pr view`** — open current branch's MR in browser
- **`rt mr create`**
- **`rt mr merge`**
- **`rt mr close`**
- **`rt mr status`**
- **`rt mr list`**
- **`rt mr rebase`**
- **`rt mr auto-merge`**

## Onboarding & Health

- **`rt init`** — guided repo setup, stores the recipe in `.rt/` for the next person
- **`rt doctor`** — check local env (node version, missing deps, stale worktrees, broken symlinks)

## Cross-Repo

- **`rt all`** — execute commands across all tracked repos e.g. `rt all status`
  only for commands that make sense to run across multiple repos
