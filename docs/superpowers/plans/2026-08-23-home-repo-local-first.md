# Home Repo Local-First Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `rt home init` always ends with a working home repo — cloning when given a URL, `git init`-ing locally when not — and every surface reports honestly whether that repo is actually backed up.

**Architecture:** Four independent slices. Task 1 moves URL resolution into `rt home init` and deletes the hardcoded default. Task 2 adds the local-only init path. Task 3 teaches the snapshot daemon that "no remote" is a state rather than a failure. Task 4 adds the health probe and fixes the one setup step that currently implies a push happened when it did not.

**Tech Stack:** Bun (TypeScript), `bun:test`, git plumbing via the existing exec seams.

**Spec:** `docs/superpowers/specs/2026-08-23-home-repo-local-first-design.md` — read it first; it carries the reasoning these tasks implement.

## Global Constraints

- Worktree `/Users/matt/Documents/GitHub/repo-tools-homerepo-wt`, branch `home-repo-local-first`. b3's headless gate is **already cherry-picked as `bc02814`** — do not cherry-pick it again.
- **Never use `@{u}`.** The daemon pushes `git push -q origin HEAD` with no `-u`, so a repo that was `git init`-ed and later given a remote has the remote ref but no upstream config: `@{u}` exits 128. Always compare against `refs/remotes/origin/<branch>`, with `<branch>` from `git symbolic-ref --short HEAD`.
- **A missing `refs/remotes/origin/<branch>` means everything-unpushed**, not "nothing to push". `git rev-list` against an absent ref is fatal, not empty.
- **Tests build the whole sequence — `git init` → commit → attach remote → first push → second push — never a clone.** A clone arrives with upstream configured, an origin, and history; every defect found reviewing this spec was invisible on a clone, and each lived in a different step of that sequence.
- Never touch the real `~/.mattstack`, the keychain, or a live daemon. Tests repoint `process.env.HOME` via the existing bunfig preload.
- Comments constraint-only — no narration, no ticket numbers, no reviewer-facing justification.
- Gates per task, FOREGROUND: `bun test lib commands packages` + `bun x tsc --noEmit`. Baseline is 3470 pass / 0 fail; any delta is yours to explain.
- One commit per task, trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: `rt home init` owns URL resolution

Today `parseUrlArg` (`commands/home.ts:193-201`) returns `DEFAULT_USER_REPO_URL` when no `--url` is given, and `lib/setup/steps/home.ts:61` converts `RT_HOME_URL` into `--url`. So env arrives *as* rung 1 and an intent value could never outrank it.

**Files:**
- Modify: `commands/home.ts:84` (delete `DEFAULT_USER_REPO_URL`), `:193-201` (`parseUrlArg`), `HomeInitSeams` at `:495`
- Modify: `lib/setup/steps/home.ts:55-65` (stop synthesizing `--url`, delete the now-false warning)
- Test: `commands/__tests__/home.test.ts`

**Interfaces:**
- Produces: `resolveHomeUrl(args: string[], seams: { readIntent: () => SetupIntent | null; env: Record<string, string | undefined> }): string | null` — `null` means local-only. Task 2 consumes the `null`.
- Consumes: `readIntent(p: Pick<Probes, "readFile" | "home">)` from `lib/setup/intent.ts:34`, seamed so tests never write a real `~/.mattstack/rt/setup-intent.json`.

- [ ] **Step 1: Write the failing tests**

```ts
test("--url wins over intent and env", () => {
  const url = resolveHomeUrl(["--url", "https://x/a.git"], {
    readIntent: () => ({ v: 1, at: "", mode: "create", homeRepo: "https://x/b.git" }) as SetupIntent,
    env: { RT_HOME_URL: "https://x/c.git" },
  });
  expect(url).toBe("https://x/a.git");
});

test("intent homeRepo beats RT_HOME_URL", () => {
  const url = resolveHomeUrl([], {
    readIntent: () => ({ v: 1, at: "", mode: "create", homeRepo: "https://x/b.git" }) as SetupIntent,
    env: { RT_HOME_URL: "https://x/c.git" },
  });
  expect(url).toBe("https://x/b.git");
});

test("RT_HOME_URL is used when nothing else supplies one", () => {
  expect(resolveHomeUrl([], { readIntent: () => null, env: { RT_HOME_URL: "https://x/c.git" } })).toBe("https://x/c.git");
});

test("no url anywhere resolves to null — local-only, never a built-in default", () => {
  expect(resolveHomeUrl([], { readIntent: () => null, env: {} })).toBeNull();
});

test("--url with no value still throws rather than falling through to local-only", () => {
  expect(() => resolveHomeUrl(["--url"], { readIntent: () => null, env: {} })).toThrow(InvalidUrlArgError);
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun test commands/__tests__/home.test.ts -t resolveHomeUrl`
Expected: FAIL — `resolveHomeUrl` is not defined.

- [ ] **Step 3: Implement**

Delete `DEFAULT_USER_REPO_URL` entirely. Rewrite `parseUrlArg` to return `string | null` (keeping its `InvalidUrlArgError` throw for a valueless `--url`) and add:

```ts
export function resolveHomeUrl(
  args: string[],
  seams: { readIntent: () => SetupIntent | null; env: Record<string, string | undefined> },
): string | null {
  const fromFlag = parseUrlArg(args);
  if (fromFlag !== null) return fromFlag;
  const fromIntent = seams.readIntent()?.homeRepo;
  if (fromIntent) return fromIntent;
  return seams.env.RT_HOME_URL ?? null;
}
```

Add `readIntent?: () => SetupIntent | null` to `HomeInitSeams`, defaulted at call time like the other seams.

- [ ] **Step 4: Strip the setup step's env handling**

In `lib/setup/steps/home.ts`, delete the `RT_HOME_URL` read, the `--url` synthesis, and the warning at `:64` ("no RT_HOME_URL set — targeting rt's built-in default repo") — that line is false once the default is gone. The step invokes `["home", "init"]` with no `--url`. If `p.env` becomes unused in the file after Task 3's gate deletion, remove the import then, not now.

- [ ] **Step 5: Run tests and the gates**

Run: `bun test lib commands packages` and `bun x tsc --noEmit`
Expected: PASS. Existing tests asserting the old default will fail — update them to the new behaviour rather than restoring the constant.

- [ ] **Step 6: Commit**

```bash
git add commands/home.ts commands/__tests__/home.test.ts lib/setup/steps/home.ts
git commit -m "feat(home): rt home init owns url resolution; delete the hardcoded default"
```

---

### Task 2: The local-only init path

**Files:**
- Modify: `lib/home/init-plan.ts:32` (step union), `:194-198` (clone branch)
- Modify: `lib/home/init-exec.ts:72-76` (executor)
- Modify: `commands/home.ts` (pass the resolved `string | null` into the plan config)
- Modify: `lib/setup/steps/home.ts` — **delete the `applies` gate and its comment block from `bc02814`**, keeping its third test with the expectation rewritten
- Test: `lib/home/__tests__/init-plan.test.ts`, `lib/setup/__tests__/steps-a.test.ts`

**Interfaces:**
- Consumes: Task 1's `resolveHomeUrl` returning `string | null`.
- Produces: plan step `{ kind: "initUserRepo" }`, emitted in place of `cloneUserRepo` when the URL is `null`.

**Decision this plan settles (the spec asked for it):** the local-only initial commit happens **inside `initUserRepo`, before** `ensureHomeAgeKey` writes `user/.sops.yaml`. That leaves `.sops.yaml` uncommitted, exactly as the clone path leaves it today, so both paths reach the same end state and the existing "commit it yourself" message stays true.

- [ ] **Step 1: Write the failing tests**

```ts
test("no url plans initUserRepo instead of cloneUserRepo", () => {
  const plan = buildInitPlan(freshState(), { url: null, machineKey: "m" });
  expect(plan.steps.some((s) => s.kind === "initUserRepo")).toBe(true);
  expect(plan.steps.some((s) => s.kind === "cloneUserRepo")).toBe(false);
});

test("a url still plans cloneUserRepo", () => {
  const plan = buildInitPlan(freshState(), { url: "https://x/a.git", machineKey: "m" });
  expect(plan.steps.some((s) => s.kind === "cloneUserRepo")).toBe(true);
});

test("gitignore and owners ride along with initUserRepo, same as clone", () => {
  const plan = buildInitPlan(freshState(), { url: null, machineKey: "m" });
  expect(plan.steps.some((s) => s.kind === "writeGitignore")).toBe(true);
  expect(plan.steps.some((s) => s.kind === "writeOwners")).toBe(true);
});

test("an existing repo is never re-initialised, with or without a url", () => {
  const present = { ...freshState(), userRepoPresent: true };
  for (const url of [null, "https://x/a.git"]) {
    const plan = buildInitPlan(present, { url, machineKey: "m" });
    expect(plan.steps.some((s) => s.kind === "initUserRepo" || s.kind === "cloneUserRepo")).toBe(false);
  }
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun test lib/home/__tests__/init-plan.test.ts`
Expected: FAIL — `initUserRepo` is not a step kind.

- [ ] **Step 3: Implement the plan step**

Widen the config's `url` to `string | null`, add `| { kind: "initUserRepo" }` to the step union, and branch:

```ts
if (!state.userRepoPresent) {
  steps.push(config.url === null ? { kind: "initUserRepo" } : { kind: "cloneUserRepo", url: config.url });
  steps.push({ kind: "writeGitignore", content: renderHomeGitignore() });
  steps.push({ kind: "writeOwners", content: renderOwnersFile() });
}
```

- [ ] **Step 4: Implement the executor**

In `lib/home/init-exec.ts`, alongside `cloneUserRepo`. `lib/team/create.ts:168-190` is the working reference for this sequence:

```ts
case "initUserRepo": {
  log("initialising user/ as a local repo (no remote)");
  await run(exec, ["git", "init", "-b", "main", "user"]);
  return;
}
```

The initial commit lands after `writeGitignore`/`writeOwners` have populated the tree — add a `commitInitialUserRepo` step emitted only on the local-only path, running `git -C user add -A` then `git -C user commit -m "initial home repo"`. A clone has history already, which is why this step is local-only.

- [ ] **Step 5: Delete the headless gate**

In `lib/setup/steps/home.ts`, remove the `applies` clause added by `bc02814` and its comment block — the comment argues for a gate that no longer exists. Restore `applies: (ctx) => ctx.intent?.mode !== "restore"`. Rewrite the kept third test:

```ts
test("still applies interactively with no RT_HOME_URL — home init now creates a local-only repo", () => {
  const { ctx } = makeCtx(fakeProbes({ env: {} }), { nonInteractive: false });
  expect(homeInitStep.applies(ctx)).toBe(true);
});
```

Delete the other two gate tests: they assert a gate that is gone.

- [ ] **Step 6: Run tests and the gates**

Run: `bun test lib commands packages` and `bun x tsc --noEmit`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add lib/home/ commands/home.ts lib/setup/steps/home.ts lib/setup/__tests__/steps-a.test.ts
git commit -m "feat(home): git init a local-only repo when no url is supplied"
```

---

### Task 3: The daemon treats "no remote" as a state

**Files:**
- Modify: `lib/daemon/home-snapshot.ts:458` (push), `:672` (arming)
- Test: `lib/daemon/__tests__/home-snapshot.test.ts`

**Interfaces:**
- Produces: `hasRemote(exec, repoDir): Promise<boolean>` and `unpushedAgainstOrigin(exec, repoDir): Promise<boolean>` — Task 4's probe uses the same git commands but reads them independently, not by importing these.

- [ ] **Step 1: Write the failing tests**

```ts
test("no remote: commits, never pushes, never broadcasts a failure", async () => {
  const h = await harnessWithLocalOnlyRepo();          // git init + commit, no remote
  await h.writeFile("user/settings.user.jsonc", "{}");
  await h.runCycles(3);
  expect(h.commits().length).toBeGreaterThan(0);
  expect(h.execCalls().filter((c) => c[1] === "push")).toEqual([]);
  expect(h.broadcasts("home:push-failed")).toEqual([]);
});

test("a freshly attached remote arms a push with no new commit", async () => {
  const h = await harnessWithLocalOnlyRepo();
  await h.writeFile("user/a", "1");
  await h.runCycles(1);                                 // commits locally, no push
  await h.attachRemote();                               // git remote add origin <bare>
  await h.janitorTick();                                // no file change
  expect(h.execCalls().filter((c) => c[1] === "push").length).toBe(1);
});

test("second push only fires when there is something ahead of the ref", async () => {
  const h = await harnessWithLocalOnlyRepo();
  await h.attachRemote();
  await h.writeFile("user/a", "1");
  await h.runCycles(1);                                 // first push
  await h.janitorTick();                                // nothing new
  expect(h.execCalls().filter((c) => c[1] === "push").length).toBe(1);
});
```

`harnessWithLocalOnlyRepo` builds the full sequence — `git init -b main`, a commit, and a bare repo available for `attachRemote()` — never a clone.

- [ ] **Step 2: Run to verify they fail**

Run: `bun test lib/daemon/__tests__/home-snapshot.test.ts`
Expected: FAIL — the push runs unconditionally, so the first test sees a push call.

- [ ] **Step 3: Implement remote detection**

```ts
async function hasRemote(exec: ExecSeam, cwd: string): Promise<boolean> {
  const r = await exec(["git", "remote"], { cwd, stderr: "pipe" });
  return r.code === 0 && r.stdout.trim().length > 0;
}
```

Guard the push body: with no remote, log once at `debug` and return without pushing, without arming a retry, and without broadcasting `home:push-failed`.

- [ ] **Step 4: Implement the arming rule**

```ts
async function unpushedAgainstOrigin(exec: ExecSeam, cwd: string): Promise<boolean> {
  const b = await exec(["git", "symbolic-ref", "--short", "HEAD"], { cwd, stderr: "pipe" });
  if (b.code !== 0) return false;                       // detached HEAD: never green, never arm
  const branch = b.stdout.trim();
  const ref = `refs/remotes/origin/${branch}`;
  const has = await exec(["git", "rev-parse", "--verify", "-q", ref], { cwd, stderr: "pipe" });
  if (has.code !== 0) return true;                      // no ref yet — everything is unpushed
  const ahead = await exec(["git", "rev-list", `${ref}..HEAD`], { cwd, stderr: "pipe" });
  return ahead.code === 0 && ahead.stdout.trim().length > 0;
}
```

Replace `if (committed || pushPending) schedulePush()` at `:672` with a check that also arms when `await hasRemote(...)` and `await unpushedAgainstOrigin(...)`. **Never `@{u}`** — see Global Constraints.

- [ ] **Step 5: Run tests and the gates**

Run: `bun test lib commands packages` and `bun x tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/daemon/home-snapshot.ts lib/daemon/__tests__/home-snapshot.test.ts
git commit -m "feat(daemon): no remote is a state, not a push failure"
```

---

### Task 4: The `home.backup` probe and the honest setup step

**Files:**
- Modify: `lib/setup/validators/rt-health.ts` (add the row — note the path; `lib/setup/rt-health.ts` does not exist)
- Modify: `lib/setup/steps/tools.ts:165-211` (`snapshot.push` detail)
- Test: `lib/setup/__tests__/rt-health.test.ts`, `lib/setup/__tests__/steps-*.test.ts`

**Interfaces:**
- Consumes: nothing from Tasks 1-3 at the code level — the probe reads git state itself, so it works when the daemon has never run.

- [ ] **Step 1: Write the failing tests**

```ts
test("no remote: needs-you, not skipped — skipped renders as info and shows no warning", async () => {
  const row = await homeBackupRow(await localOnlyRepo());
  expect(row.status).toBe("needs-you");
  expect(row.required).toBe(false);
});

test("remote attached but never pushed: needs-you, not ready", async () => {
  const repo = await localOnlyRepo();
  await attachRemote(repo);
  expect((await homeBackupRow(repo)).status).toBe("needs-you");
});

test("commits ahead of the ref: needs-you", async () => {
  const repo = await pushedRepo();
  await commit(repo, "later");
  expect((await homeBackupRow(repo)).status).toBe("needs-you");
});

test("pushed and nothing ahead: ready", async () => {
  expect((await homeBackupRow(await pushedRepo())).status).toBe("ready");
});
```

`pushedRepo()` is `git init` → commit → `git remote add` → `git push origin HEAD` — **not a clone**. A clone configures upstream and would pass even against a broken `@{u}` implementation.

- [ ] **Step 2: Run to verify they fail**

Run: `bun test lib/setup/__tests__/rt-health.test.ts`
Expected: FAIL — no `home.backup` row exists.

- [ ] **Step 3: Implement the row**

Add to `lib/setup/validators/rt-health.ts`, following the shape of the existing `access.team-repo` row: id `home.backup`, `required: false`, resolving status with the same git sequence as Task 3's `unpushedAgainstOrigin` (branch → ref exists → rev-list). Details per the spec's table:

| condition | status | detail |
|---|---|---|
| no remote | `needs-you` | `local only — your settings are versioned on this machine but are not backed up anywhere` |
| no `refs/remotes/origin/<branch>` | `needs-you` | `remote configured, nothing pushed yet` |
| commits ahead of the ref | `needs-you` | `<n> commit(s) not pushed` |
| ref exists, nothing ahead | `ready` | `last pushed <when>` |

Remedy for the no-remote case names the command, since no verb exists:
`git -C ~/.mattstack/user remote add origin <url>`

`needs-you` is required, not merely "non-ready": `skipped` and `checking` render as `skip`/`severity: "info"` (`commands/verify.ts:70-75`) — a dim dash with no warning, which would silently defeat the row's purpose.

- [ ] **Step 4: Fix `snapshot.push`'s wording**

`lib/setup/steps/tools.ts:165-211` is titled "Push your first snapshot" and returns `done: "committed <sha>"` off the daemon's commit — it never observes a push. With no remote its detail must say the snapshot was committed locally and not pushed. The `done` state is unchanged; the step did what it could.

```ts
const detail = await hasRemote(...) ? `pushed ${sha}` : `committed ${sha} locally — no remote, nothing pushed`;
```

- [ ] **Step 5: Run tests and the gates**

Run: `bun test lib commands packages` and `bun x tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Verify against a real fresh HOME (orchestrator-only)**

This machine cannot detect a regression here — `home.init` short-circuits on the existing clone, so the path never runs locally. Against a temp HOME with no clone: `rt home init` produces a local-only repo; `rt verify` shows `home.backup` as a **warning**, and the run's critical-check tally is unchanged by it. Assert that row's status and severity specifically — **not** that the whole run passes, since `access.team-repo` is `required: true` and reports `missing` with no team remote (`lib/setup/validators/access.ts:50-56`).

- [ ] **Step 7: Commit**

```bash
git add lib/setup/validators/rt-health.ts lib/setup/steps/tools.ts lib/setup/__tests__/
git commit -m "feat(setup): home.backup probe, and snapshot.push stops implying a push"
```

---

## Not in this plan

Per the spec's out-of-scope section: `rt home remote set <url>` (the remedy names the git command instead), creating a remote on the operator's behalf, the settings-page panel, and the `SetupIntent.homeRepo` field itself plus the app screen — those are the installer lane's, and Task 1 reads the field defensively whether or not it is populated yet.
