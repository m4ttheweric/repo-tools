# Auto-fix pipeline failures on approved MRs

**Status:** Design — pending implementation plan
**Owner:** Matthew Goodwin
**Date:** 2026-04-30

## Summary

When a merge request the user owns has its pipeline transition to `failed`, the daemon should — under tightly controlled conditions — invoke an agent in a **dedicated agent worktree managed by rt** to fix the failure, commit, and push. The motivating constraint is that pipeline-fix work is mechanical and interrupting (lint, type, formatter, sometimes a small test), and the agent needs an environment where local validation works (Doppler-initialized, `.env` present, dependencies installed). Reusing the user's manually-set-up environment is cheaper and safer than building a sandbox.

**Provisioning split:** rt creates the worktree at a fixed rt-managed path (`~/.rt/<repo>/agent-worktree/`) when the user runs `rt auto-fix init`. The user is then responsible for the project-specific bring-up — install deps, run `doppler login` / `doppler setup`, copy any local `.env` files, etc. rt does not run those steps because it cannot guess which ones a project needs and cannot hold credentials. After init + bring-up, every auto-fix runs in that worktree. If Doppler tokens expire or deps drift, the user re-runs the bring-up; the daemon never tries to repair the environment itself.

The feature is daemon-driven: there is no explicit `rt fix` command. The daemon watches MR state via the existing `glance-sdk` subscription and acts when every gate passes. When gates don't pass it stays out of the way; in marginal cases (e.g. agent worktree dirty or missing) it sends a single push notification per failing SHA so the user knows it tried.

## Goals

- Auto-resolve mechanical pipeline failures on approved MRs without user attention.
- Never operate on someone else's MR, never mutate someone else's work.
- Never operate on an MR that's still being actively developed (approval is the proxy).
- Bound the agent's blast radius via scope caps, path denylist, and an attempt budget.
- Run inside a dedicated agent worktree that rt creates and manages, while the user handles project-specific bring-up (Doppler auth, install, env files).
- Never touch the user's other worktrees — main checkout, parked worktrees, feature branches in flight all stay untouched.
- Prefer staying silent over spamming notifications; a single per-SHA notice is enough.

## Non-goals

- Fixing failures on MRs the user did not author.
- Fixing failures on draft / unapproved MRs.
- Re-running flaky pipelines (a different feature; here we just skip flakes).
- Resolving reviewer comments / `changes_requested` reviews.
- Modifying CI configuration, lockfiles, or infra paths to make a pipeline pass.
- Building a hermetic sandbox; the agent runs in the rt-managed agent worktree.
- Provisioning the agent worktree's *project environment* — deps install, Doppler login, copying `.env` files, and similar bring-up are the user's responsibility. rt creates the worktree itself but cannot run these steps for the user.
- Running multiple auto-fixes in parallel — one agent worktree means one fix at a time per repo.

## Trigger

The daemon already maintains the live `glance-sdk` MR subscription per repo and the `notifier.ts` machinery for detecting pipeline transitions (see `lib/notifier.ts:440-470`). Auto-fix piggybacks on the same state delta:

> when a `pipeline.status` transition crosses to `failed` for an MR the user owns,
> evaluate eligibility; if it passes, kick off the auto-fix flow.

No new polling. No new subscription. Auto-fix is a side effect of the same cache update that already drives notifications.

## Eligibility — six gates

Every gate must pass. Any failure short-circuits the rest. Order is cheapest-first.

### Gate 1 — MR identity
- Author is the daemon-running user.
- MR state is `opened` (not draft, not merged, not closed).

### Gate 2 — Review status
- `mr.reviews.isApproved === true` (≥1 reviewer approved).
- No reviewer has `changes_requested` pending. (If approval is recorded but a different reviewer requested changes, skip.)

### Gate 3 — Pipeline status
- `mr.pipeline.status === "failed"`.
- The failing pipeline ran against the **current MR HEAD SHA** (not a stale failure from before a force-push).
- **Flake heuristic:** if the failing job has a retry record where any retry passed, treat as flake and skip. (No classifier — only the explicit `retried-and-passed` signal is honored. Everything else is a real failure.)

### Gate 4 — Attempt budget
Persisted in `~/.rt/<repo>/auto-fix-log.json`, keyed by `<branch>@<sha>`.

- ≤ 2 prior **counted** attempts on this exact SHA. An attempt counts if it produced a commit (`fixed`), erred (`error`), or had its diff rejected (`rejected_diff`). A clean refusal by the agent (`skipped`) does not count — declining is the right behavior and shouldn't burn budget.
- ≥ 5 minutes elapsed since the last auto-fix commit on this branch (gives CI a chance to verify the previous attempt before we'd consider a follow-up).
- A new commit (any source) on the branch produces a new SHA, which resets the attempt count automatically because the budget is per-SHA.

### Gate 5 — Agent worktree readiness

"Clean" means `git -C <worktree> status --porcelain` returns empty: no modified, no staged, no untracked files.

The agent worktree lives at a fixed rt-managed path per repo: `~/.rt/<repo>/agent-worktree/`. rt creates it via `git worktree add` when the user runs `rt auto-fix init`, then locks it (`git worktree lock`) so accidental `git worktree remove` from outside rt is rejected. The user does not choose the path — `rt auto-fix init` always uses the same location for a given repo. After rt provisions the worktree, the user does the project-specific bring-up: install deps, run `doppler login` / `doppler setup`, copy any local `.env` files. rt does not run these steps.

The path is also recorded in `~/.rt/<repo>/auto-fix.json` under `worktreePath` for reference, but the value is set by rt at init time, not edited by the user.

On each eligible failure, the daemon checks the agent worktree in order:

1. **Configured?** `auto-fix.json` has a `worktreePath` value.
   - No → notification (once per SHA): `Auto-fix is enabled but no agent worktree is configured. Run rt auto-fix init.`
2. **Exists?** The path resolves and `git worktree list --porcelain` includes it as a worktree of this repo.
   - No → notification (once per SHA): `Agent worktree at <path> is missing. Run rt auto-fix init to recreate.`
3. **Clean?** `git status --porcelain` returns empty.
   - No → notification (once per SHA): `Agent worktree at <path> is dirty. Clean it before auto-fix can run.` This is the case where the user accidentally edited or left state behind.
4. All checks pass → in the agent worktree:
   - `git fetch origin <branch>`
   - `git switch <branch>` (works whether the worktree was on a different branch or the same one)
   - verify worktree HEAD matches MR HEAD (else abort with `rejected: HEAD drifted` and reset)
   - hand off to agent

After completion the agent worktree is left on the failing branch. The user does not need to "rest" the worktree on a neutral branch between fixes — git switching to the next branch on the next run is fine. If the user wants the worktree on main when idle, they can switch it themselves; the daemon does not impose that policy.

### Gate 6 — Concurrency lock

Per-repo lock at `~/.rt/<repo>/auto-fix.lock` containing `{ branch, sha, pid, startedAt }`. Per-repo (not per-branch) is correct here because there is exactly one agent worktree per repo, so two simultaneous fixes for the same repo cannot share it.

- Acquire before `git fetch`; release on exit (success, failure, crash).
- Stale-lock sweep on daemon startup: any lock whose PID isn't alive is removed.
- If a second eligible failure arrives for the same repo while a fix is in flight, it is queued in memory (one slot — the most recent failing SHA wins; older queued items are dropped). When the active fix releases the lock, the queued item is re-evaluated from scratch (gates may have changed; e.g. a new commit landed).
- The user's other worktrees are unaffected — `rt cd`, commits, and pushes from any other worktree proceed normally.

## Agent invocation

The agent runs via the existing `lib/agent-runner.ts` (`claude -p` by default, with the same `cli`/`args` config knobs the MR `describe` flow uses). The auto-fix prompt is assembled by a new helper modeled on `assemblePrompt` in `commands/mr.ts`, but lives in the daemon code since this runs out-of-band.

### Prompt contents

1. **Task framing** — "A pipeline on this branch is failing. Make the smallest change that makes it pass. Stay within scope caps. Refuse rather than guess."
2. **Failing job logs** — the daemon already has access to `fetchJobDetail` / job traces (see `lib/daemon/handlers/mr.ts:67-76`). For each failing job: name + last ~200 lines of trace.
3. **Repo context** — branch, target, recent commits on branch, changed files vs. target, diff stat. Reuse the existing `captureGitSnapshot` from `commands/mr.ts:160-175`.
4. **Scope rules** — explicit caps and denylist (see below). The agent is told these are hard limits and to abort if a fix would exceed them.
5. **Validation requirement** — before committing, the agent must run the project's lint + typecheck (and tests if test-class is enabled for this repo) locally and confirm they pass on the changed files.
6. **Exit protocol** — the agent must end with one of:
   - `RESULT: fixed` followed by a one-line summary, then commit + (the agent does not push; the daemon pushes after validating the diff).
   - `RESULT: skipped` followed by a one-line reason (no commit).
   - `RESULT: error` followed by a short note (no commit).

### Scope rules emitted to the agent

- **File cap:** ≤ 5 files modified (configurable per-repo in `~/.rt/<repo>/auto-fix.json`).
- **Line cap:** ≤ 200 lines changed (configurable).
- **Path denylist:**
  - `package.json` (deps section), all lockfiles (`bun.lock`, `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`)
  - `migrations/**`, `db/migrate/**`
  - `.gitlab-ci.yml`, `.github/workflows/**`
  - `Dockerfile`, `docker-compose*.yml`
  - `infra/**`, `terraform/**`
  - `.env*` (any environment file)

These are also enforced by the daemon **after** the agent reports success — the daemon runs `git diff --name-only` and `git diff --shortstat`, rejects out-of-scope diffs, and resets the worktree if violated.

## Validation and commit

On `RESULT: fixed` from the agent:

1. **Daemon validates the diff** in the worktree:
   - `git diff --name-only` against denylist → reject if any path matches.
   - `git diff --shortstat` → reject if files > cap or insertions+deletions > cap.
   - `git status --porcelain` → expect a non-empty diff. If empty, treat as `skipped`.
2. **Verify HEAD didn't drift** — re-check that the worktree's branch HEAD matches MR HEAD. If a third party pushed during the agent run, abort and reset.
3. **Commit** with subject `auto-fix: <agent's one-line summary>` and a trailer:
   ```
   Auto-Fixed-By: rt
   Pipeline-Failure-SHA: <sha>
   ```
   (The trailer makes attempts identifiable in `git log` for later filtering.)
4. **Push** via `git push origin <branch>`. Do not force-push.
5. **Log the attempt** in `auto-fix-log.json`: `{ branch, sha, attemptedAt, outcome: "fixed", commitSha, durationMs }`.
6. **Notify** the user: `Auto-fix pushed on <branch>: <summary>` with the MR URL.

On `RESULT: skipped` or `RESULT: error`:

1. Write `~/.rt/<repo>/auto-fix-notes/<branch>-<sha>.md` containing the agent's stderr + final reason. This is durable so the user can inspect later.
2. Log the attempt with outcome `skipped` or `error`.
3. Notify the user once: `Auto-fix tried <branch> and stepped back: <reason>. See: rt auto-fix log <branch>`.
4. If outcome is `error`, increment the attempt counter (counts toward the cap of 2).
5. If outcome is `skipped`, do **not** increment the counter — the agent declined cleanly, no need to penalize.

If validation rejects the agent's diff (out-of-scope or denylist):

1. Reset the agent worktree to its pre-agent HEAD. We recorded the SHA before spawning. Both commands are scoped to the worktree path so they cannot affect other worktrees of the same repo:
   - `git -C <agent-worktree> reset --hard <pre-agent-sha>` — restores tracked files.
   - `git -C <agent-worktree> clean -fd` — removes any untracked files the agent created.
2. Log outcome `rejected_diff` with the violation reason. This counts toward the attempt budget.
3. Notify: `Auto-fix on <branch> rejected: <reason>`.

## Concurrency safety

- **Per-repo lock** — only one auto-fix at a time per repo, since there is one agent worktree per repo. Different repos can fix in parallel.
- **Lock-holder identification** — if rt commands run inside the agent worktree while a fix is in flight, they refuse with `auto-fix is running here (PID <pid>); will release after <branch>@<sha>`.
- **The user's other worktrees are unaffected** — their `rt cd`, commits, pushes work normally. The lock applies only to the agent worktree.
- **Mid-run user edits in the agent worktree** — caught by the daemon's pre-commit re-check (`git status --porcelain` must show only files the agent wrote). If the user starts editing in the agent worktree mid-agent, we abort and reset.
- **Daemon restart mid-run** — child agent processes are not re-parented. On restart, the daemon sweeps stale locks; any in-flight changes left in the agent worktree get reset by the next eligible cycle (the dirty-tree check fires first, the user is notified, and they can `rt auto-fix reset` to clear the leftovers).

## Persistence and observability

### Files

- `~/.rt/<repo>/agent-worktree/` — the rt-managed agent worktree itself (full git checkout). Created by `rt auto-fix init`, locked via `git worktree lock`.
- `~/.rt/<repo>/auto-fix.json` — per-repo config:
  ```json
  {
    "enabled": true,
    "worktreePath": "/Users/matt/.rt/myrepo/agent-worktree",
    "fileCap": 5,
    "lineCap": 200,
    "additionalDenylist": ["src/legacy/**"],
    "allowTestFixes": false
  }
  ```
  `worktreePath` is written by `rt auto-fix init` and not user-editable; it always resolves to `~/.rt/<repo>/agent-worktree/`. It's recorded in the config (rather than recomputed each time) so other modules don't need to know the convention.
- `~/.rt/<repo>/auto-fix-log.json` — append-only ring (last 100 entries).
- `~/.rt/<repo>/auto-fix-notes/<branch>-<sha>.md` — agent stderr / reasoning for skipped/error outcomes.
- `~/.rt/<repo>/auto-fix.lock` — active lock (deleted on completion).

### CLI surface

```
rt auto-fix init               # provision the rt-managed agent worktree at ~/.rt/<repo>/agent-worktree/
rt auto-fix status             # show current state: provisioned? exists? clean? last attempt?
rt auto-fix enable | disable   # toggle per-repo enabled flag
rt auto-fix reset              # reset the agent worktree to clean state (git reset --hard + clean -fd) — recovery from a stuck run
rt auto-fix log [<branch>]     # show recent attempts (date, branch, sha, outcome, duration)
rt auto-fix notes <branch>     # print the most recent notes file for that branch
```

`rt auto-fix init` does the rt-side work and prints a checklist for the user-side work:

**rt does:**
1. Resolve the active repo from the current working directory (uses the existing `CommandContext` identity resolution).
2. `mkdir -p ~/.rt/<repo>/`.
3. `git -C <main-checkout> worktree add ~/.rt/<repo>/agent-worktree <default-branch>`.
4. `git -C ~/.rt/<repo>/agent-worktree worktree lock --reason "rt auto-fix"`.
5. Write `worktreePath` into `auto-fix.json`.

**rt then prints (does not execute):**
> Agent worktree created at `~/.rt/<repo>/agent-worktree/`.
>
> Now bring up the project environment in that worktree. Run, in that directory:
> - your install command (e.g. `bun install`)
> - your auth setup (e.g. `doppler login` then `doppler setup`)
> - copy any local `.env` files you need
> - run a quick check (`bun typecheck` or similar) to confirm the environment works
>
> When done, run `rt auto-fix status` to verify everything is ready.

The init command takes no path argument. The path is fixed at `~/.rt/<repo>/agent-worktree/` so that every other rt module knows where to find it without consulting config beyond the `worktreePath` field, and so the user never has to remember where they put it.

No `rt auto-fix run` command. Forcing a run circumvents gates we deliberately built. If the user wants to trigger an attempt, they can `git push --force-with-lease` (or just commit) — that resets the attempt counter and the next failure cycle will try again.

## Notification model

The existing notifier (`lib/notifier.ts`) gains three new event keys:

- `auto_fix_pushed` — agent fixed and pushed; default ON.
- `auto_fix_skipped` — agent looked at it and declined (no commit); default ON.
- `auto_fix_unavailable` — eligibility passed but the agent worktree is missing, dirty, or unconfigured; default OFF (opt-in only). Rate-limited to once per SHA, with the message naming the specific reason so the user knows whether to run `rt auto-fix init`, clean the worktree, or restore it.

`auto_fix_pushed` carries the MR URL so the user can click through to the new pipeline run.

## Failure mode analysis

Walking through what happens when things go sideways:

- **Agent introduces a regression that passes lint/types but breaks tests** — CI catches it. Pipeline fails again. Attempt counter increments to 2. Next failure will try once more, then back off until a new commit.
- **Agent edits a file outside the denylist that we should have denied** — caught only by review at merge time. The denylist must be conservative; we err on the side of bigger denylist over smaller.
- **Agent commits and pushes, but pipeline fails differently** — counted as a new SHA; new attempt budget. If the new failure is also auto-fixable, we go again (capped at 2).
- **User force-pushes during agent run** — daemon's pre-commit HEAD-match check catches it. Reset, abort.
- **User starts editing in the agent worktree mid-run** — pre-commit `status` check catches it. Reset, abort. (The agent worktree is invisible to other rt commands by design — see "Worktree invisibility" below — so this should only happen if the user manually navigates there.)
- **Daemon crashes mid-run** — stale lock, possibly partial edits in the agent worktree. Stale lock cleared on next start. Partial edits remain; the next eligible cycle sees a dirty tree, sends an `auto_fix_unavailable` notification, and the user can run `rt auto-fix reset` to clean.
- **Two MRs fail simultaneously in the same repo** — first eligible MR claims the per-repo lock; second is queued (most-recent-wins). When the first releases, the queued one re-evaluates from scratch.
- **User forgets to re-init Doppler / install deps after env drift** — the agent will fail to validate locally and emit `RESULT: error` with the underlying error. The user sees the notification, fixes the worktree, next cycle picks up.
- **User accidentally deletes the agent worktree directory** — `git worktree list` no longer shows it. Daemon emits `auto_fix_unavailable` with the "missing" reason. User runs `rt auto-fix init` to recreate (and re-runs the project bring-up steps, since deps and auth are gone too).
- **rt's data directory (`~/.rt/<repo>/`) wiped** — same as above; the worktree, config, log, notes are all gone. User restarts from `rt auto-fix init`. The user's actual repo checkouts are unaffected.

## Worktree invisibility

The agent worktree must be invisible to every other rt command that operates on worktrees — `rt cd`, `rt run`, `rt status`, `rt parking-lot`, `rt branch`, the runner's worktree pickers, and any future command that enumerates worktrees. Polluting these surfaces with a worktree the user never wants to manually engage with is exactly the kind of friction this design is trying to avoid.

**Mechanism:** centralize worktree enumeration through a single helper (likely in `lib/git-ops.ts` or a new `lib/worktrees.ts`) that:

1. Calls `git worktree list --porcelain`.
2. Filters out any worktree whose path is under `~/.rt/<repo>/agent-worktree/` (the rt-managed location). Because the path is fixed and not user-configurable, the filter is a simple prefix match — no config read needed in hot paths.
3. Default behavior excludes the agent worktree.
4. Accepts a `{ includeAgentWorktree: true }` option for the auto-fix engine itself, which is the one caller that does need to see it.

A secondary check against `auto-fix.json`'s `worktreePath` is fine as a belt-and-suspenders, but the prefix filter on `~/.rt/` is the primary defense — no config-read race, no missing-file edge case.

Every existing call site that shells out to `git worktree list` directly is migrated to this helper. The audit list (non-exhaustive — to be confirmed during implementation):

- `lib/parking-lot-config.ts` and `lib/daemon/parking-lot.ts` — enumerate worktrees for park/scan.
- `commands/cd.ts` — picker/auto-complete sources.
- `commands/run.ts` and `commands/runner.tsx` — script discovery per worktree.
- `lib/pickers.ts` — generic worktree pickers.
- `commands/branch.ts` and `commands/branch-clean.ts` — branch listing across worktrees.
- `commands/status.tsx` / `commands/mr-status.tsx` — dashboard surfaces.
- `lib/repo-index.ts` — workspace discovery.

If a call site is missed, the agent worktree leaks into the picker the user is trying to use cleanly. The implementation plan should treat finding-and-migrating these call sites as one of its top tasks, with a verification step that greps for any remaining direct `worktree list` invocations.

The agent worktree is also tagged via `git worktree lock --reason "rt auto-fix"` when `rt auto-fix init` provisions it. This is a defensive belt: it prevents accidental `git worktree remove` from clobbering it, and any tooling that respects `--locked` flags will skip it. `rt auto-fix init` sets the lock; `rt auto-fix reset` does not unlock it. Removing the worktree intentionally requires `git worktree unlock` first, which is high-friction enough to prevent accidents.

## Open questions

None for v1 — every decision point has been answered through brainstorming. v2 candidates:

- Per-failure-class enable/disable in `auto-fix.json` beyond the current `allowTestFixes` toggle.
- Force-trigger CLI for manual attempts (`rt auto-fix now`) — deliberately omitted from v1.
- Multiple agent worktrees per repo (e.g. one per `bun version`) — only if mono-version assumption breaks down.

## Implementation surface (preview for plan)

These are the files / modules that will likely change. The implementation plan, written next, will spell out the exact ordering and tests:

- `lib/worktrees.ts` (new) — single source of truth for worktree enumeration. `listWorktrees({ includeAgentWorktree?: boolean })`, `worktreeIsClean(path)`, `worktreeHeadSha(path)`. Default behavior filters out the agent worktree. Every other module that needs a worktree list goes through here.
- `lib/notifier.ts` — add `auto_fix_pushed`, `auto_fix_skipped`, `auto_fix_unavailable` event keys; trigger auto-fix evaluation on the same `pipeline:failed` transition that currently fires the notification (`lib/notifier.ts:440-470`).
- `lib/auto-fix-config.ts` (new) — read/write `~/.rt/<repo>/auto-fix.json` (worktree path, caps, denylist additions, enabled flag). Exposes `agentWorktreePath(repo)` returning the conventional `~/.rt/<repo>/agent-worktree/` path so callers don't hardcode the layout.
- `lib/daemon/auto-fix.ts` (new) — core engine: gate evaluator, agent worktree readiness check, lock manager, agent invocation, post-agent validation, commit/push, log writer.
- `lib/daemon/handlers/auto-fix.ts` (new) — IPC handlers for log/notes/config reads and writes (`auto-fix:log:read`, `auto-fix:notes:read`, `auto-fix:config:get`, `auto-fix:config:set`, `auto-fix:reset`).
- `commands/auto-fix.ts` (new) — top-level command surface: `init`, `status`, `enable`, `disable`, `reset`, `log`, `notes`. Wired into `cli.ts`.
- `lib/agent-runner.ts` — no changes expected; the existing `runAgent` is sufficient.

**Migration audit (worktree invisibility):** every existing direct caller of `git worktree list` is moved to `lib/worktrees.ts`. The plan must include a search step to enumerate them and a final grep to confirm zero direct `worktree list` calls remain outside the new helper. Known initial set: `lib/parking-lot-config.ts`, `lib/daemon/parking-lot.ts`, `commands/cd.ts`, `commands/run.ts`, `commands/runner.tsx`, `commands/branch.ts`, `commands/branch-clean.ts`, `commands/status.tsx`, `commands/mr-status.tsx`, `lib/pickers.ts`, `lib/repo-index.ts`.
