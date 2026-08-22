# Home-Repo Re-Root Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox syntax.

**Goal:** `~/.mattstack/user` becomes THE personal repo (no repo at root); machine scope moves to tracked `user/local/<machine-key>/settings.local.jsonc`; stores rename to scope-in-filename; the live tree migrates safely.

**Architecture:** Path constructors change in `lib/rt-paths.ts` (authority) and mirror into `packages/rt-client/src/settings/paths.ts` (parity test enforces). A new `machineKey()` (hostname slug + untracked override file) makes `machineSettingsPath()` impure — duplicated IDENTICALLY both sides. The sops cwd/path_regex/filename-override triple moves in lockstep to `user/`-rooted. `rt home init` is rewritten from "adopt root + fold in prefs" to "clone user repo + provision machine". Live migration is orchestrator-only.

**Tech Stack:** Bun, TypeScript, sops+age, git filter-repo.

**Spec:** `docs/superpowers/specs/2026-08-21-home-repo-reroot.md` (this repo, same branch). Upstream: `docs/superpowers/specs/2026-08-20-suite-settings-migration.md`.

## Global Constraints

- Worktree `/Users/matt/Documents/GitHub/repo-tools-reroot-wt`, branch `reroot-user-repo` off origin/main. NEVER touch the real `~/.mattstack`, the keychain, or the live daemon from tests — all tests repoint `process.env.HOME` at temp dirs (call-time resolution makes this work; never cache paths at module load).
- `lib/rt-paths.ts` is the authority; `packages/rt-client/src/settings/paths.ts` mirrors it verbatim (including `machineKey()`), or `lib/__tests__/settings-paths-parity.test.ts` fails.
- The precedence ladder, registry, resolve/write semantics are UNCHANGED — only paths and filenames move.
- After editing anything under `packages/rt-client/src/`, run `bun run build` inside `packages/rt-client/` (the dist-freshness test fails otherwise).
- Gates per task: `bun test lib commands packages` + `bun x tsc --noEmit`. Foreground-only; no monitors; NEEDS_CONTEXT on anything outside the worktree.
- Comments constraint-only. Trailer: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

### Task 1: machineKey() + store path constructors + consumers

**Files:**
- Modify: `lib/rt-paths.ts` (settings-stores section, ~:70-107)
- Modify: `packages/rt-client/src/settings/paths.ts` (mirror)
- Modify: `packages/rt-client/src/settings/stores.ts` (`listTeams()` probe ~:85-129)
- Modify: `packages/rt-client/src/settings/write.ts` (machine-scope write creates `local/<key>/` — check whether its write path already mkdirs; add if not)
- Modify: `lib/command-tree-def.ts` (~:602 `--scope` hints print the three store paths)
- Test: `lib/__tests__/settings-paths-parity.test.ts` (update expectations), plus paths unit tests in both trees

**Interfaces produced:** `machineKey(): string` (exported from both paths modules); new path returns:
`userSettingsPath()` → `<HOME>/.mattstack/user/settings.user.jsonc`;
`machineSettingsPath()` → `<HOME>/.mattstack/user/local/<machineKey()>/settings.local.jsonc`;
`teamSettingsPath(t)` → `<HOME>/.mattstack/teams/<t>/mattstack/settings.team.jsonc`.

`machineKey()` exact behavior (identical in both modules):
1. If `<HOME>/.mattstack/machine-key` exists, return its trimmed content (must be non-empty after trim; empty falls through).
2. Else slugify the hostname: `require("os").hostname()` lowercased, strip a trailing `.local`, replace every run of chars outside `[a-z0-9-]` with `-`, trim leading/trailing `-`. Empty result → `"default"`.

```ts
export function machineKey(): string {
  const override = join(home(), ".mattstack", "machine-key");
  try {
    const v = readFileSync(override, "utf8").trim();
    if (v) return v;
  } catch {}
  const slug = hostname().toLowerCase().replace(/\.local$/, "")
    .replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || "default";
}
```
(`readFileSync` from `fs`, `hostname` from `os` — add imports both sides.)

`listTeams()` probe: `mattstack/settings.jsonc` → `mattstack/settings.team.jsonc`.

- [ ] RED tests: machineKey override-file wins; hostname slugging (mixed case, `.local`, illegal chars, empty→default); the three path shapes; parity test updated; listTeams probe on new filename (old-name dir NOT listed)
- [ ] Implement in `lib/rt-paths.ts`, mirror verbatim in rt-client paths.ts; update stores.ts, write.ts mkdir, command-tree-def hints
- [ ] `cd packages/rt-client && bun run build`; full gates green
- [ ] Commit

### Task 2: sops triple moves to user/-rooted

**Files:**
- Modify: `lib/home/age-key.ts` (`renderSopsYaml` :122-124 — `path_regex: user/secrets/.*` → `secrets/.*`)
- Modify: `lib/secrets/store.ts` (`buildSecretsSpawnOptions` :340-348 — `cwd: mattstackHome()` → `join(mattstackHome(), "user")`; the `--filename-override user/secrets/<domain>.json` construction (~:222-230 + the header comment :10) → `secrets/<domain>.json`)
- Test: existing suites for both modules — update expectations; the store suite's cwd-pin unit test asserts the new cwd

The three values are cwd-coupled: sops resolves `.sops.yaml` and its `path_regex` relative to cwd, and the filename-override must match the regex or sops matches NO creation rule (silent wrong-recipient). All three change in this one task, never separately.

- [ ] RED: renderSopsYaml output equals the new literal; spawn options cwd = `<mattstackHome>/user`; filenameOverride = `secrets/<domain>.json`
- [ ] Implement; full gates green
- [ ] Commit

### Task 3: rt home init rewrite + boundary

**Files:**
- Modify: `lib/home/init-plan.ts` — retire `createRepo`/`gitInit`/`foldInPrefs`/`unlinkUserClone`/`adoptCommit` step kinds, `HomeState.prefsRemoteUrl`/`hasUserClone`, `reason: "prefs-remote-unreadable"`, `ADOPT_COMMIT_MESSAGE`. New `HomeState` probes: `{ userRepoPresent, machineKeyFilePresent, profileDirPresent, skillsSymlinkPresent, stateDirsMissing: string[] }`. New plan (ordered): `ensureStateDirs` (rt/deck/shepherdr/repos/work/teams as missing) → `cloneUserRepo { url }` (skip if present) → `writeMachineKey { key }` (skip if file present) → `ensureProfileDir { key }` (mkdir `user/local/<key>/` if missing) → `writeSkillsSymlink` (root `skills.jsonc` → `user/skills.jsonc`; skip if a correct symlink exists; a REAL file at the root path is a `blocked` reason, never overwritten).
- Modify: `lib/home/init-exec.ts` — executors for the new step kinds; delete retired executors.
- Modify: `lib/home/boundary.ts` — `HOME_BOUNDARY` becomes the USER-repo gitignore authority: ignored = `[".DS_Store", "*.sock", "*.tmp"]` (NO `local/`); update the header comment (the gitignore is hygiene now, not the security boundary — structure is).
- Modify: `commands/home.ts` — wording follows ("write the boundary .gitignore" → user repo); `rt home init` clones `mattstack-home` (same remote URL discovery it uses today — check how it currently learns the remote; if it derived it from the existing root repo, it now takes `--url <remote>` with the current remote as the recorded default).
- Test: `lib/home/__tests__/` — init-plan table tests rewritten for the new state machine; boundary test expectations.

- [ ] RED: plan-builder table tests (fresh HOME → all steps; repo present → provisioning-only; real file at symlink path → blocked)
- [ ] Implement plan + exec + boundary + command wording; full gates green
- [ ] Commit

### Task 4: fixture/docs sweep

**Files:**
- Modify: `e2e/tests/settings.test.ts`, `e2e/tests/endpoint.test.ts` (seed stores at the new paths/names; machine store fixtures must write `user/local/<key>/settings.local.jsonc` — use the override file to pin a known key in fixtures)
- Modify: any remaining unit-test fixtures found by `grep -rln 'settings\.jsonc\|settings\.local\.jsonc' lib commands packages e2e --include='*.ts'` (excluding rt-client dist)
- Modify: docs that state the old layout: `grep -rln 'settings\.local\.jsonc\|user/settings\.jsonc' docs README.md`

- [ ] Sweep both greps to zero stale references (report any intentionally kept, e.g. historical spec text)
- [ ] Full gates + `bun run test:all` if present; e2e suite green
- [ ] Commit

### Task 5 (ORCHESTRATOR-ONLY, live): migration

Execute the spec's "Live migration" section verbatim — ordered, backup first, swap-before-delete, full verify as defined there. Includes the team-repo file rename (their repo, commit+push), the machine-key file, the compat symlink, deleting the root `.git/` + interim guard hooks, and updating the memory + handoff conventions to `work/scratch/`.
