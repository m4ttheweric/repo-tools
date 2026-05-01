# Auto-fix pipeline failures on approved MRs

**Status:** Design — pending implementation plan
**Owner:** Matthew Goodwin
**Date:** 2026-04-30

## Summary

When a merge request the user owns has its pipeline transition to `failed`, the daemon should — under tightly controlled conditions — invoke an agent in one of the user's existing worktrees to fix the failure, commit, and push. The motivating constraint is that pipeline-fix work is mechanical and interrupting (lint, type, formatter, sometimes a small test), and the user already has a local environment where validation works (Doppler-initialized, `.env` present, dependencies installed). Repurposing that environment is cheaper and safer than building a sandbox.

The feature is daemon-driven: there is no explicit `rt fix` command. The daemon watches MR state via the existing `glance-sdk` subscription and acts when every gate passes. When gates don't pass it stays out of the way; in marginal cases (e.g. no usable worktree) it sends a single push notification per failing SHA so the user knows it tried.

## Goals

- Auto-resolve mechanical pipeline failures on approved MRs without user attention.
- Never operate on someone else's MR, never mutate someone else's work.
- Never operate on an MR that's still being actively developed (approval is the proxy).
- Bound the agent's blast radius via scope caps, path denylist, and an attempt budget.
- Reuse the user's existing worktree environments — don't build sandboxes that lack auth/secrets.
- Prefer staying silent over spamming notifications; a single per-SHA notice is enough.

## Non-goals

- Fixing failures on MRs the user did not author.
- Fixing failures on draft / unapproved MRs.
- Re-running flaky pipelines (a different feature; here we just skip flakes).
- Resolving reviewer comments / `changes_requested` reviews.
- Modifying CI configuration, lockfiles, or infra paths to make a pipeline pass.
- Building a hermetic sandbox; the agent runs in real local worktrees only.

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

### Gate 5 — Worktree availability

"Clean" throughout this section means `git -C <worktree> status --porcelain` returns empty: no modified, no staged, no untracked files. Git enforces that a non-bare branch is checked out in at most one worktree, so "find a worktree on branch B" yields at most one candidate.

The daemon walks `git worktree list --porcelain` for the repo and tries to find a usable worktree, in this order:

1. **Direct match** — a worktree currently on the failing branch.
   - Tree clean → use it as-is.
   - Tree dirty → skip (notification: `auto-fix wants <branch> but worktree at <path> is dirty`).
2. **Repurpose a parked worktree** — a worktree currently on `parking-lot/<N>` AND tree clean.
   - Yes → in that worktree:
     - `git fetch origin <branch>`
     - `git switch <branch>`
     - verify worktree HEAD == MR HEAD (else abort)
     - run agent
     - on completion (success, no-op, or failure): `git switch parking-lot/<N>` to restore. The synthetic parking branch is unchanged because we never committed on it.
   - Multiple parked candidates → pick the first; LRU could be added later.
   - Defensively re-check tree clean even though parked; parking is a user signal, not a guarantee.
3. **Neither** → no action this cycle. Notification: `Pipeline failed on <branch> — no usable worktree. Park a worktree or checkout <branch> to enable auto-fix.` Rate-limited to once per SHA.

### Gate 6 — Concurrency lock
Per-MR lock at `~/.rt/<repo>/auto-fix-locks/<branch>.lock` containing `{ worktreePath, sha, pid, startedAt }`.

- Acquire before agent spawn; release on exit (success, failure, crash).
- Stale-lock sweep on daemon startup: any lock whose PID isn't alive is removed.
- Other rt write commands (`rt cd <other-branch>` from inside the locked worktree, `rt git push` from inside it) check the lock and refuse with a clear message naming the lock holder.
- Multiple branches can auto-fix in parallel across different worktrees; the lock is per-branch, not per-repo.

## Agent invocation

The agent runs via the existing `lib/agent-runner.ts` (`claude -p` by default, with the same `cli`/`args` config knobs the MR `describe` flow uses). The auto-fix prompt is assembled by a new helper alongside `assemblePrompt` in `commands/mr.ts`-style style — but in the daemon code, since this runs out-of-band.

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
3. Notify the user once: `Auto-fix tried <branch> and stepped back: <reason>. See: rt mr auto-fix-log <branch>`.
4. If outcome is `error`, increment the attempt counter (counts toward the cap of 2).
5. If outcome is `skipped`, do **not** increment the counter — the agent declined cleanly, no need to penalize.

If validation rejects the agent's diff (out-of-scope or denylist):

1. Reset the worktree to its pre-agent state. We recorded the worktree HEAD SHA before spawning. The reset is two commands, both scoped to the worktree path so they cannot affect other worktrees of the same repo:
   - `git -C <worktree> reset --hard <pre-agent-sha>` — restores tracked files.
   - `git -C <worktree> clean -fd` — removes any untracked files the agent created.
2. If we repurposed a parked worktree, switch back to `parking-lot/<N>`.
3. Log outcome `rejected_diff` with the violation reason. This counts toward the attempt budget.
4. Notify: `Auto-fix on <branch> rejected: <reason>`.

## Concurrency safety

- **Per-MR lock** — only one auto-fix per branch at a time. Multiple branches can run concurrently across worktrees.
- **Lock-holder identification** — other rt commands that mutate that worktree refuse with `auto-fix is running here (PID <pid>); will release after <branch>@<sha>`.
- **Mid-run user edits** — caught by the daemon's pre-commit re-check (`git status --porcelain` must show only files the agent wrote). If a user starts editing in the worktree mid-agent, we abort and reset.
- **Daemon restart mid-run** — child agent processes are not re-parented. On restart, the daemon sweeps stale locks, and any in-flight worktree changes get reset on the next eligible cycle if they violate scope (they will, because the agent didn't get to commit).

## Persistence and observability

### Files

- `~/.rt/<repo>/auto-fix.json` — per-repo config (caps, enabled-flag, allowed-failure-classes).
  ```json
  {
    "enabled": true,
    "fileCap": 5,
    "lineCap": 200,
    "additionalDenylist": ["src/legacy/**"],
    "allowTestFixes": false
  }
  ```
- `~/.rt/<repo>/auto-fix-log.json` — append-only ring (last 100 entries).
- `~/.rt/<repo>/auto-fix-notes/<branch>-<sha>.md` — agent stderr / reasoning for skipped/error outcomes.
- `~/.rt/<repo>/auto-fix-locks/<branch>.lock` — active lock (deleted on completion).

### CLI surface

Minimal — auto-fix is daemon-driven, but the user needs read-only inspection:

- `rt mr auto-fix-log [<branch>]` — show last N attempts (date, branch, sha, outcome, duration).
- `rt mr auto-fix-notes <branch>` — print the most recent notes file for that branch.
- `rt mr auto-fix enable` / `disable` — toggle per-repo `enabled` flag.

No `rt mr auto-fix run` command. Forcing a run circumvents gates we deliberately built. If the user wants to trigger an attempt, they can `git push --force-with-lease` (or just commit) — that resets the attempt counter and the next failure cycle will try again.

## Notification model

The existing notifier (`lib/notifier.ts`) gains three new event keys:

- `auto_fix_pushed` — agent fixed and pushed; default ON.
- `auto_fix_skipped` — agent looked at it and declined (no commit); default ON.
- `auto_fix_unavailable` — eligibility passed but no usable worktree; default OFF (opt-in only). Rate-limited to once per SHA.

`auto_fix_pushed` carries the MR URL so the user can click through to the new pipeline run.

## Failure mode analysis

Walking through what happens when things go sideways:

- **Agent introduces a regression that passes lint/types but breaks tests** — CI catches it. Pipeline fails again. Attempt counter increments to 2. Next failure will try once more, then back off until a new commit.
- **Agent edits a file outside the denylist that we should have denied** — caught only by review at merge time. The denylist must be conservative; we err on the side of bigger denylist over smaller.
- **Agent commits and pushes, but pipeline fails differently** — counted as a new SHA; new attempt budget. If the new failure is also auto-fixable, we go again (capped at 2).
- **User force-pushes during agent run** — daemon's pre-commit HEAD-match check catches it. Reset, abort.
- **User starts working in the worktree mid-run** — pre-commit `status` check catches it. Reset, abort.
- **Daemon crashes mid-run** — stale lock, possibly partial edits in the worktree. Stale lock cleared on next start. Partial edits remain (we don't auto-clean a worktree the user might have engaged with), but the next eligible cycle will see a dirty tree and skip with notification.
- **Two MRs fail simultaneously, only one parked worktree available** — first eligible MR claims the worktree; second logs `unavailable` and waits for the next cycle.

## Open questions

None for v1 — every decision point has been answered through brainstorming. v2 candidates:

- LRU policy for picking among multiple parked worktrees (low priority; first-match works).
- Per-failure-class enable/disable in `auto-fix.json` beyond the current `allowTestFixes` toggle.
- Force-trigger CLI for manual attempts (`rt mr auto-fix now`) — deliberately omitted from v1.

## Implementation surface (preview for plan)

These are the files / modules that will likely change. The implementation plan, written next, will spell out the exact ordering and tests:

- `lib/notifier.ts` — add `auto_fix_pushed`, `auto_fix_skipped`, `auto_fix_unavailable` keys; trigger auto-fix evaluation on the same `pipeline:failed` transition that currently fires the notification.
- `lib/daemon/auto-fix.ts` (new) — core engine: gate evaluator, worktree picker, lock manager, agent invocation, validation, commit/push, log writer.
- `lib/daemon/handlers/auto-fix.ts` (new) — IPC handlers for `auto-fix:log:read`, `auto-fix:notes:read`, `auto-fix:config:get`, `auto-fix:config:set`.
- `commands/mr.ts` — extend with `auto-fix-log`, `auto-fix-notes`, `auto-fix enable|disable` subcommands, or split into `commands/auto-fix.ts`.
- `lib/parking-lot-config.ts` — surface a helper for "is this worktree currently parked" by checking branch == `parking-lot/<index>`. Already implicit; add a named function.
- `lib/git-ops.ts` — add `listWorktrees()` (porcelain parser), `worktreeIsClean(path)`, `worktreeHeadSha(path)`. Light wrappers around git plumbing.
- `lib/agent-runner.ts` — no changes expected; the existing `runAgent` is sufficient.
