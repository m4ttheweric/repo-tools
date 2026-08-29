# Phase 4: The destructive engine earns its paranoia — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Harden rt's worktree engine so its destructive operations (kill, freshen, dispose, reap) are safe against the process table, the filesystem, and dropped database writes, and move the pool out of the user's clone.

**Architecture:** Twelve mostly-independent hardening changes plus a final verification task, landing on top of roadmap waves 1+2. The pool-root move (RT-52) is foundational and goes first; recoverable disposal (RT-51) builds on the relocated retention store. Every behavior change is test-first against an existing seam.

**Tech Stack:** Bun, TypeScript, bun:sqlite, git CLI via `runGit`/`runCapture`.

**Spec:** `docs/superpowers/specs/2026-08-28-p4-destructive-engine-design.md`

## Global Constraints

- **No SCHEMA_VERSION bump.** It is `9` and is a resource claimed across concurrent lanes. `TreeRecord` is a kv JSON blob so new fields are free; the one DDL (an `endpoint_claims.start_time` column) is added by a `PRAGMA table_info` guard run **unconditionally from `openStateDb` after `runMigrations`**, never inside the `user_version` gate.
- **No `lib/daemon.ts` edits** are anticipated; if one proves necessary, stop and ask first.
- **Serialized repo identity** names per-repo directories: `serializeIdentity(await deriveRepoIdentity(repoPath))`, imported in-repo from `lib/settings/identity.ts` (never `@mattstack/rt-client`).
- **Realpath discipline:** every cwd-prefix comparison and every root handed to the reaper resolves through realpath first (lsof reports realpath'd cwds; `~/.mattstack` may be symlinked). Use `safeRealpath`.
- **Lazy migration:** new trees use the new root; existing trees age out where they sit; the `worktrees.root` override is always honored.
- **Named constants with a one-line rationale:** `MISSING_PRUNE_PASSES = 3`, `WORKTREE_MIN_FREE_DISK_GB = 5`, `CLAIM_TRUST_TTL_MS`.
- **Picker conformance:** every new leaf with a required positional declares `omitBehavior` in `lib/command-tree-def.ts`; the picker gates on `process.stdin.isTTY && !json && !process.env.RT_BATCH`. `bun run picker:check` and `bun run docs:gen`/`docs:check` are part of verification whenever the command surface changes.
- **No em dashes** in any code, comment, commit message, or doc (repo rule). Use ellipses, parens, or rephrase. Comments state constraints only (clean-code rule).
- Run everything from the worktree root `/Users/matt/Documents/GitHub/repo-tools/.worktrees/ideal-marble`. Never run `rt` or a daemon against the real machine.

## File Structure

New files:
- `lib/worktree/__tests__/pool-root.test.ts` — RT-52 default-root tests.
- `lib/worktree/restore.ts` — RT-51 restore engine (manifest read, rehydrate, re-register).
- `lib/worktree/__tests__/restore.test.ts`, `lib/worktree/__tests__/manifest.test.ts`.

Modified (by responsibility):
- `lib/rt-paths.ts` — add `worktreesDir()`/`worktreePoolRoot()`.
- `lib/worktree/config.ts` — default root, unowned app-config default flip, onDeck ceiling constant.
- `lib/worktree/trash.ts` — retention root follows the tree; manifest write/read; reaper honors keptUntil.
- `lib/worktree/create.ts` — info/exclude gate; critical create-flip.
- `lib/worktree/dispose.ts` — re-read under lock; caller-pid threading; manifest at dispose.
- `lib/worktree/registry.ts` — critical `saveRegistry`, boolean return, `missCount`, manifest fields.
- `lib/worktree/git-async.ts` — `stashChangesAsync` returns the git result.
- `lib/state/kv-blob.ts` — `setKvValueCritical`.
- `lib/state/db.ts` — `ensureEndpointClaimsStartTimeColumn`, called from `openStateDb`.
- `lib/state/endpoint-claims-store.ts` — `startTime` column plumbing.
- `lib/endpoint/allocator.ts` — `pidStartTime` probe, TTL-aware `isLiveClaim`, capture at claim.
- `lib/endpoint/store.ts` — passthrough for critical claim writes.
- `lib/daemon/worktree-process-kill.ts` — spared-set, caller pids, nested-tree exclusion, realpath.
- `lib/daemon/worktree-reconciler.ts` — main-freshen gate/abort, S063 hold, reap both roots, onDeck ceiling + disk precheck, dormant surfacing.
- `lib/daemon/handlers/worktree.ts` — adopt unmanaged/`--claim`, dispose re-read, restore handler, dormant status.
- `commands/worktree.ts` — `--claim`, `worktreeRestore`, caller pid in dispose payload.
- `commands/endpoint.ts` — `endpointRelease`.
- `lib/command-tree-def.ts` — `--claim`, `worktree restore`, `endpoint release`.

---

## Task 1: RT-52 — pool root moves out of the clone

**Files:**
- Modify: `lib/rt-paths.ts:39-79`
- Modify: `lib/worktree/config.ts:146-207` (`sanitizeRoot`, `loadWorktreeRepoConfig`)
- Modify: `lib/worktree/create.ts:50-67` (`defaultRoot`/`ensureInfoExclude` gate)
- Test: `lib/worktree/__tests__/pool-root.test.ts` (new)

**Interfaces:**
- Produces: `worktreesDir(): string` = `join(rtDir(), "worktrees")`; `worktreePoolRoot(serializedIdentity: string): string` = `join(worktreesDir(), serializedIdentity)`.
- Consumes: `serializeIdentity`, `deriveRepoIdentity` from `lib/settings/identity.ts`.

- [ ] **Step 1: Write the failing test**

```ts
// lib/worktree/__tests__/pool-root.test.ts
import { test, expect } from "bun:test";
import { join } from "path";
import { worktreesDir, worktreePoolRoot } from "../../rt-paths.ts";
import { rtDir } from "../../rt-paths.ts";

test("worktreePoolRoot lives under rtDir/worktrees keyed by the serialized identity", () => {
  const id = "remote:gitlab.com%2Facme%2Facme-dev";
  expect(worktreesDir()).toBe(join(rtDir(), "worktrees"));
  expect(worktreePoolRoot(id)).toBe(join(rtDir(), "worktrees", id));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test lib/worktree/__tests__/pool-root.test.ts`
Expected: FAIL, `worktreesDir` / `worktreePoolRoot` are not exported.

- [ ] **Step 3: Add the helpers to `lib/rt-paths.ts`** (after `tmpDir()`, ~line 71, matching the existing style)

```ts
/**
 * ~/.mattstack/rt/worktrees — the pool root container. A repo's ephemeral and
 * on-deck trees live at worktrees/<serialized identity>/ so they stay OUT of
 * the user's clone (repo-stealth) and no sibling tree's cwd is ever nested
 * under the main clone (retires S017's collateral-kill root cause).
 */
export function worktreesDir(): string {
  return join(rtDir(), "worktrees");
}

/** worktrees/<serialized identity> — one repo's pool root. */
export function worktreePoolRoot(serializedIdentity: string): string {
  return join(worktreesDir(), serializedIdentity);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test lib/worktree/__tests__/pool-root.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing config default test**

```ts
// append to pool-root.test.ts
import { loadWorktreeRepoConfig } from "../config.ts";
import { serializeIdentity, deriveRepoIdentity } from "../../settings/identity.ts";

test("default worktrees.root is the out-of-repo pool root", async () => {
  const repoPath = process.cwd(); // a real git repo (this worktree)
  const cfg = await loadWorktreeRepoConfig("repo-tools", repoPath);
  const id = serializeIdentity(await deriveRepoIdentity(repoPath));
  expect(cfg.root).toBe(worktreePoolRoot(id));
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `bun test lib/worktree/__tests__/pool-root.test.ts -t "default worktrees.root"`
Expected: FAIL, root is still `join(repoPath, ".worktrees")`.

- [ ] **Step 7: Change the default root**

In `lib/worktree/config.ts`, import `serializeIdentity` and `worktreePoolRoot`, then change `sanitizeRoot` to take the serialized identity and `loadWorktreeRepoConfig` to pass it (`loadWorktreeRepoConfig` already `await`s `deriveRepoIdentity` at line 194, so no new async is introduced):

```ts
// config.ts imports
import { rtDir, worktreePoolRoot } from "../rt-paths.ts";
import { deriveRepoIdentity, serializeIdentity } from "../settings/identity.ts";

// sanitizeRoot: default is now the pool root, not <repo>/.worktrees
function sanitizeRoot(raw: unknown, serializedIdentity: string): string {
  return typeof raw === "string" && raw.length > 0 ? expandHome(raw) : worktreePoolRoot(serializedIdentity);
}

// inside loadWorktreeRepoConfig, after `const derived = await deriveRepoIdentity(repoPath);`
const serialized = serializeIdentity(derived);
// ...
root: sanitizeRoot(declared.root, serialized),
```

- [ ] **Step 8: Gate `ensureInfoExclude` on an in-repo root in `create.ts`**

The new default root is outside the repo, so `.worktrees/` never appears in the clone. Only exclude when a user override points the root back inside the repo:

```ts
// create.ts, replacing the defaultRoot block at ~55-60
import { relative, isAbsolute } from "path";
// ...
const rel = relative(repoPath, cfg.root);
const rootInsideRepo = rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
if (rootInsideRepo) {
  // Keep the info/exclude only for an override that puts the pool back in the
  // clone; the default out-of-repo root needs no exclude.
  await ensureInfoExclude(repoPath, `${rel.split("/")[0]}/`);
}
```

- [ ] **Step 9: Run the config default test to verify it passes, plus the worktree suite**

Run: `bun test lib/worktree`
Expected: PASS (fix any existing config test that asserted `<repo>/.worktrees`).

- [ ] **Step 10: Commit**

```bash
git add lib/rt-paths.ts lib/worktree/config.ts lib/worktree/create.ts lib/worktree/__tests__/pool-root.test.ts
git commit -m "RT-52: default worktree pool root to ~/.mattstack/rt/worktrees/<identity>"
```

---

## Task 2: RT-52 — retention store follows the tree; reaper sweeps every root

**Files:**
- Modify: `lib/worktree/trash.ts:103-105` (`retainedTrashRoot`), `:119-165` (`retireTree`), `:201-240` (`reapExpiredTrash`)
- Modify: `lib/daemon/worktree-reconciler.ts:1055-1068` (`reapRepoTrash`)
- Test: `lib/worktree/__tests__/trash.test.ts` (existing; add cases)

**Interfaces:**
- Changed: `retainedTrashRoot(poolRoot: string): string` = `join(poolRoot, ".trash")` (was keyed on `repoPath`).
- Changed: `reapExpiredTrash(roots: string[], log, now?)` sweeps `<root>/.trash` for every root.

- [ ] **Step 1: Write the failing test** (retention lands beside the tree, under a moved root)

```ts
// trash.test.ts (add)
import { retainedTrashRoot } from "../trash.ts";
import { join } from "path";
test("retainedTrashRoot is a .trash sibling of the pool root", () => {
  expect(retainedTrashRoot("/somewhere/pool")).toBe(join("/somewhere/pool", ".trash"));
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test lib/worktree/__tests__/trash.test.ts -t "retainedTrashRoot"`
Expected: FAIL, `retainedTrashRoot` still takes `repoPath` and hardcodes `.worktrees/.trash`.

- [ ] **Step 3: Rework `retainedTrashRoot` and `retireTree`**

```ts
// trash.ts
export function retainedTrashRoot(poolRoot: string): string {
  return join(poolRoot, RETAIN_DIR);
}

export async function retireTree(path: string, name: string, repoPath: string): Promise<RetireResult> {
  let trashPath: string;
  try {
    if (!name || name.includes("/") || name.includes("\\")) {
      throw new Error(`worktree trash name must be a single path component: ${JSON.stringify(name)}`);
    }
    const poolRoot = dirname(path); // the root this tree actually lives in
    // Only a pool root INSIDE the clone needs a git info/exclude; the default
    // out-of-repo root does not show up in the user's `git status` at all.
    const rel = relative(repoPath, poolRoot);
    if (rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)) {
      await ensureInfoExclude(repoPath, `${rel.split("/")[0]}/`);
    }
    const root = retainedTrashRoot(poolRoot);
    await mkdir(root, { recursive: true });
    trashPath = join(root, `${name}-${Date.now()}`);
  } catch {
    const fallback = await trashTree(path, name);
    return fallback.ok ? { ...fallback, retained: false } : fallback;
  }
  // ... rename body unchanged
}
```

Add `import { relative, isAbsolute } from "path";` to trash.ts.

- [ ] **Step 4: Make `reapExpiredTrash` sweep a set of roots**

```ts
export async function reapExpiredTrash(roots: string[], log: TrashLog, now: number = Date.now()): Promise<number> {
  let reaped = 0;
  for (const poolRoot of new Set(roots)) {
    const root = retainedTrashRoot(poolRoot);
    let entries: string[];
    try {
      entries = await readdir(root);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") log.warn({ err, root }, "worktree retention sweep could not read trash dir");
      continue;
    }
    for (const entry of entries) {
      const epoch = /-(\d+)$/.exec(entry)?.[1];
      if (!epoch || !looksLikeRtEpoch(epoch)) { log.warn({ root, entry }, "worktree retention sweep skipped an entry it did not write"); continue; }
      if (now - Number(epoch) <= RETENTION_MS) continue;
      await reapTrashDir(join(root, entry), log);
      reaped += 1;
    }
  }
  return reaped;
}
```

- [ ] **Step 5: Update `reapRepoTrash` to pass every root (legacy default + cfg.root)**

```ts
// worktree-reconciler.ts reapRepoTrash
const legacyDefault = join(repoPath, ".worktrees");
const poolRoots = [legacyDefault];
if (isRootAnAncestorOfRepo(repoPath, cfg.root)) {
  log.warn({ repo: repoName, root: cfg.root, repoPath }, "worktree trash sweep refused a configured root that is an ancestor of the repo");
} else {
  poolRoots.push(cfg.root);
}
const reaped = await reapTrashInRoots(poolRoots, log);
if (reaped > 0) log.info({ repo: repoName, count: reaped }, "worktree trash reaped");
const expired = await reapExpiredTrash(poolRoots, log);
if (expired > 0) log.info({ repo: repoName, count: expired }, "worktree retention trash reaped");
```

- [ ] **Step 6: Run tests**

Run: `bun test lib/worktree/__tests__/trash.test.ts` then `bunx tsc --noEmit`
Expected: PASS, zero type errors. Fix any existing `reapExpiredTrash(repoPath, ...)` call sites to pass an array.

- [ ] **Step 7: Commit**

```bash
git add lib/worktree/trash.ts lib/daemon/worktree-reconciler.ts lib/worktree/__tests__/trash.test.ts
git commit -m "RT-52: retention store follows the tree's pool root; reaper sweeps every root"
```

---

## Task 3: S025 — registry and claim writes are critical

**Files:**
- Modify: `lib/state/kv-blob.ts:54-61` (add `setKvValueCritical`)
- Modify: `lib/worktree/registry.ts:75-85` (`saveRegistry` returns boolean), `:87-92`
- Modify: `lib/daemon/handlers/worktree.ts:97-103` (`patchTree` returns boolean), `:350-378` (claim abort)
- Modify: `lib/worktree/create.ts:138-152` (flip abort)
- Test: `lib/worktree/__tests__/registry-critical.test.ts` (new)

**Interfaces:**
- Produces: `setKvValueCritical<T>(ns, key, value, db?): boolean` (true iff the write landed).
- Changed: `saveRegistry(repoName, trees): boolean`; `patchTree(...): boolean`.

- [ ] **Step 1: Write the failing test** (a busy write does not bump the epoch and reports failure)

```ts
// registry-critical.test.ts
import { test, expect } from "bun:test";
import { openStateDb } from "../../state/db.ts";
// Use a db stub whose kv UPSERT throws SQLITE_BUSY, assert setKvValueCritical returns false.
test("setKvValueCritical returns false when the write stays busy", () => {
  const busy = { query: () => ({ run: () => { const e: any = new Error("busy"); e.code = "SQLITE_BUSY"; throw e; } }) } as any;
  const { setKvValueCritical } = require("../../state/kv-blob.ts");
  expect(setKvValueCritical("ns", "k", { a: 1 }, busy)).toBe(false);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test lib/worktree/__tests__/registry-critical.test.ts`
Expected: FAIL, `setKvValueCritical` not exported.

- [ ] **Step 3: Add `setKvValueCritical`**

```ts
// kv-blob.ts
import { persistOrWarn, runCriticalWrite } from "./busy.ts";

/** Critical write: retries, and reports whether the row actually landed so a
 *  destructive caller can refuse to advance state on a dropped write. */
export function setKvValueCritical<T>(ns: string, key: string, value: T, db: Database = getStateDb()): boolean {
  const done = runCriticalWrite(
    `kv:${ns}`,
    () => { db.query(KV_UPSERT_SQL).run(ns, key, JSON.stringify(value), Date.now()); return true; },
    { ns, k: key, op: "write" },
  );
  return done === true;
}
```

- [ ] **Step 4: Route `saveRegistry` through it, return boolean, bump epoch only on success**

```ts
// registry.ts
export function saveRegistry(repoName: string, trees: TreeRecord[]): boolean {
  loadRegistry(repoName);
  const ok = setKvValueCritical(WORKTREE_REGISTRY_NS, repoName, trees);
  if (ok) epochs.set(repoName, registryEpoch(repoName) + 1);
  return ok;
}
```

Do the same for `saveClaims` in `lib/endpoint/store.ts` (route `replaceEndpointClaims` through a critical path; the store's `replaceEndpointClaims` uses `persistOrWarn`... add a `replaceEndpointClaimsCritical` returning boolean in `endpoint-claims-store.ts` mirroring `setKvValueCritical`, and have `saveClaims` return its boolean).

- [ ] **Step 5: `patchTree` returns the boolean; provision claim aborts on false**

```ts
// handlers/worktree.ts
function patchTree(repoName: string, path: string, patch: (rec: TreeRecord) => void): boolean {
  const trees = loadRegistry(repoName);
  const rec = trees.find((t) => t.path === path);
  if (!rec) return false;
  patch(rec);
  return saveRegistry(repoName, trees);
}
```

In the provision claim block (`:369`), refuse if the claim write is lost:

```ts
const claimWritten = patchTree(repoName, tree.path, (r) => {
  r.state = "claimed"; r.disposal = disposal; r.claimedAt = new Date().toISOString();
  if (typeof payload.owner === "string" && payload.owner.length > 0) r.owner = payload.owner;
});
if (!claimWritten) return { ok: false, error: "claim-write-failed" };
```

- [ ] **Step 6: `create.ts` final flip aborts on a dropped write**

```ts
// create.ts, replacing the final saveRegistry
const finalTrees = loadRegistry(repoName).map((t) => (t.path === path ? updated : t));
if (!saveRegistry(repoName, finalTrees)) {
  log.warn({ repo: repoName, tree: name, path }, "worktree create: final registry flip dropped; leaving row creating");
  return { ok: false, error: "create-failed", failedStep: "registry-flip" };
}
```

- [ ] **Step 7: Write the integration test** (busy at flip → tree not scrapped)

```ts
// registry-critical.test.ts (add) — use the reconciler's onAfterLoad seam + a busy-injecting db to assert a completed tree is not scrapped and a claimed tree is not re-handed. Model on lib/worktree/__tests__ existing db-stub helpers.
```

- [ ] **Step 8: Run and commit**

Run: `bun test lib/worktree lib/state` then `bunx tsc --noEmit`
```bash
git add lib/state/kv-blob.ts lib/worktree/registry.ts lib/endpoint/store.ts lib/state/endpoint-claims-store.ts lib/daemon/handlers/worktree.ts lib/worktree/create.ts lib/worktree/__tests__/registry-critical.test.ts
git commit -m "S025: route registry and claim writes through runCriticalWrite; destructive callers abort on a dropped write"
```

---

## Task 4: S017/S018 — process-kill correctness

**Files:**
- Modify: `lib/daemon/worktree-process-kill.ts:96-113` (`selectKillTargets`), `:128-181` (`killWorktreeProcesses`)
- Modify: `lib/daemon/worktree-reconciler.ts:435-450` (`autoReturnMain` passes sibling paths)
- Modify: `lib/worktree/dispose.ts:236-245` (thread caller pids)
- Modify: `commands/worktree.ts:389-395` (add `callerPid`), `lib/daemon/handlers/worktree.ts` `disposeDeps`
- Test: `lib/daemon/__tests__/worktree-process-kill.test.ts` (existing; add cases)

**Interfaces:**
- Changed: `killWorktreeProcesses(worktreePath, opts?: { callerPids?: number[]; excludePaths?: string[] }): Promise<WorktreeKillResult>`.
- `DisposeDeps` gains `callerPids?: number[]`.

- [ ] **Step 1: Write failing tests** for the spared set and the caller-pid protection

```ts
// worktree-process-kill.test.ts (add)
import { selectKillTargets } from "../worktree-process-kill.ts";
const row = (pid, comm, full = comm, ppid = 1) => ({ pid, ppid, command: comm, fullCommand: full });
test("multiplexers, remote shells, and editors are spared", () => {
  const rows = [row(10,"tmux"), row(11,"ssh"), row(12,"nvim"), row(13,"node","node server.js")];
  const killed = selectKillTargets(rows).map(t => t.pid);
  expect(killed).toEqual([13]);
});
test("caller pid and its descendants are spared", () => {
  const rows = [row(100,"rt","rt worktree dispose"), row(101,"node","node x", 100), row(200,"node","node dev")];
  const killed = selectKillTargets(rows, { protectedPids: [100] }).map(t => t.pid);
  expect(killed).toEqual([200]);
});
```

- [ ] **Step 2: Run to verify failure** (`tmux`/`ssh`/`nvim` currently killed)

Run: `bun test lib/daemon/__tests__/worktree-process-kill.test.ts -t "spared"`
Expected: FAIL.

- [ ] **Step 3: Add the spared set to `selectKillTargets`**

```ts
// worktree-process-kill.ts, near SHELL_BINS
const SPARED_BINS = new Set(["tmux","screen","ssh","mosh","vim","nvim","emacs","less","man"]);

// inside selectKillTargets' filter, after the SHELL_BINS check:
if (SPARED_BINS.has(proc.command) || SPARED_BINS.has(basename(proc.fullCommand.split(" ")[0] ?? ""))) return false;
```

(The caller-pid case already works through `opts.protectedPids`; the second test passes once the harness supplies it.)

- [ ] **Step 4: Thread caller pids and exclude nested trees in `killWorktreeProcesses`**

```ts
import { realpathSync } from "fs";
function safeRealpath(p: string): string { try { return realpathSync(p); } catch { return p; } }

export async function killWorktreeProcesses(
  worktreePath: string,
  opts: { callerPids?: number[]; excludePaths?: string[] } = {},
): Promise<WorktreeKillResult> {
  const target = safeRealpath(worktreePath);
  const excludes = (opts.excludePaths ?? []).map(safeRealpath)
    .filter((e) => e === target || e.startsWith(target + "/")); // only nested trees matter
  // ... lsof unchanged, then when filtering cwdMap:
  for (const [pid, raw] of cwdMap) {
    const cwd = safeRealpath(raw);
    const insideTarget = cwd === target || cwd.startsWith(target + "/");
    // A cwd owned by a MORE specific nested tree belongs to that tree, not this one.
    const ownedByNested = excludes.some((e) => cwd === e || cwd.startsWith(e + "/"));
    if (!insideTarget || ownedByNested) cwdMap.delete(pid);
  }
  // ...
  const targets = selectKillTargets(rows, {
    protectedPids: [process.pid, process.ppid, ...(opts.callerPids ?? [])],
  });
  // before the SIGTERM loop, log the non-package-script targets at warn:
  log.warn({ worktreePath, targets: targets.map(t => ({ pid: t.pid, comm: t.command })) }, "worktree process kill: SIGTERM targets");
```

- [ ] **Step 5: `autoReturnMain` passes sibling registry paths; `disposeTree` passes caller pids**

In `autoReturnMain` (worktree-reconciler.ts:445), compute the other registered trees and pass them:

```ts
const siblings = loadRegistry(repoName).filter((t) => t.path !== rec.path).map((t) => t.path);
const { terminated } = await killWorktreeProcesses(rec.path, { excludePaths: siblings });
```

In `disposeTree` (dispose.ts:238), thread `deps.callerPids`:

```ts
const { terminated } = await killWorktreeProcesses(rec.path, { callerPids: deps.callerPids });
```

Add `callerPids?: number[]` to `DisposeDeps`, set it in `disposeDeps(...)` from `opts` (which reads `payload.callerPid`), and add `payload.callerPid = process.pid;` in `commands/worktree.ts` dispose payload.

- [ ] **Step 6: Write the nested-tree exclusion test** (fixture with a main cwd and a nested tree cwd)

```ts
// worktree-process-kill.test.ts — since killWorktreeProcesses spawns lsof/ps,
// extract the cwd-attribution filter into a pure helper attributeCwds(target, excludes, cwdMap)
// and unit-test it: a cwd under <target>/.worktrees/other is excluded when other is in excludes.
```

- [ ] **Step 7: Run and commit**

Run: `bun test lib/daemon/__tests__/worktree-process-kill.test.ts` then `bunx tsc --noEmit`
```bash
git add lib/daemon/worktree-process-kill.ts lib/daemon/worktree-reconciler.ts lib/worktree/dispose.ts commands/worktree.ts lib/daemon/handlers/worktree.ts lib/daemon/__tests__/worktree-process-kill.test.ts
git commit -m "S017/S018: kill scoped to the exact tree (realpath, nested-tree exclusion), caller pid and multiplexers/editors spared"
```

---

## Task 5: S019 — never pop a stash this pass did not push

**Files:**
- Modify: `lib/worktree/git-async.ts:187-196` (`stashChangesAsync` returns the result)
- Modify: `lib/daemon/worktree-reconciler.ts:744-776` (`freshenOne` stash discipline)
- Test: `lib/daemon/__tests__/` freshen stash test (new or existing reconciler test file)

**Interfaces:**
- Changed: `stashChangesAsync(cwd, label, opts?): Promise<GitResult>` (was `Promise<void>`).

- [ ] **Step 1: Write the failing test** (push fails, pre-existing stash survives, no pop issued)

```ts
// model on existing reconciler tests with an injected runGit. Assert: when the
// stash push returns exitCode !== 0, freshenOne calls fail() and returns false,
// and no "stash pop" git call is issued.
```

- [ ] **Step 2: Run to verify failure**

Expected: FAIL, current code pops `stash@{0}` unconditionally.

- [ ] **Step 3: Make `stashChangesAsync` return the git result**

```ts
export async function stashChangesAsync(cwd: string, label: string, opts: { timeoutMs?: number } = {}): Promise<GitResult> {
  const message = `!!GitHub_Desktop<${label}>`;
  return runGit(cwd, ["stash", "push", "-u", "-m", message], { timeoutMs: opts.timeoutMs ?? MUTATING_TIMEOUT_MS });
}
```

- [ ] **Step 4: Rework the `freshenOne` stash block** (remove the positional fallback; abort on push failure; re-check clean before ff)

```ts
let stashName: string | null = null;
const label = rec.branch ?? rec.name;
if (classify.blockers.length > 0) {
  const push = await stashChangesAsync(rec.path, label);
  if (push.exitCode !== 0) {
    log.warn({ ...fields, output: push.stderr.trim() }, "freshen: stash push failed; leaving tree and stash untouched");
    fail();
    return false;
  }
  const resolved = await findDesktopStashAsync(rec.path, label);
  if (!resolved) {
    log.warn({ ...fields }, "freshen: stash push reported success but its marker could not be resolved; aborting without a pop");
    fail();
    return false;
  }
  stashName = resolved.name; // never a positional stash@{0} fallback
  // Confirm the tree actually cleared before the ff (mirrors autoReturnMain).
  const after = await runGit(rec.path, ["status", "--porcelain"], { timeoutMs: MUTATING_TIMEOUT_MS });
  if (after.exitCode !== 0 || after.stdout.trim().length > 0) {
    log.warn({ ...fields }, "freshen: stash did not clear the worktree; aborting");
    await popStash();
    fail();
    return false;
  }
}
```

- [ ] **Step 5: Run tests, add a grep-guard**

Run: `bun test lib/daemon/__tests__` and `grep -n 'stash@{0}' lib/daemon/worktree-reconciler.ts` (expect no hits).

- [ ] **Step 6: Commit**

```bash
git add lib/worktree/git-async.ts lib/daemon/worktree-reconciler.ts lib/daemon/__tests__/
git commit -m "S019: freshen never falls back to a positional stash ref; a failed push aborts the pass"
```

---

## Task 6: S064 — do not stash the user's live main checkout

**Files:**
- Modify: `lib/daemon/worktree-reconciler.ts:678-699` (`freshenCandidate` gate), `:744-807` (`freshenOne` main abort + pop event)
- Test: reconciler test file

**Interfaces:**
- Consumes: `loadWorktreeAppConfig` (already imported), `emit`.

- [ ] **Step 1: Write the failing test** (main with blockers after fetch aborts without stashing; a dormant machine never freshens main)

- [ ] **Step 2: Run to verify failure**

- [ ] **Step 3: Gate idle-main freshen behind `enabled`**

```ts
// freshenCandidate, in the kind === "main" branch, before the blockers read:
if (!loadWorktreeAppConfig().enabled) return false; // idle-main freshen touches the user's checkout: opt-in only
```

- [ ] **Step 4: Re-check blockers for main right before the merge and abort (no stash)**

```ts
// freshenOne, after the discard reset, before the stash block:
if (rec.kind === "main") {
  const recheck = await classifyDirtyAsync(rec.path);
  if (recheck.blockers.length > 0) {
    log.info({ ...fields }, "freshen: main gained uncommitted work during the fetch window; leaving it untouched");
    return false; // not a failure to back off on: the user is editing
  }
}
```

- [ ] **Step 5: A failed pop is a hard failure with a user-visible event**

```ts
const popStash = async (): Promise<boolean> => {
  if (!stashName) return true;
  const pop = await runGit(rec.path, ["stash", "pop", stashName], { timeoutMs: MUTATING_TIMEOUT_MS });
  if (pop.exitCode !== 0) {
    log.warn({ ...fields, stashName }, `freshen: stash ${stashName} did not reapply cleanly`);
    emit("worktree:stash-conflict", { repo: repoName, tree: rec.name, path: rec.path, stashName });
    return false;
  }
  return true;
};
// at the post-ff pop: if (!(await popStash())) { fail(); return false; }
```

- [ ] **Step 6: Run and commit**

Run: `bun test lib/daemon/__tests__` then `bunx tsc --noEmit`
```bash
git add lib/daemon/worktree-reconciler.ts lib/daemon/__tests__/
git commit -m "S064: idle-main freshen is opt-in and aborts on live edits; failed pop emits a user-visible event"
```

---

## Task 7: R040 — dispose re-reads the record under the lock

**Files:**
- Modify: `lib/worktree/dispose.ts:180-200` (re-read + compare at the top of `disposeTree`)
- Test: `lib/worktree/__tests__/dispose.test.ts`

**Interfaces:** none changed (guard is internal).

- [ ] **Step 1: Write the failing test** (a stale snapshot whose state changed under the lock is refused `changed`)

```ts
// dispose.test.ts — load a registry with a tree, mutate its state on disk
// (simulate a concurrent claim), call disposeTree with the OLD snapshot, assert
// { disposed: false, refusal: "changed" } and that nothing was trashed.
```

- [ ] **Step 2: Run to verify failure**

- [ ] **Step 3: Add the re-read guard at the top of `disposeTree`** (after `refuse` is defined)

```ts
const fresh = findByPath(loadRegistry(repoName), rec.path);
if (!fresh || fresh.kind !== rec.kind || fresh.state !== rec.state || fresh.branch !== rec.branch || fresh.owner !== rec.owner) {
  return refuse("changed");
}
rec = fresh; // act on the lock-scoped truth, not the pre-lock snapshot
```

(Import `findByPath`, `loadRegistry`. `rec` is a parameter; reassign locally or use a `const current = fresh`.)

- [ ] **Step 4: Run and commit**

Run: `bun test lib/worktree/__tests__/dispose.test.ts`
```bash
git add lib/worktree/dispose.ts lib/worktree/__tests__/dispose.test.ts
git commit -m "R040: disposeTree re-reads the registry record under the lock and refuses a changed tree"
```

---

## Task 8: S063 — a missing path is held, not pruned

**Files:**
- Modify: `lib/worktree/registry.ts:9-24` (`TreeRecord.missCount`)
- Modify: `lib/daemon/worktree-reconciler.ts:194-217` (prune loop hold), `:139` (skip git prune when a root is unreadable)
- Modify: `lib/worktree/create.ts`/`trash.ts` (`scrapTree` collision guard)
- Test: reconciler test file

**Interfaces:**
- `TreeRecord` gains `missCount?: number` (free JSON field).
- Produces: `const MISSING_PRUNE_PASSES = 3;` in `worktree-reconciler.ts`.

- [ ] **Step 1: Write the failing test** (a path absent for one pass keeps its row; dropped only after 3)

- [ ] **Step 2: Run to verify failure**

- [ ] **Step 3: Add `missCount` to `TreeRecord`** and the constant

```ts
// registry.ts TreeRecord
missCount?: number; // consecutive reconcile passes the path was absent (S063 hold)
// worktree-reconciler.ts
const MISSING_PRUNE_PASSES = 3; // ~15 min at the 5-min cadence: rides out a transient unmount, still cleans a real removal within a cache window
```

- [ ] **Step 4: Rework the step-(a) prune loop to hold**

```ts
for (const rec of trees) {
  if (rec.state === "creating") { afterPrune.push(rec); continue; }
  if (gitByCanon.has(canon(rec.path))) {
    if (rec.missCount) { delete rec.missCount; changed = true; }
    afterPrune.push(rec);
  } else {
    const misses = (rec.missCount ?? 0) + 1;
    if (misses < MISSING_PRUNE_PASSES) {
      rec.missCount = misses; changed = true; afterPrune.push(rec);
      log.info({ repo: repoName, tree: rec.name, path: rec.path, misses }, "reconcile: worktree path missing, holding");
    } else {
      log.info({ repo: repoName, tree: rec.name, path: rec.path }, "reconcile: pruning registry entry after sustained absence");
      changed = true; // dropped
    }
  }
}
```

- [ ] **Step 5: Skip the unconditional `git worktree prune` when a registered root is unreadable**

```ts
// before line 139's runGit(repoPath, ["worktree", "prune"])
const rootsReadable = loadRegistry(repoName).every((t) => t.state === "creating" || existsSync(dirname(t.path)));
if (rootsReadable) {
  await runGit(repoPath, ["worktree", "prune"]);
} else {
  log.info({ repo: repoName }, "reconcile: a pool root is unreadable this pass; skipping git worktree prune");
}
```

- [ ] **Step 6: Guard `scrapTree`'s rm -rf** against a directory it did not create (check it is a git worktree with no unexpected content before trashing). Add the check in `scrapTree` before the trash rename.

- [ ] **Step 7: Run and commit**

Run: `bun test lib/daemon/__tests__ lib/worktree` then `bunx tsc --noEmit`
```bash
git add lib/worktree/registry.ts lib/daemon/worktree-reconciler.ts lib/worktree/create.ts lib/worktree/trash.ts lib/daemon/__tests__/
git commit -m "S063: reconcile holds a transiently-missing path for 3 passes instead of pruning it"
```

---

## Task 9: S056 — adopt leaves foreign trees unmanaged; `--claim` opts in

**Files:**
- Modify: `commands/worktree.ts:157-167` (`AdoptArgs.claim`, `parseAdoptArgs`), `:488-497` (payload)
- Modify: `lib/daemon/handlers/worktree.ts:616-691` (adopt classification)
- Modify: `lib/command-tree-def.ts:589-597` (`adopt` `--claim` flag)
- Test: `lib/daemon/__tests__/worktree-handlers.test.ts:570-605` (flip the existing assertion)

**Interfaces:**
- `AdoptArgs` gains `claim: boolean`; adopt payload gains `claim?: boolean`.

- [ ] **Step 1: Flip the failing test** (a foreign hand-made tree survives adopt as `unmanaged` without `--claim`)

```ts
// worktree-handlers.test.ts: change the assertion from kind:"ephemeral",disposal:"merge"
// to kind:"unmanaged" for the plain hand-made worktree; add a second case passing
// claim:true that asserts kind:"ephemeral".
```

- [ ] **Step 2: Run to verify failure**

- [ ] **Step 3: Add `--claim` to `parseAdoptArgs`**

```ts
export interface AdoptArgs { repoName?: string; json: boolean; claim: boolean; }
export function parseAdoptArgs(args: string[]): AdoptArgs {
  let rest = args;
  const json = takeBoolFlag(rest, "--json"); rest = json.rest;
  const claim = takeBoolFlag(rest, "--claim"); rest = claim.rest;
  const repo = takeFlag(rest, "--repo"); rest = repo.rest;
  return { repoName: repo.value, json: json.present, claim: claim.present };
}
// worktreeAdopt: daemonQuery("worktree:adopt", { repoName, claim: parsed.claim }, ADOPT_TIMEOUT_MS)
```

- [ ] **Step 4: Adopt handler leaves foreign trees unmanaged unless `claim`**

Replace the final foreign-promotion `patchTree` block (worktree.ts:683-690) with:

```ts
if (payload?.claim === true) {
  patchTree(repoName, rec.path, (r) => { r.kind = "ephemeral"; r.state = "claimed"; r.disposal = "merge"; r.claimedAt = new Date().toISOString(); });
  claimed.push(rec.name);
} else {
  // Left as reconcileRepoRegistry stamped it: kind "unmanaged", never auto-disposed.
  unmanaged.push(rec.name);
}
```

Add `const unmanaged: string[] = [];` and include it in the returned data. Update the command's output to name each tree's resulting kind (human + `--json`).

- [ ] **Step 5: Add the `--claim` flag to `command-tree-def.ts` adopt node**

```ts
{ name: "Claim", flag: "--claim", type: "boolean", default: false, hint: "Take ownership: adopt foreign worktrees as auto-disposing ephemerals (default: leave them unmanaged, untouched)" },
```

- [ ] **Step 6: Run, regenerate docs, commit**

Run: `bun test lib/daemon/__tests__/worktree-handlers.test.ts`, `bun run picker:check`, `bun run docs:gen && bun run docs:check`
```bash
git add commands/worktree.ts lib/daemon/handlers/worktree.ts lib/command-tree-def.ts lib/daemon/__tests__/worktree-handlers.test.ts website/
git commit -m "S056: adopt leaves foreign worktrees unmanaged; --claim opts a tree into ephemeral ownership"
```

---

## Task 10: S077 — on-deck consent gate, ceiling, disk precheck, dormant surfacing

**Files:**
- Modify: `lib/worktree/config.ts:364` (`APP_CONFIG_DEFAULTS`), add ceiling constant
- Modify: `lib/daemon/worktree-reconciler.ts:935-987` (`replenishAndShrink` ceiling + disk precheck)
- Modify: `lib/daemon/handlers/worktree.ts` (`worktree:list` dormant field) and the daemon status handler
- Test: `lib/worktree/__tests__/config.test.ts`, reconciler test

**Interfaces:**
- Produces: `const WORKTREE_MIN_FREE_DISK_GB = 5;`, `const WORKTREE_ONDECK_CEILING = <n>;`.

- [ ] **Step 1: Write failing tests** (unowned machine defaults `enabled:false`; a team-only onDeck stays dormant; below-threshold disk skips create)

- [ ] **Step 2: Run to verify failure**

- [ ] **Step 3: Flip the unowned default**

```ts
// config.ts — unowned machines start disabled; a machine that explicitly set it, or a legacy parking-lot.json, keeps its value via the ownership latch.
const APP_CONFIG_DEFAULTS: WorktreeAppConfig = { enabled: false, killProcesses: true };
```

(Confirm `loadWorktreeAppConfig` still returns the store/legacy value when owned; only the unowned/no-legacy-file default changes.)

- [ ] **Step 4: Add the ceiling and disk precheck to `replenishAndShrink`**

```ts
const WORKTREE_ONDECK_CEILING = 5; // machine-side clamp: no team declaration builds more than this on one laptop
const WORKTREE_MIN_FREE_DISK_GB = 5; // room for one tree plus a multi-GB monorepo install's transient peak (2026-08-21 wedge profile)

// in replenishAndShrink, after loading cfg:
const onDeck = Math.min(cfg.onDeck, WORKTREE_ONDECK_CEILING);
if (onDeck <= 0) return;
// before each createTree in the loop:
if (!(await hasFreeDiskGb(repoPath, WORKTREE_MIN_FREE_DISK_GB))) {
  log.warn({ repo: repoName }, "replenish: skipped, free disk below threshold");
  break;
}
```

Add a `hasFreeDiskGb(path, gb)` helper (async `runCapture(["df","-k",path])` parse, or `statfsSync`).

- [ ] **Step 5: Surface the dormant state**

In `worktree:list` output and `rt daemon status`: when `worktreeSettingsDeclared(...)` is true but `loadWorktreeAppConfig().enabled` is false, add a `dormant: true` field and a message naming the exact enable command (`rt settings set rt.worktreeApp '{"enabled":true}' --scope machine`).

- [ ] **Step 6: Run, docs, commit**

Run: `bun test lib/worktree lib/daemon/__tests__`, `bun run docs:gen && bun run docs:check` if status/list output text changed.
```bash
git add lib/worktree/config.ts lib/daemon/worktree-reconciler.ts lib/daemon/handlers/worktree.ts lib/worktree/__tests__/ lib/daemon/__tests__/ website/
git commit -m "S077: on-deck pool is opt-in on unowned machines, capped, disk-gated, and dormant-state is surfaced"
```

---

## Task 11: S068 — endpoint claim liveness by process start-time

**Files:**
- Modify: `lib/state/db.ts` (add `ensureEndpointClaimsStartTimeColumn`, call from `openStateDb` after `runMigrations`)
- Modify: `lib/state/endpoint-claims-store.ts` (`startTime` plumbing, SQL)
- Modify: `lib/endpoint/allocator.ts` (Probes `pidStartTime`, `isLiveClaim` TTL, capture at claim)
- Modify: `commands/endpoint.ts` (`endpointRelease`), `lib/command-tree-def.ts:113-124` (release leaf)
- Test: `lib/endpoint/__tests__/allocator.test.ts`, a db-column test

**Interfaces:**
- `EndpointClaim` gains `startTime?: string`.
- `Probes` gains `pidStartTime(pid: number | undefined): string | undefined`.
- Produces: `const CLAIM_TRUST_TTL_MS = 12 * 60 * 60 * 1000;` (a legacy NULL-start-time claim with a live pid is trusted only within this window).

- [ ] **Step 1: Write the failing column test** (a machine already at v9 gains the column on open)

```ts
// assert PRAGMA table_info(endpoint_claims) includes start_time after openStateDb on a temp db.
```

- [ ] **Step 2: Run to verify failure**

- [ ] **Step 3: Add the unconditional column guard**

```ts
// db.ts, modeled on addSectionsColumnIfMissing but called from openStateDb, NOT runMigrations
function ensureEndpointClaimsStartTimeColumn(db: Database): void {
  const columns = db.query("PRAGMA table_info(endpoint_claims);").all() as { name: string }[];
  if (columns.some((c) => c.name === "start_time")) return;
  db.exec("ALTER TABLE endpoint_claims ADD COLUMN start_time TEXT;");
}
// in openStateDb, right after runMigrations(db, dirname(path)):
ensureEndpointClaimsStartTimeColumn(db);
```

- [ ] **Step 4: Plumb `startTime` through the store**

```ts
// endpoint-claims-store.ts: add startTime to EndpointClaim + ClaimRow, SELECT/INSERT SQL,
// rowToClaim (set startTime when row.start_time !== null), and the INSERT bind list.
```

- [ ] **Step 5: Write the failing liveness tests** (start-time mismatch = dead; NULL within TTL = live; NULL beyond TTL = dead)

- [ ] **Step 6: Add the probe and TTL-aware `isLiveClaim`**

```ts
// allocator.ts
export interface Probes {
  listeners: Set<number>;
  pidAlive(pid: number | undefined): boolean;
  pidStartTime(pid: number | undefined): string | undefined;
  canBind(port: number): boolean;
}
const CLAIM_TRUST_TTL_MS = 12 * 60 * 60 * 1000;

export function isLiveClaim(c: EndpointClaim, probes: Probes, now: number = Date.now()): boolean {
  if (probes.listeners.has(c.port)) return true;
  if (!probes.pidAlive(c.pid)) return false;
  if (c.startTime === undefined) {
    const age = now - Date.parse(c.ts); // legacy row: trust a live pid only briefly
    return Number.isFinite(age) && age < CLAIM_TRUST_TTL_MS;
  }
  return probes.pidStartTime(c.pid) === c.startTime; // recycled pid = start-time mismatch = dead
}
```

`defaultProbes` scrapes all process start times once (`ps -axo pid=,lstart=`) into a `Map<number,string>`; `pidStartTime(pid) = map.get(pid)`. `resolveClaim` captures `startTime: pid !== undefined ? probes.pidStartTime(pid) : undefined` alongside `ts` (allocator.ts:117-120).

- [ ] **Step 7: Add `endpoint release`**

`endpointRelease(args)` in `commands/endpoint.ts` mirrors `endpointLookup` (resolve identity + toplevel), sends `daemonQuery("endpoint:release", { repo: identity, worktree, role }, ...)`; the picker over claimable worktrees gates on `isTTY && !json && !RT_BATCH`. Add the `release` node to `endpointSubcommands` with `omitBehavior: "picker"` and a required `Worktree` positional.

- [ ] **Step 8: Run, docs, commit**

Run: `bun test lib/endpoint lib/state`, `bunx tsc --noEmit`, `bun run picker:check`, `bun run docs:gen && bun run docs:check`
```bash
git add lib/state/db.ts lib/state/endpoint-claims-store.ts lib/endpoint/allocator.ts commands/endpoint.ts lib/command-tree-def.ts lib/endpoint/__tests__/ lib/state/__tests__/ website/
git commit -m "S068: endpoint liveness compares process start-time (recycled pid reads dead); rt endpoint release escape hatch"
```

---

## Task 12: RT-51 — durable disposal manifest and `rt worktree restore`

**Files:**
- Create: `lib/worktree/restore.ts`, `lib/worktree/__tests__/restore.test.ts`, `lib/worktree/__tests__/manifest.test.ts`
- Modify: `lib/worktree/dispose.ts` (write `manifest.json` into the retained entry)
- Modify: `lib/worktree/trash.ts` (`reapExpiredTrash` honors `keptUntil` from the manifest)
- Modify: `lib/daemon/handlers/worktree.ts` (`worktree:restore` handler)
- Modify: `commands/worktree.ts` (`worktreeRestore`), `lib/command-tree-def.ts` (`restore` leaf)

**Interfaces:**
- Produces: `interface DisposalManifest { name: string; originalPath: string; branch: string | null; headSha: string | null; reason: string; disposedAt: string; keptUntil: string; }`.
- Produces: `worktree:restore` payload `{ repoName, tree }` → `{ ok, data: { restored, path } }`.

- [ ] **Step 1: Write the failing manifest test** (dispose writes `manifest.json` inside the retained entry)

- [ ] **Step 2: Run to verify failure**

- [ ] **Step 3: Write the manifest at dispose time**

In `disposeTree`, after a successful `retireTree` with `retained: true`, before/with `stripTrashDir`, write `join(trashed.trashPath, "manifest.json")` with the `DisposalManifest` (capture `headSha` via `headSha(rec.path)` BEFORE the rename, and `branch`, `reason`). The manifest lives inside the entry so it survives a `state.db` quarantine; an optional kv index (ns `worktree-trash`, key repo) mirrors entries for fast listing.

- [ ] **Step 4: `reapExpiredTrash` honors `keptUntil`**

Read `manifest.json` in each entry; if present, reap by `keptUntil` (not just the epoch in the name); a missing manifest falls back to the epoch rule. This lets a restore extend or clear retention.

- [ ] **Step 5: Write the failing restore test** (restore rehydrates into the pool root, re-registers, refuses when the branch exists elsewhere)

- [ ] **Step 6: Implement `lib/worktree/restore.ts`**

```ts
export async function restoreTree(deps: { repoName: string; repoPath: string; emit; log }, treeName: string): Promise<RestoreResult> {
  // 1. find the retained entry + manifest (scan retention roots, newest epoch wins)
  // 2. refuse if manifest.branch now exists elsewhere (git branch --list / worktree list) -> { ok:false, reason:"branch-elsewhere" }
  // 3. recreate the branch from manifest.headSha if gone; git worktree add <poolRoot>/<name> <branch>
  // 4. copy the retained (stripped) tree's gitignored/untracked content back over the checkout
  // 5. re-register the TreeRecord (kind ephemeral, state claimed) via saveRegistry
  // 6. clear the entry's keptUntil (or delete the retained dir) and the kv index row
  // 7. re-run ready steps for the stripped reinstallables
}
```

- [ ] **Step 7: Wire the daemon handler and CLI verb**

`worktree:restore` handler in `handlers/worktree.ts` (inherits `handleCommand`) calls `restoreTree` under `withTreeLock`. `worktreeRestore(args)` in `commands/worktree.ts` sends it; the `restore` leaf in `command-tree-def.ts` declares `omitBehavior: "picker"` with a required `Tree` positional and the `isTTY && !json && !RT_BATCH` picker over restorable entries. `commands/worktree.ts` is already in `lib/module-registry.ts`, so no registry entry is needed.

- [ ] **Step 8: Run, docs, commit**

Run: `bun test lib/worktree`, `bunx tsc --noEmit`, `bun run picker:check`, `bun run docs:gen && bun run docs:check`
```bash
git add lib/worktree/restore.ts lib/worktree/dispose.ts lib/worktree/trash.ts lib/daemon/handlers/worktree.ts commands/worktree.ts lib/command-tree-def.ts lib/worktree/__tests__/ website/
git commit -m "RT-51: durable disposal manifest and rt worktree restore"
```

---

## Task 13: Full verification and docs consolidation

**Files:** regenerated `website/` reference; no new source.

- [ ] **Step 1: Regenerate and check docs**

Run: `bun run docs:gen && bun run docs:check`
Expected: clean; commit any regenerated reference not already committed.

- [ ] **Step 2: Picker conformance**

Run: `bun run picker:check`
Expected: green (covers the new `--claim`, `restore`, `endpoint release`).

- [ ] **Step 3: Types and unit suites**

Run: `bunx tsc --noEmit` then `bun test lib commands packages scripts`
Expected: zero type errors; all green. Fix regressions before proceeding.

- [ ] **Step 4: Repo purity**

Run: `scripts/repo-purity.sh`
Expected: green.

- [ ] **Step 5: E2E daemon + worktree verbs**

Run: `rm -f dist/rt` then `bun test --preload ./e2e/setup.ts --timeout 60000 e2e/tests/daemon.test.ts` and any worktree-verb e2e test (`bun run test:e2e` if practical). State which ran in the report.
Expected: green. Restart any e2e daemon fixture so new handlers (`worktree:restore`, `endpoint:release`) are loaded.

- [ ] **Step 6: rt-client build (only if `packages/rt-client` was touched)**

Run: `cd packages/rt-client && bun run build` (this phase does not expect to touch it; run only if a diff shows otherwise).

- [ ] **Step 7: Commit any regenerated artifacts**

```bash
git add website/
git commit -m "docs: regenerate command reference for phase 4"
```

## Self-Review notes

- Spec coverage: every in-scope finding maps to a task (S017/S018 → 4; S019 → 5; S064 → 6; S025 → 3; R040 → 7; S063 → 8; S078/S079 → closed by wave 1, re-verified in Task 2's relocation; S068 → 11; S056 → 9; S077 → 10; RT-52 → 1+2; RT-51 → 12).
- No SCHEMA_VERSION bump: the only DDL is the `start_time` column, added unconditionally from `openStateDb` (Task 11 Step 3).
- Naming consistency: `killWorktreeProcesses(path, opts)`, `saveRegistry(): boolean`, `retainedTrashRoot(poolRoot)`, `isLiveClaim(c, probes, now?)`, `restoreTree(deps, treeName)` are used consistently across the tasks that reference them.
