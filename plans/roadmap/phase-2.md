<!-- STATUS: DONE -->
<!-- AGENT: -->
<!-- COMPLETED: -->

# Phase 2: Worktree Context Extension Integration

**Goal:** Move the worktree-context VS Code extension into repo-tools and refactor it to query the rt daemon via HTTP instead of making independent API calls.

**Prerequisites:** Phase 1 (Leaf Command Migration)

---

## Setup

```bash
# 1. Verify prerequisites are done
# (check STATUS.json or previous phase docs)

# 2. Verify clean working state
test -z "$(git status --porcelain)" && echo "✅ clean" || echo "❌ dirty"

# 3. Mark phase as started
# Use MCP tool: start_phase("rt-roadmap", 2)
```

### Prerequisite Output Verification

Before starting, verify that the previous phase(s) actually produced their declared outputs:

- [ ] Verify Phase 1 output: All command files export named handler functions
- [ ] Verify Phase 1 output: cli.ts tree is the sole source of truth for command structure

---

## Step 1: Move extension into monorepo

Copy `worktree-context/` into `repo-tools/extensions/vscode/worktree-context/`. Keep package.json, src/, etc. intact. Verify it still builds and loads in VS Code from the new location.

```bash
git add -A && git commit -m "phase-2: move extension into monorepo"
```

## Step 2: Add daemon HTTP client for VS Code

Create `extensions/vscode/worktree-context/src/daemonClient.ts`. Use `node:http` with `socketPath` option (VS Code extensions can't use Bun). Implement `daemonQuery(cmd, payload)` that connects to `~/.rt/rt.sock` via HTTP.

```bash
git add -A && git commit -m "phase-2: add daemon http client for vs code"
```

## Step 3: Refactor status bar to use daemon

Replace direct Linear/GitLab API calls in `statusBar.ts` with `daemonQuery('cache:read')`. The daemon already has the cache warm. Status bar becomes a thin UI layer. Add graceful fallback when daemon is not running (fall back to direct API calls).

```bash
git add -A && git commit -m "phase-2: refactor status bar to use daemon"
```

## Step 4: Simplify branch switcher

In `branchSwitcher.ts` (652 lines):
1. Replace branch enrichment with `daemonQuery('cache:read')`
2. Keep VS Code Git API integration for checkout (handles workspace reload)
3. Keep VS Code quickpick UX for stash dialog
4. Remove all independent Linear/GitLab/Git exec calls

```bash
git add -A && git commit -m "phase-2: simplify branch switcher"
```

## Step 5: Unify secrets

Extension should read from `~/.rt/secrets.json` (shared with CLI). Fall back to VS Code secrets store for backward compatibility. Eventually deprecate VS Code secrets in favor of the shared file.

```bash
git add -A && git commit -m "phase-2: unify secrets"
```

## Step 6: Add new daemon endpoints

Add to daemon:
- `GET /repos` — list known repos + worktrees (extension needs for picker)
- `POST /branch:enrich` — on-demand enrichment for a single branch not yet in cache

```bash
git add -A && git commit -m "phase-2: add new daemon endpoints"
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

- [ ] Extension loads and shows status bar with daemon-sourced data
- [ ] Branch switcher shows enriched branches from daemon cache
- [ ] Extension falls back gracefully when daemon is not running
- [ ] No duplicate API calls between extension and daemon
- [ ] Secrets are read from ~/.rt/secrets.json

Mark phase as done — **include a context_snapshot** so the next agent has state:
```
# Use MCP tool: complete_phase("rt-roadmap", 2, { context_snapshot: { ... } })
```

---

## Next Agent Prompt

> I'm executing Phase 3 (Daemon Port Discovery) of the plan "rt-roadmap". Read these documents in order:
>
> 1. `/Users/matthew/Documents/GitHub/repo-tools/plans/roadmap/STATUS.json` — current plan status
> 2. `/Users/matthew/Documents/GitHub/repo-tools/plans/roadmap/phase-3.md` — your task
>
> Phase 2 (Worktree Context Extension Integration) is complete. Extension lives at repo-tools/extensions/vscode/worktree-context/. Extension uses daemon HTTP API instead of direct Linear/GitLab calls. New daemon endpoints: /repos, /branch:enrich.
>
> Follow the conventions: incremental commits after each step, run all wiring checks, ensure git status is clean. Update the phase status when done using the phased-plan MCP tools.
