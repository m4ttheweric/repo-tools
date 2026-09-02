# rt follow-ups for the mattstack pipeline gates (issue 181)

**Status:** draft for review. **Tracks:** https://github.com/m4ttstack/rt/issues/181. **Source:** compiled read-throughs of a team pack on mattstack 0.12.0 and the plan 3 review (mattstack-skills `docs/superpowers/specs/2026-09-02-engine-followups-design.md`, section "rt follow-ups"). Line numbers below are from `main` at 66acbedf.

Seven items: four in `rt skills compile` (1, 2, 3, 6), three in `rt runs` (4, 5, 7). None changes a schema. One PR on branch `rt-followups-181`, released with the next `v*` tag; the dev wrapper on this machine runs `main`, so merging is the local install.

## 1. Skill-dir rewrite for every attachments-side output

Today `commands/skills.ts:588` sets `opts.stageDir` only for pipeline stages, so a stage's fills and includes get `${CLAUDE_SKILL_DIR}/../../attachments/<stage>/parts/...` while an internal (attachments-side) verb such as `receive-review` gets `${CLAUDE_SKILL_DIR}/parts/...` (`lib/skills/placeholders.ts:41-44`, `lib/skills/compile.ts:515`). An internal verb is never invoked by name; a public skill in the pack reads it, so `${CLAUDE_SKILL_DIR}` is that reader's directory and `${CLAUDE_SKILL_DIR}/parts/...` resolves nowhere.

Change: every target compiled to the attachments side (stages and internal verbs alike) gets the host-relative directory `${CLAUDE_SKILL_DIR}/../../attachments/<name>` as its `stageDir` (the option keeps its name; its meaning is "the directory a pack-side reader reaches this file at"), so `partsPrefix` and the step-body rewrite produce `${CLAUDE_SKILL_DIR}/../../attachments/<name>/parts/...`. Public verbs keep `${CLAUDE_SKILL_DIR}`. `commands/skills.ts` derives the value from the target's side, the same way `buildStageEntries` (`lib/skills/layout.ts:47`) already does for stages.

Known limit, documented in the compiler's README: a reader outside the pack (another plugin's skill) cannot resolve `${CLAUDE_SKILL_DIR}/../../...`; pack text that is read from outside must name files "relative to this file".

Tests: `lib/skills/__tests__/placeholders.test.ts` gains "an internal verb's include files are rewritten under the attachments-side host dir"; `lib/skills/__tests__/compile.test.ts` gains a compile of an internal verb with a vendoring include asserting the emitted path prefix; the existing stage test keeps passing unchanged.

## 2. `{{verb.path:<name>}}`

Engines name sibling verbs as `mattstack:checkout` and the like, which are not registered skills. The new placeholder renders the path from the current output file's directory to the named verb's `SKILL.md`: `../<name>/SKILL.md` when both are on the same side, `../../skills/<name>/SKILL.md` or `../../attachments/<name>/SKILL.md` across sides. It is a reading path ("relative to this file"), never a shell path.

Mechanics: `compileTargets()` (`commands/skills.ts:674-710`) already computes `isPublic` for every roster verb and stage; it passes a `verbSides: Record<string, "skills" | "attachments">` through `compileVerb` to `compileSkill` and into `PlaceholderContext` (`lib/skills/types.ts:39-52`), along with the current target's own side. `substitute()` (`lib/skills/placeholders.ts:127-154`) gains `case "verb.path"` next to `run-start.flags`: the argument must match `[a-z][a-z0-9-]*`; an unknown name throws `<where>: {{verb.path:<name>}} -- <name> is not a compiled verb of this pack`. `lintReferences` accepts the rendered relative path because the target directory is among `emittedTargetDirs` (`compile.ts:124-131`).

Tests: placeholders (same side, cross side both directions, unknown name, bad argument); compile (a roster verb whose body carries the placeholder compiles to the right relative path and lints clean).

## 3. Drop a heading that precedes an empty slot

`slotText` returns "" for an unbound slot (`placeholders.ts:47`), leaving a `## Reviewer` or `## Domain rules` heading with nothing under it. `substitute()` is line based (`placeholders.ts:119-156`) with the whole `lines` array in scope.

Change: while mapping lines, a heading line (`^#{1,6}\s`) whose next non-blank line is exactly a `{{slot:<name>}}` placeholder with `fills[<name>] === null` is dropped together with the blank lines between them; the slot line still renders "" as today, so the output keeps at most one blank line where the block was. Headings followed by a bound slot, by any other placeholder, or by prose are untouched.

Tests: placeholders gains "a heading above an unbound slot is dropped", "a heading above a bound slot stays", "a heading above prose stays", and the existing "unbound optional slot substitutes empty" keeps passing.

## 4. `rt runs stage-redirect`

The work engine's Redirect leaves the stage it leaves as `running` (`stages.status` is free text, `lib/runs/write.ts:23-27`; `stageEnd` accepts only `"done" | "failed"`, `write.ts:116`; `stage-done` and `stage-fail` take no `--status` flag, `commands/runs-write.ts:107-118`).

Change: a new write verb `rt runs stage-redirect --stage <from> --to <to> [--reason <text>]`. It calls `stageEnd(db, from, "redirected", { reason: reason ?? "redirected to <to>" })` on the latest attempt of `<from>`; exit 3 when that stage never started (the existing zero-row guard), exit 2 on a missing flag. `stageEnd`'s status union widens to `"done" | "failed" | "redirected"`. The verb is listed in the `runs` usage string (`commands/runs.ts:113`) and the write-verb header (`runs-write.ts:4-18`), joins `WriteVerb` (`runs-write.ts:30`), and emits the same best-effort `run-updated` event the other stage verbs emit. `STATUS_ICON` (`commands/runs.ts:45`) gains `redirected: "»"`. `computeAttention` (`lib/runs/attention.ts:69`) keeps treating only `failed` as a reason; a redirected row is neither failure nor work in progress. `packages/rt-client` keeps `RunStageRow.status: string`; its README lists the new value. No `lib/module-registry.ts` change: the verb lives inside the existing `runs-write` module.

Tests: `lib/runs/__tests__/write.test.ts` ("stage-redirect closes the latest attempt as redirected with the default reason", "on a never-started stage it fails"), `commands/__tests__/runs-write.test.ts` (JSON envelope, exit codes 2 and 3), `commands/__tests__/runs.test.ts` (the icon renders, no "?").

The mattstack work engine's Redirect recipe then calls the verb before clearing produces (its follow-ups plan carries the interim sentence until this ships).

## 5. A default for `RT_RUN_DB`

Claude Code runs every Bash call in a fresh shell, so `export RT_RUN_DB` does not persist and agents prefix each verb by hand. `RT_RUN_DB` is read in one place, `withRunDbAsync` (`commands/runs-write.ts:164-177`). `recordIdentity` (`lib/runs/identity.ts:5-19`) already stores `claude-session` from `CLAUDE_CODE_SESSION_ID` at run-start and every stage-start, and `findRunsBySession` (`lib/runs/store.ts:193-216`) already locates runs by it.

Change: when `RT_RUN_DB` is unset, `withRunDbAsync` resolves a default in this order and says which it used in the JSON envelope (`"runDbResolved": "env" | "session" | "worktree"`):
1. `CLAUDE_CODE_SESSION_ID` is set and exactly one `running` run carries it as `claude-session`: that run's `state.db`.
2. Otherwise the newest `running` run whose `worktree` field is the current directory or one of its ancestors.
3. Otherwise exit 2 with `RT_RUN_DB is not set and no running run matches this session or directory` plus, when more than one candidate matched step 1 or 2, their run ids, so the caller can export the right one.

`run-start` is unchanged (it creates the DB and prints `runDb`); the engines' `export` lines stay as the contract's markers. A new `lib/runs/resolve-db.ts` holds the resolution so `rt runs find` can share it later. `RT_RUNS_ROOT` is honored as everywhere else.

Tests: unit tests for the resolver under a fixture `RT_RUNS_ROOT` (one session match; two session matches; worktree ancestor match; nothing matches; a `done` run is ignored); `commands/__tests__/runs-write.test.ts` gains "field set without RT_RUN_DB resolves by session" and "fails with exit 2 naming both candidates".

## 6. `{{pack.path:<attachment>/<file>}}`

A fill that names a file in another attachment (the pack's evidence sub-skill script, read from a stage and from two ship hosts) cannot write `${CLAUDE_SKILL_DIR}/<file>` (that vendors and rewrites to the parts dir) and today escapes the rewrite with the unbraced `$CLAUDE_SKILL_DIR/../../attachments/<name>/<file>`.

Change: the placeholder renders `${CLAUDE_SKILL_DIR}/../../<side>/<attachment>/<file>`, host anchored so it works inside a shell command from any public skill in the pack. The argument is `<attachment>/<file>` (one or more path segments after the attachment name; no `..`); the attachment must be a directory under the pack's `attachments/` or `skills/` (side resolved as in item 2), and the file must exist there at compile time, else the compile errors with the missing path. Because the compiler rewrites every braced `${CLAUDE_SKILL_DIR}` in fill text to the parts prefix (`compile.ts:174`), the placeholder renders a private sentinel during substitution and the final assembly replaces the sentinel after all rewrites. `lintReferences` treats the rendered path as satisfied (the file was checked at compile time); `bodyPaths` classifies it as `token` but `lintReferences` skips the "not an emitted file" warning for paths the compile itself produced.

Tests: placeholders (renders the anchored path; rejects `..` and a missing attachment); compile (a fill using the placeholder compiles into a stage and into a public verb with the anchored path intact after the parts rewrite; a missing file errors; lint is clean).

## 7. Repeatable scopes: no schema change

`decisions` upserts on `(run_id, contract, scope)` (`lib/runs/write.ts:32-35`, `147-165`); a gate that fires several times inside one attempt (watch-ci called once per branch by sync-open-mrs) overwrites its own row. Widening the primary key would be a versioned migration with three duplicated DDL copies to keep in step (`lib/runs/__tests__/fixtures.ts:47`, `prune.test.ts:29, 59`).

Decision: the scope string carries the discriminator; rt changes nothing in the schema. The runs-write header and `docs/superpowers/specs/2026-09-01-runs-write-verbs-design.md` gain one paragraph: scopes are free-form; a gate that can fire more than once per attempt appends a discriminator after the attempt (`ci:<stage>:<attempt>:<branch>`), and `snapshot` returns every row. A test in `write.test.ts` records `ci:sync-open-mrs:1:feature-a` and `ci:sync-open-mrs:1:feature-b` and asserts both rows persist. The mattstack watch-ci engine adds the branch to its `ci` scope when a per-branch caller invokes it (a task added to the engine follow-ups plan).

## What does not change

- No schema version bump; no daemon handler changes; no `rt-client` type changes beyond documentation.
- `rt runs find`, `run-start`, `snapshot` behave as today.
- The Stop hook keeps its own run lookup (session, then mtime).

## Testing and release

- TDD per item: the failing test first, then the change; `bun test lib commands packages scripts` green; `bun run test:all` before the PR is marked ready (CLAUDE.md: e2e runs in CI and the unit script skips it).
- Compile the mattstack pack and a team pack against the branch (`rt skills compile --pack mattstack --pack-dir <mattstack checkout> --mattstack-dir <mattstack checkout>`, then `check`) to prove items 1 to 3 and 6 on real engines; the team pack's `check` after item 1 shows the two internal verbs stale (their include paths changed), which is the expected proof.
- PR from `rt-followups-181` to `main`; address CodeRabbit findings; CI green; merge on the operator's confirmation; the next `v*` tag ships it.
