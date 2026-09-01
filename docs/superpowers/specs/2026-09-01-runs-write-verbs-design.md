# rt runs write verbs

Move the pipeline run DB's write side out of `pipeline-state.sh` (mattstack-skills) into rt, as subcommands of the existing `rt runs` family, so every pipeline stage records state through a plain `rt` invocation.

## Why

Stage skills tell agents to write run state through a shell variable: `"$RT_PIPELINE_STATE" stage-done --stage plan`. Claude Code's worktree-isolation guard refuses any Bash command whose executable is a variable, and its newest build (2.1.257) does so unconditionally. On 2026-09-01 that refusal dropped a provision `stage-done` and a plan `stage-start` in run `20260901-132107-9133-81450`; the run showed provision running for hours and never recorded a plan stage. The script now fails loudly on a zero-row update, but the root cause is the invocation form. `rt` is already a bare word on every agent's PATH and in every allowed-tools list.

Option chosen (from the ladder least to most complicated: rename only, rt as dispatcher, rt owns writes locally, rt owns writes via daemon): **rt owns writes locally**. One home for the schema beside the read side that already understands it, no daemon dependency in the write path.

This supersedes the upstream run DB design's split (writes in mattstack-skills, "no writes from rt"): rt now owns both sides of the run DB. The upstream's other invariants stand: a down or wedged daemon never blocks a pipeline, and the DB write lands before any emission.

## Decisions already made

| Question | Decision |
|---|---|
| Verb shape | `rt runs <same subcommand names and flags as the script>` |
| Transition | delete `pipeline-state.sh` outright in the mattstack bump; no shim |
| Run context | `RT_RUN_DB` env var, as today; `RT_RUNS_ROOT` and `RT_RUN_EMIT` keep their meaning |
| Emission | in-process `events:emit run-updated` over the daemon socket via `daemonSocketQuery`, awaited with a one-second timeout, never restarts the daemon or writes to stderr |

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
- `run-start` provenance, written to `runs.pack_commits` and `runs.pack_dirty` exactly as the script does. `pack_commits` is a comma-joined list built in this order: one `name=sha` per directory in `--pack-dirs` that is a git checkout (`name` is the directory's basename, `sha` is `git rev-parse --short HEAD`), then `mattstack=<value>` when `--mattstack-sha` is given, then the raw `--pack-sha` value when given; NULL when the list is empty. `pack_dirty` is 1 when any pack dir has `git status --porcelain` output or `--mattstack-dirty 1` is given, else 0. A directory that is not a git checkout contributes nothing and never sets dirty. The compiler bakes these flags into every compiled work verb (`{{run-start.flags}}` in `lib/skills/placeholders.ts`), so they are required, not optional extras. A value-taking flag with no following token is exit 2, never silently eating the next flag as its value.
- `run-status` sets `runs.status` and `runs.ended_at`; any status outside the three is exit 2.
- `stage-start` inserts a `running` row with `attempt = max(attempt)+1` for that name and sets `runs.current_stage`. Records identity.
- `stage-done` / `stage-fail` update the latest attempt of the named stage with status, `ended_at`, and the optional reason and detail path. **New in rt, carried from today's script fix:** zero rows updated is `{"ok":false,"error":"stage never started: NAME"}`, exit 3.
- `field set` upserts `(run_id, key)` with producer `--stage` and `at = now`. `field get` prints the raw value, no JSON; a missing key is exit 3 with no output.
- `decision record` upserts `(run_id, contract, scope)`. `--selection` that is not valid JSON is exit 2 (new; the script stored anything).
- `snapshot` prints `{ok, run, stages, fields, decisions}` as raw `SELECT *` rows from the open `RT_RUN_DB` handle, with the same ordering the script used (stages by `started_at, attempt`; fields by `at`; decisions by `decided_at`). It is implemented in `write.ts` beside the mutations, not through `store.ts`'s `readRun`, which keys on `(repo, runId)` under `runsRoot()` and returns the enriched `RunDetail` shape rather than raw rows.
- `rt runs` with a positional argument that is not a known subcommand prints a usage error and exits 2. Today the dispatcher runs a node's own handler when the first argument matches no subcommand, so `rt runs stage-start` on an rt without these verbs silently prints the run list and exits 0; `runsList` rejecting positionals closes that on any rt carrying this change.
- Output is JSON on stdout for every outcome of every subcommand except `field get`. Exit codes: 0 ok, 1 sqlite failure, 2 usage or environment, 3 not found.
- Bare `rt runs` (the list), `rt runs show`, and `rt runs abandon` are unchanged. `list` was never a registered subcommand; it only worked through the fallthrough closed below, and nothing invokes it literally.

`--repo` on `run-start` is the run-dir key (the string `runs:list` hands out), not a parsed identity; the write side treats it as an opaque path component exactly as the read side does, validated with `isPathComponent`.

## Layout in rt

- `lib/runs/write.ts` (new): owns the schema. `createRunDb(path)` with the four `CREATE TABLE IF NOT EXISTS` statements and `PRAGMA journal_mode=WAL`; `migrate(db)` bringing a v1 DB to v2 (the two `stages` columns, the two `runs` columns, stamp `user_version` only once the columns are present); one exported function per mutating operation except `run-start`, each taking an open `Database` and plain arguments and returning the value the CLI prints; plus two read helpers the CLI needs, `snapshot(db)` and `runIdentity(db)` (the run row's `repo` and `runId`, or null). `busy_timeout=5000` on every open for writing.
- `lib/runs/start.ts` (new): `runStart(root, opts)` alone, because it is the one operation that spawns git (pack provenance) and the daemon's import graph must never reach a synchronous spawn (`lib/__tests__/no-daemon-sync-exec.test.ts`). The daemon reaches `write.ts` through `store.ts` and `reconcile.ts`; only the CLI imports `start.ts`.
- `lib/runs/paths.ts` (new): `runsRoot()` and `isPathComponent()`, shared by the read and write sides without a cycle; `store.ts` re-exports them.
- `lib/runs/store.ts`: keeps the read side. `KNOWN_SCHEMA_VERSION` becomes the write side's number and is re-exported for `schemaAhead`.
- `lib/runs/reconcile.ts`: `abandonRun` calls `write.ts` instead of running its own SQL, so the daemon's `runs:abandon` and the CLI share one implementation.
- `lib/runs/provenance.ts` (new): `packProvenance(dirs)` returns `{dirty, commits}` from `git rev-parse --short HEAD` and `git status --porcelain` per dir; non-git dirs are skipped.
- `lib/runs/identity.ts` (new, small): `recordIdentity(db)` upserts `claude-session` and `herdr-pane` under `produced_by = 'run'` from `CLAUDE_CODE_SESSION_ID` and `HERDR_PANE_ID`, change-guarded so an unchanged value never bumps `fields.at`.
- `commands/runs-write.ts` (new): one exported function per subcommand doing argument parsing, `RT_RUN_DB` resolution, the call into `write.ts` or `start.ts`, emission, and printing; `commands/runs.ts` keeps the read verbs and gains the positional rejection. Registered in `lib/command-tree-def.ts` under `runsSubcommands` beside `show` and `abandon`, with help text matching the surface above, and in `lib/module-registry.ts` so the compiled binary resolves the module. The `runs` node's description drops "read-only".
- Header comments that become false are rewritten in the same change: `commands/runs.ts` ("rt never opens run DBs from the CLI"), `lib/runs/store.ts`, and `lib/runs/reconcile.ts` ("the one writable path rt has into run state"). None of them is a constraint the new verbs violate; they described the old split.
- Emission: after a successful write, and unless `RT_RUN_EMIT=0`, `daemonSocketQuery("events:emit", { topic: "run-updated", payload: { repo, runId, stage, kind } }, 1_000)`, awaited, result ignored. `daemonSocketQuery` is the read-only probe path: a missing socket returns at once with no tray `/daemon/start` call and no stderr warning, unlike `daemonQuery`, which would restart the daemon and wait up to several seconds. A daemon that accepts and never answers costs the one-second timeout, nothing more. The write has landed before this runs. `kind` and `stage` per verb: `run-start` and `run-status` send `kind` of the same name with `stage: null`; `stage-start`, `stage-done`, `stage-fail`, and `field-set` send their name with the `--stage` value; `decision` sends `kind: "decision"` with the `--scope` value as `stage`.

## Errors

No subcommand throws to a stack trace. A caught sqlite error prints `{"ok":false,"error":"sqlite write failed: <message>"}` and exits 1. Argument problems print the usage line for that subcommand as the error string and exit 2. Values are bound as parameters, never interpolated, so the script's quote-escaping helper has no counterpart.

## Testing

Port every case in mattstack-skills `tests/pipeline-state.test.ts` (28 today) and `attachments/pipeline/work/scripts/tests/pipeline-state-run-start.test.sh` (the `--mattstack-sha`, `--mattstack-dirty`, and `--pack-sha` cases) before deleting them:

- `lib/runs/__tests__/write.test.ts`: schema creation and version stamp; v1 migration in place and on `run-start` into an existing directory; stage lifecycle and attempt bumping; the zero-row guard for done and fail; field round-trip with quotes; decision upsert; provenance dirty detection for unstaged, staged, and untracked changes; non-git dir skipped; `pack_commits` order and `pack_dirty` for the three run-start flags; identity change guard and `produced_by = 'run'`.
- `commands/__tests__/runs-write.test.ts`: the CLI contract by calling the exported functions with a temp `RT_RUNS_ROOT`, capturing stdout and exit code: JSON shapes, exit codes 1/2/3, missing `RT_RUN_DB`, `field get` raw output, a value flag with no value, `rt runs <unknown>` as a usage error, emission skipped under `RT_RUN_EMIT=0`, and emission bounded: against a socket that accepts and never answers, the call returns within 1.5 seconds; against no socket, at once.

Each case is written first and watched to fail.

## mattstack-skills changes

In the same bump, through the writing-skills skill:

- Delete `attachments/pipeline/work/scripts/pipeline-state.sh`, `attachments/pipeline/work/scripts/tests/pipeline-state-run-start.test.sh`, and `tests/pipeline-state.test.ts`; drop the test from the list in `README.md`.
- Work engine (`attachments/pipeline/work/SKILL.md`): drop the `export RT_PIPELINE_STATE=` line (the `PACK_DIRS` computation stays, `run-start` still takes it); in allowed-tools, `Bash(${CLAUDE_SKILL_DIR}/scripts/pipeline-state.sh:*)` becomes `Bash(rt runs:*)` and `Bash(git -C *:*)` stays; every `"$RT_PIPELINE_STATE"` becomes `rt runs`.
- The `run-start` step gains the version gate: the response must parse as JSON with `ok: true` and a `runDb`. Anything else (a run listing, usage text) means this rt predates the write verbs; the agent stops and tells the user to update rt before continuing. This is the only enforcement; `rt --version` prints `rt dev` under the dev-mode launcher (observed on this machine on 2026-09-01), so a numeric check is not reliable.
- The eight stage engines under `attachments/pipeline/stage-*/SKILL.md` and `attachments/parameterized-skills/references/convention.md`: `"$RT_PIPELINE_STATE"` becomes `rt runs`.
- `RT_RUN_DB` is still exported after `run-start`, as its own step, exactly as today.
- Certify the touched dirs, bump `plugin.json`.

## Rollout order

1. rt: merge to main, then release, so teammates' rt carries the verbs.
2. mattstack-skills: the bump above. Local sessions on `rt` dev mode see the verbs as soon as main has them.
3. `claude plugin update mattstack@mattstack`; `rt skills compile --pack <team>` for the team pack (the plain form, `--json` does not write today); bump the pack; push; `claude plugin update <pack>@<marketplace>`. The compiled pack's script disappears from a machine at that machine's own `claude plugin update`, so each person runs it with no pipeline in flight; the recompile and push do not touch anyone's installed copy.
4. On an rt without these verbs, `rt runs stage-start` and every other write call falls through to the bare `rt runs` list and exits 0, recording nothing: the dispatcher runs a node's own handler when the first argument matches no subcommand. That is the silent failure this spec exists to remove, and it is reachable by anyone whose pack updates before their rt. The `run-start` gate in the work engine (above) is what catches it: no `{"ok":true,...,"runDb":...}`, no pipeline. rt has no self-update verb, so updating rt is a manual step per machine and the gate's message says so.

## Non-goals

- No daemon-side write verbs and no console changes; `runs:abandon` keeps its current route.
- No rt-client additions.
- No change to the run DB schema beyond moving its definition.
- No compatibility shim for the deleted script.
