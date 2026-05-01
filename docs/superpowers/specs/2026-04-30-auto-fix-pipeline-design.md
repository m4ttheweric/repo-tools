# Auto-fix pipeline failures on approved MRs

**Status:** Design — pending implementation plan
**Owner:** Matthew Goodwin
**Date:** 2026-04-30 (revised after Doppler unblocking)

## Summary

When a merge request the user owns has its pipeline transition to `failed`, the daemon should — under tightly controlled conditions — provision a short-lived **ephemeral git worktree**, run an agent there to fix the failure, push the result, and tear the worktree down. The motivating use case is mechanical pipeline failures (lint, type, formatter, sometimes a small test) that the user could fix in five minutes but interrupt deeper work.

Worktrees are ephemeral because the prerequisite Doppler-sync feature (see `2026-04-30-doppler-template-sync-design.md`) eliminates per-worktree environment setup. Combined with the Bun cache making `bun install` near-instant, a fresh worktree can be provisioned, run an agent in, and torn down in a couple of minutes — with no persistent state for the user to maintain.

The feature is daemon-driven: there is no `rt fix` command. The daemon watches MR state via the existing `glance-sdk` subscription and acts when every gate passes. When gates don't pass it stays out of the way.

## Prerequisite

This design depends on the **Doppler template + auto-sync** feature shipping first. That feature makes Doppler "just work" in any new worktree of a Doppler-using repo by reconciling `~/.doppler/.doppler.yaml` against a per-repo template (`~/.rt/<repo>/doppler-template.yaml`). Without it, ephemeral worktrees would require an interactive `make initDoppler` per fix, which defeats the entire premise.

The auto-fix engine calls the same reconciler before spawning the agent, so the agent inherits a fully-configured Doppler environment without any user step.

## Goals

- Auto-resolve mechanical pipeline failures on approved MRs without user attention.
- Never operate on someone else's MR, never mutate someone else's work.
- Never operate on an MR that's still being actively developed (approval is the proxy).
- Bound the agent's blast radius via scope caps, path denylist, and an attempt budget.
- Use ephemeral worktrees that exist only for the duration of a single fix — no persistent state for the user to maintain, no worktree visible in their normal day-to-day.
- Never touch the user's other worktrees — main checkout, parked worktrees, feature branches in flight all stay untouched.
- Prefer staying silent over spamming notifications; a single per-SHA notice is enough.

## Non-goals

- Fixing failures on MRs the user did not author.
- Fixing failures on draft / unapproved MRs.
- Re-running flaky pipelines (a different feature; here we just skip flakes).
- Resolving reviewer comments / `changes_requested` reviews.
- Modifying CI configuration, lockfiles, or infra paths to make a pipeline pass.
- Running multiple auto-fixes in parallel for the same repo — serialized through a per-repo lock.
- Building a hermetic sandbox; the agent uses the user's machine-local Doppler/dependency state via the same channels the user uses.

## Trigger

The daemon already maintains the live `glance-sdk` MR subscription per repo and the `notifier.ts` machinery for detecting pipeline transitions (see `lib/notifier.ts:440-470`). Auto-fix piggybacks on the same state delta:

> when a `pipeline.status` transition crosses to `failed` for an MR the user owns,
> evaluate eligibility; if it passes, kick off the auto-fix flow.

No new polling. No new subscription. Auto-fix is a side effect of the same cache update that already drives notifications.

## Eligibility — five gates

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
- **Flake heuristic:** if the failing job has a retry record where any retry passed, treat as flake and skip. Only the explicit `retried-and-passed` signal is honored.

### Gate 4 — Attempt budget
Persisted in `~/.rt/<repo>/auto-fix-log.json`, keyed by `<branch>@<sha>`.

- ≤ 2 prior **counted** attempts on this exact SHA. An attempt counts if it produced a commit (`fixed`), erred (`error`), or had its diff rejected (`rejected_diff`). A clean refusal by the agent (`skipped`) does not count — declining is the right behavior and shouldn't burn budget.
- ≥ 5 minutes elapsed since the last auto-fix commit on this branch (gives CI a chance to verify the previous attempt before we'd consider a follow-up).
- A new commit (any source) on the branch produces a new SHA, which resets the attempt count automatically because the budget is per-SHA.

### Gate 5 — Concurrency lock
Per-repo lock at `~/.rt/<repo>/auto-fix.lock` containing `{ branch, sha, pid, startedAt }`. Per-repo because ephemeral worktrees within the same repo share git plumbing (e.g. ref locks during `git worktree add`); also keeps overall machine load predictable.

- Acquire before any worktree creation; release on exit (success, failure, crash).
- Stale-lock sweep on daemon startup: any lock whose PID isn't alive is removed.
- If a second eligible failure arrives for the same repo while a fix is in flight, it is queued in memory (one slot — the most recent failing SHA wins; older queued items are dropped). When the active fix releases the lock, the queued item is re-evaluated from scratch.
- Different repos can fix in parallel.

## Worktree provisioning (ephemeral)

When all gates pass, the daemon provisions a short-lived worktree and runs the agent inside it.

### Provisioning steps

All operations happen inside the daemon process; the user sees nothing in their terminal.

1. **Compute worktree path:** `~/.rt/<repo>/auto-fix-worktrees/<branch>-<short-sha>` where `<short-sha>` is the first 8 chars of the failing SHA. Path is unique per attempt — different SHAs don't collide.
2. **Create worktree:** `git -C <main-repo-path> worktree add <worktree-path> origin/<branch>` (using the failing branch directly).
3. **Verify HEAD:** `git -C <worktree-path> rev-parse HEAD` must equal the MR HEAD. Else abort with `rejected: HEAD drifted` and remove the worktree.
4. **Reconcile Doppler:** call the Doppler-sync reconciler (see prerequisite spec) for this repo. The reconciler walks the template's per-app paths and writes any missing entries to `~/.doppler/.doppler.yaml`. After this step, every app subdir in the new worktree has its Doppler project + config bound.
5. **Run setup commands** to bring the worktree to a state where the agent can validate locally. The daemon resolves these in this order:
   - If `auto-fix.json` has an explicit `setupCommands` array → run each command in order, fail-fast on non-zero exit.
   - Otherwise, **detect from lockfiles** in the worktree root and run the corresponding install command:
     - `bun.lock` or `bun.lockb` → `bun install`
     - `pnpm-lock.yaml` → `pnpm install --frozen-lockfile`
     - `yarn.lock` → `yarn install --frozen-lockfile`
     - `package-lock.json` → `npm ci`
     - `Gemfile.lock` → `bundle install`
     - `go.sum` → `go mod download`
     - `requirements.txt` → `pip install -r requirements.txt`
     - none of the above → skip install (the agent itself can attempt to bootstrap if needed; it has shell access in the worktree).
   - Lockfile detection picks the **first match** in the order above, which mirrors typical JS-monorepo conventions where multiple lockfiles are uncommon. If multiple are present the user can disambiguate via `setupCommands`.
   - Setup commands run with the same env the agent will get (Doppler env from the reconciler, etc.).
6. **Run the agent.**

The daemon **never** detects or runs lint / typecheck / test commands itself. Those are the agent's responsibility — the agent inspects the repo's `package.json` scripts, `Makefile`, README, etc. and decides which validation commands to run before committing. The daemon's job is only to bring the worktree to "deps installed, env ready" state.

### Teardown steps

After the agent finishes (success, skip, error, or crash):

1. If the agent committed and pushed: leave the worktree alone for one more pass — the daemon reads the commit SHA + timestamps for logging.
2. **Remove the worktree:** `git -C <main-repo-path> worktree remove --force <worktree-path>`. The `--force` is required because the worktree may have unpushed changes if the agent failed mid-flow; we don't care, we're throwing it away.
3. **Optional Doppler cleanup:** entries the reconciler wrote can be left (harmless) or pruned via `rt doppler sync --prune-stale`. Default: leave them. They're keyed by absolute path; the path doesn't exist anymore but Doppler doesn't care.

### Why ephemeral wins over persistent

- No long-lived state to drift. Each fix starts from a known-good base (`origin/<branch>`).
- No worktree visible in `rt cd` / `rt run` between fixes (it doesn't exist).
- No "is the worktree dirty?" check — fresh worktrees are always clean by construction.
- Concurrent fixes across repos are trivially safe; each fix has its own worktree.
- Doppler sync makes the per-fix overhead manageable (~seconds).

## Agent invocation

The agent runs via the existing `lib/agent-runner.ts` (`claude -p` by default, with the same `cli`/`args` config knobs the MR `describe` flow uses). The auto-fix prompt is assembled by a new helper modeled on `assemblePrompt` in `commands/mr.ts`, but lives in the daemon code.

### Prompt contents

1. **Task framing** — "A pipeline on this branch is failing. Make the smallest change that makes it pass. Stay within scope caps. Refuse rather than guess."
2. **Failing job logs** — the daemon already has access to `fetchJobDetail` / job traces (see `lib/daemon/handlers/mr.ts:67-76`). For each failing job: name + last ~200 lines of trace.
3. **Repo context** — branch, target, recent commits on branch, changed files vs. target, diff stat. Reuse the existing `captureGitSnapshot` from `commands/mr.ts:160-175`.
4. **Scope rules** — explicit caps and denylist (see below). The agent is told these are hard limits and to abort if a fix would exceed them.
5. **Validation requirement** — before committing, the agent must run the project's lint + typecheck (and tests if test-class is enabled for this repo) locally and confirm they pass on the changed files.
6. **Exit protocol** — the agent must end with one of:
   - `RESULT: fixed` followed by a one-line summary (then commit; daemon pushes).
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

These are also enforced by the daemon **after** the agent reports success — the daemon runs `git diff --name-only` and `git diff --shortstat`, rejects out-of-scope diffs, and tears down the worktree if violated.

## Validation and commit

On `RESULT: fixed` from the agent:

1. **Daemon validates the diff** in the worktree:
   - `git diff --name-only` against denylist → reject if any path matches.
   - `git diff --shortstat` → reject if files > cap or insertions+deletions > cap.
   - `git status --porcelain` → expect a non-empty diff. If empty, treat as `skipped`.
2. **Verify HEAD didn't drift** — re-check that the worktree's branch HEAD matches MR HEAD. If a third party pushed during the agent run, abort and tear down.
3. **Commit** with subject `auto-fix: <agent's one-line summary>` and a trailer:
   ```
   Auto-Fixed-By: rt
   Pipeline-Failure-SHA: <sha>
   ```
   (The trailer makes attempts identifiable in `git log` for later filtering.)
4. **Push** via `git push origin <branch>`. Do not force-push.
5. **Log the attempt** in `auto-fix-log.json`: `{ branch, sha, attemptedAt, outcome: "fixed", commitSha, durationMs }`.
6. **Tear down** the worktree.
7. **Notify** the user: `Auto-fix pushed on <branch>: <summary>` with the MR URL.

On `RESULT: skipped` or `RESULT: error`:

1. Write `~/.rt/<repo>/auto-fix-notes/<branch>-<sha>.md` containing the agent's stderr + final reason. This is durable so the user can inspect later.
2. Log the attempt with outcome `skipped` or `error`.
3. Tear down the worktree.
4. Notify the user once: `Auto-fix tried <branch> and stepped back: <reason>. See: rt auto-fix log <branch>`.
5. If outcome is `error`, increment the attempt counter (counts toward the cap of 2).
6. If outcome is `skipped`, do **not** increment the counter — the agent declined cleanly, no need to penalize.

If validation rejects the agent's diff (out-of-scope or denylist):

1. Log outcome `rejected_diff` with the violation reason. Counts toward the attempt budget.
2. Tear down the worktree (no need to reset; we're throwing it away).
3. Notify: `Auto-fix on <branch> rejected: <reason>`.

## Concurrency safety

- **Per-repo lock** — only one auto-fix at a time per repo. Different repos can fix in parallel.
- **Ephemeral isolation** — each fix has its own worktree path, so even if the lock somehow released early, two agents wouldn't fight over the same files.
- **The user's other worktrees are unaffected** — different paths entirely; the rt-managed `auto-fix-worktrees/` directory lives under `~/.rt/<repo>/`, not in the user's GitHub clone.
- **Daemon restart mid-run** — child agent processes are not re-parented. On restart, the daemon sweeps stale locks; any leftover ephemeral worktree directories are pruned by a "stale worktree sweep" that removes anything under `~/.rt/<repo>/auto-fix-worktrees/` older than 1h (also runs on startup).

## Persistence and observability

### Files

- `~/.rt/<repo>/auto-fix.json` — per-repo config:
  ```json
  {
    "enabled": true,
    "fileCap": 5,
    "lineCap": 200,
    "additionalDenylist": ["src/legacy/**"],
    "allowTestFixes": false,
    "setupCommands": [
      ["bun", "install"],
      ["bun", "run", "gen"]
    ]
  }
  ```
  `setupCommands` is optional. When omitted, the daemon detects the install command from lockfiles (see "Run setup commands" above). When set, it overrides detection entirely — useful for monorepos that need multiple bootstrap steps (install + codegen + asset build).
- `~/.rt/<repo>/auto-fix-log.json` — append-only ring (last 100 entries).
- `~/.rt/<repo>/auto-fix-notes/<branch>-<sha>.md` — agent stderr / reasoning for skipped/error outcomes.
- `~/.rt/<repo>/auto-fix.lock` — active lock (deleted on completion).
- `~/.rt/<repo>/auto-fix-worktrees/` — ephemeral worktrees, pruned on completion or by the stale sweep.

### CLI surface

```
rt auto-fix enable | disable   # toggle per-repo enabled flag
rt auto-fix log [<branch>]     # show recent attempts (date, branch, sha, outcome, duration)
rt auto-fix notes <branch>     # print the most recent notes file for that branch
rt auto-fix status             # show: enabled? recent attempts? lock holder if any?
```

No `rt auto-fix init` (no persistent state to initialize beyond the optional `auto-fix.json`).
No `rt auto-fix reset` (no persistent worktree to clean — ephemeral worktrees clean themselves).
No `rt auto-fix run` (forcing a run circumvents gates; if you want to trigger an attempt, push or commit, which resets the attempt counter and the next failure cycle will try).

## Notification model

The existing notifier (`lib/notifier.ts`) gains three new event keys:

- `auto_fix_pushed` — agent fixed and pushed; default ON.
- `auto_fix_skipped` — agent looked at it and declined (no commit); default ON.
- `auto_fix_rejected` — daemon rejected the agent's diff for scope/denylist violation; default ON.

`auto_fix_pushed` carries the MR URL so the user can click through to the new pipeline run.

The previous design's `auto_fix_unavailable` notification (worktree missing/dirty/etc.) is no longer needed — ephemeral worktrees can't enter those states.

## Failure mode analysis

- **Agent introduces a regression that passes lint/types but breaks tests** — CI catches it. Pipeline fails again. Attempt counter increments to 2. Next failure will try once more, then back off until a new commit.
- **Agent edits a file outside the denylist that we should have denied** — caught only by review at merge time. The denylist must be conservative; we err on the side of bigger denylist over smaller.
- **Agent commits and pushes, but pipeline fails differently** — counted as a new SHA; new attempt budget. If the new failure is also auto-fixable, we go again (capped at 2).
- **User force-pushes during agent run** — daemon's pre-commit HEAD-match check catches it. Tear down, abort.
- **Daemon crashes mid-run** — stale lock, orphaned worktree on disk. Stale lock cleared on next start; orphaned worktrees pruned by the stale-sweep (anything under `auto-fix-worktrees/` older than 1h gets `git worktree remove --force`). User sees no leftover state.
- **Two MRs fail simultaneously in the same repo** — first eligible MR claims the per-repo lock; second is queued (most-recent-wins). When the first releases, the queued one re-evaluates from scratch.
- **A setup command fails in the ephemeral worktree** — daemon aborts before spawning the agent; logs outcome `setup_failed` with the command that failed and its stderr; counts as an error attempt; user sees notification with the failure reason. Likely causes: a recent dep change with a lockfile not yet pulled, a network/registry issue, or a `setupCommands` override referencing a missing tool.
- **No lockfile detected and no `setupCommands` configured** — daemon skips the install step entirely. The agent runs in a worktree without `node_modules`. Whether that's fine depends on the failure type (lint-only fixes might work; type-checking won't). The agent is told the setup status in the prompt so it can decide whether to attempt or `RESULT: skipped`.
- **Doppler sync hasn't run yet for this repo (no template exists)** — the install or validation step that depends on Doppler will fail; agent reports `RESULT: error` with that error. User sees notification, runs `rt doppler init` once, future fixes work.
- **Disk pressure from accumulated ephemeral worktrees** — the stale sweep handles it (runs every hour). Worktrees during a fix run are typically <30s of life; concurrent worktrees across repos could briefly accumulate but are bounded by the per-repo lock.

## Implementation surface (preview for plan)

These are the files / modules that will likely change. The implementation plan, written next, will spell out the exact ordering and tests:

- `lib/notifier.ts` — add `auto_fix_pushed`, `auto_fix_skipped`, `auto_fix_rejected` event keys; trigger auto-fix evaluation on the same `pipeline:failed` transition that currently fires the notification (`lib/notifier.ts:440-470`).
- `lib/auto-fix-config.ts` (new) — read/write `~/.rt/<repo>/auto-fix.json` (caps, denylist additions, enabled flag, optional `setupCommands` override).
- `lib/setup-commands.ts` (new) — lockfile detection helper. Pure function: takes a worktree path, returns either the detected install command or `null`. Tested independently of the daemon.
- `lib/daemon/auto-fix.ts` (new) — core engine: gate evaluator, ephemeral worktree provisioner + teardown, lock manager, agent invocation, post-agent validation, commit/push, log writer, stale-sweep.
- `lib/daemon/handlers/auto-fix.ts` (new) — IPC handlers for log/notes/config reads and writes (`auto-fix:log:read`, `auto-fix:notes:read`, `auto-fix:config:get`, `auto-fix:config:set`, `auto-fix:status`).
- `commands/auto-fix.ts` (new) — top-level command surface: `enable`, `disable`, `log`, `notes`, `status`. Wired into `cli.ts`.
- `lib/agent-runner.ts` — no changes expected; the existing `runAgent` is sufficient.

The Doppler-sync prerequisite (`lib/daemon/doppler-sync.ts`, `commands/doppler.ts`) is implemented separately per its own design doc and is called from the auto-fix engine during worktree provisioning.

## Open questions

None for v1 — every decision point has been answered through brainstorming. v2 candidates:

- Per-failure-class enable/disable in `auto-fix.json` beyond the current `allowTestFixes` toggle.
- Force-trigger CLI for manual attempts (`rt auto-fix now`) — deliberately omitted from v1.
- Persistent `bun install`-cache warmup at the rt level (e.g. a stable "warm" worktree we keep around to template-from), if `bun install` becomes a bottleneck. Likely unnecessary given Bun's existing cache.
