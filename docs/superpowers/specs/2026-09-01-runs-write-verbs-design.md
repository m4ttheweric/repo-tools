# rt runs write verbs

Move the pipeline run DB's write side out of `pipeline-state.sh` (mattstack-skills) into rt, as subcommands of the existing `rt runs` family, so every pipeline stage records state through a plain `rt` invocation.

## Why

Stage skills tell agents to write run state through a shell variable: `"$RT_PIPELINE_STATE" stage-done --stage plan`. Claude Code's worktree-isolation guard refuses any Bash command whose executable is a variable, and its newest build (2.1.257) does so unconditionally. On 2026-09-01 that refusal dropped a provision `stage-done` and a plan `stage-start` in run `20260901-132107-9133-81450`; the run showed provision running for hours and never recorded a plan stage. The script now fails loudly on a zero-row update, but the root cause is the invocation form. `rt` is already a bare word on every agent's PATH and in every allowed-tools list.

Option chosen (from the ladder least to most complicated: rename only, rt as dispatcher, rt owns writes locally, rt owns writes via daemon): **rt owns writes locally**. One home for the schema beside the read side that already understands it, no daemon dependency in the write path.

## Decisions already made

| Question | Decision |
|---|---|
| Verb shape | `rt runs <same subcommand names and flags as the script>` |
| Transition | delete `pipeline-state.sh` outright in the mattstack bump; no shim |
| Run context | `RT_RUN_DB` env var, as today; `RT_RUNS_ROOT` and `RT_RUN_EMIT` keep their meaning |
| Emission | in-process `events:emit run-updated` over the daemon socket, best-effort |

## Command surface

```
rt runs run-start   --repo R --work-type T --pipeline P [--run-id ID] [--spawned-by S]
                    [--pack-dirs "DIR:DIR"] [--ticket ID] [--mattstack-sha SHA]
                    [--mattstack-dirty 0|1] [--pack-sha NAME=VALUE]
rt runs run-status  --status done|failed|abandoned
rt runs stage-start --stage NAME
rt runs stage-done  --stage NAME
rt runs stage-fail  --stage NAME [--reason TEXT] [--detail-path PATH]
rt runs field set   KEY VALUE --stage NAME
rt runs field get   KEY
rt runs decision record --contract C --scope S --selection JSON --decided-by W
rt runs snapshot
```

Contract, identical to the script's v2 except where marked new:

- Every subcommand except `run-start` reads `RT_RUN_DB` (path to the run's `state.db`). Missing or nonexistent: `{"ok":false,"error":...}`, exit 2.
- `run-start` creates `<RT_RUNS_ROOT or ~/.mattstack/runs>/<repo>/<runId>/state.db`, generates the run id when `--run-id` is absent (`YYYYMMDD-HHMMSS-<4 hex>-<pid>`), records `ticket` under producer `work` when given, records identity (below), captures pack provenance (below), and prints `{"ok":true,"runId":...,"runDb":...}`. A duplicate run id is exit 1.
- `run-status` sets `runs.status` and `runs.ended_at`; any status outside the three is exit 2.
- `stage-start` inserts a `running` row with `attempt = max(attempt)+1` for that name and sets `runs.current_stage`. Records identity.
- `stage-done` / `stage-fail` update the latest attempt of the named stage with status, `ended_at`, and the optional reason and detail path. **New in rt, carried from today's script fix:** zero rows updated is `{"ok":false,"error":"stage never started: NAME"}`, exit 3.
- `field set` upserts `(run_id, key)` with producer `--stage` and `at = now`. `field get` prints the raw value, no JSON; a missing key is exit 3 with no output.
- `decision record` upserts `(run_id, contract, scope)`. `--selection` that is not valid JSON is exit 2 (new; the script stored anything).
- `snapshot` prints `{ok, run, stages, fields, decisions}` with the same ordering the script used (stages by `started_at, attempt`; fields by `at`; decisions by `decided_at`).
- Output is JSON on stdout for every outcome of every subcommand except `field get`. Exit codes: 0 ok, 1 sqlite failure, 2 usage or environment, 3 not found.
- `rt runs list`, `show`, and `abandon` are unchanged.

`--repo` on `run-start` is the run-dir key (the string `runs:list` hands out), not a parsed identity; the write side treats it as an opaque path component exactly as the read side does, validated with `isPathComponent`.

## Layout in rt

- `lib/runs/write.ts` (new): owns the schema. `createRunDb(path)` with the four `CREATE TABLE IF NOT EXISTS` statements and `PRAGMA journal_mode=WAL`; `migrate(db)` bringing a v1 DB to v2 (the two `stages` columns, the two `runs` columns, stamp `user_version` only once the columns are present); one exported function per mutating operation, each taking an open `Database` and plain arguments and returning the value the CLI prints. `busy_timeout=5000` on every open for writing.
- `lib/runs/store.ts`: keeps the read side. `KNOWN_SCHEMA_VERSION` becomes the write side's number and is re-exported for `schemaAhead`. `runsRoot()` and `isPathComponent()` are shared.
- `lib/runs/reconcile.ts`: `abandonRun` calls `write.ts` instead of running its own SQL, so the daemon's `runs:abandon` and the CLI share one implementation.
- `lib/runs/provenance.ts` (new): `packProvenance(dirs)` returns `{dirty, commits}` from `git rev-parse --short HEAD` and `git status --porcelain` per dir; non-git dirs are skipped.
- `lib/runs/identity.ts` (new, small): `recordIdentity(db)` upserts `claude-session` and `herdr-pane` from `CLAUDE_CODE_SESSION_ID` and `HERDR_PANE_ID`, change-guarded so an unchanged value never bumps `fields.at`.
- `commands/runs.ts`: one exported function per subcommand doing argument parsing, `RT_RUN_DB` resolution, the call into `write.ts`, emission, and printing. Registered in `lib/command-tree-def.ts` under `runsSubcommands` beside `show` and `abandon`, with help text matching the surface above.
- Emission: after a successful write, `daemonQuery("events:emit", { topic: "run-updated", payload: { repo, runId, stage, kind } }, 2_000)`, result ignored, unless `RT_RUN_EMIT=0`. The write has landed before this runs; a down daemon costs at most the timeout.

## Errors

No subcommand throws to a stack trace. A caught sqlite error prints `{"ok":false,"error":"sqlite write failed: <message>"}` and exits 1. Argument problems print the usage line for that subcommand as the error string and exit 2. Values are bound as parameters, never interpolated, so the script's quote-escaping helper has no counterpart.

## Testing

Port every case in mattstack-skills `tests/pipeline-state.test.ts` (28 today) before deleting it:

- `lib/runs/__tests__/write.test.ts`: schema creation and version stamp; v1 migration in place and on `run-start` into an existing directory; stage lifecycle and attempt bumping; the zero-row guard for done and fail; field round-trip with quotes; decision upsert; provenance dirty detection for unstaged, staged, and untracked changes; non-git dir skipped; identity change guard.
- `commands/__tests__/runs-write.test.ts`: the CLI contract by calling the exported functions with a temp `RT_RUNS_ROOT`, capturing stdout and exit code: JSON shapes, exit codes 1/2/3, missing `RT_RUN_DB`, `field get` raw output, emission skipped under `RT_RUN_EMIT=0`, emission non-blocking against a stubbed slow daemon.

Each case is written first and watched to fail.

## mattstack-skills changes

In the same bump, through the writing-skills skill:

- Delete `attachments/pipeline/work/scripts/pipeline-state.sh` and `tests/pipeline-state.test.ts`.
- Work engine (`attachments/pipeline/work/SKILL.md`): drop the `export RT_PIPELINE_STATE=` line (the `PACK_DIRS` computation stays, `run-start` still takes it); allowed-tools becomes `Bash(rt runs:*)`; every `"$RT_PIPELINE_STATE"` becomes `rt runs`.
- The nine stage engines under `attachments/pipeline/stage-*/SKILL.md` and `attachments/parameterized-skills/references/convention.md`: `"$RT_PIPELINE_STATE"` becomes `rt runs`.
- `RT_RUN_DB` is still exported after `run-start`; the guard accepts `export RT_RUN_DB=...` followed by `rt runs ...` in one command.
- Certify the touched dirs, bump `plugin.json`.

## Rollout order

1. rt: merge to main, then release, so teammates' rt carries the verbs.
2. mattstack-skills: the bump above. Local sessions on `rt` dev mode see the verbs as soon as main has them.
3. `claude plugin update mattstack@mattstack`; `rt skills compile --pack claimview` (the plain form, `--json` does not write today); bump the pack; push; `claude plugin update claimview@assured`. Do the recompile at a moment with no run in flight, since the compiled pack's script is deleted underneath any running pipeline.
4. An old rt fails loudly by construction (`rt runs stage-start` is an unknown subcommand), so no version gate is added.

## Non-goals

- No daemon-side write verbs and no console changes; `runs:abandon` keeps its current route.
- No rt-client additions.
- No change to the run DB schema beyond moving its definition.
- No compatibility shim for the deleted script.
