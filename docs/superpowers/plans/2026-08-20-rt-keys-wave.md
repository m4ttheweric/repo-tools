# RT Keys Wave Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every remaining rt legacy config file migrates to the settings stores (or dies), the legacy rung is deleted, and `~/.mattstack/rt` becomes runtime-only.

**Architecture:** Per key: port the reader to `getSetting`, port the writer to `setSetting`, flip `migrated: true` (dropping `legacyFile`), test. No transition fallbacks — the orchestrator imports each file's current value into its store BEFORE the daemon restarts on this code (Task 6, live). The resolver is `@mattstack/rt-client`'s settings module behind the `lib/settings/` barrels.

**Tech Stack:** Bun/TypeScript; the RT-47 resolver (`getSetting`/`setSetting`, repo sections by identity).

**Spec:** `docs/superpowers/specs/2026-08-20-suite-settings-migration.md` — "rt key dispositions" table is binding. Survey facts (reader/writer file:line) below are from the 2026-08-20 resolver survey; line numbers may have drifted ±20 — locate by symbol.

## Global Constraints

- Worktree `/Users/matt/Documents/GitHub/repo-tools-rt50b-wt`, branch `goodwinmattheweric/rt-50-keys-wave`. Never touch the main checkout or the live `~/.mattstack` (Task 6 is orchestrator-only).
- The migration order per key is atomic: reader port + writer port + `migrated: true` flip (remove `legacyFile` from the row) + registry-test updates land in ONE commit per task.
- Repo-scoped reads pass `repoIdentity` (derive via `deriveRepoIdentity`) — repo NAME conventions die with the files.
- Readers keep their sanitizers/computed defaults local (the `rt.worktrees` pattern: resolver for values, validation in the reader).
- Deep-merge caution: the resolver deep-merges `type: "object"` keys across scopes; single-scope keys behave as replace.
- Strict TDD; tests never touch real HOME (preload repoint stands). Comments constraint-only, no ticket/task refs. Tree/registry pairs for any new module. No monitor exists — run tests yourself, never wait.
- Gates every task: `bun x tsc --noEmit` 0; `bun run test:all`-scope unit dirs (`bun test lib commands packages`) green.
- Commit trailer: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

### Task 1: The five global singletons

**Files (per survey):**
- `rt.notifications`: `lib/notifier.ts` — `PREFS_PATH` (:83), `loadNotificationPrefs()` (:117, bare JSON.parse → all-true defaults from `NOTIFICATION_TYPES`), `saveNotificationPrefs` (:128); writer `commands/settings.ts:243` (`configureNotifications`). Scope: user. Reader becomes `getSetting<Record<string,boolean>>("rt.notifications")` merged over the same defaults; save becomes `setSetting(..., "user")`. `notify()` re-reads per call — live propagation preserved by the resolver's unmemoized reads.
- `rt.cron`: `lib/daemon/cron.ts` — `loadCronConfig` (:60), `parseCronConfig` (:36, strict per-field validation KEPT — it now validates the resolved value instead of file text; adjust its input to accept a parsed object, keeping the throw-per-field behavior). Sole reader `lib/daemon.ts:135` at boot. Scope: machine. `rt settings set rt.cron` already prints nothing special — add the daemon-restart hint to the row's description.
- `rt.repoTracking`: `lib/repo-tracking.ts` — `loadRepoTracking` (:59), `saveRepoTracking` (:91), `normalizeEntry` (:35, KEPT — normalizes legacy flat entries in the resolved value), v2 shape. Readers (all per-tick, all stay signature-compatible): `lib/daemon/cache-refresh.ts:69`, `lib/daemon/freshness.ts:434,564,653,744`, `lib/daemon/project-sync.ts:147,324`, `lib/daemon/discussions-poller.ts:99`, `lib/daemon/handlers/{project-mrs.ts:72,secrets.ts,discussions.ts:49}` (preserve the injectable `overrides.tracking` seams). Writer `commands/daemon.ts:478` (`rt daemon track`) → `setSetting(..., "machine")`. Scope: machine. (Team `mattstack.tracking` intent merge is Task 3.)
- `rt.runaway`: reader `lib/daemon/system-process-scanner.ts:91`; writer `commands/settings.ts:304` (`configureRunaway`, direct writeFileSync → setSetting machine). Keep the "restart daemon to apply" print.
- `rt.workspacePrefs`: `commands/code.ts` — `PREFS_PATH` (:21), `loadPrefs` (:28, tolerates legacy `entries` alias — keep), `savePrefs` (:40). Consumer `rt nav` via `openDirectoryInEditor`. Scope: machine.
- Registry: flip all five rows `migrated: true`, drop `legacyFile` + `siblingCommand` labeling changes; update `registry.test.ts` enumerations (migrated set 5→10; the "genuinely global legacy keys" list shrinks) and `commands/__tests__/settings-keys-render.test.ts:31` (hardcodes `rt.llm` — retarget to a surviving migrated:false key, e.g. `rt.hooks`).

**Interfaces:** every public loader/saver keeps its exact signature (sync loaders may stay sync ONLY if the resolver read is sync — `getSetting` IS sync per the resolver design; verify and keep sync).

- [ ] **Step 1:** RED tests per key: a store-seeded value resolves through the ported loader; the ported saver lands in the right scope file; defaults on empty store match today's.
- [ ] **Step 2:** run, fail. **Step 3:** port all five (same shape each). **Step 4:** green + tsc 0 + full unit gate. **Step 5:** commit `RT-50: five global singletons read the stores`.

---

### Task 2: The per-repo four + branchNaming flip

**Files (per survey):**
- `rt.sync`: `lib/sync-config.ts` — `loadSyncConfig(dataDir)` (:51) — NOTE the dataDir param dies; new signature `loadSyncConfig(repoIdentity: string | null)` reading `getSetting("rt.sync", { repoIdentity })`; shape `{autoResolve:[...]}` + `matchRule` kept. Callers updated: `lib/worktree/dispose.ts:86`, `commands/git/rebase.ts:246`, `commands/sync.ts:161` (each already knows its repo; derive identity there). `saveSyncConfig` has no production caller — delete it + its `lib/__tests__/repo-layout.test.ts` usage (that test's per-repo-layout guard shrinks to doppler…which also dies this task: rewrite the test to cover what remains or delete it if empty — report which).
- `rt.variations`: `lib/variations.ts` — `loadVariations(dataDir)` (:47) → identity-based resolver read; `saveVariation` (:68) → `setSetting` team.repo... **scope decision is ruled: team.repo** — but `saveVariation` writes at runtime from `rt run` interactive flows; setSetting to TEAM prints the "local only until you commit and push" reminder — acceptable (solo). Reader `commands/run.ts:479` + `variationKey` unchanged.
- `rt.presets`: `lib/run-presets.ts` — dir-of-files dies; SHAPE CHANGE to `{ "<name>": { entries: [...] } }` under `rt.presets` user.repo. `loadPresets`/`findPreset`/`savePreset` keep signatures, backed by the object. Reader/writer `commands/run.ts:201-204`.
- `rt.dopplerTemplate`: `lib/doppler-template.ts` — `loadTemplate(repoName)` (:33) → `loadTemplate(repoIdentity)` reading the key (shape: the YAML array becomes the same array as JSON); `templatePath` existence check in `lib/daemon/doppler-sync.ts:32` becomes a resolver-presence check ("no-template" opt-out preserved; use value-undefined, not explainSetting). `saveTemplate`/`captureFromActualConfig` have zero production callers — DELETE both + their test usages (`lib/__tests__/doppler-template.test.ts` slims to loadTemplate-over-resolver; `lib/daemon/__tests__/doppler-sync.test.ts:10` re-seeds via store writes). `reconcileForRepo`'s two callers (`lib/worktree/create.ts:140`, `lib/daemon/cache-refresh.ts:200-206`) pass identity — they have repo path/name; derive.
- `rt.branchNaming`: no rt reader exists. Flip `migrated: true`, drop legacyFile; the on-disk files stay (VS Code ext). Nothing else.
- Registry/test updates as in Task 1 (migrated set 10→15).

- [ ] Steps: RED per key (store-seeded repo-section value resolves; presets shape round-trips; doppler reconciler opts out on absent key) → implement → green + gates → commit `RT-50: per-repo keys read the stores; presets reshape; doppler template is a key`.

---

### Task 3: Team tracking intent (`mattstack.tracking`)

**Files:** `lib/repo-tracking.ts` (merge layer), `lib/daemon/__tests__/repo-tracking.test.ts`.
Per the spec's installer table: team key is IDENTITY-keyed declared intent `{repos: {"<identity>": {caches:[...]}}}`; machine `rt.repoTracking` stays NAME-keyed grants; the daemon merges with machine winning per-repo. Implementation: `loadRepoTracking()` grows an optional identity→name resolution seam (injectable map derived from the repo index — `~/.mattstack/rt/repos.json` names + each repo's derived identity; build the map via `deriveRepoIdentity` per known repo, memoized). Merge: team intent entries whose identity resolves to a locally-known name are folded in as `{mode:"live", caches}` unless the machine key names that repo (machine wins entirely per-repo). Unresolvable identities are ignored silently (repo not cloned here — the installer's fresh-machine case works the day the clone lands).

- [ ] Steps: RED (team intent for a cloned repo appears; machine override wins; uncloned identity ignored) → implement → green + gates → commit `RT-50: team tracking intent merges under machine grants`.

---

### Task 4: The deletions

**Files (per survey + spec):**
- `lib/llm.ts` (whole file), `rt settings llm` verb (`commands/settings.ts:681` `configureLlm` + tree subcommand), `lib/__tests__/llm.test.ts`, registry row `rt.llm` (+ enumeration updates). llm.json handling gone.
- `lib/repo-config.ts` (dead: zero callers) + the `lib/repo.ts:18-20` re-export + the wizard. Any test files exercising them.
- **The legacy rung**: `packages/rt-client/src/settings/resolve.ts` lines ~156-196 (`LegacyReader`, `LEGACY_KEY_MAP`, `legacyFilePath`, `defaultLegacyReader`, `setLegacyReader`), the `collectSlots` legacy slot (~:328-339), `"legacy"` out of the `Scope` union + `SCOPE_ORDER`, `legacy?` out of `ResolveOpts`; caller opts deleted at `lib/endpoint/config.ts:272` (+ header note), `lib/worktree/config.ts:122` (+ header), `commands/settings-keys.ts:85,117,168,318,362`; the per-repo `config.json` mtime probe in `lib/endpoint/shim.ts:177-181` (store paths remain). Tests: delete the `describe("legacy layer")` block in the moved resolve.test.ts (~:573-632) and edit the woven assertions the survey enumerated (scope-precedence layer enum, the spec-proof deep-merge case rebuilt on team/user/machine only, explain-ordering rows, e2e/tests/settings.test.ts's legacy fixture + assertions).
- Registry hygiene: every `migrated: true` row has no `legacyFile`; the `repoScoped↔legacyFile` consistency test updates; `rt.hooks` remains the only `migrated: false` row (deferred by ruling) — the write-refusal tests retarget to it.
- `lib/rt-paths.ts` `repoDataDir` STAYS (runtime files still live there).

- [ ] Steps: delete → update tests per the enumerated list → tsc 0 + full unit gate + e2e settings suite green (fresh dist/rt) → commit `RT-50: legacy rung, llm chain, and repo-config die`.

---

### Task 5: Wave gates + docs

- [ ] `bun x tsc --noEmit` 0; `bun test lib commands packages` green; `rm -f dist/rt` + full e2e green; `bun scripts/check-docs.ts` clean.
- [ ] Grep live docs (README, website/docs excluding reference/, docs/ excluding superpowers/+dated) for `llm.json`, `cron.jsonc`, `notifications.json`, `repo-tracking.json`, `rt settings llm`, per-repo `config.json` — fix every live-doc hit; regenerate reference docs (the `settings llm` page dies).
- [ ] Commit `RT-50: keys-wave docs + gates`.

---

### Task 6 (ORCHESTRATOR-ONLY, live machine): the cutover

1. From the worktree, import current values into stores (script piping file contents → `rt settings set <key> --scope <scope> [--repo assured-dev]`): notifications→user, cron→machine (the `triggers` object as stored today), **repo-tracking→machine UNWRAPPED — store the inner `repos` map only, NOT the `{version:2, repos:{...}}` envelope** (the ported loader takes the flat map; the envelope reads as nothing-tracked), runaway→machine (if file exists), workspace-prefs→machine, sync/variations/doppler-template(YAML→JSON)/branch-naming→team.repo per the table for assured-dev, **presets→user.repo as ONE `rt.presets` object: key = filename minus `.json` (names keep their spaces/parens), value = the file's `{entries}`** — both preset files under `repos/assured-dev/presets/` fold in before step 3 deletes the directory.
2. Merge the branch (PR, Matt's checkpoint), pull main, `rt daemon restart`.
3. Delete the migrated files + cruft: `~/.mattstack/rt/{cron.jsonc,llm.json,notifications.json,repo-tracking.json,workspace-prefs.json,runaway-config.json}` (if present), `repos/assured-dev/{config.json,sync.json,variations.json,doppler-template.yaml,agent-tasks/}`, `repos/assured-dev/presets/`, `repos/origin/` (path-bug artifact), `repos/*/agent-tasks/`. KEEP: `branch-naming.json` (ext), `hooks.json`+`hooks/` (deferred), `endpoints.json`, `worktrees.json`, `run-history.jsonl`, `panel-columns.json`, `logdy-pino-columns.json`, `secrets.json` (board-lane blocker).
4. Verify: `rt verify` green; `rt settings list` shows the migrated values with provenance; daemon logs clean; `rt run` picker still sees variations/presets for assured-dev; cron trigger fires on next event or at least loads (`RT_LOG_LEVEL=debug` daemon boot line).
