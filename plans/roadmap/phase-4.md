<!-- STATUS: DONE -->
<!-- AGENT: -->
<!-- COMPLETED: -->

# Phase 4: Status Dashboard & Notifications

**Goal:** Build rt status (instant branch dashboard from daemon cache) and smart macOS notifications for pipeline failures, MR approvals, and stale ports.

**Prerequisites:** Phase 2 (Worktree Context Extension Integration), Phase 3 (Daemon Port Discovery)

---

## Setup

```bash
# 1. Verify prerequisites are done
# (check STATUS.json or previous phase docs)

# 2. Verify clean working state
test -z "$(git status --porcelain)" && echo "✅ clean" || echo "❌ dirty"

# 3. Mark phase as started
# Use MCP tool: start_phase("rt-roadmap", 4)
```

### Prerequisite Output Verification

Before starting, verify that the previous phase(s) actually produced their declared outputs:

- [ ] Verify Phase 2 output: Extension lives at repo-tools/extensions/vscode/worktree-context/
- [ ] Verify Phase 2 output: Extension uses daemon HTTP API instead of direct Linear/GitLab calls
- [ ] Verify Phase 2 output: New daemon endpoints: /repos, /branch:enrich
- [ ] Verify Phase 3 output: Daemon cache includes port scan data refreshed every cycle
- [ ] Verify Phase 3 output: rt port command uses daemon data for instant, zero-config display

---

## Step 1: Build rt status command

Create `commands/status.ts` with a `showStatus()` handler. Query daemon `cache:read` and `/ports` endpoints. Render a dashboard:
```
feature/cv-1415  ◉ MR opened  ✓ Pipeline passed  2/2 approved  [Code Review]
  :4000 apps/backend  node (12m)  :4002 apps/frontend  vite (12m)
feature/cv-1394  ◉ MR opened  ⟳ Pipeline running (3/17)       [Testing]
master           ● Up to date
```
Register in `cli.ts` as a leaf command.

```bash
git add -A && git commit -m "phase-4: build rt status command"
```

## Step 2: Add rt status --watch mode

Add `--watch` flag that re-queries the daemon every N seconds and re-renders the dashboard. Use ANSI escape codes to update in place without flicker.

```bash
git add -A && git commit -m "phase-4: add rt status --watch mode"
```

## Step 3: Build rt branch clean

Create branch cleanup command that uses daemon timestamps to sort branches by staleness. Interactive bulk delete with safety checks (e.g., can't delete branches with open MRs without confirmation).

```bash
git add -A && git commit -m "phase-4: build rt branch clean"
```

## Step 4: Implement smart notifications

Add notification support to the daemon:
- Pipeline failures → macOS notification via `osascript`
- MR approved → notification
- Merge conflicts detected → warning
- Stale port processes → 'node on :4000 has been running 6h'

Daemon compares current state to previous state on each refresh to detect transitions.

```bash
git add -A && git commit -m "phase-4: implement smart notifications"
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

- [ ] rt status renders instantly from daemon cache
- [ ] rt status --watch updates in place
- [ ] rt branch clean shows branches sorted by staleness
- [ ] Notifications fire for pipeline state transitions
- [ ] Notifications fire for stale processes

Mark phase as done — **include a context_snapshot** so the next agent has state:
```
# Use MCP tool: complete_phase("rt-roadmap", 4, { context_snapshot: { ... } })
```

---

## 🎉 Plan Complete

This is the final phase. No next agent prompt needed.
