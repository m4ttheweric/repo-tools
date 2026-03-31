<!-- STATUS: DONE -->
<!-- AGENT: -->
<!-- COMPLETED: -->

# Phase 0: Command Restructure

**Goal:** Rationalize the command surface: remove type-check, create settings branch node (absorbing setup-keys, branch team, uninstall), rename kill-port to port with scan/kill subcommands.

**Prerequisites:** None — this is the first phase.

---

## Setup

```bash
# 1. Verify prerequisites are done
# (check STATUS.json or previous phase docs)

# 2. Verify clean working state
test -z "$(git status --porcelain)" && echo "✅ clean" || echo "❌ dirty"

# 3. Mark phase as started
# Use MCP tool: start_phase("rt-roadmap", 0)
```

---

## Step 1: Remove type-check

Delete `commands/type-check.ts` and remove from `cli.ts`. This is a build task that belongs as an `rt x` recipe, not a standalone command.

```bash
git add -A && git commit -m "phase-0: remove type-check"
```

## Step 2: Create settings command

Create `commands/settings.ts` with exported handlers:
- `setLinearToken()` — extract from current `setupSecrets()` in `lib/linear.ts`
- `setGitlabToken()` — extract from current `setupSecrets()` in `lib/linear.ts`
- `setLinearTeam()` — move from `configureTeam()` in `commands/branch.ts`
- `uninstallRepo()` — move from `commands/uninstall.ts`

Register in `cli.ts` as a branch node:
```
settings:
  subcommands:
    linear:
      subcommands:
        token: { fn: 'setLinearToken' }
        team: { fn: 'setLinearTeam' }
    gitlab:
      subcommands:
        token: { fn: 'setGitlabToken' }
    uninstall: { fn: 'uninstallRepo', requiresRepo: true }
```

```bash
git add -A && git commit -m "phase-0: create settings command"
```

## Step 3: Remove team from branch

Remove the `team` subcommand from the `branch` node in `cli.ts`. Remove `configureTeam` and `pickAndSaveTeam` from `commands/branch.ts` (now in settings). Update any references that point users to `rt branch team` → `rt settings linear team`.

```bash
git add -A && git commit -m "phase-0: remove team from branch"
```

## Step 4: Remove old top-level entries

Remove `setup-keys` and `uninstall` entries from `cli.ts`. Delete `commands/uninstall.ts` (code moved to settings). Clean up `setupSecrets` export from `lib/linear.ts` if no longer used directly.

```bash
git add -A && git commit -m "phase-0: remove old top-level entries"
```

## Step 5: Rename kill-port to port

Rename `commands/kill-port.ts` → `commands/port.ts`. Refactor to export two functions:
- `scanPorts()` — the repo-aware port scan (current behavior without the kill step)
- `killPorts(args)` — the interactive kill picker, also supports `rt port kill 8080` ad-hoc mode

Register in `cli.ts`:
```
port:
  subcommands:
    scan: { fn: 'scanPorts' }
    kill: { fn: 'killPorts' }
```

```bash
git add -A && git commit -m "phase-0: rename kill-port to port"
```

---

## Wiring Check

No wiring checks defined for this phase.

---

## Teardown

```bash
# Context snapshot — IMPORTANT: always provide this when calling complete_phase
echo "=== CONTEXT SNAPSHOT ==="
echo 'Phase complete'
test -z "$(git status --porcelain)" && echo "✅ git clean" || echo "❌ dirty"
```

## Verification

- [ ] rt settings → shows picker with linear, gitlab, uninstall
- [ ] rt settings linear → shows token, team
- [ ] rt settings linear token → prompts for Linear API key
- [ ] rt settings linear team → shows team picker
- [ ] rt settings gitlab token → prompts for GitLab token
- [ ] rt settings uninstall → removes rt data for current repo
- [ ] rt branch → shows only switch and create (no team)
- [ ] rt port scan → shows port status
- [ ] rt port kill → interactive kill picker
- [ ] rt port kill 8080 → ad-hoc kill
- [ ] type-check, setup-keys, kill-port are gone from the tree

Mark phase as done — **include a context_snapshot** so the next agent has state:
```
# Use MCP tool: complete_phase("rt-roadmap", 0, { context_snapshot: { ... } })
```

---

## Next Agent Prompt

> I'm executing Phase 1 (Leaf Command Migration) of the plan "rt-roadmap". Read these documents in order:
>
> 1. `/Users/matthew/Documents/GitHub/repo-tools/plans/roadmap/STATUS.json` — current plan status
> 2. `/Users/matthew/Documents/GitHub/repo-tools/plans/roadmap/phase-1.md` — your task
>
> Phase 0 (Command Restructure) is complete. commands/settings.ts with 4 exported handlers. commands/port.ts with scan/kill handlers. Cleaned cli.ts tree with settings and port branch nodes. commands/type-check.ts deleted. commands/uninstall.ts deleted.
>
> Follow the conventions: incremental commits after each step, run all wiring checks, ensure git status is clean. Update the phase status when done using the phased-plan MCP tools.
