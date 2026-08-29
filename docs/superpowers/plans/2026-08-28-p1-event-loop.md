# Phase 1 · Event-Loop Sacred Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Excise every synchronous subprocess call from daemon-reachable code, make `runCapture`'s timeout actually enforceable, add an import-graph gate that keeps sync-exec dead, and stop the coalesced refresh and background scans from wedging or taxing the event loop.

**Architecture:** Route all daemon-thread subprocess work through the existing async helpers (`runCapture` in `lib/subprocess.ts`, `runGit`/`listWorktreesAsync` in `lib/worktree/git-async.ts`). Harden `runCapture` so a pipe-holding grandchild can no longer hold its promise open. Add a source-graph test that walks the daemon's import tree and fails on any sync-exec import. Bound the refresh cycle and the provider cache, and gate/cheapen the periodic scans.

**Tech Stack:** Bun 1.3.13, TypeScript (strict), `bun:test`, `bun:sqlite`, pino. `@mattstack/glance` provides `GitLabProvider`.

**Spec:** `/Users/matt/Documents/GitHub/repo-tools/.claude/worktrees/daemon-stability-audit/docs/daemon-stability-audit-2026-08.md` ... "Roadmap > Phase 1" (items 1.1-1.5) plus Appendix A/B for each finding (S007, S008, S015, S016, S021, S023, S024, S038, S039, S045, S048, S049, S055, S058, S061, S093, S098, S101, S104, R032).

## Global Constraints

- **Isolated HOME for any binary run.** Never start a daemon or run `dist/rt` against the real machine. Any daemon or `dist/rt` invocation runs under `env -i HOME=<temp dir>` only. Tests use `bun:test` with tmp HOME/`RT_RUNS_ROOT` fixtures ... never touch the developer's `~/.mattstack` or `~/.rt`.
- **Write fence.** These sibling-owned files must NOT be modified this run: `cli.ts`, `lib/daemon.ts`, `lib/daemon/park.ts`, `lib/daemon/boot-reconcile.ts`, `lib/daemon/boot-migrate.ts`, `lib/daemon/shutdown.ts`, `lib/daemon-logger.ts`, `lib/daemon-config.ts`, `lib/daemon-status.ts`, `commands/daemon.ts`, `lib/daemon/events-bus.ts`, `lib/daemon/home-snapshot.ts`, `lib/daemon/handlers/status.ts`, `lib/state/*`, `rt-tray/**`, `lib/daemon/api-server.ts`, `lib/daemon/api-auth.ts`, `lib/daemon/socket-server.ts`, `lib/daemon/handlers/secrets.ts`, `lib/notifier.ts`, `lib/daemon/handlers/discussions.ts`, `lib/daemon/handlers/chat.ts`, `lib/daemon/handlers/agent.ts`, `lib/daemon/handlers/pane.ts`, `lib/daemon/handlers/project-mrs.ts`, `lib/daemon/handlers/worktree.ts`, `lib/herdr/client.ts`, `lib/port-scanner.ts`, `lib/deps/links.ts`, `lib/worktree/trash.ts`, `lib/agent-herdr.ts`, `lib/daemon/cron.ts`, `lib/daemon/hooks-guard.ts`, `lib/home/age-key.ts`, `lib/daemon/discussions-store.ts`.
- **S055 carve-out.** `lib/daemon/handlers/status.ts` is sibling-owned. Do NOT edit it. The async replacement it needs (`listWorktreesAsync`) already lives in a file we own (`lib/worktree/git-async.ts`). The one-line call-site swap is documented in the report Notes, not applied here. The import-graph gate (Task 7) allowlists `status.ts` with a comment naming S055.
- **rt-client mirror.** `packages/rt-client/src/settings/exec.ts` is a byte-for-byte mirror of `lib/subprocess.ts`'s `runCapture`. Change `lib/subprocess.ts` first, mirror there, then run `bun run build` inside `packages/rt-client` (its `dist/` is gitignored and copied verbatim by `file:` consumers; `packages/rt-client/test/dist-freshness.test.ts` fails otherwise).
- **Canonical fixtures.** `listWorktreesAsync` returns git's canonicalized paths (`/private/var/...` on macOS tmpdirs). Tests that build temp repos must compare against `realpathSync`'d paths.
- **Subagent models.** Every subagent dispatched during execution carries an explicit `model` (`sonnet` for mechanical tasks, `haiku` for lookups).
- **Verification (all must pass before done):** `bun test lib commands packages scripts` green; `bunx tsc --noEmit` zero errors; the Task 7 gate passes AND is proven to fail when a forbidden import is reintroduced (show the RED run in the report).
- **Comments:** clean-code rules. A comment states a constraint the code cannot show (a parity anchor, an ordering trap, a non-obvious invariant). No narration, no finding IDs in source. No em dashes.

---

### Task 1: Make `runCapture`'s timeout enforceable (S023, S024)

`runCapture` awaits `new Response(proc.stdout).text()` unconditionally after the kill timer fires; a grandchild that inherited the pipe keeps that read pending forever, so the promise never settles and every in-flight guard latches. Fix: race the reads against the deadline so `runCapture` always settles within `timeoutMs`, and escalate SIGTERM→SIGKILL on the child. (Group-kill via `process.kill(-pid)` is NOT reliable on Bun 1.3.13 ... verified ESRCH once the direct child exits ... so this uses the race as the load-critical fix, per the S023 fixer note that racing the reads is mandatory and kill escalation is belt-and-suspenders. A surviving grandchild leaks its fd until the OS reaps it, which the audit accepts.)

**Files:**
- Modify: `lib/subprocess.ts` (the `runCapture` body and `RunResult`)
- Mirror: `packages/rt-client/src/settings/exec.ts` (byte-for-byte)
- Test: `lib/__tests__/subprocess.test.ts` (create if absent)

**Interfaces:**
- Produces: `runCapture(argv, opts) => Promise<RunResult>` where `RunResult` gains `timedOut?: boolean`. Contract unchanged otherwise: never throws; on spawn failure/timeout/read error returns `exitCode: -1` (callers already branch on `!== 0`). `timedOut: true` is additive and set only on the deadline path.

- [ ] **Step 1: Write the failing test**

Create `lib/__tests__/subprocess.test.ts`:

```ts
import { test, expect } from "bun:test";
import { runCapture } from "../subprocess.ts";

test("resolves within the deadline even when a grandchild holds the pipe", async () => {
  // zsh exits after ~0.2s, but backgrounds `sleep 20` which inherits stdout.
  const t0 = Date.now();
  const r = await runCapture(
    ["/bin/zsh", "-c", "sleep 20 & echo started; sleep 0.2"],
    { timeoutMs: 1000 },
  );
  const elapsed = Date.now() - t0;
  expect(elapsed).toBeLessThan(4000); // must NOT wait for the 20s grandchild
  expect(r.timedOut).toBe(true);
  expect(r.exitCode).toBe(-1);
});

test("a SIGTERM-ignoring child is bounded by SIGKILL escalation", async () => {
  const t0 = Date.now();
  const r = await runCapture(
    ["/bin/zsh", "-c", "trap '' TERM; sleep 20"],
    { timeoutMs: 800 },
  );
  expect(Date.now() - t0).toBeLessThan(4000);
  expect(r.timedOut).toBe(true);
});

test("normal fast command still returns real stdout and exitCode 0", async () => {
  const r = await runCapture(["/bin/echo", "hello"], { timeoutMs: 5000 });
  expect(r.stdout.trim()).toBe("hello");
  expect(r.exitCode).toBe(0);
  expect(r.timedOut).toBeUndefined();
});

test("timed-out call reports exitCode -1 so callers treat it as failure", async () => {
  const r = await runCapture(["/bin/sleep", "20"], { timeoutMs: 500 });
  expect(r.exitCode).toBe(-1);
  expect(r.timedOut).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test lib/__tests__/subprocess.test.ts`
Expected: the grandchild test FAILS (elapsed ~20s, exceeds 4000ms) or times out ... proving the current unconditional-await bug.

- [ ] **Step 3: Rewrite `runCapture` to race the reads against the deadline**

In `lib/subprocess.ts`, add `timedOut` to `RunResult` and replace the timer + read block:

```ts
export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** Set true only when the deadline fired before the child settled. */
  timedOut?: boolean;
}
```

Replace the body from the `const timer = setTimeout(...)` line through the closing of the `try/catch/finally` (lines 60-76) with:

```ts
  const timeoutMs = opts.timeoutMs ?? 10_000;
  // SIGTERM at the deadline, SIGKILL a short grace later. A child that ignores
  // SIGTERM (or a D-state descendant) cannot be reaped in-band, so the read is
  // raced against the deadline below rather than awaited unconditionally: that
  // is what lets runCapture settle while a grandchild still holds the pipe.
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const term = setTimeout(() => {
    try { proc.kill("SIGTERM"); } catch { /* already exited */ }
    killTimer = setTimeout(() => {
      try { proc.kill("SIGKILL"); } catch { /* already exited */ }
    }, 2000);
  }, timeoutMs);

  const captured: Promise<RunResult> = (async () => {
    try {
      const stdoutPromise = new Response(proc.stdout as ReadableStream).text();
      const stderrPromise = captureStderr
        ? new Response(proc.stderr as ReadableStream).text()
        : Promise.resolve("");
      const [stdout, stderr, exitCode] = await Promise.all([
        stdoutPromise,
        stderrPromise,
        proc.exited,
      ]);
      return { stdout, stderr, exitCode };
    } catch {
      return { stdout: "", stderr: "", exitCode: -1 };
    }
  })();

  const deadline: Promise<RunResult> = new Promise((resolve) => {
    setTimeout(() => resolve({ stdout: "", stderr: "", exitCode: -1, timedOut: true }), timeoutMs);
  });

  try {
    return await Promise.race([captured, deadline]);
  } finally {
    clearTimeout(term);
    if (killTimer) clearTimeout(killTimer);
  }
```

(Keep the `Bun.spawn` block above it unchanged, including the env comment.)

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test lib/__tests__/subprocess.test.ts`
Expected: PASS (all four).

- [ ] **Step 5: Mirror into rt-client and rebuild**

Apply the identical `RunResult`/body change to `packages/rt-client/src/settings/exec.ts` (its `runCapture` is the same shape; keep its own env comment). Then:

Run: `bun run build` (from `packages/rt-client/`)
Then: `bun test packages/rt-client`
Expected: `dist-freshness.test.ts` PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/subprocess.ts packages/rt-client/src/settings/exec.ts packages/rt-client/dist lib/__tests__/subprocess.test.ts
git commit -m "runCapture: race reads against the deadline so a pipe-holding grandchild can't wedge it (S023, S024)"
```

---

### Task 2: Long timeouts for mutating git verbs (S104)

Mutating git verbs (checkout, merge, stash push/pop) and `status` share the 60s `DEFAULT_TIMEOUT_MS`; a large-repo checkout gets SIGKILLed half-applied at 60s. Give them the same 5-minute budget that fetch/`worktree add` already have.

**Files:**
- Modify: `lib/worktree/git-async.ts` (add constant; thread `timeoutMs` into stash helpers and `statusPorcelainAsync`)
- Modify: `lib/daemon/worktree-reconciler.ts` (checkout/merge call sites in `freshenOne` and `autoReturnMain`)
- Test: `lib/__tests__/git-async-timeouts.test.ts` (create)

**Interfaces:**
- Produces: `export const MUTATING_TIMEOUT_MS = 5 * 60_000;` in `git-async.ts`. `stashChangesAsync(cwd, label, opts?: { timeoutMs?: number })` and `popStashAsync(cwd, stashName, opts?: { timeoutMs?: number })` now accept an optional timeout, defaulting to `MUTATING_TIMEOUT_MS`.

- [ ] **Step 1: Write the failing test**

Create `lib/__tests__/git-async-timeouts.test.ts`:

```ts
import { test, expect } from "bun:test";
import { MUTATING_TIMEOUT_MS } from "../worktree/git-async.ts";

test("mutating timeout is 5 minutes", () => {
  expect(MUTATING_TIMEOUT_MS).toBe(5 * 60_000);
});
```

Also assert the stash helper signature accepts an override (compile-time guard):

```ts
import { stashChangesAsync, popStashAsync } from "../worktree/git-async.ts";
test("stash helpers accept a timeout override", () => {
  // Type-level: these must type-check with an opts arg.
  const a: typeof stashChangesAsync = stashChangesAsync;
  const b: typeof popStashAsync = popStashAsync;
  expect(typeof a).toBe("function");
  expect(typeof b).toBe("function");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test lib/__tests__/git-async-timeouts.test.ts`
Expected: FAIL ... `MUTATING_TIMEOUT_MS` not exported.

- [ ] **Step 3: Add the constant and thread it**

In `lib/worktree/git-async.ts`, below `const DEFAULT_TIMEOUT_MS = 60_000;`:

```ts
/** Checkout/merge/stash on a large tree can legitimately exceed a minute; a
 *  60s SIGKILL leaves the working tree half-switched. Match fetch/worktree-add. */
export const MUTATING_TIMEOUT_MS = 5 * 60_000;
```

Update the helpers:

```ts
export async function statusPorcelainAsync(cwd: string): Promise<string> {
  const r = await runGit(cwd, ["status", "--porcelain"], { timeoutMs: MUTATING_TIMEOUT_MS });
  return r.stdout;
}

export async function stashChangesAsync(
  cwd: string,
  label: string,
  opts: { timeoutMs?: number } = {},
): Promise<void> {
  const message = `!!GitHub_Desktop<${label}>`;
  await runGit(cwd, ["stash", "push", "-u", "-m", message], {
    timeoutMs: opts.timeoutMs ?? MUTATING_TIMEOUT_MS,
  });
}

export async function popStashAsync(
  cwd: string,
  stashName: string,
  opts: { timeoutMs?: number } = {},
): Promise<void> {
  await runGit(cwd, ["stash", "pop", stashName], {
    timeoutMs: opts.timeoutMs ?? MUTATING_TIMEOUT_MS,
  });
}
```

- [ ] **Step 4: Bump the reconciler checkout/merge call sites**

In `lib/daemon/worktree-reconciler.ts`, add `MUTATING_TIMEOUT_MS` to the existing `../worktree/git-async.ts` import (the file already imports `runGit` from there). Add `{ timeoutMs: MUTATING_TIMEOUT_MS }` to these `runGit` calls:
- `freshenOne`: `["checkout", "--", ...classify.discard]` (~line 727); `["merge", "--ff-only", defaultRef]` (~line 756).
- `autoReturnMain`: `["checkout", defaultBranch]` (~line 469); `["merge", "--ff-only", defaultRef]` (~line 475).

Example:

```ts
const merge = await runGit(rec.path, ["merge", "--ff-only", defaultRef], { timeoutMs: MUTATING_TIMEOUT_MS });
```

The stash push/pop calls in these functions inherit the new default automatically. (Leave `worktree prune` and `branch -D` at the 60s default; they are not in S104's named set and are fast.)

- [ ] **Step 5: Run tests**

Run: `bun test lib/__tests__/git-async-timeouts.test.ts && bun test lib/daemon/__tests__/worktree-reconciler`
Expected: PASS. If a reconciler test asserts an exact `runGit` argv without opts, update it to allow the opts arg.

- [ ] **Step 6: Commit**

```bash
git add lib/worktree/git-async.ts lib/daemon/worktree-reconciler.ts lib/__tests__/git-async-timeouts.test.ts
git commit -m "git-async: 5-min timeout for checkout/merge/stash/status so a large-repo checkout isn't killed half-applied (S104)"
```

---

### Task 3: Excise sync exec from cache-refresh and git-worktrees (S008, S045, S021)

The 5-minute refresh runs `execSync` (`for-each-ref`, `git config`) and the sync `listWorktrees`/`listWorktreeRoots` per repo on the daemon thread. Swap to the async helpers. Add the missing `listWorktreeRootsAsync` twin. Gate the doppler loop on grants (honors the "off = zero background work" contract).

**Files:**
- Modify: `lib/worktree/git-async.ts` (add `listWorktreeRootsAsync`)
- Modify: `lib/daemon/cache-refresh.ts` (three swaps + doppler grant gate)
- Modify: `lib/daemon/__tests__/cache-refresh-gc.test.ts` (retarget the `listWorktrees`/`listWorktreeRoots` spies)
- Test: `lib/__tests__/git-async.test.ts` or add to existing git-async coverage for `listWorktreeRootsAsync`

**Interfaces:**
- Consumes: `listWorktreesAsync(path) => Promise<WorktreeEntry[] | null>`, `runGit(cwd, args) => Promise<GitResult>` (Task 1/2 hardened).
- Produces: `listWorktreeRootsAsync(repoPath) => Promise<string[]>` (returns `[]` on git failure, matching the sync contract).

- [ ] **Step 1: Write the failing test for `listWorktreeRootsAsync`**

Add to a git-async test file (create `lib/__tests__/git-worktree-roots-async.test.ts`):

```ts
import { test, expect } from "bun:test";
import { mkdtempSync } from "fs";
import { realpathSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { listWorktreeRootsAsync } from "../worktree/git-async.ts";
import { runGit } from "../worktree/git-async.ts";

test("listWorktreeRootsAsync returns the main worktree path", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "rt-wt-")));
  await runGit(dir, ["init", "-q"]);
  await runGit(dir, ["commit", "--allow-empty", "-m", "init", "-c", "user.email=a@b.c", "-c", "user.name=t"]);
  const roots = await listWorktreeRootsAsync(dir);
  expect(roots).toContain(dir);
});

test("listWorktreeRootsAsync returns [] on a non-repo", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "rt-nonrepo-")));
  expect(await listWorktreeRootsAsync(dir)).toEqual([]);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test lib/__tests__/git-worktree-roots-async.test.ts`
Expected: FAIL ... `listWorktreeRootsAsync` not exported.

- [ ] **Step 3: Add `listWorktreeRootsAsync`**

In `lib/worktree/git-async.ts`, after `listWorktreesAsync`:

```ts
/** Worktree root paths (main + linked), existing-on-disk only. `[]` on git
 *  failure ... the async twin of git-worktrees.ts listWorktreeRoots. */
export async function listWorktreeRootsAsync(repoPath: string): Promise<string[]> {
  return (await listWorktreesAsync(repoPath) ?? []).map((w) => w.path);
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test lib/__tests__/git-worktree-roots-async.test.ts`
Expected: PASS.

- [ ] **Step 5: Swap the cache-refresh call sites**

In `lib/daemon/cache-refresh.ts`:

Imports ... remove `import { execSync } from "child_process";` and `import { listWorktreeRoots, listWorktrees } from "../git-worktrees.ts";`; add `import { listWorktreesAsync, listWorktreeRootsAsync, runGit } from "../worktree/git-async.ts";`.

Branch listing (line ~112):

```ts
const branches: Array<{ path: string; branch: string }> = ((await listWorktreesAsync(repoPath)) ?? [])
  .filter((w): w is { path: string; branch: string } => !!w.branch && !w.branch.startsWith("on-deck/"));
```

`for-each-ref` (lines ~118-133):

```ts
const worktreeBranchSet = new Set(branches.map((b) => b.branch));
const localBranches = await runGit(repoPath, ["for-each-ref", "--format=%(refname:short)", "refs/heads/"]);
if (localBranches.exitCode === 0) {
  for (const name of localBranches.stdout.split("\n")) {
    const trimmed = name.trim();
    if (!trimmed || worktreeBranchSet.has(trimmed) || trimmed.startsWith("on-deck/")) continue;
    if (extractLinearId(trimmed)) branches.push({ path: repoPath, branch: trimmed });
  }
} else {
  log.warn({ repo: repoPath }, "local branch listing failed");
}
```

(argv form removes the shell, so the old `replace(/^'|'$/g, "")` quote-stripping is no longer needed ... the `--format=%(refname:short)` has no surrounding quotes without a shell.)

Remote URL (lines ~138-142):

```ts
let remoteUrl: string | undefined;
const remote = await runGit(repoPath, ["config", "--get", "remote.origin.url"]);
if (remote.exitCode === 0) remoteUrl = remote.stdout.trim() || undefined;
```

Doppler loop (line ~209): replace `listWorktreeRoots(repoPath)` with `await listWorktreeRootsAsync(repoPath)`, and gate the loop body on grants. Load tracking once above the loop and skip repos with no cache grant:

```ts
const tracking = loadRepoTracking();
for (const [repoName, repoPath] of Object.entries(repoIndex())) {
  if (!existsSync(repoPath)) continue;
  if (grants(tracking, repoName).caches.size === 0) continue; // off = zero background work
  try {
    const worktreeRoots = await listWorktreeRootsAsync(repoPath);
    // ...unchanged body...
```

(`loadRepoTracking` and `grants` are already imported in this file.)

- [ ] **Step 6: Retarget the GC test spies**

In `lib/daemon/__tests__/cache-refresh-gc.test.ts` (~lines 105, 108), the test spies on `gitWorktreesModule.listWorktrees`/`listWorktreeRoots`. Retarget to the async twins:

```ts
import * as gitAsync from "../../worktree/git-async.ts";
// ...
spyOn(gitAsync, "listWorktreesAsync").mockResolvedValue([]);
spyOn(gitAsync, "listWorktreeRootsAsync").mockResolvedValue([]);
```

(Remove the now-unused `gitWorktreesModule` import if nothing else uses it.)

- [ ] **Step 7: Run the cache-refresh tests**

Run: `bun test lib/daemon/__tests__/cache-refresh-gc.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add lib/worktree/git-async.ts lib/daemon/cache-refresh.ts lib/daemon/__tests__/cache-refresh-gc.test.ts lib/__tests__/git-worktree-roots-async.test.ts
git commit -m "cache-refresh: async git + grant-gated doppler loop; add listWorktreeRootsAsync (S008, S045, S021)"
```

---

### Task 4: Async, cached `getRemoteUrl` in freshness (R032)

`getRemoteUrl` uses `execSync` on the daemon thread inside every forge handler (mr:action, discussions:*, project sync) and the freshness reconcile loop. Make it async via `runCapture` with a 5s timeout, cached per repoPath for the process lifetime.

**Files:**
- Modify: `lib/daemon/freshness.ts`
- Test: `lib/daemon/__tests__/freshness-remote-url.test.ts` (create)

**Interfaces:**
- Produces: `getRemoteUrl(repoPath) => Promise<string | null>` (was sync). All four call sites become `await getRemoteUrl(...)`.

- [ ] **Step 1: Write the failing test**

Create `lib/daemon/__tests__/freshness-remote-url.test.ts` ... since `getRemoteUrl` is module-private, test through a real repo via a tiny exported probe is not available; instead assert no `execSync`/`child_process` import remains in freshness.ts (the observable contract for R032) plus a behavioral cache test using a real temp repo through the public `getRepoContext` is heavy. Keep it to the source guard, which the Task 7 gate will also enforce, plus a targeted unit if a seam exists:

```ts
import { test, expect } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";

test("freshness.ts no longer imports execSync/child_process", () => {
  const src = readFileSync(resolve(import.meta.dir, "..", "freshness.ts"), "utf8");
  expect(src).not.toMatch(/from\s+["']child_process["']/);
  expect(src).not.toMatch(/\bexecSync\b/);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test lib/daemon/__tests__/freshness-remote-url.test.ts`
Expected: FAIL ... `child_process`/`execSync` still present.

- [ ] **Step 3: Convert `getRemoteUrl` and add the cache**

In `lib/daemon/freshness.ts`: remove `import { execSync } from "child_process";`; add `import { runCapture } from "../subprocess.ts";`. Add a module-level cache near the other module state (below the `providers`/`userId` block ~line 91):

```ts
const remoteUrlCache = new Map<string, string | null>();
```

Replace `getRemoteUrl` (lines 95-103):

```ts
/** remote.origin.url, cached per repoPath for the process lifetime (remotes
 *  rarely change). Async so it never blocks the event loop. */
async function getRemoteUrl(repoPath: string): Promise<string | null> {
  const cached = remoteUrlCache.get(repoPath);
  if (cached !== undefined) return cached;
  const r = await runCapture(["git", "config", "--get", "remote.origin.url"], {
    cwd: repoPath,
    timeoutMs: 5000,
    stderr: "ignore",
  });
  const url = r.exitCode === 0 ? (r.stdout.trim() || null) : null;
  remoteUrlCache.set(repoPath, url);
  return url;
}
```

Add `await` at the four call sites: `ensureProvider` (~135), `getRepoContext` (~273 and ~292), `reconcileFreshnessImpl` (~692). All three enclosing functions are already `async`.

- [ ] **Step 4: Run to verify it passes**

Run: `bun test lib/daemon/__tests__/freshness-remote-url.test.ts && bunx tsc --noEmit`
Expected: PASS; tsc zero errors (the `await` additions type-check because callers are async).

- [ ] **Step 5: Commit**

```bash
git add lib/daemon/freshness.ts lib/daemon/__tests__/freshness-remote-url.test.ts
git commit -m "freshness: async, cached getRemoteUrl via runCapture (R032)"
```

---

### Task 5: Async `killWorktreeProcesses` (S015, S016)

`killWorktreeProcesses` runs three `execSync` calls (system-wide `lsof`, two `ps`) on the daemon thread per disposal and on the unattended reactor path; a stuck `lsof` wedges the loop. Port to `runCapture` (the identical async `lsof` already exists in `system-process-scanner.ts`).

**Files:**
- Modify: `lib/daemon/worktree-process-kill.ts` (make `killWorktreeProcesses` async; three `runCapture` swaps)
- Modify: `lib/worktree/dispose.ts:238` (add `await`)
- Modify: `lib/daemon/worktree-reconciler.ts:447` (add `await`; update the "sync by design" comment)
- Test: `lib/daemon/__tests__/worktree-process-kill.test.ts` (add a source guard + keep `selectKillTargets` coverage)

**Interfaces:**
- Produces: `killWorktreeProcesses(worktreePath) => Promise<WorktreeKillResult>` (was sync). `WorktreeKillResult` unchanged.

- [ ] **Step 1: Write the failing test**

Add to `lib/daemon/__tests__/worktree-process-kill.test.ts`:

```ts
import { readFileSync } from "fs";
import { resolve } from "path";

test("worktree-process-kill.ts imports no sync exec", () => {
  const src = readFileSync(resolve(import.meta.dir, "..", "worktree-process-kill.ts"), "utf8");
  expect(src).not.toMatch(/from\s+["']child_process["']/);
  expect(src).not.toMatch(/\bexecSync\b/);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test lib/daemon/__tests__/worktree-process-kill.test.ts`
Expected: FAIL ... `execSync` still imported.

- [ ] **Step 3: Port the three calls to `runCapture`**

In `lib/daemon/worktree-process-kill.ts`: remove `import { execSync } from "child_process";`; add `import { runCapture } from "../subprocess.ts";`. Make the function async and swap each call (argv form, no shell, no `2>/dev/null`):

```ts
export async function killWorktreeProcesses(worktreePath: string): Promise<WorktreeKillResult> {
  const lsof = await runCapture(["lsof", "-d", "cwd", "-Fpn"], { timeoutMs: 10_000 });
  if (lsof.exitCode !== 0 && !lsof.stdout) {
    log.warn({ exitCode: lsof.exitCode, worktreePath }, "lsof failed; skipping worktree process kill");
    return { terminated: [] };
  }
  const lsofOut = lsof.stdout;
  // ...existing parse of lsofOut into candidate pids (unchanged)...
```

Then the `ps -p <pids> -o pid=,ppid=,comm=,args=` call:

```ts
  const ps = await runCapture(["ps", "-p", pidList, "-o", "pid=,ppid=,comm=,args="], { timeoutMs: 5000 });
  if (ps.exitCode !== 0 && !ps.stdout) {
    log.warn({ exitCode: ps.exitCode, worktreePath }, "ps failed; skipping worktree process kill");
    return { terminated: [] };
  }
  for (const line of ps.stdout.split("\n")) { /* unchanged parse */ }
```

Then the `ps eww` label call:

```ts
  const eww = await runCapture(["ps", "eww", "-o", "pid=,command=", "-p", targets.map((t) => t.pid).join(",")], { timeoutMs: 5000 });
  if (eww.exitCode === 0 || eww.stdout) scripts = parsePackageScripts(eww.stdout);
```

(`pidList` is the same comma/space-joined pid string the old `ps` used; pass it as one argv element ... `ps -p` accepts a comma-separated list.)

- [ ] **Step 4: Await at the two call sites**

`lib/worktree/dispose.ts:238`: `const { terminated } = await killWorktreeProcesses(rec.path);`
`lib/daemon/worktree-reconciler.ts:447`: `const { terminated } = await killWorktreeProcesses(rec.path);` ... and replace the "ruled execSync exception (the process killer is sync by design)" comment with one that no longer claims sync (e.g. drop it; the try/catch keeps its "a failure here never blocks the return" rationale).

- [ ] **Step 5: Run tests**

Run: `bun test lib/daemon/__tests__/worktree-process-kill.test.ts && bunx tsc --noEmit`
Expected: PASS; tsc clean (both call sites already sit in `async` functions).

- [ ] **Step 6: Commit**

```bash
git add lib/daemon/worktree-process-kill.ts lib/worktree/dispose.ts lib/daemon/worktree-reconciler.ts lib/daemon/__tests__/worktree-process-kill.test.ts
git commit -m "worktree-process-kill: async lsof/ps via runCapture (S015, S016)"
```

---

### Task 6: Async index write in `resolveIndexPathForIdentity` (S098)

`endpoint:claim`/`endpoint:lookup` can reach `resolveIndexPathForIdentity`, which on a legacy-key match calls `updateRepoIndex` → `observedMainPath` → a synchronous `git worktree list` on the daemon thread. Resolve the observed main path asynchronously.

**Files:**
- Modify: `lib/repo-index.ts` (add `observedMainPathAsync`; use it on the async path)
- Test: `lib/__tests__/repo-index-async.test.ts` (create)

**Interfaces:**
- Consumes: `listWorktreesAsync(path) => Promise<WorktreeEntry[] | null>`, `setIndexPath(key, mainPath)` (existing sync KV write, no subprocess).
- Produces: `observedMainPathAsync(repoRoot) => Promise<string>` (degrades to `repoRoot`).

- [ ] **Step 1: Write the failing test**

Create `lib/__tests__/repo-index-async.test.ts`:

```ts
import { test, expect } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";

test("resolveIndexPathForIdentity no longer reaches a sync git via observedMainPath", () => {
  const src = readFileSync(resolve(import.meta.dir, "..", "repo-index.ts"), "utf8");
  // observedMainPath (sync execSync) must not be called from the async resolver path.
  expect(src).toMatch(/observedMainPathAsync/);
});
```

(The Task 7 import-graph gate is the real enforcement that no sync git reaches the daemon graph; this test just anchors the async twin's existence.)

- [ ] **Step 2: Run to verify it fails**

Run: `bun test lib/__tests__/repo-index-async.test.ts`
Expected: FAIL ... `observedMainPathAsync` not present.

- [ ] **Step 3: Add `observedMainPathAsync` and use it**

In `lib/repo-index.ts`, add `import { listWorktreesAsync } from "./worktree/git-async.ts";` (top imports). Add next to `observedMainPath`:

```ts
/** Async twin of observedMainPath: the repo's MAIN worktree path as git
 *  reports it, degrading to repoRoot. Safe on the daemon thread. */
async function observedMainPathAsync(repoRoot: string): Promise<string> {
  const wts = await listWorktreesAsync(repoRoot);
  return wts?.[0]?.path ?? repoRoot;
}
```

In `resolveIndexPathForIdentity` (line ~277), replace `updateRepoIndex(serialized, path);` with:

```ts
setIndexPath(serialized, await observedMainPathAsync(path));
```

(`setIndexPath` is the raw KV write already exported in this file; it does the same persistence `updateRepoIndex` does, minus the sync git probe, which `observedMainPathAsync` now supplies.)

- [ ] **Step 4: Run to verify it passes**

Run: `bun test lib/__tests__/repo-index-async.test.ts && bunx tsc --noEmit`
Expected: PASS; tsc clean (`resolveIndexPathForIdentity` is already async).

- [ ] **Step 5: Commit**

```bash
git add lib/repo-index.ts lib/__tests__/repo-index-async.test.ts
git commit -m "repo-index: async observed-main-path on the endpoint:claim resolve path (S098)"
```

---

### Task 7: The import-graph gate (1.3)

A test that walks the daemon's import graph from `lib/daemon.ts` and fails if any daemon-reachable module has a sync-exec call site (`execSync(`, `spawnSync(`, `Bun.spawnSync(`, `Bun.sleepSync(`). The rule has been re-broken twice; only a gate keeps it dead. Ships GREEN with an honest allowlist of every current out-of-Phase-1 offender, each commented with the finding/phase that removes it (decision: full-closure walk with honest allowlist).

**Verified facts (from a throwaway walker run against the live tree):**
- Closure from `lib/daemon.ts` = 151 files. `lib/daemon.ts` and other entry files carry a `#!/usr/bin/env bun` shebang that makes `Bun.Transpiler.scanImports` throw ... strip a leading shebang before scanning.
- `.tsx` files (e.g. `lib/rt-render.tsx`, in the closure) need the `tsx` loader, not `ts`.
- Relative imports are spelled with explicit `.ts`/`.tsx` extensions throughout, so `resolve(dirname(file), importPath)` needs no extension guessing.
- Matching call sites (`\bexecSync\s*\(`) rather than bare `execSync` avoids false positives: `api-server.ts:105` mentions `Bun.sleepSync` in a comment with no paren, correctly NOT flagged. Raw-source matching yields the same 13 offenders as comment-stripped matching, so the test uses raw matching.
- After Tasks 3/4/5 remove cache-refresh.ts, freshness.ts, and worktree-process-kill.ts from the offender set, exactly these 10 remain (the allowlist):

| Allowlist entry | Removing finding / phase |
|---|---|
| `lib/daemon/user-path.ts` | Phase 6 PATH rebuild (S013/S014/S062) |
| `lib/daemon/boot-reconcile.ts` | Phase 0.6 / S044 (`Bun.sleepSync`) |
| `lib/state/db.ts` | Phase 0.7 / S072-S073 busy-retry (`Bun.sleepSync`) |
| `lib/state/busy.ts` | Phase 0.7 / S072-S073 busy-retry (`Bun.sleepSync`) |
| `lib/git-worktrees.ts` | S055 (reached only via `handlers/status.ts`; that swap to `listWorktreesAsync` removes the edge) |
| `lib/daemon/handlers/status.ts` | S055 (the edge that pulls in git-worktrees.ts; own source has no sync-exec, listed per the brief) |
| `lib/repo-index.ts` | Phase 5.3 dedup (retains `execSync` at heal/derive paths; Task 6's endpoint path is covered by `repo-index-async.test.ts`) |
| `lib/repo.ts` | R050 / Phase 5.4 (reached via `handlers/system-processes.ts` → `repo-arg.ts`) |
| `lib/git.ts` | R050 / Phase 5.4 (via `repo.ts`) |
| `lib/herdr-launch.ts` | Phase 5 herdr (reached via `handlers/pane.ts`) |
| `lib/rt-render.tsx` | R050 / Phase 5.4 (daemon carries the TUI; `no-eager-tui` extension breaks the chain) |

**Files:**
- Create: `lib/__tests__/no-daemon-sync-exec.test.ts`

**Interfaces:**
- Self-contained test; consumes nothing from other tasks. Must run AFTER Tasks 3/4/5 land (else the three fixed files fail it).

- [ ] **Step 1: Write the gate test (RED against current tree, before Tasks 3/4/5, or GREEN after)**

Create `lib/__tests__/no-daemon-sync-exec.test.ts`:

```ts
import { test, expect } from "bun:test";
import { readFileSync } from "fs";
import { dirname, resolve } from "path";

// Files with sync-exec that Phase 1 does NOT remove. Each entry names the
// finding/phase that will delete it, so this list shrinks as later phases land.
// A regression that reintroduces sync-exec into any OTHER daemon-reachable
// module fails this gate (the rule has been re-broken twice).
const ALLOWLIST = new Set<string>([
  "lib/daemon/user-path.ts",        // Phase 6 PATH rebuild (S013/S014/S062)
  "lib/daemon/boot-reconcile.ts",   // Phase 0.6 / S044 (Bun.sleepSync)
  "lib/state/db.ts",                // Phase 0.7 / S072-S073 busy-retry
  "lib/state/busy.ts",              // Phase 0.7 / S072-S073 busy-retry
  "lib/git-worktrees.ts",           // S055: reached only via handlers/status.ts
  "lib/daemon/handlers/status.ts",  // S055: the edge into git-worktrees.ts
  "lib/repo-index.ts",              // Phase 5.3 dedup (heal/derive execSync)
  "lib/repo.ts",                    // R050 / Phase 5.4 (via handlers/system-processes.ts)
  "lib/git.ts",                     // R050 / Phase 5.4 (via repo.ts)
  "lib/herdr-launch.ts",            // Phase 5 herdr (via handlers/pane.ts)
  "lib/rt-render.tsx",              // R050 / Phase 5.4 (daemon carries the TUI)
]);

const SYNC_EXEC = [
  /\bexecSync\s*\(/,
  /\bspawnSync\s*\(/,
  /\bBun\.spawnSync\s*\(/,
  /\bBun\.sleepSync\s*\(/,
];

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const stripShebang = (s: string) => s.replace(/^#!.*\n/, "");
const tsT = new Bun.Transpiler({ loader: "ts" });
const tsxT = new Bun.Transpiler({ loader: "tsx" });
const loaderFor = (f: string) => (f.endsWith(".tsx") || f.endsWith(".jsx") ? tsxT : tsT);

/** Files reachable from lib/daemon.ts via relative imports (the daemon graph). */
function daemonClosure(): string[] {
  const entry = resolve(REPO_ROOT, "lib/daemon.ts");
  const visited = new Set<string>();
  const stack = [entry];
  while (stack.length) {
    const file = stack.pop()!;
    if (visited.has(file)) continue;
    visited.add(file);
    let src: string;
    try { src = stripShebang(readFileSync(file, "utf8")); } catch { continue; }
    let imports: { path: string }[];
    try { imports = loaderFor(file).scanImports(src); } catch { continue; }
    for (const imp of imports) {
      if (!imp.path.startsWith(".")) continue; // external package
      stack.push(resolve(dirname(file), imp.path));
    }
  }
  return [...visited];
}

function hasSyncExec(source: string): boolean {
  return SYNC_EXEC.some((re) => re.test(source));
}

test("no daemon-reachable module calls sync exec (outside the allowlist)", () => {
  const offenders: string[] = [];
  for (const file of daemonClosure()) {
    const rel = file.replace(REPO_ROOT + "/", "");
    if (ALLOWLIST.has(rel)) continue;
    let src: string;
    try { src = readFileSync(file, "utf8"); } catch { continue; }
    if (hasSyncExec(src)) offenders.push(rel);
  }
  expect(offenders).toEqual([]);
});

test("the checker flags a reintroduced sync-exec call (proves the gate bites)", () => {
  // Permanent RED proof: the matcher must catch a fresh offense.
  expect(hasSyncExec(`import { execSync } from "child_process";\nexecSync("true");`)).toBe(true);
  expect(hasSyncExec(`await Bun.sleepSync(10);`)).toBe(true);
  expect(hasSyncExec(`// a comment mentioning execSync without a call`)).toBe(false);
});

test("the daemon closure actually resolves (guards against a walker that finds nothing)", () => {
  const closure = daemonClosure();
  expect(closure.length).toBeGreaterThan(50); // ~151 today; a collapse means the walk broke
});
```

- [ ] **Step 2: Run the gate**

Run: `bun test lib/__tests__/no-daemon-sync-exec.test.ts`
Expected: GREEN (Tasks 3/4/5 already removed cache-refresh, freshness, worktree-process-kill). If it lists an offender not in the allowlist, that file is either a Phase-1 target that regressed (fix it) or a daemon-reachable sync-exec outside Phase 1 (add it to the allowlist with a finding/phase comment). The closure-size guard and the checker RED-proof tests must also pass.

- [ ] **Step 3: Demonstrate the gate fails on reintroduction (report evidence)**

Temporarily add to `lib/daemon/pollers.ts` (a Phase-1-clean, non-allowlisted daemon file): `import { execSync } from "child_process";` and a call `execSync("true");`. Run:

Run: `bun test lib/__tests__/no-daemon-sync-exec.test.ts`
Expected: FAIL ... offenders `["lib/daemon/pollers.ts"]`. Capture this RED output for the report, then revert both lines.

- [ ] **Step 4: Commit**

```bash
git add lib/__tests__/no-daemon-sync-exec.test.ts
git commit -m "gate: fail on sync-exec anywhere in the daemon import graph (1.3)"
```

---

### Task 8: Refresh cannot wedge (S007)

One hung GitLab call latches `refreshInFlight` forever, freezing the coalesced refresh, and merged `runner.pending` grows unbounded. Add a whole-cycle deadline that clears the latch so the next tick can start, and cap the pending queue.

**Files:**
- Modify: `lib/daemon/cache-refresh.ts` (extract a coalescer with a deadline)
- Modify: `lib/daemon/freshness.ts` (`applyInvalidationBatch` pending cap)
- Test: `lib/daemon/__tests__/cache-refresh-coalesce.test.ts` (create), `lib/daemon/__tests__/freshness-pending-cap.test.ts` (create)

**Interfaces:**
- Produces: `makeCoalescer(run, deadlineMs, onTimeout) => () => Promise<void>` exported from `cache-refresh.ts`.
- Produces: `PENDING_CAP` const in `freshness.ts`; `applyInvalidationBatch` dedupes-and-caps pending.

- [ ] **Step 1: Write the failing coalescer test**

Create `lib/daemon/__tests__/cache-refresh-coalesce.test.ts`:

```ts
import { test, expect } from "bun:test";
import { makeCoalescer } from "../cache-refresh.ts";

test("clears the in-flight latch after the deadline even if run never settles", async () => {
  let starts = 0;
  let timedOut = 0;
  const coalesce = makeCoalescer(
    () => { starts++; return new Promise<void>(() => {}); }, // never resolves
    50,
    () => { timedOut++; },
  );
  const t0 = Date.now();
  await coalesce();               // resolves at the deadline, not never
  expect(Date.now() - t0).toBeLessThan(500);
  expect(timedOut).toBe(1);
  await coalesce();               // latch cleared, a new run can start
  expect(starts).toBe(2);
});

test("coalesces concurrent callers onto one run", async () => {
  let starts = 0;
  let resolveRun!: () => void;
  const coalesce = makeCoalescer(
    () => { starts++; return new Promise<void>((r) => { resolveRun = r; }); },
    10_000,
    () => {},
  );
  const a = coalesce();
  const b = coalesce();
  expect(starts).toBe(1);
  resolveRun();
  await Promise.all([a, b]);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test lib/daemon/__tests__/cache-refresh-coalesce.test.ts`
Expected: FAIL ... `makeCoalescer` not exported.

- [ ] **Step 3: Add `makeCoalescer` and use it**

In `lib/daemon/cache-refresh.ts`, add above `createCacheRefresher`:

```ts
/** Below the 5-min tick, above the slowest legitimate deep sync. */
const REFRESH_CYCLE_DEADLINE_MS = 4 * 60 * 1000;

/**
 * Coalesce concurrent callers onto one in-flight run, but clear the latch after
 * `deadlineMs` even if the run never settles, so a wedged cycle (a half-open
 * GitLab socket that never rejects) cannot pin the latch forever. The wedged
 * run's frame still leaks until the OS reaps the socket; this only frees the
 * next tick.
 */
export function makeCoalescer(
  run: () => Promise<void>,
  deadlineMs: number,
  onTimeout: () => void,
): () => Promise<void> {
  let inFlight: Promise<void> | null = null;
  return () => {
    if (inFlight) return inFlight;
    const impl = run().catch(() => {}); // a rejected cycle still clears the latch
    const guarded = Promise.race([
      impl,
      new Promise<void>((resolve) => setTimeout(() => { onTimeout(); resolve(); }, deadlineMs)),
    ]).finally(() => { inFlight = null; });
    inFlight = guarded;
    return guarded;
  };
}
```

Replace the `refreshInFlight` coalescer (lines 54-60) inside `createCacheRefresher`:

```ts
  const refreshCache = makeCoalescer(
    refreshCacheImpl,
    REFRESH_CYCLE_DEADLINE_MS,
    () => log.warn("cache refresh timed out; cleared in-flight latch for next tick"),
  );
```

(Delete `let refreshInFlight` and the old `function refreshCache`. `refreshCacheImpl` stays as the async body; `return refreshCache;` at the end is unchanged.)

- [ ] **Step 4: Run to verify it passes**

Run: `bun test lib/daemon/__tests__/cache-refresh-coalesce.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the pending-cap test**

Create `lib/daemon/__tests__/freshness-pending-cap.test.ts`:

```ts
import { test, expect } from "bun:test";
import { applyInvalidationBatch, PENDING_CAP } from "../freshness.ts";

test("merged pending is deduped by kind:ref and capped", async () => {
  const runner: any = { processing: true, pending: [] };
  // Push more distinct keys than the cap; plus duplicates.
  const keys = Array.from({ length: PENDING_CAP + 500 }, (_, i) => ({ kind: "mr", ref: String(i) }));
  const dupes = [{ kind: "mr", ref: "0" }, { kind: "mr", ref: "0" }];
  await applyInvalidationBatch({} as any, {} as any, runner, [...keys, ...dupes], {});
  expect(runner.pending.length).toBeLessThanOrEqual(PENDING_CAP);
  const ids = runner.pending.map((k: any) => `${k.kind}:${k.ref}`);
  expect(new Set(ids).size).toBe(ids.length); // no duplicates
});
```

- [ ] **Step 6: Run to verify it fails**

Run: `bun test lib/daemon/__tests__/freshness-pending-cap.test.ts`
Expected: FAIL ... `PENDING_CAP` not exported (and current code pushes unbounded).

- [ ] **Step 7: Cap the pending queue**

In `lib/daemon/freshness.ts`, add near the module state (below `const watches`):

```ts
/** Bound merged pending so a wedged processKeys cannot grow memory unbounded. */
export const PENDING_CAP = 1000;
```

Replace the `if (runner.processing)` block in `applyInvalidationBatch` (lines 392-395):

```ts
  if (runner.processing) {
    const seen = new Set(runner.pending.map((k) => `${k.kind}:${k.ref}`));
    for (const k of keys) {
      if (runner.pending.length >= PENDING_CAP) break;
      const id = `${k.kind}:${k.ref}`;
      if (seen.has(id)) continue;
      seen.add(id);
      runner.pending.push(k);
    }
    return;
  }
```

- [ ] **Step 8: Run to verify it passes**

Run: `bun test lib/daemon/__tests__/freshness-pending-cap.test.ts && bunx tsc --noEmit`
Expected: PASS; tsc clean.

- [ ] **Step 9: Commit**

```bash
git add lib/daemon/cache-refresh.ts lib/daemon/freshness.ts lib/daemon/__tests__/cache-refresh-coalesce.test.ts lib/daemon/__tests__/freshness-pending-cap.test.ts
git commit -m "refresh: whole-cycle deadline clears the coalesce latch; cap RepoWatch.pending (S007)"
```

---

### Task 9: Provider cache invalidation on token rotation (S048, S049)

`providers` caches `GitLabProvider` instances by repoName with no token check, so a rotated `gitlabToken` never reaches watchers or forge handlers until a daemon restart. Key the cache on a token fingerprint and rebuild on mismatch; reset the `userIdResolved` latch.

**Files:**
- Modify: `lib/daemon/freshness.ts`
- Test: `lib/daemon/__tests__/freshness-provider-rotation.test.ts` (create)

**Interfaces:**
- Consumes: `loadSecrets()` (from `../linear.ts`, returns `{ gitlabToken }`), `makeProvider(host, token)`.
- Internal: `providers` map value becomes `{ provider: GitLabProvider; token: string }`.

- [ ] **Step 1: Write the failing test**

Create `lib/daemon/__tests__/freshness-provider-rotation.test.ts`. Since `ensureProvider` is module-private, test the observable contract: the source no longer returns a cached provider without comparing the current token. Assert the fingerprint mechanism exists and the `if (cached) return cached;` short-circuit is gone:

```ts
import { test, expect } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";

test("ensureProvider compares the current token before reusing a cached provider", () => {
  const src = readFileSync(resolve(import.meta.dir, "..", "freshness.ts"), "utf8");
  // The unconditional cache-hit return is the S049 bug; it must be gone.
  expect(src).not.toMatch(/const cached = providers\.get\(repoName\);\s*\n\s*if \(cached\) return cached;/);
  // A token fingerprint must be stored alongside the provider.
  expect(src).toMatch(/providers\.set\(repoName,\s*\{\s*provider/);
});
```

(A behavioral test would need a real GitLabProvider + secrets seam; the freshness module has no injection point for `loadSecrets`. This source-contract test plus `bunx tsc` is the achievable guard; note the limitation in the report.)

- [ ] **Step 2: Run to verify it fails**

Run: `bun test lib/daemon/__tests__/freshness-provider-rotation.test.ts`
Expected: FAIL ... the unconditional cache-hit return still present.

- [ ] **Step 3: Key the provider cache on a token fingerprint**

In `lib/daemon/freshness.ts`, change the `providers` map type (line 88):

```ts
const providers = new Map<string, { provider: GitLabProvider; token: string }>();
```

Rewrite `ensureProvider` so `loadSecrets()` runs before the cache decision and a token mismatch rebuilds (lines 125-155):

```ts
async function ensureProvider(repoName: string, repoPath: string): Promise<GitLabProvider | null> {
  const secrets = await loadSecrets();
  if (!secrets.gitlabToken) {
    log.info(`no gitlabToken; skipping ${repoName}`);
    return null;
  }
  const cached = providers.get(repoName);
  if (cached && cached.token === secrets.gitlabToken) return cached.provider;
  if (cached) {
    // Token rotated: drop the stale provider and any live watch built on it so
    // the next reconcile rebuilds with the new token, and re-resolve userId.
    stopWatch(repoName);
    userIdResolved = false;
  }

  const remoteUrl = await getRemoteUrl(repoPath);
  if (!remoteUrl) { log.info(`no origin remote for ${repoName}; skipping`); return null; }
  if (!isGitLabRemote(remoteUrl)) { log.info(`remote "${remoteUrl}" for ${repoName} is not GitLab; skipping events watch`); return null; }
  const remote = parseRemoteUrl(remoteUrl);
  if (!remote) { log.info(`could not parse remote "${remoteUrl}" for ${repoName}; skipping`); return null; }

  const provider = makeProvider(remote.host, secrets.gitlabToken);
  providers.set(repoName, { provider, token: secrets.gitlabToken });
  return provider;
}
```

Update the other cache reads to the new value shape:
- `getRepoContext` line 251: `let provider = providers.get(repoName)?.provider ?? null;`
- `getRepoContext` line 282 (after building): `providers.set(repoName, { provider, token: secrets.gitlabToken });`
- `ensureUserId` line 160: `const anyProvider = providers.values().next().value?.provider as GitLabProvider | undefined;`
- `disposeFreshness` `providers.clear()` unchanged.

(`stopWatch` is already defined in this module; calling it for a repo with no watch is a no-op ... verify its guard, add an early return if absent.)

- [ ] **Step 4: Run to verify it passes**

Run: `bun test lib/daemon/__tests__/freshness-provider-rotation.test.ts && bunx tsc --noEmit`
Expected: PASS; tsc clean (all `providers.get/set/values` sites updated to the new shape).

- [ ] **Step 5: Commit**

```bash
git add lib/daemon/freshness.ts lib/daemon/__tests__/freshness-provider-rotation.test.ts
git commit -m "freshness: rebuild the provider cache when gitlabToken rotates (S048, S049)"
```

---

### Task 10: A single failed lsof no longer resets runaway detection (S061)

`gather()` returns `[]` on both a real empty scan and an `lsof`/`ps` failure; `scan()` then prunes every tracked pid, resetting `firstSeen` and the runaway sample window so a machine where `lsof` fails intermittently can never fire a runaway notification. Distinguish failure (null) from empty.

**Files:**
- Modify: `lib/daemon/system-process-scanner.ts` (`getAllRepoPids`, `gather`, `scan`, `refresh`)
- Test: `lib/daemon/__tests__/system-process-scanner-resilience.test.ts` (create)

**Interfaces:**
- Internal: `getAllRepoPids` and `gather` return `... | null` (null = the underlying `lsof`/`ps` scan failed). `scan`/`refresh` preserve `tracked`/`lastResult`/`lastScanAt` when `gather` returns null.
- Change `gather` from `private` to `protected` so a test subclass can drive its return value.

- [ ] **Step 1: Write the failing test**

Create `lib/daemon/__tests__/system-process-scanner-resilience.test.ts`:

```ts
import { test, expect } from "bun:test";
import { SystemProcessScanner } from "../system-process-scanner.ts";

class FakeScanner extends SystemProcessScanner {
  next: any[] | null = [];
  protected async gather(): Promise<any[] | null> { return this.next; }
}

test("a failed gather (null) keeps tracked windows and lastResult intact", async () => {
  const s = new FakeScanner();
  // Seed a tracked process across enough scans that firstSeen is established.
  s.next = [{ pid: 4242, cpuPercent: 95, command: "node", args: "x", ppid: 1, port: null, memoryMB: 10, etime: "01:00", repo: "r", linearTicket: null, packageScript: null }];
  const first = await s.scan();
  expect(first.find((p) => p.pid === 4242)).toBeTruthy();
  const firstSeen = s.getTracked().get(4242)?.firstSeen;

  // Now lsof fails: gather returns null. tracked and lastResult must survive.
  s.next = null;
  const during = await s.scan();
  expect(s.getTracked().get(4242)?.firstSeen).toBe(firstSeen);
  expect(during.find((p) => p.pid === 4242)).toBeTruthy(); // lastResult carried forward
});
```

(Field names on the fake process object follow `GatheredProcess`; adjust to the exact shape when implementing. `getTracked()` is an existing accessor.)

- [ ] **Step 2: Run to verify it fails**

Run: `bun test lib/daemon/__tests__/system-process-scanner-resilience.test.ts`
Expected: FAIL ... `gather` is `private` (can't override) and/or `scan` wipes `tracked` on the null tick.

- [ ] **Step 3: Thread the failure signal**

In `lib/daemon/system-process-scanner.ts`:

`getAllRepoPids` ... return null on lsof failure instead of an empty Map:

```ts
async function getAllRepoPids(trackedPaths: string[]): Promise<Map<number, string> | null> {
  if (trackedPaths.length === 0) return new Map();
  const { stdout, exitCode } = await runCapture(["lsof", "-d", "cwd", "-Fpn"], { timeoutMs: 10_000 });
  if (exitCode !== 0 && !stdout) {
    log.warn({ exitCode }, "lsof scan failed; preserving prior process state");
    return null;
  }
  return parseLsofCwdMap(stdout, trackedPaths);
}
```

`gather` ... change signature to `protected async gather(...): Promise<GatheredProcess[] | null>` and propagate null (lines 380, 389):

```ts
    const cwdMap = await getAllRepoPids(trackedPaths);
    if (cwdMap === null) return null;       // lsof failed
    if (cwdMap.size === 0) return [];        // genuinely no tracked-cwd processes
    // ...
    const psRes = await runCapture([...], { timeoutMs: 5000 });
    if (psRes.exitCode !== 0 && !psRes.stdout) return null; // ps failed
    if (!psRes.stdout) return [];
```

`scan` ... early-return on null before the try/finally so `tracked`/`lastResult`/`lastScanAt` are untouched:

```ts
  async scan(portEntries: PortEntry[] = []): Promise<SystemProcess[]> {
    const gathered = await this.gather(portEntries);
    if (gathered === null) return this.lastResult; // failed tick: preserve everything
    try {
      // ...existing loop over `gathered`, prune, this.lastResult = results...
      return results;
    } finally {
      this.lastScanAt = Date.now();
    }
  }
```

`refresh` ... same null guard:

```ts
  async refresh(portEntries: PortEntry[] = []): Promise<SystemProcess[]> {
    const gathered = await this.gather(portEntries);
    if (gathered === null) return this.lastResult;
    try {
      // ...existing map...
      return results;
    } finally {
      this.lastScanAt = Date.now();
    }
  }
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test lib/daemon/__tests__/system-process-scanner-resilience.test.ts && bun test lib/daemon/__tests__/system-process-scanner.test.ts && bunx tsc --noEmit`
Expected: PASS (new + existing scanner tests); tsc clean.

- [ ] **Step 5: Commit**

```bash
git add lib/daemon/system-process-scanner.ts lib/daemon/__tests__/system-process-scanner-resilience.test.ts
git commit -m "system-process-scanner: a failed lsof preserves runaway windows (S061)"
```

---

### Task 11: Cheapen run-DB opens: mtime memoization + herdr backoff (S101, S038, S039)

The agent-status poller and `runs:list` open every retained run's SQLite db every 10s (cost scales with retained runs, not live runs), and the poller spawns herdr every 10s forever on a herdr-less machine. Memoize finished-run summaries by state.db mtime, and back off the herdr probe after repeated failures.

**Files:**
- Modify: `lib/runs/store.ts` (mtime cache in `listRuns`)
- Modify: `lib/daemon/agent-status-poller.ts` (consecutive-failure backoff)
- Test: `lib/runs/__tests__/store-memo.test.ts` (create), add to `lib/daemon/__tests__/agent-status-poller.test.ts`

**Interfaces:**
- Internal: `listRuns` caches finished-run `RunSummary` keyed by `${repo}/${id}` → `{ mtimeMs, summary }`; running runs are never cached (their db still mutates and their liveness overlay changes).
- Internal: poller gains `FAILURE_THRESHOLD` / `BACKOFF_TICKS` backoff.

- [ ] **Step 1: Write the failing memoization test**

Create `lib/runs/__tests__/store-memo.test.ts`. Use the existing `seedRun`/`root` fixtures and a spy to prove a finished run's db is not reopened when its mtime is unchanged:

```ts
import { test, expect, afterEach, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { listRuns } from "../store.ts";
import { root, seedRun } from "./fixtures.ts";

afterEach(() => { delete process.env.RT_RUNS_ROOT; });

test("a finished run's db is opened once, then served from the mtime cache", () => {
  root(); // sets RT_RUNS_ROOT to a temp dir
  seedRun("repoA", "run1", { status: "done" });
  const openSpy = spyOn(Database.prototype, "query");
  listRuns();                 // first call opens + reads
  const afterFirst = openSpy.mock.calls.length;
  listRuns();                 // second call: mtime unchanged -> no reopen
  expect(openSpy.mock.calls.length).toBe(afterFirst); // no additional queries for run1
  openSpy.mockRestore();
});
```

(If `seedRun`'s signature differs, match it; the point is a finished run plus a proof the second `listRuns` does not re-query it.)

- [ ] **Step 2: Run to verify it fails**

Run: `bun test lib/runs/__tests__/store-memo.test.ts`
Expected: FAIL ... every `listRuns` reopens and re-queries every run.

- [ ] **Step 3: Add the mtime cache**

In `lib/runs/store.ts`, add `import { statSync } from "fs";` (if absent) and a module cache:

```ts
// Finished runs never change; skip the open+PRAGMA+4-reads when the db mtime
// is unchanged. Running runs are never cached: their db still mutates and their
// liveness overlay is recomputed per call.
const summaryCache = new Map<string, { mtimeMs: number; summary: RunSummary }>();
```

Rewrite the per-run body of `listRuns` (lines 122-130):

```ts
    for (const id of dirs(join(runsRoot(), r))) {
      const dbPath = join(runsRoot(), r, id, "state.db");
      let mtimeMs: number;
      try { mtimeMs = statSync(dbPath).mtimeMs; } catch { continue; }
      const key = `${r}/${id}`;
      const hit = summaryCache.get(key);
      if (hit && hit.mtimeMs === mtimeMs) { out.push(hit.summary); continue; }

      const opened = openRun(r, id);
      if (!opened) continue;
      try {
        const row = runRow(opened.db);
        if (row) {
          const summary = withAttention(opened.db, row, liveness);
          out.push(summary);
          if (summary.status !== "running") summaryCache.set(key, { mtimeMs, summary });
        }
      } finally {
        opened.db.close();
      }
    }
```

(Confirm the field is `summary.status`; the poller reads `run.status`. If `RunSummary` names it `state`, use that.)

- [ ] **Step 4: Run to verify it passes**

Run: `bun test lib/runs/__tests__/store-memo.test.ts && bun test lib/runs/__tests__/store.test.ts`
Expected: PASS (new + existing store tests, including corrupt/missing-db cases).

- [ ] **Step 5: Write the failing herdr-backoff test**

Add to `lib/daemon/__tests__/agent-status-poller.test.ts` (using the existing `probe`/`list` DI seams and manual `tick()`):

```ts
test("backs off the herdr probe after repeated failures", async () => {
  let probeCalls = 0;
  const handle = startAgentStatusPoller({
    intervalMs: 3_600_000,           // real timer never fires
    probe: async () => { probeCalls++; return null; }, // herdr absent
    list: () => [],
  });
  for (let i = 0; i < 20; i++) await handle.tick();
  handle.stop();
  // Without backoff this would be 20; with backoff (threshold 3, 1-in-6) far fewer.
  expect(probeCalls).toBeLessThan(10);
});
```

- [ ] **Step 6: Run to verify it fails**

Run: `bun test lib/daemon/__tests__/agent-status-poller.test.ts`
Expected: FAIL ... `probeCalls` is 20 (probes every tick).

- [ ] **Step 7: Add the backoff**

In `lib/daemon/agent-status-poller.ts`, add constants and counter state in the closure around `tick`:

```ts
const FAILURE_THRESHOLD = 3;   // consecutive null probes before backing off
const BACKOFF_TICKS = 6;       // then probe once every 6 ticks (~60s at 10s cadence)
```

```ts
  let consecutiveFailures = 0;
  let ticksSkipped = 0;
  async function tick() {
    if (consecutiveFailures >= FAILURE_THRESHOLD) {
      if (++ticksSkipped < BACKOFF_TICKS) return;
      ticksSkipped = 0;
    }
    const entries = await probe();
    if (entries === null) { consecutiveFailures++; return; }
    consecutiveFailures = 0;
    // ...existing tick body...
  }
```

- [ ] **Step 8: Run to verify it passes**

Run: `bun test lib/daemon/__tests__/agent-status-poller.test.ts && bunx tsc --noEmit`
Expected: PASS; tsc clean.

- [ ] **Step 9: Commit**

```bash
git add lib/runs/store.ts lib/daemon/agent-status-poller.ts lib/runs/__tests__/store-memo.test.ts lib/daemon/__tests__/agent-status-poller.test.ts
git commit -m "runs: mtime-memoize finished-run summaries; back off herdr probe (S101, S038, S039)"
```

---

### Task 12: Gate background scans on demand (S058, S093)

The 10s system-process scan and 30s port scan run at full cadence with zero consumers (idle tray, battery). Gate them on a recent consumer read (tray/CLI/REST hit of `ports`/`system-processes`/`tray:status`). Wired via a new tracker read from `pollers.ts` and set by wrapping the demand commands in `command-router.ts` (no forbidden-file edit; verified reachable).

**Files:**
- Create: `lib/daemon/demand-tracker.ts`
- Modify: `lib/daemon/command-router.ts` (wrap the demand-command entries)
- Modify: `lib/daemon/pollers.ts` (skip scans when no recent demand)
- Test: `lib/daemon/__tests__/demand-tracker.test.ts` (create)

**Interfaces:**
- Produces: `recordDemand()`, `demandedWithin(ms) => boolean`, `wrapWithDemand(handlers, cmds) => handlers` in `demand-tracker.ts`.

- [ ] **Step 1: Write the failing test**

Create `lib/daemon/__tests__/demand-tracker.test.ts`:

```ts
import { test, expect } from "bun:test";
import { recordDemand, demandedWithin, wrapWithDemand } from "../demand-tracker.ts";

test("demandedWithin reflects a recent recordDemand", () => {
  recordDemand();
  expect(demandedWithin(60_000)).toBe(true);
  expect(demandedWithin(0)).toBe(false); // window of 0ms is never "recent"
});

test("wrapWithDemand records demand and delegates to the inner handler", async () => {
  let called = false;
  const handlers = { "system-processes": async () => { called = true; return { ok: true }; }, other: async () => ({ ok: true }) };
  wrapWithDemand(handlers, ["system-processes"]);
  const before = demandedWithin(50);
  await handlers["system-processes"](undefined as any);
  expect(called).toBe(true);
  expect(demandedWithin(1000)).toBe(true);
  void before;
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test lib/daemon/__tests__/demand-tracker.test.ts`
Expected: FAIL ... module does not exist.

- [ ] **Step 3: Create the tracker**

Create `lib/daemon/demand-tracker.ts`:

```ts
/**
 * "A consumer is watching" signal for the background scans. The tray/CLI/console
 * calling ports/system-processes/tray:status stamps demand here (via the
 * command-router wrapper); pollers skip the 10s/30s scans when nothing has asked
 * recently, so an idle machine stops paying the lsof/git tax (S058, S093).
 */
let lastDemandAt = 0;

export function recordDemand(): void {
  lastDemandAt = Date.now();
}

/** True when a consumer read a scan-backed command within `ms`. */
export function demandedWithin(ms: number): boolean {
  return lastDemandAt !== 0 && Date.now() - lastDemandAt < ms;
}

/** Wrap the named handler entries so each call stamps demand, then delegates. */
export function wrapWithDemand<T extends Record<string, any>>(handlers: T, cmds: string[]): T {
  for (const cmd of cmds) {
    const inner = handlers[cmd];
    if (typeof inner !== "function") continue;
    (handlers as any)[cmd] = (...args: any[]) => { recordDemand(); return inner(...args); };
  }
  return handlers;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `bun test lib/daemon/__tests__/demand-tracker.test.ts`
Expected: PASS.

- [ ] **Step 5: Wrap the demand commands in the router**

In `lib/daemon/command-router.ts`: `import { wrapWithDemand } from "./demand-tracker.ts";`. Change the trailing `return { ...handlers... }` of `buildRoutedHandlers` to assign then wrap:

```ts
  const handlers: TypedHandlers & HandlerMap = {
    ...createCacheHandlers(ctx),
    // ...unchanged spreads...
    "freshness:reconcile": async () => {
      await reconcileFreshness({ ctx, broadcast });
      return { ok: true, data: getFreshnessSnapshot() };
    },
  };
  // A tray/CLI/console read of any scan-backed command means "someone is
  // watching", which un-gates the background scans (see pollers.ts, S058/S093).
  return wrapWithDemand(handlers, ["ports", "system-processes", "tray:status"]);
```

- [ ] **Step 6: Gate the scans in pollers**

In `lib/daemon/pollers.ts`: `import { demandedWithin } from "./demand-tracker.ts";` and add:

```ts
/** Consider a consumer "present" for 5 min after its last scan-backed read. */
const DEMAND_WINDOW_MS = 5 * 60 * 1000;
```

Add the gate as the first line inside both scan bodies (after the in-flight guard):

```ts
  async function refreshPortCache(): Promise<void> {
    if (portScanInFlight) return;
    if (!demandedWithin(DEMAND_WINDOW_MS)) return; // no consumer asked recently
    portScanInFlight = true;
    // ...unchanged...
  }

  async function refreshSystemProcesses(): Promise<void> {
    if (processScanInFlight) return;
    if (!demandedWithin(DEMAND_WINDOW_MS)) return;
    processScanInFlight = true;
    // ...unchanged...
  }
```

(The tray's on-demand `system-processes` handler already calls `scanner.refresh()` when its cache is stale, so a freshly-connecting consumer gets immediate data and its read stamps demand, resuming the poller on the next tick. The hooks-scan and cache-refresh intervals are unaffected.)

- [ ] **Step 7: Run tests + typecheck**

Run: `bun test lib/daemon/__tests__/demand-tracker.test.ts && bunx tsc --noEmit`
Expected: PASS; tsc clean.

- [ ] **Step 8: Commit**

```bash
git add lib/daemon/demand-tracker.ts lib/daemon/command-router.ts lib/daemon/pollers.ts lib/daemon/__tests__/demand-tracker.test.ts
git commit -m "pollers: gate the 10s/30s scans on recent consumer demand (S058, S093)"
```

---

### Final verification (run before the whole-branch review)

- [ ] `bun run build` inside `packages/rt-client` (rt-client's `runCapture` mirror changed in Task 1).
- [ ] `bun test lib commands packages scripts` ... all green.
- [ ] `bunx tsc --noEmit` ... zero errors.
- [ ] `bun test lib/__tests__/no-daemon-sync-exec.test.ts` ... green; capture the Task 7 Step 3 RED demonstration for the report.
- [ ] Confirm no sibling-owned file in the write fence was modified (`git diff --name-only main...` reviewed against the fence).
