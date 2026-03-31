<!-- STATUS: NOT_STARTED -->
<!-- AGENT: -->
<!-- COMPLETED: -->

# Phase 1: Leaf Command Migration

**Goal:** Migrate all remaining commands from run() exports to named handler functions in the declarative command tree.

**Prerequisites:** Phase 0 (Command Restructure)

---

## Setup

```bash
# 1. Verify prerequisites are done
# (check STATUS.json or previous phase docs)

# 2. Verify clean working state
test -z "$(git status --porcelain)" && echo "✅ clean" || echo "❌ dirty"

# 3. Mark phase as started
# Use MCP tool: start_phase("rt-roadmap", 1)
```

### Prerequisite Output Verification

Before starting, verify that the previous phase(s) actually produced their declared outputs:

- [ ] Verify Phase 0 output: commands/settings.ts with 4 exported handlers
- [ ] Verify Phase 0 output: commands/port.ts with scan/kill handlers
- [ ] Verify Phase 0 output: Cleaned cli.ts tree with settings and port branch nodes
- [ ] Verify Phase 0 output: commands/type-check.ts deleted
- [ ] Verify Phase 0 output: commands/uninstall.ts deleted

---

## Step 1: Migrate x command

In `commands/x.ts`:
1. Rename `export async function run(args)` → `export async function scriptRunner(args)`
2. Remove any manual `console.clear()` or header rendering
3. Remove `requireIdentity()` call — dispatcher handles it via `requiresRepo: true`
4. Keep the internal wizard/script picker as-is
5. Update `cli.ts` to use `fn: 'scriptRunner'`

```bash
git add -A && git commit -m "phase-1: migrate x command"
```

## Step 2: Migrate build command

In `commands/build-select.ts`:
1. Rename `export async function run(args)` → `export async function buildSelect(args)`
2. Remove boilerplate (console.clear, header)
3. Keep the turbo package selector
4. Update `cli.ts`

```bash
git add -A && git commit -m "phase-1: migrate build command"
```

## Step 3: Migrate hooks command

In `commands/hooks.ts`:
1. Rename `export async function run(args)` → `export async function toggleHooks(args)`
2. Remove boilerplate
3. **Important:** hooks applies to repos only, not individual worktrees. Evaluate if `requiresRepo: true` prompts for worktree selection incorrectly. If so, add a `requiresRepoOnly` flag to CommandNode or handle inside the handler.
4. Update `cli.ts`

```bash
git add -A && git commit -m "phase-1: migrate hooks command"
```

## Step 4: Migrate cd and code commands

In `commands/cd.ts` and `commands/code.ts`:
1. Rename `run` → named exports (`worktreePicker`, `openInEditor`)
2. These are repo pickers themselves — set `requiresRepo: false` in `cli.ts` so the dispatcher doesn't conflict with their own picker
3. Remove boilerplate

```bash
git add -A && git commit -m "phase-1: migrate cd and code commands"
```

## Step 5: Migrate doctor command

In `commands/doctor.ts`:
1. Rename `run` → `runDoctor`
2. Remove boilerplate
3. Update `cli.ts`

```bash
git add -A && git commit -m "phase-1: migrate doctor command"
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

- [ ] rt --help shows all commands with descriptions
- [ ] rt <command> direct invocation works for every command
- [ ] rt (no args) interactive picker shows clean screen at every level
- [ ] No run() exports remain in any command file
- [ ] No manual console.clear() or requireIdentity() in command handlers

Mark phase as done — **include a context_snapshot** so the next agent has state:
```
# Use MCP tool: complete_phase("rt-roadmap", 1, { context_snapshot: { ... } })
```

---

## Next Agent Prompt

> I'm executing Phase 2 (Worktree Context Extension Integration) of the plan "rt-roadmap". Read these documents in order:
>
> 1. `/Users/matthew/Documents/GitHub/repo-tools/plans/roadmap/STATUS.json` — current plan status
> 2. `/Users/matthew/Documents/GitHub/repo-tools/plans/roadmap/phase-2.md` — your task
>
> Phase 1 (Leaf Command Migration) is complete. All command files export named handler functions. cli.ts tree is the sole source of truth for command structure.
>
> Follow the conventions: incremental commits after each step, run all wiring checks, ensure git status is clean. Update the phase status when done using the phased-plan MCP tools.
