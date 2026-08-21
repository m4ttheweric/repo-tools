# Home-Repo Foundation (H1 + S + E) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `~/.mattstack` the git-backed home repo with the layer boundary correct (H1), stand up the sops/age secrets layer with keychain key custody (S), and move the settings resolver + a suite-wide registry into `@mattstack/rt-client` (E).

**Architecture:** Three sequential lanes inside one worktree/branch. H1 gives git a correct view of the tree before anything new lands. S puts every live secret into encrypted-tracked files under `user/secrets/` and gives consumers one read API. E relocates `lib/settings/` machinery into `packages/rt-client/src/settings/` and grows the registry to the whole suite so `rt settings set` accepts `deck.*`/`board.*`/`gitq.*`/`mattstack.*`/`claude.*` keys.

**Tech Stack:** Bun/TypeScript (rt), `gh` CLI, `git`, `git-filter-repo`, `sops` + `age` CLIs, macOS `security` CLI (keychain).

**Spec:** `docs/superpowers/specs/2026-08-20-suite-settings-migration.md` (workstreams H, S, and "The suite standard"). The spec's rulings are binding; MAT-374 is the doctrine behind them.

## Global Constraints

- Worktree `/Users/matt/Documents/GitHub/repo-tools-rt50b-wt`, branch `goodwinmattheweric/rt-50-settings-keys`. Never touch the main checkout.
- Strict TDD on pure logic; exec seams (git, gh, sops, age, security, filter-repo) stay thin and injectable — tests never invoke the real keychain, real GitHub, or the real `~/.mattstack` (bunfig preload repoints HOME for bun test; never remove it).
- **Live-machine operations** (anything under the real `~/.mattstack`, real `gh repo create`, real keychain writes) are ORCHESTRATOR-ONLY steps, marked as such — implementer subagents build and test the commands, they never run them against the real tree.
- Where the platform blocks agent secret-handling, emit the exact command for Matt to run instead — never work around it.
- Comments follow clean-code rules. New commands: any new `module:` in `lib/command-tree-def.ts` gets its `lib/module-registry.ts` import + entry in the same commit (compiled-binary footgun).
- No monitor exists. Run tests yourself, never wait.
- Gates every task: `bun x tsc --noEmit` → 0; `bun test lib/ commands/ packages/` green.
- Commit per task, trailer: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

### Task 1: `rt home` command — plan-of-record + boundary gitignore (pure logic)

**Files:**
- Create: `commands/home.ts` (verbs `init`, `key` added in Task 4; this task: `init` only)
- Create: `lib/home/boundary.ts`, `lib/home/init-plan.ts`
- Create: `lib/home/__tests__/boundary.test.ts`, `lib/home/__tests__/init-plan.test.ts`
- Modify: `lib/command-tree-def.ts` (new `home` node, `init` subcommand, module `./commands/home.ts`, fn `homeInit`), `lib/module-registry.ts` (import + entry)

**Interfaces:**
- Produces: `HOME_BOUNDARY: { tracked: string[]; ignored: string[] }` and `renderHomeGitignore(): string` (lib/home/boundary.ts); `buildInitPlan(state: HomeState): InitStep[]` where `HomeState = { isRepo: boolean; hasUserClone: boolean; hasTeamClones: string[]; cruft: string[] }` and `InitStep` is a discriminated union `{kind: "createRepo"|"gitInit"|"writeGitignore"|"writeOwners"|"deleteCruft"|"foldInPrefs"|"adoptCommit"|"push", ...args}` (lib/home/init-plan.ts). Task 2 consumes `InitStep`.

- [ ] **Step 1: Failing tests for the boundary.** `renderHomeGitignore()` output must ignore exactly: `rt/`, `deck/`, `shepherdr/`, `repos/`, `ci-attendants/`, `work/`, `teams/`, `user/local/`, `settings.local.jsonc`, `*.sock`, `.DS_Store` — and NOT ignore `user/`, `skills.jsonc`, `snapshot-owners.jsonc`, `user/secrets/`. Test with `ignore`-style matching (write pairs of path→expected). Also: `buildInitPlan` on `{isRepo:false, hasUserClone:true, hasTeamClones:["claimview"], cruft:["skills.jsonc.pre-pack","skills.jsonc.retired-backup"]}` yields steps in exactly this order: createRepo → gitInit → writeGitignore → writeOwners → deleteCruft → foldInPrefs → adoptCommit → push; on `{isRepo:true,...}` it returns `[]` plus a `reason: "already-initialized"`.
- [ ] **Step 2: Run tests, verify they fail** (`bun test lib/home/`) with module-not-found.
- [ ] **Step 3: Implement** `boundary.ts` + `init-plan.ts` (pure — no fs, no exec). `commands/home.ts:homeInit` composes: gather `HomeState` from injected probes (`{ isGitRepo(dir), exists(path), listTeamClones() }` defaulted to real fs/git), print the plan, `--dry-run` stops there; execution wiring lands in Task 2.
- [ ] **Step 4: Tests green; tree+registry pair added; tsc 0.**
- [ ] **Step 5: Commit** `RT-30: rt home init — boundary + init plan (pure core)`.

---

### Task 2: `rt home init` execution — git/gh/filter-repo seams

**Files:**
- Create: `lib/home/init-exec.ts`, `lib/home/__tests__/init-exec.test.ts`
- Modify: `commands/home.ts`

**Interfaces:**
- Consumes: `InitStep[]` from Task 1.
- Produces: `executeInitPlan(steps, exec: ExecSeam, log): Promise<InitResult>` with `ExecSeam = { run(cmd: string[], opts?: {cwd?: string}): Promise<{code:number; stdout:string; stderr:string}> }`. Every external call goes through `exec.run` — tests use a scripted fake recording argv.

- [ ] **Step 1: Failing tests** asserting the exact argv sequences per step kind:
  - createRepo → `["gh","repo","create","<name>","--private"]` (name from opts; default `mattstack-home`, owner defaulted to the authenticated user)
  - gitInit → `["git","init","-b","main"]` in `~` +`.mattstack` cwd, then `["git","remote","add","origin","<url>"]`
  - foldInPrefs → temp-dir clone of the `user/` remote, `["git","filter-repo","--to-subdirectory-filter","user"]` in the temp clone, then in the home repo `["git","fetch","<tmp>","main"]` + `["git","merge","FETCH_HEAD","--allow-unrelated-histories","-m",...]`, then removal of `user/.git` (via seam `removeDir`, not shell rm)
  - adoptCommit → `["git","add","-A"]` + `["git","commit","-m","home: adopt the declarative layer"]`
  - push → `["git","push","-u","origin","main"]`
  - a failing step aborts the remaining steps and returns `{ok:false, failedStep, stderr}` — test with a fake that fails at writeGitignore.
- [ ] **Step 2: Run, verify fail.**
- [ ] **Step 3: Implement** `init-exec.ts`; `homeInit` wires the real seam (`Bun.spawn`-based runCapture, `env: process.env` — PATH-snapshot gotcha) and refuses to run when `HomeState.isRepo` (idempotence). Preflight: `gh auth status` must pass and `git filter-repo --version` must resolve; on failure print the install commands (`brew install git-filter-repo`) and exit 1 — no partial runs.
- [ ] **Step 4: Tests green; tsc 0.**
- [ ] **Step 5: Commit** `RT-30: rt home init — execution seams`.

---

### Task 3 (ORCHESTRATOR-ONLY, live machine): run H1 against the real tree

Not a subagent task. With Matt's `gh` auth: `rt home init --dry-run` from the worktree (`bun run cli.ts home init --dry-run`), review the printed plan, then run it live. Verify after: `git -C ~/.mattstack status` clean; `git log` shows the adoption commit ON TOP of mattstack-prefs history under `user/`; `user/.git` gone; `rt verify` green; `rt settings get rt.worktrees --repo assured-dev` still resolves (user store reads unaffected). The old mattstack-prefs remote retires: archive note only, no deletion of the GitHub repo (history safety).

---

### Task 4: age key custody + `rt home key export` + `.sops.yaml`

**Files:**
- Create: `lib/home/age-key.ts`, `lib/home/__tests__/age-key.test.ts`
- Modify: `commands/home.ts` (verb `key` with `export`), `lib/command-tree-def.ts` (subcommand under `home`)

**Interfaces:**
- Produces (AS BUILT after review hardening): `readAgeKey(seams): Promise<{key: string} | {absent: true}>` — `absent` ONLY on exit 44 corroborated by the "could not be found" stderr marker; ANY other failure THROWS ("keychain unreachable … refusing to mint") and callers must let that propagate as a real error, never treat it as missing. `ensureAgeKey(seams): Promise<{publicKey: string}>` mints only on provable absence and stores WITHOUT `-U` (duplicate item fails loudly). `keyExport` never mints (`AgeKeyAbsentError` → "run rt home init"); minting lives in homeInit. `createRealAgeKeySeam()` returns the argv-redacting wrapper; the raw seam is unexported. `renderSopsYaml(publicKey): string` emits creation rules encrypting `user/secrets/**` to the recipient. Tasks 5–6 consume `readAgeKey`'s union contract; the live step writes `.sops.yaml` at `~/.mattstack/.sops.yaml`.

- [ ] **Step 1: Failing tests**: keygen path (fake `age-keygen` output → parsed public key, security argv recorded, `-w` value never logged); existing-key path (find succeeds → no keygen); `renderSopsYaml("age1xyz")` contains `path_regex: user/secrets/.*` and the recipient; `keyExport` prints the private key to stdout ONCE with a warning header and never writes it to any file (assert the fake fs saw zero writes).
- [ ] **Step 2: Run, fail.** **Step 3: Implement** (seams injected; real seam uses runCapture with `env: process.env`).
- [ ] **Step 4: Green; tsc 0.** **Step 5: Commit** `RT-32: age key custody in the keychain + sops rules`.

---

### Task 5: secrets read/write API + `rt secrets` verbs

**Files:**
- Create: `lib/secrets/store.ts`, `lib/secrets/__tests__/store.test.ts`, `commands/secrets.ts`
- Modify: `lib/command-tree-def.ts` (`secrets` node: `set`, `list`, `rotate`; hidden from help until S lands? No — visible, honest), `lib/module-registry.ts`

**Interfaces:**
- Produces: `readSecret(domain: string, key: string, seams): Promise<string|null>` and `writeSecret(domain, key, value, seams): Promise<void>` over files `~/.mattstack/user/secrets/<domain>.json` — read = `["sops","-d","<file>"]` with `SOPS_AGE_KEY` injected from `readAgeKey` (never via argv, only env), parse JSON, per-process memo; write = decrypt-merge-encrypt via `["sops","--set",...]` or decrypt+edit+`["sops","-e","-i"]` (implementer picks the sops idiom that round-trips cleanly; test pins the chosen argv). `rotateSecret(domain, key, minter)` re-mints + writes + returns the commit message `secrets: rotate <domain>.<key>`. `listSecretNames` decrypts and returns keys only, never values.
- Domains ruled by the spec inventory: `rt` (linearApiKey, gitlabToken, linearTeamId, linearTeamKey, sdmEmail, switchboardToken, switchboardAdminToken), `deck` (cfApiToken, cfZoneId, sessionSecret, passwordHash.<app>), `board` (slackToken, slackClientSecret, slackSigningSecret).

- [ ] **Step 1: Failing tests** (fake sops seam): read path env carries SOPS_AGE_KEY and argv never contains the key; missing file → null, no throw; write argv pinned; memo invalidated by writeSecret; `rt secrets list` output contains names not values (fake decrypted payload with a canary value, assert canary absent from stdout).
- [ ] **Step 2: Run, fail.** **Step 3: Implement.** **Step 4: Green; tsc 0; tree+registry pairs.**
- [ ] **Step 5: Commit** `RT-32: sops-backed secrets store + rt secrets verbs`.

---

### Task 6: port rt's secrets consumers + daemon verb for the extension

**Files:**
- Modify: `lib/linear.ts` (loadSecrets/saveSecret/saveTeamConfig re-back onto `lib/secrets/store.ts`, same signatures so callers don't churn), `lib/daemon/handlers/secrets.ts` (new verb `secrets:read` returning ONLY the whitelisted keys the extension needs — implementer greps `extensions/vscode/rt-context/src/secrets.ts` for its field usage and whitelists exactly those), `extensions/vscode/rt-context/src/secrets.ts` (daemon call replaces the file read; extension builds standalone — check its own tsconfig/build)
- Tests: extend `lib/daemon/__tests__/settings-handlers.test.ts` pattern for the new verb; `lib/__tests__/` coverage for the re-backed loaders (async now? loadSecrets is sync today — keep a sync facade over a decrypt-once memo primed at first call, or make callers async; implementer reports which; the survey lists every caller: lib/enrich.ts:263,298,414, lib/daemon/freshness.ts:129,269, handlers/secrets.ts:35, handlers/discussions.ts:117,146, lib/sdm/browser-login.ts:318, commands/settings.ts:37,80,118,168)

**Interfaces:**
- Consumes: Task 5's store API. Produces: `secrets.json` has zero rt readers; the plaintext file's deletion is a live-machine step AFTER the import (orchestrator, with the ext updated).

- [ ] Steps: failing tests → implement → green → commit `RT-32: consumers read the encrypted store; extension via daemon`.

---

### Task 7 (ORCHESTRATOR-ONLY, live): secrets import + plaintext retirement

`rt home key export` → Matt stores in password manager. Then per-domain import: read current plaintext (`~/.mattstack/rt/secrets.json`, deck `platform.json` secrets + `settings.json` secret/hashes, board `.env` three slack values), `rt secrets set` each (or hand Matt the commands if the classifier blocks), commit (encrypted blobs land in git — verify `git show` displays sops ciphertext, NEVER plaintext, before pushing). Delete: rt `secrets.json`, board `.env` CF pair. Deck/board plaintext originals retire in their own lanes (their readers still point at them until then). `rt verify` + daemon restart + spot-check: `rt status` still enriches (gitlab token flows), extension still resolves.

---

### Task 8: resolver extraction into `@mattstack/rt-client`

**Files:**
- Create: `packages/rt-client/src/settings/{resolve,stores,identity,write,registry-machinery}.ts` (moved from `lib/settings/`, import paths adjusted; `registry.ts` splits: machinery types + `getDef/allDefs/validateValue` → `registry-machinery.ts`; the def TABLE stays separate — Task 9)
- Create: `packages/rt-client/src/settings/registry-defs.ts` (the suite table; starts as rt's 16 rows verbatim)
- Modify: `lib/settings/*.ts` → thin re-export barrels (`export * from "../../packages/rt-client/src/settings/resolve.ts"` style — every existing rt importer keeps working unchanged), `packages/rt-client/src/index.ts` (export the settings module), `packages/rt-client/package.json` (version → 0.3.0)
- Move: `lib/settings/__tests__/*` → `packages/rt-client/src/settings/__tests__/` (paths only; assertions unchanged — this is the proof the move is pure)

**Interfaces:**
- Produces: `@mattstack/rt-client` exports `getSetting/listSettings/explainSetting/setSetting/expandVariables`, the registry API, and the secrets store surface Task 5 built if cleanly separable (else secrets stay rt-internal this lane and deck/board get them via their lanes — implementer reports).

- [ ] **Step 1:** Move files, fix imports, re-export barrels. **Step 2:** `bun test packages/ lib/ commands/` — the moved suite green UNCHANGED (any assertion edit beyond paths = report as concern). **Step 3:** tsc 0. **Step 4:** rt-client's own `bun test tests/` (its existing suite) green. **Step 5: Commit** `RT-50: settings machinery lives in rt-client (pure move)`.

---

### Task 9: the suite registry

**Files:**
- Modify: `packages/rt-client/src/settings/registry-defs.ts` — add, per the spec's tables (exact scopes/types from the spec; every new def `migrated` is omitted — that flag is rt-legacy-specific): `mattstack.integrations` (team, object, deep), `mattstack.tracking` (team, object, deep), `mattstack.appPath` (machine, string, replace), `claude.marketplaces` (user+team, array, replace), `claude.plugins` (user+team, array, replace), `deck.apps` (user, object, deep), `deck.access` (user, object, deep), `deck.platform` (machine, object, deep), `board.*` rows (team: gitlabHost, projects, members, title, botUsernames, ticketPrefixes, slack; user: staleAfterDays, workspaces, defaultMember, triage; machine: claudeCommand, cwds, rtRepos, triageMaxConcurrent, switchboardUrl; two doctor keys: `board.doctorSkill`, `board.triage.doctorSkill` — distinct rows, the BOARD-14 semantic difference lives in board's reader, note it in each row's description), `gitq.workSlots` (machine), `gitq.forges` (user), `gitq.board` (machine)
- Modify: registry enumeration tests (counts change once; write the new literal arrays), `commands/settings-keys.ts` if any labeling assumes `rt.` prefix (survey says renderers are prefix-agnostic — verify)

**Interfaces:**
- Consumes: Task 8's machinery. Produces: `rt settings set deck.access --scope user '<json>'` works end-to-end (e2e settings suite gets one new case proving a non-rt prefix round-trips).

- [ ] Steps: failing e2e/unit test for a `deck.*` round-trip → add defs → green → tsc 0 → commit `RT-50: one suite registry — deck/board/gitq/mattstack/claude keys land`.

---

### Task 10: foundation gates + merge readiness

- [ ] `bun x tsc --noEmit` 0; `bun run test:all` green (delete `dist/rt` first); rt-client suite green; e2e settings suite green.
- [ ] Orchestrator: verify against the LIVE tree that `rt settings list` renders the suite keys and `rt verify` stays green (daemon restart to pick up handlers).
- [ ] Commit any stragglers; branch ready for PR (merge decision is the orchestrator's checkpoint with Matt).
