# rt settings resolver Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One resolver over four settings stores (user/team/machine/legacy+defaults) with a schema registry, `rt settings` verbs, and two consumers (endpoint config, worktree config) migrated end to end.

**Architecture:** New `lib/settings/` package: stores (jsonc-parser reads/writes), registry (SettingDef table), identity (async memoized remote derivation), resolve (8-scope overlay with per-key merge, teamLocked, variables, Provenance[]). Consumers keep signatures where possible; legacy per-repo config.json slots in above defaults. The intercept rules file remains the one deliberate cache with a staleness probe.

**Tech Stack:** Bun + TypeScript, bun:test, `jsonc-parser` (one new dependency). Working tree: `/Users/matt/Documents/GitHub/repo-tools-settings-wt` (git worktree, branch `goodwinmattheweric/rt-47-settings-resolver-four-files-one-namespace`). All commands run THERE, never in the main checkout.

**Spec:** `docs/superpowers/specs/2026-08-20-rt-settings-resolver-design.md` — the binding authority; every task implements named spec sections. Read it before your task.

## Global Constraints

- All work in `/Users/matt/Documents/GitHub/repo-tools-settings-wt` on the existing branch. Never touch `~/Documents/GitHub/repo-tools` (another session's territory) or any `~/.mattstack` live state.
- New CLI modules need BOTH `lib/module-registry.ts` edits; `bun run docs:gen` after tree changes; `lib/__tests__/module-registry.test.ts` and the rt-paths source guard must stay green.
- Never sync-exec anywhere reachable from the daemon thread; identity derivation is async + memoized.
- No new outcome logging in handlers; domain events only.
- JSONC comments survive every programmatic write (jsonc-parser modify/applyEdits; never JSON.stringify a store file).
- Unknown keys: hard error on explicit get/set; warn+skip+label when found in files. Type-mismatched values in files: warn+skip that scope.
- Unit tests run under the bunfig HOME-isolation preload; store paths resolve inside the temp HOME via the new rt-paths constructors. EVERY suite that seeds store files re-points HOME per test (mkdtempSync in beforeEach) — store files are process-global state.
- Precedence (weakest→strongest): `default < legacy < team < user < team.repos < user.repos < machine < machine.repos`; per-key `merge: "replace"|"deep"`; deep = field-by-field overlay, arrays replace atomically; teamLocked keys resolve `team.repos > team > default` only, everything else shadowed.
- Variables: expand ONLY `${repoRoot}`, `${worktree}`, `${home}`, `${team:<name>}` (lexical, no existence check); all other `${...}` pass through verbatim; closed-set variable without context = loud error.
- Commit format `RT-47: <lowercase imperative>` + trailer `Co-Authored-By: Claude <noreply@anthropic.com>`.

---

### Task 1: store paths, jsonc-parser, store reader

**Files:**
- Modify: `lib/rt-paths.ts` (three constructors), `package.json` (+jsonc-parser)
- Create: `lib/settings/stores.ts`
- Test: `lib/settings/__tests__/stores.test.ts`

**Interfaces:**
- Produces:

```ts
// rt-paths.ts additions (call-time HOME like everything else there)
export function userSettingsPath(): string;          // ~/.mattstack/user/settings.jsonc
export function teamSettingsPath(team: string): string; // ~/.mattstack/teams/<team>/mattstack/settings.jsonc
export function machineSettingsPath(): string;       // ~/.mattstack/settings.local.jsonc
export function teamsDir(): string;                  // ~/.mattstack/teams
// stores.ts
export interface StoreFile { global: Record<string, unknown>; repos: Record<string, Record<string, unknown>>; file: string; exists: boolean }
export function readStore(file: string): StoreFile;  // jsonc-parser parse; "repos" key split out; malformed file → exists:true, empty maps, one warn
export function listTeams(): string[];               // subdirs of teamsDir() containing mattstack/settings.jsonc
```

- [ ] **Step 1: failing tests** — write `stores.test.ts`: reads a JSONC file with comments + `repos` section into `{global, repos}`; missing file → `exists:false` empty maps; malformed JSONC → empty maps + `exists:true` (capture the warn via a spy or accept stderr); `listTeams` finds only teams with a settings file. Write fixture files under the temp HOME using the rt-paths constructors.
- [ ] **Step 2: run, verify FAIL** (`bun test lib/settings/`).
- [ ] **Step 3: implement** — `bun add jsonc-parser`; rt-paths constructors with doc comments; stores.ts using `parse` from jsonc-parser (collect parse errors → treat as malformed).
- [ ] **Step 4: run tests + `bun test lib/__tests__/rt-paths.test.ts` + `bunx tsc --noEmit`** — all green.
- [ ] **Step 5: commit** `RT-47: settings store paths and jsonc store reader`.

---

### Task 2: schema registry

**Files:**
- Create: `lib/settings/registry.ts`
- Test: `lib/settings/__tests__/registry.test.ts`

**Interfaces:**
- Produces (spec "Schema registry" section verbatim):

```ts
export type SettingScope = "user" | "team" | "machine";
export interface SettingDef { key: string; type: "string"|"number"|"boolean"|"object"|"array"; scopes: SettingScope[]; default?: unknown; merge: "replace"|"deep"; teamLocked?: boolean; secret?: boolean; repoScoped?: boolean; migrated: boolean; legacyFile?: string; siblingCommand?: string; pathGuardFields?: string[]; description: string }
export function getDef(key: string): SettingDef | undefined;
export function allDefs(): SettingDef[];
export function validateValue(def: SettingDef, value: unknown): { ok: true } | { ok: false; reason: string };
```

Registry contents (every def carries `scopes`; repoScoped keys allow all three, `rt.repoIdentityOverrides` machine-only; `rt.worktrees` registry default = `{ onDeck: 0 }` with root/branchFormat/ready computed-or-empty in the reader): `rt.roles` (object, deep, repoScoped, migrated:true, pathGuardFields ["hook"]), `rt.intercepts` (array, replace, repoScoped, migrated:true), `rt.worktrees` (object, deep, repoScoped, migrated:true, note: `root` default computed in reader), `rt.repoIdentityOverrides` (object, replace, machine-only, migrated:true), plus the 14 `migrated:false` entries from the spec with `legacyFile` values from the trace (`rt.llm`→`llm.json`, `rt.cron`→`cron.jsonc`, `rt.repoTracking`→`repo-tracking.json`, `rt.notifications`→`notifications.json` + siblingCommand `rt settings notifications`, `rt.mr`→`repos/<repo>/mr.json`, `rt.sync`, `rt.branchNaming`, `rt.variations`, `rt.presets`, `rt.workspaceSync`, `rt.dopplerTemplate`, `rt.workspacePrefs`, `rt.runaway` + siblingCommand `rt settings runaway`, `rt.hooks`).

- [ ] **Step 1: failing tests** — getDef known/unknown; validateValue per type incl. object/array mismatch; every def has description + legacyFile when migrated:false; exactly 4 migrated:true keys.
- [ ] **Step 2: FAIL. Step 3: implement (a static table + helpers). Step 4: green + tsc. Step 5: commit** `RT-47: settings schema registry, wave-1 defs`.

---

### Task 3: identity derivation

**Files:**
- Create: `lib/settings/identity.ts`
- Test: `lib/settings/__tests__/identity.test.ts`

**Interfaces:**

```ts
export function normalizeRemote(remote: string): string | null;   // spec "Repo identity": https/ssh/git@ unify; lowercase host; strip .git, credentials; local paths & unrecognized → null
export function identityFromRemote(remote: string): string | null;  // SYNC: machine-store overrides (readStore) then normalizeRemote — THE one helper every non-derive site uses (run.ts, buildInterceptRules, tests); fork-pinning works everywhere or nowhere
export async function deriveRepoIdentity(repoPath: string): Promise<string | null>;  // git config --get remote.origin.url via async Bun.spawn; memoized per path; null on failure; consults the machine store's rt.repoIdentityOverrides (via stores.ts readStore, keyed by observed remote) BEFORE normalizeRemote — the wiring that makes the overrides key real (test: override maps an unrecognized local-path remote to a chosen identity)
export function clearIdentityMemo(): void; // tests
```

- [ ] **Step 1: failing tests** — normalizeRemote table: `https://gitlab.com/assured/assured-dev.git` → `gitlab.com/assured/assured-dev`; `git@gitlab.com:assured/assured-dev.git` → same; `ssh://git@github.com/m4ttstack/rt` → `github.com/m4ttstack/rt`; `https://user:pass@host/x/y` → `host/x/y`; `/private/tmp/foo` → null; `HTTPS://GitLab.com/A/B` → `gitlab.com/A/B` (host lowercased, path case preserved). Overrides: exact remote match wins. deriveRepoIdentity: real `git init` + `git remote add origin <url>` in temp dir → derives; dir with no remote → null; memoization: second call after remote change still returns memoized value (documented behavior).
- [ ] **Step 2: FAIL. Step 3: implement. Step 4: green + tsc. Step 5: commit** `RT-47: repo identity normalization and async derivation`.

---

### Task 4: the resolver (read side)

**Files:**
- Create: `lib/settings/resolve.ts` (getSetting/listSettings/explainSetting + variables)
- Test: `lib/settings/__tests__/resolve.test.ts`

**Interfaces:** the spec's Resolver block verbatim, with `provenance: Provenance[]` (weakest-first) and `legacy` supplied by an injectable hook:

```ts
export interface LegacyReader { (key: string, repoName: string): unknown | undefined }
export function setLegacyReader(fn: LegacyReader): void;  // TEST SEAM ONLY. The DEFAULT reader ships in this task (reads repos/<name>/config.json, key map { "rt.roles":"roles", "rt.intercepts":"intercepts", "rt.worktrees":"worktrees" }); Task 4's tests need no stub — write legacy fixture files instead.
export function expandVariables(value: unknown, ctx: { repoRoot?: string; worktree?: string; home: string; teamsDir: string }): unknown; // recursive over strings in objects/arrays; closed set only
// Team-store selection, wave 1: overlay ALL teams from listTeams() in alphabetical order (deterministic); multi-team precedence is explicitly deferred (spec Out of scope) — one team exists today.
```

- [ ] **Step 1: failing tests** — the heart. TEST HYGIENE: every settings test re-points HOME per test (mkdtempSync in beforeEach, restore after — the lib/worktree config.test.ts pattern), because store files are process-global state under the shared preload HOME. Cover at minimum:
  - replace-key precedence across all 8 scopes (build fixture stores in temp HOME; assert winner + full Provenance[] chain)
  - deep-merge proof case from the spec: team `{onDeck:3, ready:[a,b]}`, user `{namePool:[...]}`, legacy `{onDeck:1, root:"x", branchFormat:"y", namePool:[old]}` → merged `{onDeck:3 (team), ready (team), namePool (user), root+branchFormat (legacy)}`, provenance lists every contributor weakest-first
  - array-inside-deep replaces atomically (ready from team fully replaces legacy's)
  - teamLocked: user+machine values present but team wins; explain marks them `shadowed: "teamLocked"`
  - unknown key get → throws; unregistered key in file → skipped + `listSettings` labels `unregistered`; type-mismatch value in one store → that scope skipped + labeled `invalid`, weaker scopes still apply
  - variables: `${team:claimview}` and `${home}` expand; `${port}` passes through in the SAME string as an expanded var; `${repoRoot}` without ctx throws; `expand:false` returns raw
  - repoScoped key with `repoIdentity: null` → repo sections skipped, global scopes apply
- [ ] **Step 2: FAIL. Step 3: implement. Step 4: green + tsc. Step 5: commit** `RT-47: resolver — 8-scope overlay, per-key merge, teamLocked, variables, provenance`.

---

### Task 5: the write path

**Files:**
- Create: `lib/settings/write.ts` (setSetting)
- Test: `lib/settings/__tests__/write.test.ts`

**Interfaces:** spec Resolver block: `setSetting(key, value, scope, opts?)` — refusals: disallowed scope, missing team store, unregistered key, migrated:false (message names legacyFile + siblingCommand), and the path-literal guard: defs may declare `pathGuardFields: string[]` (registry Task 2 sets `["hook"]` on rt.roles); a user/team-scope write whose value contains such a field starting with `/` or `~` is refused with a hint to use `${team:...}`/`${repoRoot}` (machine scope exempt). jsonc-parser `modify`+`applyEdits`, JSONPath `["repos", identity, key]` for repoScoped, `[key]` global. Team writes print the commit+push reminder to stderr.

- [ ] **Step 1: failing tests** — write to user store creates the file when absent by seeding `// header...\n{}\n` FIRST and then modifying (verified spike: jsonc-parser modify on a comment-only file emits the header after the closing brace — always seed with an empty object present); write preserves an existing comment adjacent to an untouched key (assert the comment LINE survives, not surrounding bytes — neighbors re-flow); repoScoped write creates the nested repos section (missing-parent creation is comment-safe, verified); each refusal case incl. the pathGuardFields hook refusal; team write on missing team store refuses.
- [ ] **Step 2: FAIL. Step 3: implement. Step 4: green + tsc. Step 5: commit** `RT-47: setSetting — comment-preserving writes with refusal rules`.

---

### Task 6: CLI verbs + daemon read handlers

**Files:**
- Create: `commands/settings-keys.ts` (the four verbs; separate module from commands/settings.ts to keep that file's existing leaves untouched)
- Modify: `lib/command-tree-def.ts` (get/set/list/explain leaves under the existing `settings` family), `lib/module-registry.ts` (BOTH edits), `lib/daemon/command-router.ts` + Create `lib/daemon/handlers/settings.ts` (`settings:get`, `settings:list`, HandlerMap, read-only; handlers call the resolver with `expand:false` — no repo context exists to expand against, raw values + provenance are the honest daemon answer)
- Test: `lib/daemon/__tests__/settings-handlers.test.ts`; CLI covered via e2e (Task 9)
- Regenerate docs (`bun run docs:gen`)

**Interfaces:** `rt settings get <key> [--repo <name>] [--json]`, `set <key> <json-value> --scope user|team|machine [--repo <name>]`, `list [--repo <name>] [--json]`, `explain <key> [--repo <name>]`. `--repo` resolves name→path via the repo index, derives identity (async), and feeds `legacy.repoName`.

- [ ] **Step 1: failing handler tests** — direct factory pattern (see `lib/daemon/__tests__/endpoint-handlers.test.ts`): settings:get returns value+provenance for a fixture store; settings:list labels migrated:false.
- [ ] **Step 2: FAIL. Step 3: implement** (flag parsing per `commands/events.ts` conventions; JSON output exact; human output compact). Tree entries, module registry, docs:gen.
- [ ] **Step 4: green + tsc + `bun run docs:check` + module-registry test. Step 5: commit** `RT-47: rt settings get/set/list/explain + read-only daemon verbs`.

---

### Task 7: migrate the endpoint consumer

**Files:**
- Modify: `lib/endpoint/config.ts` (resolver-backed, legacy fallback, header rewrite), `lib/endpoint/shim.ts` (buildInterceptRules derives identity from captured remotes; staleness probe export), `lib/endpoint/run.ts` (normalize rule.repoRemote → identity for the post-match read), `lib/daemon/handlers/endpoint.ts` (async identity per claim), `commands/intercept.ts` (status gains staleness), `commands/verify.ts` (staleness in the intercept check), `lib/settings/resolve.ts` ONLY IF wiring setLegacyReader needs it
- Test: extend `lib/endpoint/__tests__/config.test.ts` + `shim.test.ts`; keep every existing endpoint/intercept/worktree test green (they may need fixture stores now — prefer making legacy fallback carry them unchanged)

**Interfaces:**
- Produces: `loadEndpointConfig(args: { repoIdentity: string | null; repoName: string }): EndpointRepoConfig` (shape unchanged). `loadEndpointRepoConfig(repoName)` is DELETED (verified: no sync production caller exists). The four async callers each supply identity from data in hand: `run.ts` and `buildInterceptRules` map remotes through `identityFromRemote` (overrides-aware, never bare normalizeRemote); the two daemon handler paths `await deriveRepoIdentity(repoPath)` (memoized; repoPath from `ctx.repoIndex()`). Unit tests that called the old name are updated in this task. Also `staleIntercepts(): { stale: boolean; reason?: string }` comparing store mtimes vs intercepts.json mtime.
- Key behaviors to test (add a beforeEach fresh-HOME to the EXISTING lib/endpoint/__tests__/config.test.ts so stray store fixtures from other suites can never leak into its legacy-path assertions): fixture team store carrying roles/intercepts for a fake identity → loadEndpointConfig returns them with `${team:x}` hook expanded; absent stores → legacy config.json still honored byte-identically (existing tests prove this); `rt settings set` on rt.intercepts regenerates intercepts.json (test via commands layer or exported hook); staleness probe flags store-newer-than-cache.
- [ ] Steps: failing tests → FAIL → implement → **full `bun test lib` green** + tsc → commit `RT-47: endpoint config reads through the resolver; intercept staleness probe`.

---

### Task 8: migrate the worktree consumer

**Files:**
- Modify: `lib/worktree/config.ts` (`loadWorktreeRepoConfig` async, resolver-backed, legacy fallback, header rewrite) and ALL FIVE callsites (find with `rg -n "loadWorktreeRepoConfig" lib commands` — verified async contexts: lib/worktree/create.ts:59, worktree-reconciler.ts:745/878/979, handlers/worktree.ts:240; plumb await), PLUS the hidden direct reader `repoHasWorktreeActivity` in `lib/daemon/worktree-reconciler.ts:985-989` (reads the raw `worktrees` key from config.json itself, gating the reconciler pass at :1020 — migrate it to the resolver: activity = a `rt.worktrees` resolution whose provenance is STRONGER than `default` (registry default {onDeck:0} must NOT count as activity); dedicated tests for both the store-only-repo positive and the nothing-anywhere negative), `lib/settings` legacy map if needed
- Test: extend `lib/worktree/__tests__/config.test.ts` (or its actual test home) with the deep-merge proof case through the REAL reader: team store onDeck/ready + user store namePool + legacy file everything → reader returns the spec's merged result; `root` computed default intact when nowhere set

- [ ] Steps: failing tests → FAIL → implement (async signature, callsites) → **full `bun test lib commands packages` green** + tsc → commit `RT-47: worktree config reads through the resolver (deep-merge proof case)`.

---

### Task 9: e2e

**Files:**
- Create: `e2e/tests/settings.test.ts`

Scenario against a real compiled binary + foreground daemon (copy `e2e/tests/endpoint.test.ts` mechanics: freePort, RT_API_PORT threading, child reaping, `rm -f dist/rt` first):
1. Hermetic HOME with seeded user + team + machine stores (fixture team dir under `~/.mattstack/teams/e2eteam/mattstack/`; note `${team:e2eteam}` expands to the ZONE ROOT `~/.mattstack/teams/e2eteam` — place the hook stub relative to that, not to mattstack/), a git repo with a recognized fake remote, registered in repos.json.
2. `rt settings get/list/explain --json` verify value, provenance chain incl. a deep-merge key, migrated:false labeling, unregistered-key labeling.
3. `rt settings set` (user scope) → value change visible on next get; comment planted in the file beforehand survives (read file, assert comment line).
4. Endpoint through stores: roles/intercepts ONLY in the team store (no per-repo config.json keys), `rt intercept install`, run the fake command through the shim → right PORT (proves resolver feeds interception end to end), `${team:e2eteam}` hook path expands (hook can be a stub echoing env).
5. Stale probe: set the team store's mtime explicitly into the future of the cache's (utimesSync +2s, never a bare touch — same-tick mtimes flake), `rt intercept status --json` reports stale; `rt intercept install` clears it.
6. Worktree merge visible: `rt settings get rt.worktrees --repo <name> --json` shows team onDeck + user namePool with multi-scope provenance.
- [ ] Steps: write → run (`rm -f dist/rt && bun test --preload ./e2e/setup.ts --timeout 60000 e2e/tests/settings.test.ts`) → fix reality frictions in source → full gates: `bunx tsc --noEmit && bun test lib commands packages && rm -f dist/rt && bun test --preload ./e2e/setup.ts --timeout 60000 e2e/` → commit `RT-47: e2e — stores to shim end to end, provenance, staleness`.

---

## Orchestrator-only steps after the branch is green (NOT implementer tasks)

Per spec "Data migration + machine hygiene", IN THIS ORDER (the old binary must never run against migrated state):
1. Seed team store (COPY LIVE VALUES) in the claimview zone + push; seed user store in mattstack-prefs + push; scaffold machine store. (Additive: harmless to the old binary, which never reads them.)
2. Merge the worktree branch → main; full gates on main; daemon restart (dev-mode daemon runs main's source, so the restart activates the resolver) and `rt intercept install` on the NEW build.
3. Live smoke on the new build: `rt settings explain rt.worktrees --repo assured-dev` (multi-scope provenance incl. legacy), `rt settings list`, intercepted backend start, `rt endpoint lookup`.
4. ONLY THEN diff-then-remove the migrated keys (`roles`, `intercepts`, `worktrees`, dead `ports`) from live assured-dev config.json, re-run `rt intercept install`, re-smoke (provenance now shows stores only).
5. The attic archive of the trace's DEAD files; final verify.

## Self-review notes

- Spec coverage: stores/paths (T1), registry+defs (T2), identity (T3), resolution+variables (T4), writes (T5), CLI+daemon (T6), endpoint migration+staleness (T7), worktree migration+proof case (T8), end-to-end truth (T9); data migration lives with the orchestrator by design.
- Type consistency: StoreFile (T1) consumed by T4; SettingDef (T2) by T4/T5/T6; deriveRepoIdentity (T3) by T6/T7/T8; Provenance[] everywhere; loadEndpointConfig args shape shared T7/e2e.
- Every task ends inside the worktree with tsc + suite green; nothing touches live machine state until the orchestrator steps.
