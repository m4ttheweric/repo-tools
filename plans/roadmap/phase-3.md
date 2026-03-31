<!-- STATUS: NOT_STARTED -->
<!-- AGENT: -->
<!-- COMPLETED: -->

# Phase 3: Daemon Port Discovery

**Goal:** Add zero-config port discovery to the daemon by scanning listening TCP ports and matching process CWD to known worktree/repo paths.

**Prerequisites:** Phase 1 (Leaf Command Migration)

---

## Setup

```bash
# 1. Verify prerequisites are done
# (check STATUS.json or previous phase docs)

# 2. Verify clean working state
test -z "$(git status --porcelain)" && echo "✅ clean" || echo "❌ dirty"

# 3. Mark phase as started
# Use MCP tool: start_phase("rt-roadmap", 3)
```

### Prerequisite Output Verification

Before starting, verify that the previous phase(s) actually produced their declared outputs:

- [ ] Verify Phase 1 output: All command files export named handler functions
- [ ] Verify Phase 1 output: cli.ts tree is the sole source of truth for command structure

---

## Step 1: Implement port scanner in daemon

Add a port scanning module to the daemon refresh cycle:
1. Run `lsof -iTCP -sTCP:LISTEN -P -n` to get all listening ports with PIDs
2. For each PID, resolve CWD via `lsof -a -p <pid> -d cwd -Fn`
3. Match CWD against known worktree/repo paths
4. Extract relative subdirectory (strip worktree root from CWD) as label
5. Store in daemon cache: `{ port, pid, command, cwd, repo, worktree, relativeDir, uptime }`

```bash
git add -A && git commit -m "phase-3: implement port scanner in daemon"
```

## Step 2: Add daemon endpoint for port data

Add `GET /ports` endpoint that returns the cached port scan results grouped by repo and worktree.

```bash
git add -A && git commit -m "phase-3: add daemon endpoint for port data"
```

## Step 3: Upgrade rt port command

Refactor `commands/port.ts` to query daemon `GET /ports` for instant results instead of running lsof on-demand. Display format:
```
assured-dev
  assured-primary · feature/cv-1415
    :4000  apps/backend     node   (12m)
    :4001  apps/adjuster    node   (12m)
  assured-staging · feature/cv-1380
    :4010  apps/backend     node   (2h)    ← stale?

repo-tools
  :3500  .                  bun    (3h)
```
Fall back to direct lsof scan when daemon is not running.

```bash
git add -A && git commit -m "phase-3: upgrade rt port command"
```

## Step 4: Remove manual port config

Remove the `ports` field from `~/.rt/<repo>/config.json` schema. The daemon auto-discovers everything. Update any documentation or help text that references manual port config.

```bash
git add -A && git commit -m "phase-3: remove manual port config"
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

- [ ] rt port shows auto-discovered ports grouped by repo/worktree
- [ ] Relative subdirectory labels are correct (e.g., apps/adjuster, apps/backend)
- [ ] Multiple worktrees with active ports are shown separately
- [ ] rt port kill works with daemon-discovered ports
- [ ] Falls back to direct lsof when daemon is not running

Mark phase as done — **include a context_snapshot** so the next agent has state:
```
# Use MCP tool: complete_phase("rt-roadmap", 3, { context_snapshot: { ... } })
```

---

## Next Agent Prompt

> I'm executing Phase 4 (Status Dashboard & Notifications) of the plan "rt-roadmap". Read these documents in order:
>
> 1. `/Users/matthew/Documents/GitHub/repo-tools/plans/roadmap/STATUS.json` — current plan status
> 2. `/Users/matthew/Documents/GitHub/repo-tools/plans/roadmap/phase-4.md` — your task
>
> Phase 3 (Daemon Port Discovery) is complete. Daemon cache includes port scan data refreshed every cycle. rt port command uses daemon data for instant, zero-config display.
>
> Follow the conventions: incremental commits after each step, run all wiring checks, ensure git status is clean. Update the phase status when done using the phased-plan MCP tools.
