# rt follow-ups for the mattstack pipeline gates (issue 181)

**Status:** approved by review (three rounds, 2026-09-02). **Tracks:** https://github.com/m4ttstack/rt/issues/181. **Source:** compiled read-throughs of a team pack on mattstack 0.12.0 and the plan 3 review (mattstack-skills `docs/superpowers/specs/2026-09-02-engine-followups-design.md`, section "rt follow-ups"). Line numbers below are from `main` at 66acbedf.

Seven items: four in `rt skills compile` (1, 2, 3, 6), three in `rt runs` (4, 5, 7). None changes a schema. One PR on branch `rt-followups-181`, released with the next `v*` tag; the dev wrapper on this machine runs `main`, so merging is the local install.

## 1. Skill-dir rewrite for every attachments-side output

Today `commands/skills.ts:588` sets `opts.stageDir` only for pipeline stages, so a stage's fills and includes get `${CLAUDE_SKILL_DIR}/../../attachments/<stage>/parts/...` while an internal (attachments-side) roster verb such as `receive-review` gets `${CLAUDE_SKILL_DIR}/parts/...` (`lib/skills/placeholders.ts:41-44`, `lib/skills/compile.ts:515`). An internal verb is never invoked by name; a public skill in the pack reads it, so `${CLAUDE_SKILL_DIR}` is that reader's directory and `${CLAUDE_SKILL_DIR}/parts/...` resolves nowhere.

Rule after the change, per compile target:
- a stage keeps today's entry dir on either side (`${CLAUDE_SKILL_DIR}/../../skills/<name>` when surface-public, `.../attachments/<name>` otherwise; `buildStageEntries`, `lib/skills/layout.ts:47`; the orchestrator side depends on it, `compile-native.e2e.test.ts:58-74`);
- a non-stage internal roster verb gains `stageDir = ${CLAUDE_SKILL_DIR}/../../attachments/<name>`, so `partsPrefix` (`compile.ts:515`) and the step-body rewrite (`compile.ts:309`) produce `${CLAUDE_SKILL_DIR}/../../attachments/<name>/parts/...`;
- a non-stage public roster verb keeps `stageDir = null` (its own `${CLAUDE_SKILL_DIR}` is right).
The option keeps its name; its meaning is "the directory a pack-side reader reaches this file at". `commands/skills.ts` derives it from the target's side in `compileTargets()`.

Lint: `lintReferences` (`compile.ts:445`) exempts token paths only under `exemptPrefixes`, which `compileVerb` fills from `allStageDirs` (`skills.ts:587, 603`). That set gains the attachments-side host dir of every non-stage internal verb too, so an internal verb that vendors a fill or include lints clean.

`{{stage.dir}}` (`placeholders.ts:146-148`) then renders the host dir inside any attachments-side target, stages and internal verbs alike; its error message becomes "used in a public verb". `{{stage.fields}}` stays gated on `stageMeta` as today.

Known limit, written into a new `lib/skills/README.md` (the compiler has no doc in this repo today; the README also becomes the home for items 2, 3, and 6): a reader outside the pack (another plugin's skill) cannot resolve `${CLAUDE_SKILL_DIR}/../../...`; pack text read from outside must name files "relative to this file".

Tests: `lib/skills/__tests__/placeholders.test.ts` gains "an internal verb's include files are rewritten under the attachments-side host dir"; `lib/skills/__tests__/compile.test.ts` gains a compile of an internal roster verb with a vendoring include, asserting the emitted path prefix and zero lint notes; the existing stage tests and the e2e orchestrator test keep passing unchanged; the two assertions of the old `{{stage.dir}}` message, `placeholders.test.ts:192` and `compile.test.ts:514` ("used outside a stage"), update to "used in a public verb".

## 2. `{{verb.path:<name>}}`

Engines name sibling verbs as `mattstack:checkout` and the like, which are not registered skills. The new placeholder renders the path from the current output file's directory to the named verb's `SKILL.md`: `../<name>/SKILL.md` when both are on the same side, `../../skills/<name>/SKILL.md` or `../../attachments/<name>/SKILL.md` across sides. It is a reading path ("relative to this file"), never a shell path.

Mechanics: `compileTargets()` (`commands/skills.ts:674-710`) computes `isPublic` for every roster verb and stage. The side map `verbSides: Record<string, "skills" | "attachments">` is built from the unfiltered `all` set, before `verbFilter` applies (`skills.ts:702-709`), so `--verb <one>` and `--preview` (which requires one verb, `skills.ts:718`) still render paths to targets they are not emitting. It travels with the current target's own side through `compileVerb` to `compileSkill` and into `PlaceholderContext` (`lib/skills/types.ts:39-52`). `substitute()` (`lib/skills/placeholders.ts:127-154`) gains `case "verb.path"` next to `run-start.flags`: the argument must match `[a-z][a-z0-9-]*`; an unknown name throws `<where>: {{verb.path:<name>}} -- <name> is not a compiled verb of this pack`. `substituteIncludesOnly` (`placeholders.ts:66-75`) admits `verb.path` (and `pack.path`, item 6) beside `include`, so a fill may carry it. `lintReferences` accepts the rendered relative path because the target directory is among `emittedTargetDirs` (`compile.ts:124-131`).

Tests: placeholders (same side, cross side both directions, unknown name, bad argument, allowed in a fill); compile (a roster verb whose body carries the placeholder compiles to the right relative path and lints clean when the sibling is emitted; a `--verb`-scoped compile still resolves a path to an unemitted sibling, and that test asserts the rendered path, not zero lint notes, since `emittedTargetDirs` is the filtered set, `skills.ts:726`).

## 3. Drop a heading that precedes an empty slot

`slotText` returns "" for an unbound slot (`placeholders.ts:47`), leaving a `## Reviewer` or `## Domain rules` heading with nothing under it. `substitute()` is line based (`placeholders.ts:119-156`); `lines.map` cannot drop a line, so the pass becomes a flatMap.

Change: a heading line (`^#{1,6}\s`, outside fenced code blocks, tracked by toggling on lines that start with three backticks; tilde fences are not used by any engine in this estate and are not tracked) whose next non-blank line is exactly a `{{slot:<name>}}` placeholder with `fills[<name>] === null` is removed together with the blank lines between them, the slot line itself, and one blank line immediately after the slot line when one exists. Exact contract, with `fills.domain === null`:
- `a\n\n## Reviewer\n\n{{slot:domain}}\n\nb` renders `a\n\nb`;
- `a\n## Reviewer\n{{slot:domain}}\nb` renders `a\nb`;
- `a\n{{slot:domain}}\nb` (no heading) keeps today's `a\n\nb` (`placeholders.test.ts:66-69`);
- a heading above a bound slot, above any other placeholder, or above prose is untouched.

Tests: placeholders gains the four cases above plus "a shell comment inside a fence above a slot is not a heading".

## 4. `rt runs stage-redirect`

The work engine's Redirect leaves the stage it leaves as `running` (`stages.status` is free text, `lib/runs/write.ts:23-27`; `stageEnd` accepts only `"done" | "failed"`, `write.ts:116`; `stage-done` and `stage-fail` take no `--status` flag, `commands/runs-write.ts:107-118`).

Change: a new write verb `rt runs stage-redirect --stage <from> --to <to> [--reason <text>]`. It closes the latest attempt of `<from>` as `redirected` with `reason` defaulting to `redirected to <to>`, and refuses when that attempt is not `running` (exit 3, `stage <from> is <status>, not running`; a never-started stage is the existing zero-row exit 3). Exit 2 on a missing flag. `stageEnd`'s status union widens to `"done" | "failed" | "redirected"` and gains an `opts.requireRunning` flag that this verb sets (the other callers keep today's behavior). Registration: a node in `lib/command-tree-def.ts` `runsSubcommands` (`command-tree-def.ts:55-163`) with `module: "./commands/runs-write.ts"` and flags `--stage`, `--to`, `--reason` (no positional, so no `omitBehavior`), an exported `runsStageRedirect` wrapper beside `runsStageDone` (`runs-write.ts:187`), the `WriteVerb` union (`runs-write.ts:30`), the write-verb header (`runs-write.ts:4-18`), the `runs` usage string (`commands/runs.ts:113`), and the command-surface block of `docs/superpowers/specs/2026-09-01-runs-write-verbs-design.md`. It emits the same best-effort `run-updated` event the other stage verbs emit. `STATUS_ICON` (`commands/runs.ts:45`) gains `redirected: "»"`. `computeAttention` (`lib/runs/attention.ts:69`) keeps treating only `failed` as a reason. `packages/rt-client` keeps `RunStageRow.status: string`; its README gains one sentence under the runs section naming the four stage statuses `running | done | failed | redirected` (no list exists there today). No `lib/module-registry.ts` change: the verb lives in the existing `runs-write` module.

Tests: `lib/runs/__tests__/write.test.ts` ("stage-redirect closes the latest running attempt as redirected with the default reason", "refuses a done attempt", "fails on a never-started stage"), `commands/__tests__/runs-write.test.ts` (JSON envelope, exit codes 2 and 3), `lib/__tests__/command-tree-def.test.ts` (the `stage-redirect` leaf exists with its three flags, so the verb never falls through to the list command), `commands/__tests__/runs.test.ts` (the icon renders, no "?").

The mattstack work engine's Redirect recipe then calls the verb before clearing produces (its follow-ups plan carries the interim sentence until this ships).

## 5. A default for `RT_RUN_DB`

Claude Code runs every Bash call in a fresh shell, so `export RT_RUN_DB` does not persist and agents prefix each verb by hand. `RT_RUN_DB` is read in one place, `withRunDbAsync` (`commands/runs-write.ts:164-177`). `recordIdentity` (`lib/runs/identity.ts:5-19`) already stores `claude-session` from `CLAUDE_CODE_SESSION_ID` at run-start and every stage-start, and `findRunsBySession` (`lib/runs/store.ts:193-216`) already locates runs by it.

Change: when `RT_RUN_DB` is unset, `withRunDbAsync` resolves a default in this order:
1. `CLAUDE_CODE_SESSION_ID` is set and exactly one `running` run carries it as `claude-session`: that run's `state.db`.
2. Otherwise the newest `running` run whose `worktree` field is the current directory or one of its ancestors.
3. Otherwise exit 2 with `RT_RUN_DB is not set and no running run matches this session or directory` plus, when more than one candidate matched step 1 or 2, their run ids, so the caller can export the right one.

`withRunDbAsync` passes `{ db, resolved: "env" | "session" | "worktree" }` to the verb body. Verbs that emit JSON add `"runDbResolved"` only when `resolved` is not `"env"`, so today's envelopes for callers who export the variable stay byte-identical; `field get` prints its raw value as today and never gains the key (its plain-text output is a contract in the runs-write design doc). The resolver lives in a new `lib/runs/resolve-db.ts` so `rt runs find` can share it later; it honors `RT_RUNS_ROOT` and scans every run DB under the root on each call (no cache; prune keeps the set small). `run-start` is unchanged (it creates the DB and prints `runDb`); the engines' `export` lines stay as the contract's markers.

Tests: unit tests for the resolver under a fixture `RT_RUNS_ROOT` (one session match; two session matches; worktree ancestor match; nothing matches; a `done` run is ignored); `commands/__tests__/runs-write.test.ts` gains "field set without RT_RUN_DB resolves by session and reports runDbResolved", "with RT_RUN_DB set the envelope is unchanged", "field get without RT_RUN_DB still prints the raw value", and "fails with exit 2 naming both candidates".

## 6. `{{pack.path:<attachment>/<file>}}`

A fill that names a file in another attachment (a team pack's evidence sub-skill script, read from a stage and from two ship hosts) cannot write `${CLAUDE_SKILL_DIR}/<file>` (that vendors and rewrites to the parts dir) and today escapes the rewrite with the unbraced `$CLAUDE_SKILL_DIR/../../attachments/<name>/<file>`.

Change: the placeholder renders `${CLAUDE_SKILL_DIR}/../../<side>/<attachment>/<file>`, host anchored so it works inside a shell command from any public skill in the pack. Resolution is a disk check, not the compiled-target map: `<attachment>` must be an existing directory under the pack's `attachments/` or `skills/` (that decides `<side>`; both existing is an error naming the ambiguity), `<file>` is one or more segments with no `..`, and `<pack>/<side>/<attachment>/<file>` must exist at compile time, else the compile errors with the missing path. The file must be pack-authored source: an `<attachment>` that names a compiled target (looked up in item 2's side map, which is deterministic) is rejected with `<attachment> is a compiled verb; pack.path names source files only`, since a compiled target's output is written after every target compiles (`skills.ts:778-790`) and would pass the existence check only on a recompile.

Ordering: in all three paths the `${CLAUDE_SKILL_DIR}` rewrite runs before placeholder substitution (step body `compile.ts:309` then `substitute` at 317; inlined fill `compile.ts:352`, `rewriteSkillDirRefs` before `substituteIncludesOnly`; native slot `placeholders.ts:51-52`), so a rendered path is never rewritten; a regression test pins that. `substituteIncludesOnly` (`placeholders.ts:66-75`) admits `pack.path`, so a fill may carry it.

Lint: `substitute` and `substituteIncludesOnly` return the rendered pack paths beside `used`; `buildBody` threads them out; `compileSkill` passes them to `lintReferences` (`compile.ts:551-556`) as exact exempt paths, which skip the "not an emitted file" warning.

Tests: placeholders (renders the anchored path for an attachments-side and a skills-side target; rejects `..`, a missing attachment, a missing file, an ambiguous attachment; allowed in a fill); compile (a fill using the placeholder compiles into a stage and into a public verb with the anchored path intact after the parts rewrite; lint is clean; a reference to a compiled target's output errors).

## 7. Repeatable scopes: no schema change

`decisions` upserts on `(run_id, contract, scope)` (`lib/runs/write.ts:32-35`, `147-165`); a gate that fires several times inside one attempt (watch-ci called once per branch by sync-open-mrs) overwrites its own row. Widening the primary key would be a versioned migration with three duplicated DDL copies to keep in step (`lib/runs/__tests__/fixtures.ts:47`, `prune.test.ts:29, 59`).

Decision: the scope string carries the discriminator; rt changes nothing in the schema. The runs-write header and `docs/superpowers/specs/2026-09-01-runs-write-verbs-design.md` gain one paragraph: scopes are free-form; a gate that can fire more than once per attempt appends a discriminator after the attempt (`ci:<stage>:<attempt>:<branch>`), and `snapshot` returns every row. A test in `write.test.ts` records `ci:sync-open-mrs:1:feature-a` and `ci:sync-open-mrs:1:feature-b` and asserts both rows persist. The mattstack watch-ci engine adds the branch to its `ci` scope when a per-branch caller invokes it (a task added to the engine follow-ups plan).

## What does not change

- No schema version bump; no daemon handler changes; no `rt-client` type changes beyond documentation.
- `rt runs find`, `run-start`, `snapshot` behave as today.
- The Stop hook keeps its own run lookup (session, then mtime).

## Testing and release

- TDD per item: the failing test first, then the change; `bun test lib commands packages scripts` green; `bun run test:all` before the PR is marked ready (CLAUDE.md: e2e runs in CI and the unit script skips it).
- Real-engine proof with the branch's compiler (the dev wrapper runs the shared `main` checkout, so it is not this branch): invoke this worktree's CLI directly, `bun run <this worktree>/cli.ts skills compile --pack mattstack --pack-dir "$PWD" --mattstack-dir "$PWD"` and the matching `check` from the mattstack-skills checkout (the form mattstack's plan 3 release used through the wrapper on 2026-09-02, so both flags accept a mattstack-skills checkout), then `bun run <this worktree>/cli.ts skills check --pack claimview` from the team pack checkout. Expected: the mattstack pack's own compiled verbs report stale wherever an unbound slot heading was dropped (item 3), and the team pack reports the internal verbs (item 1) and the four engines with unbound slot headings (item 3: review, self-review, receive-review, shepherdr) stale, the proof that the compiler output changed where intended; the team pack recompiles in its own release after the merge.
- PR from `rt-followups-181` to `main`; address CodeRabbit findings; CI green; merge on the operator's confirmation; the next `v*` tag ships it.
