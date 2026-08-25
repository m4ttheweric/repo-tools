# Repo Locate + Registry Merge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a moved repo folder healable in one atomic operation — every literal path rt stores (repo index, worktree registries, endpoint claims, git's own worktree admin files) re-pointed together — and collapse the name/identity registry pairs the RT-62 cutover left behind.

**Architecture:** A pure core (`lib/repo-locate.ts`) plans and applies the move: one sync `state.db` transaction rewrites index rows, registry paths, and claim paths; `git worktree repair` runs after the commit; a pre-apply snapshot is restored if verification fails. The daemon owns the apply when it is up, running it inside a new reconciler hold so no reconcile pass can observe an index row that healed ahead of its registry (the ordering that destroys claimed/on-deck state today). A registry merge primitive lets `rt repos prune` collapse the split pool the cutover created, and a prune guard stops evicting a missing row that still owns registry data.

**Tech Stack:** Bun + TypeScript, `bun:test`, `bun:sqlite` via `state.db` (`lib/state/`), `runCapture`-backed async git (`lib/worktree/git-async.ts`), the daemon's unix-socket IPC (`lib/daemon-client.ts`).

**Spec:** `docs/superpowers/specs/2026-08-25-repo-locate-design.md` — binding; read it first. Supporting contracts: `docs/repo-identity.md` (the two string forms), `CLAUDE.md` (logging seams, module registry, operating rules).

## Global Constraints

- **The daemon is never stopped for any of this.** Mutations of daemon-owned state go through the daemon whenever its socket answers; a local apply happens only when no daemon answers. Never add a "stop the daemon first" step, a `launchctl` call, or a daemon restart.
- **Identity wire form everywhere.** Every index key, registry key, `endpoint_claims.repo` value, and daemon payload `repo` field is a serialized identity (`remote:gitlab.com%2Fg%2Fr` / `path:%2FUsers%2F…`) produced by `serializeIdentity`/validated by `parseIdentity`, imported from `lib/settings/identity.ts` (never `@mattstack/rt-client`, which does not resolve from `lib/`). The raw `host/path` form appears only in settings-store `repos.<identity>` sections — this plan touches none of those. Never hand-assemble or string-split a wire.
- **Registry namespace constant is `worktree-registry`**, mirrored in both `lib/worktree/registry.ts` and `lib/repo-index.ts`. Keep both spellings; they are a parity anchor.
- **`bun:sqlite` transactions are sync-only.** No `await` inside a `db.transaction(...)` callback. All git work (`git worktree repair`, `git worktree list`) happens AFTER the transaction commits.
- **No sync git spawns on any path the daemon can reach.** `lib/repo-index.ts` is reachable from daemon handlers (`resolveIndexPathForIdentity`), so anything added there stays free of `execSync`-shaped git beyond what already exists.
- **Logging via seams only.** `dispatch()` (`lib/command-tree.ts`) logs every CLI command's outcome; `handleCommand` (`lib/daemon.ts`) logs every daemon command's ok/rejected/threw. New code logs NO outcomes, wraps no handler in a logging try/catch, and adds no `console.log` progress narration. Daemon handlers that must record a domain event use `ctx.log`; below a seam, an empty catch is acceptable only for a genuinely expected condition.
- **Module registry: no new command module.** `rt repos locate` lives inside the existing `commands/repos.ts`, already thunked at `lib/module-registry.ts:47` (`"./commands/repos.ts": () => import("../commands/repos.ts")`). Do not add a registry entry, do not create a new command module, and do not add a static import of `lib/rt-render.tsx` or `ink` anywhere on a command-tree path.
- **The `packages/rt-client/dist/` freshness rule does not apply to this plan.** `packages/rt-client` is untouched: no `bun run build` in that package, no consumer `bun install`, no rt-client catalog entry for `repos:locate` (the daemon's handler map is the only registration needed — `lib/daemon/__tests__/rt-client-commands.test.ts` asserts catalog ⊆ handlers, never the reverse).
- **Comments are constraint-only** (`~/.claude/rules/clean-code-comments.md`): a parity anchor, an ordering trap, a non-obvious invariant, a why that would otherwise be lost. No narration of the next line, no reviewer-facing justification, no ticket numbers (RT-63/RT-68/spec section refs belong in the commit body, not the source).
- **Test HOME discipline:** every new test repoints `process.env.HOME` to a fresh `mkdtempSync` dir in `beforeEach` and calls `closeStateDb()` before and after (the `getStateDb()` singleton binds to the HOME live at its first call). `bunfig.toml`'s preload gives a process-wide throwaway HOME on top of that — never remove it.
- **Canonical fixtures:** `realpathSync` every temp dir a test hands to git. macOS canonicalizes `/var` → `/private/var`, and `git worktree list` returns the canonical spelling; an uncanonicalized fixture path makes path comparisons fail for the wrong reason.
- **Gates per task, FOREGROUND:** the task's own test files (`bun test <file>`) plus `bunx tsc --noEmit`. State any delta from the baseline. The full sweep `bun test lib commands` runs in the final task.
- **One commit per task**, message body ending with the trailer:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

## File structure

**New files:**
- `lib/repo-locate.ts` — the pure core: `planLocate`, `applyLocate`, `findLocateCandidates`, plan/refusal/result types. No daemon, no CLI, no console output.
- `lib/repo-locate-dispatch.ts` — the one place that decides daemon-vs-local for a locate. Imports `lib/daemon-client.ts`; imported by `commands/repos.ts` and (dynamically) by `lib/repo-index.ts`.
- `lib/daemon/handlers/repos.ts` — the `repos:locate` verb.
- `lib/worktree/__tests__/registry-merge.test.ts`, `lib/__tests__/repo-index-missing.test.ts`, `lib/__tests__/repo-locate.test.ts`, `lib/__tests__/repo-locate-heal.test.ts`, `lib/__tests__/repo-locate-e2e.test.ts`, `lib/daemon/__tests__/reconciler-hold.test.ts`, `lib/daemon/__tests__/repos-handlers.test.ts`, `commands/__tests__/repos-locate.test.ts`.

**Modified files:**
- `lib/worktree/registry.ts` — `mergeRegistries`, `hasRegistry`, `deleteRegistry`.
- `lib/repo-index.ts` — merge-aware `migrateWorktreeRegistry`; prune retains a missing row that owns a registry; `KnownRepo.missing`; raw row primitives (`setIndexPath`, `removeIndexRow`, `refreshRepoIndexMirror`); move-aware `updateRepoIndex` + `updateRepoIndexAsync`.
- `lib/pickers.ts`, `lib/repo.ts` — refuse to cd into a missing repo.
- `lib/daemon/worktree-reconciler.ts` — `withReconcilerHeld`.
- `lib/daemon/command-router.ts`, `lib/daemon.ts` — wire the repos handlers.
- `lib/daemon/__tests__/rt-client-commands.test.ts` — new `buildRoutedHandlers` opt.
- `lib/__tests__/repo-index-rename.test.ts` — one existing assertion inverts (refuse → merge).
- `commands/repos.ts`, `lib/command-tree-def.ts` — the `rt repos locate` verb and its prune output changes.

**Task → spec scope item:** T1→1, T2→2, T3→3, T4→7, T5→4, T6→5 (the reconciler hold), T7→5 (the verb), T8→6, T9→8, T10→spec "Verification".

---

## Task 1: Registry merge primitive

**Files:**
- Modify: `lib/worktree/registry.ts` (append after `findByPath`, `lib/worktree/registry.ts:86-91`)
- Test: `lib/worktree/__tests__/registry-merge.test.ts` (create)

**Interfaces:**
- Consumes: `TreeRecord`, `TreeKind` (already exported from `lib/worktree/registry.ts`).
- Produces: `mergeRegistries(winner: TreeRecord[], loser: TreeRecord[]): TreeRecord[]` — pure, no I/O beyond a guarded `realpathSync` for path canonicalization. Union by canonical path; winner-side records keep their relative order and come first, loser-only records follow in their own order.

- [ ] **Step 1: Write the failing test**

Create `lib/worktree/__tests__/registry-merge.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { mergeRegistries, type TreeRecord } from "../registry.ts";

function rec(over: Partial<TreeRecord> & { path: string }): TreeRecord {
  return {
    name: over.path.split("/").pop()!,
    kind: "unmanaged",
    branch: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

describe("mergeRegistries", () => {
  test("unions disjoint paths, winner side first", () => {
    const merged = mergeRegistries([rec({ path: "/a/main" })], [rec({ path: "/a/tree-1" })]);
    expect(merged.map((t) => t.path)).toEqual(["/a/main", "/a/tree-1"]);
  });

  test("an empty loser returns the winner unchanged", () => {
    const winner = [rec({ path: "/a/main" }), rec({ path: "/a/tree-1" })];
    expect(mergeRegistries(winner, [])).toEqual(winner);
  });

  test("an empty winner returns the loser's records", () => {
    const loser = [rec({ path: "/a/main", kind: "main" })];
    expect(mergeRegistries([], loser)).toEqual(loser);
  });

  test("on a shared path the managed record wins, whichever side it is on", () => {
    const claimed = rec({ path: "/a/tree-1", kind: "ephemeral", state: "claimed", owner: "matt" });
    const adopted = rec({ path: "/a/tree-1", kind: "unmanaged" });

    expect(mergeRegistries([adopted], [claimed])[0]).toEqual(claimed);
    expect(mergeRegistries([claimed], [adopted])[0]).toEqual(claimed);
  });

  test("two managed records on one path: the later createdAt wins", () => {
    const older = rec({ path: "/a/tree-1", kind: "ephemeral", state: "on-deck", createdAt: "2026-01-01T00:00:00.000Z" });
    const newer = rec({ path: "/a/tree-1", kind: "ephemeral", state: "claimed", createdAt: "2026-02-01T00:00:00.000Z" });

    expect(mergeRegistries([older], [newer])[0]).toEqual(newer);
    expect(mergeRegistries([newer], [older])[0]).toEqual(newer);
  });

  test("an equal createdAt keeps the winner side", () => {
    const w = rec({ path: "/a/tree-1", kind: "ephemeral", state: "on-deck", owner: "winner" });
    const l = rec({ path: "/a/tree-1", kind: "ephemeral", state: "on-deck", owner: "loser" });
    expect(mergeRegistries([w], [l])[0]!.owner).toBe("winner");
  });

  test("an unparseable createdAt never displaces the winner", () => {
    const w = rec({ path: "/a/tree-1", kind: "ephemeral", createdAt: "2026-01-01T00:00:00.000Z", owner: "winner" });
    const l = rec({ path: "/a/tree-1", kind: "ephemeral", createdAt: "not a date", owner: "loser" });
    expect(mergeRegistries([w], [l])[0]!.owner).toBe("winner");
  });

  test("a duplicate path inside one side keeps its first occurrence", () => {
    const first = rec({ path: "/a/tree-1", kind: "ephemeral", owner: "first" });
    const second = rec({ path: "/a/tree-1", kind: "ephemeral", owner: "second" });
    expect(mergeRegistries([first, second], [])).toEqual([first]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test lib/worktree/__tests__/registry-merge.test.ts`
Expected: FAIL — `mergeRegistries` is not exported from `../registry.ts`.

- [ ] **Step 3: Write the implementation**

In `lib/worktree/registry.ts`, add `realpathSync` to the `fs` imports (the file currently imports nothing from `fs`; add `import { realpathSync } from "fs";` above the `path` import), then append after `findByPath`:

```ts
/** Canonical path key: a tree that no longer exists compares by its own spelling rather than throwing. */
function canonPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

const MANAGED_KINDS: ReadonlySet<TreeKind> = new Set<TreeKind>(["main", "ephemeral"]);

/**
 * Total order for two records of the same canonical path: a managed record
 * carries claim/ready state no git repository has another copy of, so it beats
 * `unmanaged`; within one class the later `createdAt` wins; an equal or
 * unparseable stamp keeps the winner side.
 */
function heldRecordWins(held: TreeRecord, challenger: TreeRecord): boolean {
  const heldManaged = MANAGED_KINDS.has(held.kind);
  const challengerManaged = MANAGED_KINDS.has(challenger.kind);
  if (heldManaged !== challengerManaged) return heldManaged;
  return !(Date.parse(challenger.createdAt) > Date.parse(held.createdAt));
}

/**
 * Union two registries of the SAME repo by canonical path — the collapse a
 * name/identity index pair needs, where each side owns half of one on-deck
 * pool. Name collisions across the two sides are left standing: the union is
 * by path, and a record's name is only ever consulted for display and for
 * `usedNames` disambiguation, both of which tolerate a duplicate.
 */
export function mergeRegistries(winner: TreeRecord[], loser: TreeRecord[]): TreeRecord[] {
  const byPath = new Map<string, TreeRecord>();
  const order: string[] = [];
  for (const rec of [...winner, ...loser]) {
    const key = canonPath(rec.path);
    const held = byPath.get(key);
    if (!held) {
      byPath.set(key, rec);
      order.push(key);
      continue;
    }
    if (!heldRecordWins(held, rec)) byPath.set(key, rec);
  }
  return order.map((key) => byPath.get(key)!);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test lib/worktree/__tests__/registry-merge.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: Typecheck**

Run: `bunx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 6: Commit**

```bash
git add lib/worktree/registry.ts lib/worktree/__tests__/registry-merge.test.ts
git commit -m "feat(worktree): mergeRegistries — union two registries of one repo by canonical path"
```

---

## Task 2: Prune merges the split registry instead of refusing

**Files:**
- Modify: `lib/repo-index.ts:290-311` (`DataMigration.registry` doc + union), `lib/repo-index.ts:334-369` (`migrateWorktreeRegistry`)
- Modify: `commands/repos.ts:164-175` (`describeDataMove`)
- Test: `lib/__tests__/repo-index-rename.test.ts:385-464` (one existing assertion inverts; two tests added)

**Interfaces:**
- Consumes: `mergeRegistries(winner: TreeRecord[], loser: TreeRecord[]): TreeRecord[]` from `lib/worktree/registry.ts` (Task 1).
- Produces: `DataMigration["registry"]` widens to `"moved" | "merged" | "refused" | "none"`. `migrationIncomplete(d: DataMigration): boolean` is unchanged — `"merged"` is a COMPLETE outcome, so a merged pair's index row is evicted like any other duplicate.

- [ ] **Step 1: Write the failing tests**

In `lib/__tests__/repo-index-rename.test.ts`, inside `describe("worktree registry migration", …)`, REPLACE the existing test `"refuses when the live name already has one — both hold real claim state"` (currently at line 399) with:

```ts
    test("merges when the live name already has one — one pool, both halves", () => {
      setKvValue(WT_NS, "repo-tools", [
        { name: "t1", path: "/x/t1", kind: "ephemeral", state: "on-deck", branch: "on-deck/t1", createdAt: "2026-01-01T00:00:00.000Z" },
      ]);
      setKvValue(WT_NS, "rt", [
        { name: "main", path: "/x/main", kind: "main", branch: "main", createdAt: "2026-01-01T00:00:00.000Z" },
      ]);

      const result = migrateRepoData("repo-tools", "rt");

      expect(result.registry).toBe("merged");
      expect((listKvValues(WT_NS)["rt"] as Array<{ path: string }>).map((t) => t.path)).toEqual(["/x/main", "/x/t1"]);
      expect(listKvValues(WT_NS)["repo-tools"]).toBeUndefined();
    });

    test("a merged registry is a COMPLETE migration — the retired index row is evicted", () => {
      const dir = realRepo("repo-tools");
      indexRepoAt("repo-tools", dir, 1_000);
      indexRepoAt("rt", dir, 2_000);
      setKvValue(WT_NS, "repo-tools", tree("/x/retired"));
      setKvValue(WT_NS, "rt", tree("/x/live"));

      const removed = pruneRepoIndex();

      expect(removed.find((r) => r.repoName === "repo-tools")?.data?.registry).toBe("merged");
      expect(removed.find((r) => r.repoName === "repo-tools")?.retained).toBeUndefined();
      expect(loadRepoIndexEntries().map((e) => e.repoName)).toEqual(["rt"]);
    });

    test("--dry-run reports the merge without performing it", () => {
      setKvValue(WT_NS, "repo-tools", tree("/x/retired"));
      setKvValue(WT_NS, "rt", tree("/x/live"));

      expect(migrateRepoData("repo-tools", "rt", { dryRun: true }).registry).toBe("merged");

      expect(listKvValues(WT_NS)["repo-tools"]).toEqual(tree("/x/retired"));
      expect(listKvValues(WT_NS)["rt"]).toEqual(tree("/x/live"));
    });
```

Also REPLACE the existing test `"a refused registry KEEPS the index row — eviction is what makes a leftover unreachable"` (line 435) — the registry can no longer be the cause of a refusal; a refused FILE still is, and the test below it already covers that. Delete that test.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test lib/__tests__/repo-index-rename.test.ts`
Expected: FAIL — `expected "merged", got "refused"`.

- [ ] **Step 3: Write the implementation**

In `lib/repo-index.ts`, import the merge (registry.ts imports only `path`, `rt-paths`, and `state/index.ts`, all of which repo-index already loads — no new module weight beyond registry.ts itself):

```ts
import { mergeRegistries, type TreeRecord } from "./worktree/registry.ts";
```

Widen the `DataMigration.registry` field (`lib/repo-index.ts:310`) and its doc:

```ts
  /**
   * The retired name's worktree registry: `"moved"` onto the live name,
   * `"merged"` into the live name's own registry (the name/identity pair the
   * identity cutover left, each side owning half of one on-deck pool),
   * `"refused"` because the write could not be verified, or `"none"` if it
   * had none.
   *
   * This lives in state.db's kv, not the data dir, so it is invisible to a
   * directory walk — and it is the record the daemon keys by, so a retired
   * name that keeps it while the index row goes away leaves the reconciler
   * silently skipping the repo.
   */
  registry: "moved" | "merged" | "refused" | "none";
```

Replace the body of `migrateWorktreeRegistry` (`lib/repo-index.ts:349-369`), keeping its existing doc comment's first paragraph and replacing the final "A live name that ALREADY has a registry is refused" paragraph with the merge rule:

```ts
/**
 * Moves the retired name's worktree registry onto the live name.
 *
 * The daemon keys registries by the INDEX name
 * (`lib/daemon/worktree-reconciler.ts` iterates the repo index), while the CLI
 * looks them up by git identity. A rename splits those two, and evicting the
 * retired index row then makes the registry unreachable:
 * `repoHasWorktreeActivity` sees an empty registry under the live name and
 * skips the repo, so the reconciler quietly stops managing its worktrees.
 * That is why this moves with the data dir instead of being left behind.
 *
 * A live name that already has a registry is MERGED, not refused: both sides
 * describe the same repo's trees, so the union by path (`mergeRegistries`)
 * loses neither half of a pool that a name/identity pair split.
 */
function migrateWorktreeRegistry(from: string, to: string, opts: { dryRun?: boolean }): DataMigration["registry"] {
  let outcome: "moved" | "merged";
  try {
    if (!hasKvValue(WORKTREE_REGISTRY_NS, from)) return "none";
    outcome = hasKvValue(WORKTREE_REGISTRY_NS, to) ? "merged" : "moved";
    if (opts.dryRun) return outcome;

    const retired = getKvValue<TreeRecord[]>(WORKTREE_REGISTRY_NS, from, []);
    const live = outcome === "merged" ? getKvValue<TreeRecord[]>(WORKTREE_REGISTRY_NS, to, []) : [];
    const next = outcome === "merged" ? mergeRegistries(live, retired) : retired;
    setKvValue(WORKTREE_REGISTRY_NS, to, next);

    // persistOrWarn swallows SQLITE_BUSY, so a returned write is not a landed
    // one — and on a merge the destination row already existed, so its mere
    // presence proves nothing. Compare the readback.
    if (JSON.stringify(getKvValue<TreeRecord[]>(WORKTREE_REGISTRY_NS, to, [])) !== JSON.stringify(next)) {
      console.warn(`rt: ${from}'s worktree registry did not persist under ${to} — leaving it in place`);
      return "refused";
    }
  } catch (err) {
    console.warn(`rt: could not move ${from}'s worktree registry to ${to} (${(err as Error).message})`);
    return "refused";
  }
  deleteKvValue(WORKTREE_REGISTRY_NS, from);
  return outcome;
}
```

In `commands/repos.ts`, extend `describeDataMove` (`commands/repos.ts:164-175`) — add the merge clause immediately after the `"moved"` clause:

```ts
  if (d.registry === "merged") parts.push(`${dryRun ? "would merge" : "merged"} the worktree registry into ${r.keptAs}'s`);
  if (d.registry === "refused") parts.push(`${r.keptAs}'s worktree registry could not be written — both kept`);
```

(The existing `d.registry === "refused"` line is REPLACED by the wording above; `"refused"` now only ever means a failed write.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test lib/__tests__/repo-index-rename.test.ts commands/__tests__/repos.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `bunx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 6: Commit**

```bash
git add lib/repo-index.ts commands/repos.ts lib/__tests__/repo-index-rename.test.ts
git commit -m "feat(repos): prune merges a split worktree registry instead of refusing"
```

---

## Task 3: Prune retains a missing row that still owns a registry

**Files:**
- Modify: `lib/repo-index.ts:273-311` (`PrunedEntry`), `lib/repo-index.ts:494-524` (`pruneRepoIndex`)
- Modify: `commands/repos.ts:187-214` (`reposPrune` output)
- Test: `lib/__tests__/repo-index-rename.test.ts` (append to `describe("pruneRepoIndex", …)`), `commands/__tests__/repos.test.ts` (append to `describe("reposPrune", …)`)

**Interfaces:**
- Consumes: `WORKTREE_REGISTRY_NS` and `hasKvValue` (both already in `lib/repo-index.ts`).
- Produces: `PrunedEntry` gains `hint?: string`, and `retained?: true` is now set for two reasons — an incomplete duplicate migration (existing) and a `missing` row that owns a worktree registry (new). `PruneReason` is unchanged (`"missing" | "duplicate"`).

- [ ] **Step 1: Write the failing tests**

Append to `describe("pruneRepoIndex", …)` in `lib/__tests__/repo-index-rename.test.ts`:

```ts
    test("a missing row that still owns a worktree registry is KEPT, not evicted", () => {
      indexRepoAt("moved", join(scratch, "gone-away"), 1_000);
      setKvValue("worktree-registry", "moved", [
        { name: "t1", path: join(scratch, "gone-away", ".worktrees", "t1"), kind: "ephemeral", state: "on-deck", branch: "on-deck/t1", createdAt: "2026-01-01T00:00:00.000Z" },
      ]);

      const removed = pruneRepoIndex();
      const row = removed.find((r) => r.repoName === "moved");

      expect(row).toMatchObject({ reason: "missing", retained: true, hint: "rt repos locate" });
      expect(loadRepoIndexEntries().map((e) => e.repoName)).toEqual(["moved"]);
      expect(listKvValues("worktree-registry")["moved"]).toBeDefined();
    });

    test("a missing row with no registry is still evicted", () => {
      indexRepoAt("gone", join(scratch, "never-existed"), 1_000);

      const removed = pruneRepoIndex();

      expect(removed.find((r) => r.repoName === "gone")?.retained).toBeUndefined();
      expect(loadRepoIndexEntries()).toEqual([]);
    });
```

Append to `describe("reposPrune", …)` in `commands/__tests__/repos.test.ts`:

```ts
  test("a retained missing row tells the operator to locate it", async () => {
    const { setKvValue } = await import("../../lib/state/index.ts");
    updateRepoIndex("moved-repo", join(home, "gone-away"));
    setKvValue("worktree-registry", "moved-repo", [
      { name: "t1", path: join(home, "gone-away", ".worktrees", "t1"), kind: "ephemeral", state: "on-deck", branch: "on-deck/t1", createdAt: "2026-01-01T00:00:00.000Z" },
    ]);
    const deps = testDeps();

    await reposPrune([], {}, deps);

    expect(deps.lines.join("\n")).toContain("kept moved-repo");
    expect(deps.lines.join("\n")).toContain("rt repos locate");
    expect(loadRepoIndex()["moved-repo"]).toBeDefined();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test lib/__tests__/repo-index-rename.test.ts commands/__tests__/repos.test.ts`
Expected: FAIL — the missing row is evicted and no `hint` field exists.

- [ ] **Step 3: Write the implementation**

In `lib/repo-index.ts`, extend `PrunedEntry` (replacing the existing `retained` doc):

```ts
  /**
   * Set when the row is KEPT despite qualifying for eviction: a `duplicate`
   * whose migration could not finish, or a `missing` row that still owns a
   * worktree registry. Eviction is exactly what makes those leftovers
   * unreachable.
   */
  retained?: true;
  /** Set with `retained`: the verb that resolves this row. */
  hint?: string;
```

Replace the missing/live split at the top of `pruneRepoIndex` (`lib/repo-index.ts:499-502`):

```ts
  for (const entry of entries) {
    if (existsSync(entry.path)) {
      live.push(entry);
      continue;
    }
    // A gone path whose registry is still here is a MOVE, not a deletion:
    // dropping the row orphans the pool's claim state under a key nothing
    // iterates any more.
    let ownsRegistry = false;
    try {
      ownsRegistry = hasKvValue(WORKTREE_REGISTRY_NS, entry.repoName);
    } catch { /* unreadable db — treat as no registry and prune as before */ }
    removed.push({
      repoName: entry.repoName,
      path: entry.path,
      reason: "missing",
      ...(ownsRegistry ? { retained: true as const, hint: "rt repos locate" } : {}),
    });
  }
```

In `commands/repos.ts`, replace the `why` expression inside `reposPrune`'s print loop (`commands/repos.ts:209-211`):

```ts
    const why = r.retained
      ? r.reason === "missing"
        ? `${describeReason(r)} but it still owns a worktree registry — keeping the row; run: ${r.hint} <new-path> --repo ${r.repoName}`
        : `${describeReason(r)}, but its data could not all move${describeDataMove(r, dryRun)} — keeping the row so nothing is orphaned`
      : `${describeReason(r)}${describeDataMove(r, dryRun)}`;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test lib/__tests__/repo-index-rename.test.ts commands/__tests__/repos.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `bunx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 6: Commit**

```bash
git add lib/repo-index.ts commands/repos.ts lib/__tests__/repo-index-rename.test.ts commands/__tests__/repos.test.ts
git commit -m "fix(repos): keep a missing index row that still owns a worktree registry"
```

---

## Task 4: Lost rows stay visible and are never a cd target

**Files:**
- Modify: `lib/repo-index.ts:34-42` (`KnownRepo`), `lib/repo-index.ts:659-726` (`getKnownRepos`), `lib/repo-index.ts:896-909` (`repoOption`)
- Modify: `lib/pickers.ts:87-115` (`pickFromAllRepos`)
- Modify: `lib/repo.ts:194-232` (`requireRepoIdentity`), `lib/repo.ts:240-284` (`pickWorktree`)
- Test: `lib/__tests__/repo-index-missing.test.ts` (create)

**Interfaces:**
- Consumes: `partitionByRealpath(entries: RepoIndexEntry[]): IndexPartition`, `loadRepoIndexEntries(): RepoIndexEntry[]`, `repoDataDir(key: string): string` (all existing).
- Produces:
  - `interface KnownRepo` gains `missing?: true`.
  - `missingRepoRefusal(r: KnownRepo): string` — exported from `lib/repo-index.ts` and re-exported through `lib/repo.ts`'s existing re-export line.
  - `repoOption(r: KnownRepo)` return shape is unchanged (`{ value, label, hint, color? }`); a missing repo gets `hint: "missing — rt repos locate"` and the `dim` color.

- [ ] **Step 1: Write the failing test**

Create `lib/__tests__/repo-index-missing.test.ts`:

```ts
/**
 * A moved repo's index row must stay visible: hiding it makes the repo look
 * unregistered and re-registers it under a second row at the new path, which
 * is the split `rt repos locate` exists to prevent.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { execSync } from "child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { closeStateDb, setKvValue } from "../state/index.ts";
import { getKnownRepos, missingRepoRefusal, repoOption } from "../repo-index.ts";
import { pickFromAllRepos } from "../pickers.ts";

describe("missing index rows", () => {
  const origHome = process.env.HOME;
  let home: string;
  let scratch: string;

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "rt-missing-home-")));
    scratch = realpathSync(mkdtempSync(join(tmpdir(), "rt-missing-repos-")));
    process.env.HOME = home;
    closeStateDb();
  });

  afterEach(() => {
    process.env.HOME = origHome;
    closeStateDb();
    rmSync(home, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  });

  function realRepo(name: string): string {
    const dir = join(scratch, name);
    mkdirSync(dir, { recursive: true });
    execSync("git init -q -b main", { cwd: dir, stdio: "pipe" });
    execSync("git -c user.email=t@t -c user.name=t commit --allow-empty -q -m init", { cwd: dir, stdio: "pipe" });
    return dir;
  }

  test("a row whose path is gone survives getKnownRepos, marked missing", () => {
    setKvValue("repo-index", "moved", join(scratch, "gone-away"));

    const row = getKnownRepos().find((r) => r.repoName === "moved");

    expect(row?.missing).toBe(true);
    expect(row?.worktrees[0]?.path).toBe(join(scratch, "gone-away"));
  });

  test("a live row is never marked missing", () => {
    setKvValue("repo-index", "alive", realRepo("alive"));

    expect(getKnownRepos().find((r) => r.repoName === "alive")?.missing).toBeUndefined();
  });

  test("two lost rows for one directory collapse to a single missing entry", () => {
    setKvValue("repo-index", "legacy-name", join(scratch, "gone-away"));
    setKvValue("repo-index", "remote:gitlab.com%2Fg%2Fgone", join(scratch, "gone-away"));

    expect(getKnownRepos().filter((r) => r.missing).length).toBe(1);
  });

  test("the picker row says what to run", () => {
    const opt = repoOption({ repoName: "moved", worktrees: [{ path: "/x/gone", branch: "", isBare: false }], dataDir: "/d", missing: true });
    expect(opt.hint).toBe("missing — rt repos locate");
    expect(opt.color).toBeDefined();
  });

  test("the refusal names the repo, the gone path, and the fix", () => {
    const msg = missingRepoRefusal({ repoName: "moved", worktrees: [{ path: "/x/gone", branch: "", isBare: false }], dataDir: "/d", missing: true });
    expect(msg).toContain("/x/gone");
    expect(msg).toContain("rt repos locate");
    expect(msg).toContain("--repo moved");
  });

  test("pickFromAllRepos refuses to cd into a missing repo instead of auto-selecting it", async () => {
    const exitSpy = spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit sentinel");
    });
    const errSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      await pickFromAllRepos(
        [{ repoName: "moved", worktrees: [{ path: "/x/gone", branch: "", isBare: false }], dataDir: "/d", missing: true }],
        { stderr: true },
      );
      throw new Error("expected pickFromAllRepos to exit");
    } catch (err) {
      expect((err as Error).message).toBe("process.exit sentinel");
      expect(exitSpy.mock.calls.at(-1)?.[0]).toBe(1);
      expect(errSpy.mock.calls.flat().join(" ")).toContain("rt repos locate");
    } finally {
      errSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test lib/__tests__/repo-index-missing.test.ts`
Expected: FAIL — `missingRepoRefusal` is not exported and lost rows are dropped by `getKnownRepos`.

- [ ] **Step 3: Write the implementation**

`lib/repo-index.ts` — extend `KnownRepo`:

```ts
  /** False for repos discovered by scanning sibling directories, never
   *  explicitly visited by rt. Omitted (implicitly true) for indexed repos. */
  registered?: boolean;
  /** The indexed path no longer exists. The row is kept so `rt repos locate`
   *  can move it as one unit with its registry; it is never a cd target. */
  missing?: true;
```

Replace `getKnownRepos`'s partition and tail (`lib/repo-index.ts:670-725`):

```ts
  const repos: KnownRepo[] = [];

  const liveEntries: RepoIndexEntry[] = [];
  const lostEntries: RepoIndexEntry[] = [];
  for (const e of entries) (existsSync(e.path) ? liveEntries : lostEntries).push(e);

  // Hidden here, not evicted — see partitionByRealpath.
  const { keep } = partitionByRealpath(liveEntries);

  for (const { repoName, path: mainPath } of keep) {
    // …unchanged worktree enumeration…
  }

  const known = repos.filter(r => r.worktrees.length > 0);
  // A pair of rows for one gone directory is one lost repo, not two.
  const lost: KnownRepo[] = partitionByRealpath(lostEntries).keep.map((e) => ({
    repoName: e.repoName,
    worktrees: [{ path: e.path, branch: "", isBare: false }],
    dataDir: repoDataDir(e.repoName),
    missing: true as const,
  }));
  const knownNames = new Set([...known, ...lost].map(r => r.repoName));
  // realpath'd for set-membership ONLY — a symlinked path component (macOS
  // /tmp → /private/tmp being the canonical case) must not let the same
  // directory double-emit under two spellings. `known` itself keeps its
  // original, user-visible spellings untouched. Lost paths are deliberately
  // absent: the scan must be free to surface the moved repo's NEW directory.
  const knownPaths = new Set(known.flatMap(r => r.worktrees.map(w => safeRealpath(w.path))));

  return [...known, ...lost, ...scanUnregisteredRepos([...known, ...lost], knownNames, knownPaths)];
```

Replace `repoOption` (`lib/repo-index.ts:896-909`) — add the missing branch first:

```ts
export function repoOption(r: KnownRepo): { value: string; label: string; hint: string; color?: string } {
  if (r.missing) {
    return { value: r.repoName, label: r.repoName, hint: "missing — rt repos locate", color: dim };
  }

  const location = r.worktrees.length > 1
    ? `${r.worktrees.length} worktrees`
    : r.worktrees[0]?.path.replace(homedir(), "~") || "";

  return {
    value: r.repoName,
    label: r.repoName,
    hint: r.registered === false
      ? (location ? `${location} · unregistered` : "unregistered")
      : location,
    ...(r.registered === false ? { color: dim } : {}),
  };
}
```

Add next to it:

```ts
/** The one-line refusal every picker prints instead of cd-ing into a repo whose indexed path is gone. */
export function missingRepoRefusal(r: KnownRepo): string {
  const gone = r.worktrees[0]?.path ?? "its indexed path";
  return `${r.repoName} is no longer at ${gone} — run: rt repos locate <new-path> --repo ${r.repoName}`;
}
```

`lib/repo.ts` — add `missingRepoRefusal` to BOTH the re-export line (`lib/repo.ts:17`) and the internal import (`lib/repo.ts:22`), then add above `requireRepoIdentity`:

```ts
/** Never chdir into a repo whose indexed path is gone — locate it first. */
function refuseIfMissing(repo: KnownRepo): void {
  if (!repo.missing) return;
  console.log(`\n  ${missingRepoRefusal(repo)}\n`);
  process.exit(1);
}
```

In `requireRepoIdentity`, insert `refuseIfMissing(selectedRepo);` immediately before `process.chdir(selectedRepo.worktrees[0]!.path);`.

In `pickWorktree`, insert `refuseIfMissing(repos[0]!);` as the first statement inside the `if (totalWorktrees === 1)` block, and `refuseIfMissing(selectedRepo);` immediately after the `if (repos.length === 1) … else … ` block that assigns `selectedRepo`.

`lib/pickers.ts` — add `missingRepoRefusal` to the existing `./repo.ts` import, then in `pickFromAllRepos` insert the single-repo guard BEFORE the `await import("./rt-render.tsx")` line (so a refusal never pays for loading ink) and the picked-repo guard inside the loop:

```ts
export async function pickFromAllRepos(
  repos: KnownRepo[],
  opts?: { stderr?: boolean; errorMessage?: string; includePackages?: boolean },
): Promise<string> {
  const writer = opts?.stderr ? console.error : console.log;

  if (repos.length === 0) {
    const msg = opts?.errorMessage || "no known repos found — run rt from inside a git repo first";
    writer(`\n  ${msg}\n`);
    process.exit(1);
  }

  /** Refusing before the picker loads keeps a lost-repo-only index off the ink path entirely. */
  const refuse = (repo: KnownRepo): never => {
    writer(`\n  ${missingRepoRefusal(repo)}\n`);
    process.exit(1);
  };
  if (repos.length === 1 && repos[0]!.missing) refuse(repos[0]!);

  const { filterableSelect, BackNavigation } = await import("./rt-render.tsx");

  // Loop: back from worktree/package picker restarts at repo picker
  while (true) {
    let selectedRepo: KnownRepo;

    if (repos.length === 1) {
      selectedRepo = repos[0]!;
    } else {
      const picked = await filterableSelect({
        message: "Pick a repo",
        options: repoOptionsFromList(repos),
        ...(opts?.stderr ? { stderr: true } : {}),
      });
      if (!picked) process.exit(1);
      selectedRepo = repos.find(r => r.repoName === picked)!;
    }
    if (selectedRepo.missing) refuse(selectedRepo);
    // …unchanged worktree resolution…
```

(The pre-existing `const writer = …` inside the `repos.length === 0` block is replaced by the hoisted one above.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test lib/__tests__/repo-index-missing.test.ts lib/__tests__/repo-index-rename.test.ts commands/__tests__/repos.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `bunx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 6: Commit**

```bash
git add lib/repo-index.ts lib/repo.ts lib/pickers.ts lib/__tests__/repo-index-missing.test.ts
git commit -m "feat(repos): keep lost index rows visible and refuse to cd into them"
```

---

## Task 5: Locate core — planLocate / applyLocate

**Files:**
- Create: `lib/repo-locate.ts`
- Modify: `lib/worktree/registry.ts` (add `hasRegistry`, `deleteRegistry`)
- Modify: `lib/repo-index.ts` (export `setIndexPath`, `removeIndexRow`, `refreshRepoIndexMirror`; export `REPO_INDEX_NS`)
- Test: `lib/__tests__/repo-locate.test.ts` (create)

**Interfaces:**
- Consumes: `mergeRegistries(winner, loser)` (Task 1); `loadRegistry(repoName: string): TreeRecord[]`, `saveRegistry(repoName: string, trees: TreeRecord[]): void` (existing); `loadClaims(repoName: string): EndpointClaim[]`, `saveClaims(repoName: string, claims: EndpointClaim[]): void` from `lib/endpoint/store.ts`; `loadRepoIndexEntries(): RepoIndexEntry[]`, `migrateRepoData(from, to, opts?): DataMigration`, `migrationIncomplete(d): boolean`, `getKnownRepos(): KnownRepo[]` (existing); `deriveRepoIdentity`, `serializeIdentity`, `parseIdentity` from `lib/settings/identity.ts`; `runGit(cwd, args, opts?)`, `listWorktreesAsync(repoPath): Promise<WorktreeEntry[] | null>` from `lib/worktree/git-async.ts`; `getStateDb(): Database` from `lib/state/index.ts`.
- Produces (from `lib/repo-locate.ts`):
  - `type LocateRefusalCode = "not-a-git-repo" | "nothing-lost" | "old-path-exists" | "identity-mismatch" | "identity-changed"`
  - `interface LocateRefusal { refusal: LocateRefusalCode; message: string }`
  - `interface RegistryRewrite { repoKey: string; trees: TreeRecord[]; movedPaths: string[] }`
  - `interface ClaimRewrite { repoKey: string; worktree: string; newWorktree: string }`
  - `interface LocatePlan { identity: string; oldPath: string; newPath: string; indexKeys: string[]; legacyKeys: string[]; registryRewrites: RegistryRewrite[]; claimRewrites: ClaimRewrite[]; gitRepairPaths: string[] }`
  - `interface LocateResult { ok: boolean; identity: string; from: string; to: string; indexKeys: string[]; treesRewritten: number; claimsRewritten: number; repaired: string[]; stalePaths: string[]; legacyRows: { key: string; outcome: "collapsed" | "retained" }[]; restored?: true; error?: string }`
  - `interface LocateCandidate { path: string; identity: string }`
  - `planLocate(opts: { newPath: string; repo?: string }): Promise<LocatePlan | LocateRefusal>`
  - `applyLocate(plan: LocatePlan): Promise<LocateResult>`
  - `findLocateCandidates(): Promise<LocateCandidate[]>`
  - `isRefusal(x: LocatePlan | LocateRefusal): x is LocateRefusal`
- Produces (from `lib/worktree/registry.ts`): `hasRegistry(repoName: string): boolean`, `deleteRegistry(repoName: string): void`.
- Produces (from `lib/repo-index.ts`): `REPO_INDEX_NS` (exported const, value `"repo-index"`), `setIndexPath(key: string, mainPath: string): void`, `removeIndexRow(key: string): void`, `refreshRepoIndexMirror(): void`.

- [ ] **Step 1: Write the failing test**

Create `lib/__tests__/repo-locate.test.ts`:

```ts
/**
 * The locate core: plan a move by identity, then apply index + registry +
 * claim + git-admin rewrites as one unit.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { closeStateDb, listEndpointClaims, setKvValue } from "../state/index.ts";
import { loadRepoIndex } from "../repo-index.ts";
import { loadRegistry, saveRegistry, type TreeRecord } from "../worktree/registry.ts";
import { saveClaims } from "../endpoint/store.ts";
import { deriveRepoIdentity, serializeIdentity } from "../settings/identity.ts";
import { applyLocate, isRefusal, planLocate } from "../repo-locate.ts";

describe("repo locate", () => {
  const origHome = process.env.HOME;
  let home: string;
  let scratch: string;

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "rt-locate-home-")));
    scratch = realpathSync(mkdtempSync(join(tmpdir(), "rt-locate-repos-")));
    process.env.HOME = home;
    closeStateDb();
  });

  afterEach(() => {
    process.env.HOME = origHome;
    closeStateDb();
    rmSync(home, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  });

  /** A repo with an origin remote, so its identity is remote-kind and survives the move. */
  function repoWithRemote(name: string): string {
    const dir = join(scratch, name);
    mkdirSync(dir, { recursive: true });
    execSync("git init -q -b main", { cwd: dir, stdio: "pipe" });
    execSync(`git remote add origin https://gitlab.com/g/${name}.git`, { cwd: dir, stdio: "pipe" });
    execSync("git -c user.email=t@t -c user.name=t commit --allow-empty -q -m init", { cwd: dir, stdio: "pipe" });
    return realpathSync(dir);
  }

  function localRepo(name: string): string {
    const dir = join(scratch, name);
    mkdirSync(dir, { recursive: true });
    execSync("git init -q -b main", { cwd: dir, stdio: "pipe" });
    execSync("git -c user.email=t@t -c user.name=t commit --allow-empty -q -m init", { cwd: dir, stdio: "pipe" });
    return realpathSync(dir);
  }

  function rec(over: Partial<TreeRecord> & { path: string }): TreeRecord {
    return { name: "t", kind: "unmanaged", branch: null, createdAt: "2026-01-01T00:00:00.000Z", ...over };
  }

  test("a directory that is not a git repo is refused", async () => {
    const plain = join(scratch, "plain");
    mkdirSync(plain);
    const out = await planLocate({ newPath: plain });
    expect(isRefusal(out) && out.refusal).toBe("not-a-git-repo");
  });

  test("nothing lost in the index is refused", async () => {
    const repo = repoWithRemote("alpha");
    const out = await planLocate({ newPath: repo });
    expect(isRefusal(out) && out.refusal).toBe("nothing-lost");
  });

  test("a derived identity matching no lost row refuses and names both sides", async () => {
    setKvValue("repo-index", "remote:gitlab.com%2Fg%2Fsomething-else", join(scratch, "gone"));
    const repo = repoWithRemote("beta");

    const out = await planLocate({ newPath: repo });

    expect(isRefusal(out) && out.refusal).toBe("identity-mismatch");
    expect(isRefusal(out) && out.message).toContain("remote:gitlab.com%2Fg%2Fbeta");
    expect(isRefusal(out) && out.message).toContain("remote:gitlab.com%2Fg%2Fsomething-else");
  });

  test("a remote-less repo is refused: its identity IS its path, so a move mints a new one", async () => {
    setKvValue("repo-index", `path:${encodeURIComponent(join(scratch, "gone"))}`, join(scratch, "gone"));
    const repo = localRepo("gamma");

    const out = await planLocate({ newPath: repo });

    expect(isRefusal(out) && out.refusal).toBe("identity-changed");
    expect(isRefusal(out) && out.message).toContain("rt repos register");
  });

  test("an old path that still exists is a second clone, not a move", async () => {
    const original = repoWithRemote("delta");
    const clone = join(scratch, "delta-clone");
    execSync(`git clone -q ${original} ${clone}`, { stdio: "pipe" });
    execSync(`git remote set-url origin https://gitlab.com/g/delta.git`, { cwd: clone, stdio: "pipe" });
    setKvValue("repo-index", serializeIdentity(await deriveRepoIdentity(original)), original);

    const out = await planLocate({ newPath: realpathSync(clone) });

    expect(isRefusal(out) && out.refusal).toBe("old-path-exists");
  });

  test("plans the index keys, registry rewrite, claim rewrite and repair paths of a moved repo", async () => {
    const repo = repoWithRemote("epsilon");
    const identity = serializeIdentity(await deriveRepoIdentity(repo));
    const treePath = join(repo, ".worktrees", "t1");
    execSync(`git worktree add -q -b feat ${treePath}`, { cwd: repo, stdio: "pipe" });
    setKvValue("repo-index", identity, repo);
    setKvValue("repo-index", "epsilon-legacy", repo);
    saveRegistry(identity, [rec({ name: "main", path: repo, kind: "main", branch: "main" })]);
    saveRegistry("epsilon-legacy", [rec({ name: "t1", path: treePath, kind: "ephemeral", state: "on-deck", branch: "feat" })]);
    saveClaims(identity, [{ worktree: treePath, role: "web", port: 4001, ts: "2026-01-01T00:00:00.000Z" }]);

    const moved = join(scratch, "epsilon-moved");
    renameSync(repo, moved);

    const plan = await planLocate({ newPath: moved });
    if (isRefusal(plan)) throw new Error(`unexpected refusal: ${plan.message}`);

    expect(plan.identity).toBe(identity);
    expect(plan.oldPath).toBe(repo);
    expect(plan.newPath).toBe(moved);
    expect(plan.indexKeys.sort()).toEqual([identity, "epsilon-legacy"].sort());
    expect(plan.legacyKeys).toEqual(["epsilon-legacy"]);
    expect(plan.gitRepairPaths).toEqual([join(moved, ".worktrees", "t1")]);
    expect(plan.claimRewrites).toEqual([
      { repoKey: identity, worktree: treePath, newWorktree: join(moved, ".worktrees", "t1") },
    ]);
  });

  test("apply re-points the index, merges the pair's registries, rewrites claims and repairs git", async () => {
    const repo = repoWithRemote("zeta");
    const identity = serializeIdentity(await deriveRepoIdentity(repo));
    const treePath = join(repo, ".worktrees", "t1");
    execSync(`git worktree add -q -b feat ${treePath}`, { cwd: repo, stdio: "pipe" });
    setKvValue("repo-index", identity, repo);
    setKvValue("repo-index", "zeta-legacy", repo);
    saveRegistry(identity, [rec({ name: "main", path: repo, kind: "main", branch: "main" })]);
    saveRegistry("zeta-legacy", [rec({ name: "t1", path: treePath, kind: "ephemeral", state: "claimed", owner: "matt", branch: "feat" })]);
    saveClaims(identity, [{ worktree: treePath, role: "web", port: 4001, ts: "2026-01-01T00:00:00.000Z" }]);

    const moved = join(scratch, "zeta-moved");
    renameSync(repo, moved);
    const newTree = join(moved, ".worktrees", "t1");

    const plan = await planLocate({ newPath: moved });
    if (isRefusal(plan)) throw new Error(`unexpected refusal: ${plan.message}`);
    const result = await applyLocate(plan);

    expect(result.ok).toBe(true);
    expect(loadRepoIndex()[identity]).toBe(moved);
    expect(loadRepoIndex()["zeta-legacy"]).toBeUndefined();
    expect(loadRegistry(identity).map((t) => t.path).sort()).toEqual([moved, newTree].sort());
    expect(loadRegistry(identity).find((t) => t.path === newTree)).toMatchObject({ state: "claimed", owner: "matt" });
    expect(listEndpointClaims(identity)[0]?.worktree).toBe(newTree);
    expect(
      execSync("git worktree list --porcelain", { cwd: moved, encoding: "utf8" }),
    ).toContain(newTree);
    expect(result.legacyRows).toEqual([{ key: "zeta-legacy", outcome: "collapsed" }]);
  });

  test("a registry record whose tree is gone is reported stale, not a failure", async () => {
    const repo = repoWithRemote("eta");
    const identity = serializeIdentity(await deriveRepoIdentity(repo));
    setKvValue("repo-index", identity, repo);
    saveRegistry(identity, [
      rec({ name: "main", path: repo, kind: "main", branch: "main" }),
      rec({ name: "ghost", path: join(repo, ".worktrees", "ghost"), kind: "ephemeral", state: "on-deck" }),
    ]);

    const moved = join(scratch, "eta-moved");
    renameSync(repo, moved);

    const plan = await planLocate({ newPath: moved });
    if (isRefusal(plan)) throw new Error(`unexpected refusal: ${plan.message}`);
    const result = await applyLocate(plan);

    expect(result.ok).toBe(true);
    expect(result.stalePaths).toEqual([join(moved, ".worktrees", "ghost")]);
    expect(loadRepoIndex()[identity]).toBe(moved);
  });

  test("a failed verification restores the pre-apply rows", async () => {
    const repo = repoWithRemote("theta");
    const identity = serializeIdentity(await deriveRepoIdentity(repo));
    const treePath = join(repo, ".worktrees", "t1");
    execSync(`git worktree add -q -b feat ${treePath}`, { cwd: repo, stdio: "pipe" });
    setKvValue("repo-index", identity, repo);
    saveRegistry(identity, [rec({ name: "main", path: repo, kind: "main", branch: "main" })]);

    const moved = join(scratch, "theta-moved");
    renameSync(repo, moved);

    const plan = await planLocate({ newPath: moved });
    if (isRefusal(plan)) throw new Error(`unexpected refusal: ${plan.message}`);
    // A directory that exists but git will never list: the exact shape a
    // failed `git worktree repair` leaves behind.
    const decoy = join(moved, "decoy");
    mkdirSync(decoy, { recursive: true });
    plan.registryRewrites[0]!.movedPaths.push(decoy);

    const result = await applyLocate(plan);

    expect(result.ok).toBe(false);
    expect(result.restored).toBe(true);
    expect(loadRepoIndex()[identity]).toBe(repo);
    expect(loadRegistry(identity)[0]?.path).toBe(repo);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test lib/__tests__/repo-locate.test.ts`
Expected: FAIL — `lib/repo-locate.ts` does not exist.

- [ ] **Step 3: Add the store primitives the core needs**

In `lib/worktree/registry.ts`, add `deleteKvValue` to the `../state/index.ts` import and append:

```ts
/** Whether this repo has a registry row at all — distinct from an empty registry. */
export function hasRegistry(repoName: string): boolean {
  return hasKvValue(WORKTREE_REGISTRY_NS, repoName);
}

/** Drop a whole registry row. Only ever the retired half of a pair, after its records have been merged onto the survivor. */
export function deleteRegistry(repoName: string): void {
  deleteKvValue(WORKTREE_REGISTRY_NS, repoName);
  epochs.set(repoName, registryEpoch(repoName) + 1);
}
```

In `lib/repo-index.ts`, export the namespace constant (`lib/repo-index.ts:50` — change `const REPO_INDEX_NS` to `export const REPO_INDEX_NS`) and add, next to `updateRepoIndex`:

```ts
/**
 * Raw index-row write: no git probe, no move detection. `updateRepoIndex` is
 * the caller-facing path that DERIVES the main path; this is the primitive for
 * a caller that has already decided what the row must say, and it is the only
 * index write that is safe to run inside a state.db transaction.
 */
export function setIndexPath(key: string, mainPath: string): void {
  setKvValue(REPO_INDEX_NS, key, mainPath);
}

/** Drop one index row. */
export function removeIndexRow(key: string): void {
  deleteKvValue(REPO_INDEX_NS, key);
}

/** Rewrite ~/.mattstack/rt/repos.json from the current rows — a FILE write, so it runs after a transaction commits, never inside one. */
export function refreshRepoIndexMirror(): void {
  try {
    writeRepoIndexCompat(loadRepoIndex());
  } catch { /* best effort — see repoIndexCompatPath's doc comment */ }
}
```

- [ ] **Step 4: Write `lib/repo-locate.ts`**

```ts
/**
 * Repo locate: re-point every literal path rt stores for a repo whose folder
 * moved, as one unit.
 *
 * Ordering is the whole point. The reconciler prunes a registry row whose path
 * is absent from `git worktree list`, so an index row that heals ahead of the
 * registry destroys claimed/on-deck state and replenish then mints replacement
 * trees. Everything that can be written atomically goes in one state.db
 * transaction; `git worktree repair` and the verification run after it, and a
 * verification failure puts the pre-apply rows back.
 *
 * Pure of the daemon and the CLI: `lib/daemon/handlers/repos.ts` and
 * `commands/repos.ts` both drive these functions, and neither the caller nor
 * the transport is visible from here.
 */

import { existsSync, realpathSync } from "fs";
import { join, resolve as resolvePath } from "path";
import {
  getKnownRepos,
  loadRepoIndexEntries,
  migrateRepoData,
  migrationIncomplete,
  refreshRepoIndexMirror,
  removeIndexRow,
  setIndexPath,
  type RepoIndexEntry,
} from "./repo-index.ts";
import {
  deleteRegistry,
  hasRegistry,
  loadRegistry,
  mergeRegistries,
  saveRegistry,
  type TreeRecord,
} from "./worktree/registry.ts";
import { loadClaims, saveClaims, type EndpointClaim } from "./endpoint/store.ts";
import { deriveRepoIdentity, parseIdentity, serializeIdentity } from "./settings/identity.ts";
import { getStateDb } from "./state/index.ts";
import { listWorktreesAsync, runGit } from "./worktree/git-async.ts";

export type LocateRefusalCode =
  | "not-a-git-repo"
  | "nothing-lost"
  | "old-path-exists"
  | "identity-mismatch"
  | "identity-changed";

export interface LocateRefusal {
  refusal: LocateRefusalCode;
  message: string;
}

export interface RegistryRewrite {
  /** Index key this registry belongs to: the identity, or a legacy-name half of a healed pair. */
  repoKey: string;
  /** The whole registry after the re-root, in its original order. */
  trees: TreeRecord[];
  /** New spellings of the records this move re-rooted — what verification checks. */
  movedPaths: string[];
}

export interface ClaimRewrite {
  repoKey: string;
  worktree: string;
  newWorktree: string;
}

export interface LocatePlan {
  identity: string;
  oldPath: string;
  newPath: string;
  indexKeys: string[];
  /** Every `indexKeys` entry that is not the identity — collapsed after a verified apply. */
  legacyKeys: string[];
  registryRewrites: RegistryRewrite[];
  claimRewrites: ClaimRewrite[];
  /** In-tree worktree paths (new spellings, main excluded) handed to `git worktree repair`. */
  gitRepairPaths: string[];
}

export interface LocateResult {
  ok: boolean;
  identity: string;
  from: string;
  to: string;
  indexKeys: string[];
  treesRewritten: number;
  claimsRewritten: number;
  repaired: string[];
  /** Re-rooted registry paths with nothing on disk — a record the reconciler will prune, never a locate failure. */
  stalePaths: string[];
  legacyRows: { key: string; outcome: "collapsed" | "retained" }[];
  restored?: true;
  error?: string;
}

export interface LocateCandidate {
  path: string;
  identity: string;
}

export function isRefusal(x: LocatePlan | LocateRefusal): x is LocateRefusal {
  return "refusal" in x;
}

function refuse(refusal: LocateRefusalCode, message: string): LocateRefusal {
  return { refusal, message };
}

/** realpathSync, degrading to the literal spelling — a gone path must compare, not throw. */
function canon(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** `path` re-rooted onto `newPath`, or null when it lives outside the moved tree (an external worktree keeps its own path). */
function relocatePath(path: string, oldPath: string, newPath: string): string | null {
  if (path === oldPath) return newPath;
  if (path.startsWith(`${oldPath}/`)) return newPath + path.slice(oldPath.length);
  return null;
}

/**
 * Resolve which index rows a move touches, matching by IDENTITY only.
 *
 * A legacy-name row joins the plan through the identity row it shares a lost
 * directory with — never by name, which is exactly the drift identities exist
 * to end.
 */
export async function planLocate(opts: { newPath: string; repo?: string }): Promise<LocatePlan | LocateRefusal> {
  const newPath = canon(resolvePath(opts.newPath));
  if (!existsSync(join(newPath, ".git"))) {
    return refuse("not-a-git-repo", `${newPath} is not a git repository`);
  }

  const identity = serializeIdentity(await deriveRepoIdentity(newPath));
  const entries = loadRepoIndexEntries();
  const lost = entries.filter((e) => !existsSync(e.path));

  const named: RepoIndexEntry | null = opts.repo ? entries.find((e) => e.repoName === opts.repo) ?? null : null;
  if (opts.repo && !named) {
    return refuse("nothing-lost", `--repo ${opts.repo} is not in the repo index`);
  }
  if (named && existsSync(named.path)) {
    return refuse("old-path-exists", `${opts.repo} is indexed at ${named.path}, which still exists — that is a second clone, not a move`);
  }

  const identityRow = entries.find((e) => e.repoName === identity) ?? null;
  if (identityRow && existsSync(identityRow.path)) {
    return canon(identityRow.path) === newPath
      ? refuse("nothing-lost", `${identity} is already indexed at ${newPath}`)
      : refuse("old-path-exists", `${identity} is already indexed at ${identityRow.path}, which still exists — that is a second clone, not a move`);
  }

  if (!identityRow) {
    if (parseIdentity(identity)?.kind === "path") {
      return refuse(
        "identity-changed",
        `${newPath} derives ${identity}, and no index row is keyed by it. A repo with no origin remote is identified BY its main worktree's path, so moving it mints a new identity rather than keeping the old one — locate re-points paths, it never re-keys a repo. Register the new path instead: rt repos register ${newPath}`,
      );
    }
    return refuse(
      "identity-mismatch",
      `${newPath} derives ${identity}, which matches no indexed repo whose path is missing (lost rows: ${lost.map((e) => e.repoName).join(", ") || "none"})`,
    );
  }
  if (named && canon(named.path) !== canon(identityRow.path)) {
    return refuse(
      "identity-mismatch",
      `${newPath} derives ${identity} (indexed at ${identityRow.path}), but --repo names ${named.repoName} at ${named.path} — locate matches by identity, never by name`,
    );
  }

  const oldPath = identityRow.path;
  const indexKeys = lost.filter((e) => e.path === oldPath).map((e) => e.repoName);
  const legacyKeys = indexKeys.filter((key) => key !== identity);

  const registryRewrites: RegistryRewrite[] = [];
  const repairPaths = new Set<string>();
  for (const key of indexKeys) {
    if (!hasRegistry(key)) continue;
    const movedPaths: string[] = [];
    const trees = loadRegistry(key).map((rec) => {
      const moved = relocatePath(rec.path, oldPath, newPath);
      if (moved === null) return rec;
      movedPaths.push(moved);
      if (moved !== newPath) repairPaths.add(moved);
      return { ...rec, path: moved };
    });
    registryRewrites.push({ repoKey: key, trees, movedPaths });
  }

  const claimRewrites: ClaimRewrite[] = [];
  for (const key of indexKeys) {
    for (const claim of loadClaims(key)) {
      const moved = relocatePath(claim.worktree, oldPath, newPath);
      if (moved === null) continue;
      claimRewrites.push({ repoKey: key, worktree: claim.worktree, newWorktree: moved });
    }
  }

  return {
    identity,
    oldPath,
    newPath,
    indexKeys,
    legacyKeys,
    registryRewrites,
    claimRewrites,
    gitRepairPaths: [...repairPaths],
  };
}

interface LocateSnapshot {
  index: { key: string; path: string | null }[];
  registries: { key: string; trees: TreeRecord[]; existed: boolean }[];
  claims: { key: string; claims: EndpointClaim[] }[];
}

function captureSnapshot(plan: LocatePlan): LocateSnapshot {
  const claimKeys = [...new Set(plan.claimRewrites.map((c) => c.repoKey))];
  const entries = loadRepoIndexEntries();
  return {
    index: [...new Set([...plan.indexKeys, plan.identity])].map((key) => ({
      key,
      path: entries.find((e) => e.repoName === key)?.path ?? null,
    })),
    registries: [...new Set([...plan.registryRewrites.map((r) => r.repoKey), plan.identity])].map((key) => ({
      key,
      trees: loadRegistry(key),
      existed: hasRegistry(key),
    })),
    claims: claimKeys.map((key) => ({ key, claims: loadClaims(key) })),
  };
}

function restoreSnapshot(snapshot: LocateSnapshot): void {
  getStateDb().transaction(() => {
    for (const row of snapshot.index) {
      if (row.path === null) removeIndexRow(row.key);
      else setIndexPath(row.key, row.path);
    }
    for (const reg of snapshot.registries) {
      if (reg.existed) saveRegistry(reg.key, reg.trees);
      else deleteRegistry(reg.key);
    }
    for (const c of snapshot.claims) saveClaims(c.key, c.claims);
  })();
}

/**
 * The registry half of the apply: the pair's registries are merged onto the
 * IDENTITY key and every legacy registry row is dropped, so the reconciler
 * (which iterates identity keys) sees one pool instead of two halves.
 */
function writeRegistries(plan: LocatePlan): void {
  const byKey = new Map(plan.registryRewrites.map((r) => [r.repoKey, r.trees]));
  let merged = byKey.get(plan.identity) ?? loadRegistry(plan.identity);
  let touched = byKey.has(plan.identity);
  for (const key of plan.legacyKeys) {
    const legacy = byKey.get(key);
    if (!legacy) continue;
    merged = mergeRegistries(merged, legacy);
    deleteRegistry(key);
    touched = true;
  }
  if (touched) saveRegistry(plan.identity, merged);
}

function writeClaims(plan: LocatePlan): void {
  for (const key of new Set(plan.claimRewrites.map((c) => c.repoKey))) {
    const moves = new Map(
      plan.claimRewrites.filter((c) => c.repoKey === key).map((c) => [c.worktree, c.newWorktree]),
    );
    saveClaims(
      key,
      loadClaims(key).map((c) => {
        const moved = moves.get(c.worktree);
        return moved === undefined ? c : { ...c, worktree: moved };
      }),
    );
  }
}

/**
 * Every re-rooted tree that exists on disk must also be one git knows about;
 * a re-rooted tree with nothing on disk is a stale record, which the
 * reconciler prunes on its own and which must not fail an otherwise correct
 * move.
 */
async function verifyLocate(plan: LocatePlan): Promise<{ error: string | null; stalePaths: string[] }> {
  const listed = await listWorktreesAsync(plan.newPath);
  if (listed === null) return { error: `git worktree list failed in ${plan.newPath}`, stalePaths: [] };
  const known = new Set(listed.map((w) => canon(w.path)));
  if (!known.has(canon(plan.newPath))) {
    return { error: `${plan.newPath} is not the main worktree git reports`, stalePaths: [] };
  }

  const stalePaths: string[] = [];
  for (const rewrite of plan.registryRewrites) {
    for (const path of rewrite.movedPaths) {
      if (!existsSync(path)) {
        stalePaths.push(path);
        continue;
      }
      if (!known.has(canon(path))) {
        return { error: `${path} exists but git does not list it as a worktree of ${plan.newPath}`, stalePaths };
      }
    }
  }
  return { error: null, stalePaths };
}

/**
 * Collapse the legacy half of a healed pair, on prune's rules: the row is
 * dropped only once its data dir has fully moved, because eviction is what
 * makes a leftover unreachable.
 */
function collapseLegacyRows(plan: LocatePlan): LocateResult["legacyRows"] {
  const out: LocateResult["legacyRows"] = [];
  for (const key of plan.legacyKeys) {
    const data = migrateRepoData(key, plan.identity);
    if (migrationIncomplete(data)) {
      out.push({ key, outcome: "retained" });
      continue;
    }
    removeIndexRow(key);
    out.push({ key, outcome: "collapsed" });
  }
  return out;
}

export async function applyLocate(plan: LocatePlan): Promise<LocateResult> {
  const snapshot = captureSnapshot(plan);
  const base = {
    identity: plan.identity,
    from: plan.oldPath,
    to: plan.newPath,
    indexKeys: plan.indexKeys,
    treesRewritten: plan.registryRewrites.reduce((n, r) => n + r.movedPaths.length, 0),
    claimsRewritten: plan.claimRewrites.length,
  };

  // bun:sqlite transactions are sync-only: every git call lives below this
  // block, never inside it.
  getStateDb().transaction(() => {
    for (const key of plan.indexKeys) setIndexPath(key, plan.newPath);
    setIndexPath(plan.identity, plan.newPath);
    writeRegistries(plan);
    writeClaims(plan);
  })();
  refreshRepoIndexMirror();

  if (plan.gitRepairPaths.length > 0) {
    await runGit(plan.newPath, ["worktree", "repair", ...plan.gitRepairPaths]);
  }
  await runGit(plan.newPath, ["worktree", "repair"]);

  const { error, stalePaths } = await verifyLocate(plan);
  if (error !== null) {
    restoreSnapshot(snapshot);
    refreshRepoIndexMirror();
    return { ...base, ok: false, repaired: plan.gitRepairPaths, stalePaths, legacyRows: [], restored: true, error };
  }

  const legacyRows = collapseLegacyRows(plan);
  refreshRepoIndexMirror();
  return { ...base, ok: true, repaired: plan.gitRepairPaths, stalePaths, legacyRows };
}

/**
 * Directories the `rt.repoRoots` scan surfaced whose derived identity is one
 * of the index's lost rows — the candidate set `rt repos locate` offers when
 * it is given no path. Never auto-picked: this only proposes.
 */
export async function findLocateCandidates(): Promise<LocateCandidate[]> {
  const repos = getKnownRepos();
  const lostKeys = new Set(repos.filter((r) => r.missing).map((r) => r.repoName));
  if (lostKeys.size === 0) return [];

  const candidates: LocateCandidate[] = [];
  for (const repo of repos) {
    if (repo.registered !== false) continue;
    const path = repo.worktrees[0]?.path;
    if (!path) continue;
    let identity: string;
    try {
      identity = serializeIdentity(await deriveRepoIdentity(path));
    } catch {
      continue;
    }
    if (!lostKeys.has(identity)) continue;
    candidates.push({ path, identity });
  }
  return candidates;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test lib/__tests__/repo-locate.test.ts`
Expected: PASS (9 tests)

- [ ] **Step 6: Typecheck and re-run the neighbours**

Run: `bunx tsc --noEmit && bun test lib/__tests__/repo-index-rename.test.ts lib/__tests__/repo-index-missing.test.ts lib/worktree/__tests__/registry-merge.test.ts`
Expected: no errors; all PASS.

- [ ] **Step 7: Commit**

```bash
git add lib/repo-locate.ts lib/repo-index.ts lib/worktree/registry.ts lib/__tests__/repo-locate.test.ts
git commit -m "feat(repos): locate core — plan and apply a moved repo's path rewrites atomically"
```

---

## Task 6: `withReconcilerHeld` on the worktree reconciler

**Files:**
- Modify: `lib/daemon/worktree-reconciler.ts:1034-1129` (`createWorktreeReconciler`)
- Test: `lib/daemon/__tests__/reconciler-hold.test.ts` (create)

**Interfaces:**
- Consumes: nothing new.
- Produces: `createWorktreeReconciler(deps: ReconcilerDeps)` return type gains
  `withReconcilerHeld: <T>(fn: () => Promise<T>) => Promise<T>` — awaits any pass already in flight, blocks `kick()` from starting a new pass until `fn` settles (a kick arriving during the hold is queued and fires once, on release), and serializes concurrent holders. Existing members (`kick`, `runOnce`, `creationInFlight`, `passInFlight`) are unchanged.

- [ ] **Step 1: Write the failing test**

Create `lib/daemon/__tests__/reconciler-hold.test.ts`:

```ts
/**
 * The hold `repos:locate` runs inside: a reconcile pass that observed a healed
 * index path against un-rewritten registry paths prunes every registry row as
 * "no matching worktree", taking the pool's claim state with it.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { Logger } from "pino";
import { closeStateDb } from "../../state/index.ts";
import { createWorktreeReconciler } from "../worktree-reconciler.ts";

const silentLog = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as unknown as Logger;

/** An empty index makes each pass a no-op with real awaits — enough to observe pass boundaries without any git. */
function harness(order: string[]) {
  return createWorktreeReconciler({
    cache: { entries: {} },
    repoIndex: () => {
      order.push("pass");
      return {};
    },
    emit: () => {},
    log: silentLog,
  });
}

async function settle(reconciler: { passInFlight: () => boolean }): Promise<void> {
  for (let i = 0; i < 200 && reconciler.passInFlight(); i++) await Bun.sleep(5);
}

describe("withReconcilerHeld", () => {
  const origHome = process.env.HOME;
  let home: string;

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "rt-hold-home-")));
    process.env.HOME = home;
    closeStateDb();
  });

  afterEach(async () => {
    process.env.HOME = origHome;
    closeStateDb();
    rmSync(home, { recursive: true, force: true });
  });

  test("a pass already in flight finishes before the held fn runs", async () => {
    const order: string[] = [];
    const reconciler = harness(order);

    reconciler.kick();
    await reconciler.withReconcilerHeld(async () => {
      order.push("fn");
    });

    expect(order).toEqual(["pass", "fn"]);
  });

  test("a kick during the hold starts no pass until the fn settles", async () => {
    const order: string[] = [];
    const reconciler = harness(order);

    await reconciler.withReconcilerHeld(async () => {
      reconciler.kick();
      await Bun.sleep(10);
      expect(order).toEqual([]);
      order.push("fn-done");
    });

    await settle(reconciler);
    expect(order).toEqual(["fn-done", "pass"]);
  });

  test("two holders serialize", async () => {
    const order: string[] = [];
    const reconciler = harness(order);

    await Promise.all([
      reconciler.withReconcilerHeld(async () => {
        order.push("a-start");
        await Bun.sleep(10);
        order.push("a-end");
      }),
      reconciler.withReconcilerHeld(async () => {
        order.push("b-start");
        await Bun.sleep(1);
        order.push("b-end");
      }),
    ]);

    expect(order).toEqual(["a-start", "a-end", "b-start", "b-end"]);
  });

  test("a throwing fn releases the hold", async () => {
    const order: string[] = [];
    const reconciler = harness(order);

    await expect(
      reconciler.withReconcilerHeld(async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    reconciler.kick();
    await settle(reconciler);
    expect(order).toEqual(["pass"]);
  });

  test("the fn's value comes back to the caller", async () => {
    const reconciler = harness([]);
    expect(await reconciler.withReconcilerHeld(async () => 42)).toBe(42);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test lib/daemon/__tests__/reconciler-hold.test.ts`
Expected: FAIL — `reconciler.withReconcilerHeld is not a function`.

- [ ] **Step 3: Write the implementation**

In `lib/daemon/worktree-reconciler.ts`, extend the return type of `createWorktreeReconciler` (after `passInFlight`):

```ts
  /**
   * Run `fn` with the reconciler held: any pass in flight is awaited first,
   * and `kick()` starts no new pass until `fn` settles (one queued kick fires
   * on release). A holder rewrites registry paths that a concurrent pass would
   * read as "no matching worktree" and prune, taking the pool's claim state
   * with it. Holders serialize.
   */
  withReconcilerHeld: <T>(fn: () => Promise<T>) => Promise<T>;
```

Replace the closure state and `kick`, and add the holder, inside the function body:

```ts
  let inFlight: Promise<void> | null = null;
  /** Non-null while a holder owns the reconciler. */
  let hold: Promise<void> | null = null;
  let kickQueued = false;
  const creationPromises = new Map<string, Promise<void>>();
```

```ts
  function kick(): void {
    if (hold) {
      kickQueued = true;
      return;
    }
    if (inFlight) return;
    const p = runOnce()
      .catch((err) => {
        deps.log.warn({ err }, "worktree reconciler: kick failed");
      })
      .finally(() => {
        if (inFlight === p) inFlight = null;
      });
    inFlight = p;
  }

  async function withReconcilerHeld<T>(fn: () => Promise<T>): Promise<T> {
    while (hold) await hold;
    let release!: () => void;
    hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      // A pass that started before the hold was taken still reads the rows the
      // holder is about to rewrite, so it has to finish first.
      while (inFlight) await inFlight;
      return await fn();
    } finally {
      hold = null;
      release();
      if (kickQueued) {
        kickQueued = false;
        kick();
      }
    }
  }
```

And add `withReconcilerHeld` to the returned object:

```ts
  return { kick, runOnce, creationInFlight, passInFlight, withReconcilerHeld };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test lib/daemon/__tests__/reconciler-hold.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Re-run the reconciler suite and typecheck**

Run: `bunx tsc --noEmit && bun test lib/daemon/__tests__/worktree-reconciler.test.ts`
Expected: no errors; PASS with no delta from baseline.

- [ ] **Step 6: Commit**

```bash
git add lib/daemon/worktree-reconciler.ts lib/daemon/__tests__/reconciler-hold.test.ts
git commit -m "feat(daemon): withReconcilerHeld — exclusive access to the worktree registry"
```

---

## Task 7: The `repos:locate` daemon verb

**Files:**
- Create: `lib/daemon/handlers/repos.ts`
- Modify: `lib/daemon/command-router.ts:37-89` (opts + spread)
- Modify: `lib/daemon.ts:386-398` (`buildRoutedHandlers` call)
- Modify: `lib/daemon/__tests__/rt-client-commands.test.ts:36-44` (stub the new opt)
- Test: `lib/daemon/__tests__/repos-handlers.test.ts` (create)

**Interfaces:**
- Consumes: `planLocate(opts: { newPath: string; repo?: string })`, `applyLocate(plan)`, `isRefusal(x)`, `LocatePlan`, `LocateResult` (Task 5); `withReconcilerHeld: <T>(fn: () => Promise<T>) => Promise<T>` (Task 6); `hooksGuard.refreshWatchedRepos(): void` (`lib/daemon/hooks-guard.ts:100`); the router's local `emitEvent(topic: string, payload: unknown): void`.
- Produces:
  - `interface ReposHandlerOpts { withReconcilerHeld: <T>(fn: () => Promise<T>) => Promise<T>; refreshWatchedRepos: () => void; emitEvent: (topic: string, payload: unknown) => void }`
  - `createReposHandlers(opts: ReposHandlerOpts): Record<"repos:locate", (payload: any) => Promise<any>> & HandlerMap`
  - `buildRoutedHandlers` opts gain `repos: { withReconcilerHeld: <T>(fn: () => Promise<T>) => Promise<T>; refreshWatchedRepos: () => void }`.
  - Wire contract: `POST /repos:locate` with `{ newPath: string; repo?: string; dryRun?: boolean }` → `{ ok: true, data: LocateResult }`, or `{ ok: true, data: { dryRun: true, plan: LocatePlan } }`, or `{ ok: false, error: string }`. `repo` is a serialized identity; a non-identity is rejected `repo-unknown`.
  - Event: `repo:moved` with payload `{ identity: string; from: string; to: string }`.

- [ ] **Step 1: Write the failing test**

Create `lib/daemon/__tests__/repos-handlers.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execSync } from "child_process";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { closeStateDb, setKvValue } from "../../state/index.ts";
import { loadRepoIndex } from "../../repo-index.ts";
import { saveRegistry } from "../../worktree/registry.ts";
import { deriveRepoIdentity, serializeIdentity } from "../../settings/identity.ts";
import { createReposHandlers } from "../handlers/repos.ts";

describe("repos:locate", () => {
  const origHome = process.env.HOME;
  let home: string;
  let scratch: string;
  let order: string[];
  let events: { topic: string; payload: unknown }[];
  let handlers: ReturnType<typeof createReposHandlers>;

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "rt-repos-handler-home-")));
    scratch = realpathSync(mkdtempSync(join(tmpdir(), "rt-repos-handler-repos-")));
    process.env.HOME = home;
    closeStateDb();
    order = [];
    events = [];
    handlers = createReposHandlers({
      withReconcilerHeld: async (fn) => {
        order.push("hold-start");
        try {
          return await fn();
        } finally {
          order.push("hold-end");
        }
      },
      refreshWatchedRepos: () => order.push("refresh"),
      emitEvent: (topic, payload) => {
        order.push(`emit:${topic}`);
        events.push({ topic, payload });
      },
    });
  });

  afterEach(() => {
    process.env.HOME = origHome;
    closeStateDb();
    rmSync(home, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  });

  async function movedRepo(name: string): Promise<{ identity: string; from: string; to: string }> {
    const dir = join(scratch, name);
    mkdirSync(dir, { recursive: true });
    execSync("git init -q -b main", { cwd: dir, stdio: "pipe" });
    execSync(`git remote add origin https://gitlab.com/g/${name}.git`, { cwd: dir, stdio: "pipe" });
    execSync("git -c user.email=t@t -c user.name=t commit --allow-empty -q -m init", { cwd: dir, stdio: "pipe" });
    const from = realpathSync(dir);
    const identity = serializeIdentity(await deriveRepoIdentity(from));
    setKvValue("repo-index", identity, from);
    saveRegistry(identity, [{ name: "main", path: from, kind: "main", branch: "main", createdAt: "2026-01-01T00:00:00.000Z" }]);
    const to = join(scratch, `${name}-moved`);
    renameSync(from, to);
    return { identity, from, to };
  }

  test("a missing newPath is rejected", async () => {
    expect(await handlers["repos:locate"]({})).toEqual({ ok: false, error: "newPath-required" });
  });

  test("a non-identity repo key is rejected, not name-resolved", async () => {
    const res = await handlers["repos:locate"]({ newPath: scratch, repo: "repo-tools" });
    expect(res).toEqual({ ok: false, error: "repo-unknown" });
    expect(order).toEqual([]);
  });

  test("applies inside the hold, refreshes watchers, then emits repo:moved", async () => {
    const { identity, from, to } = await movedRepo("alpha");

    const res = await handlers["repos:locate"]({ newPath: to });

    expect(res.ok).toBe(true);
    expect(loadRepoIndex()[identity]).toBe(to);
    expect(order).toEqual(["hold-start", "refresh", "emit:repo:moved", "hold-end"]);
    expect(events[0]!.payload).toEqual({ identity, from, to });
  });

  test("dryRun returns the plan and writes nothing", async () => {
    const { identity, from, to } = await movedRepo("beta");

    const res = await handlers["repos:locate"]({ newPath: to, dryRun: true });

    expect(res.ok).toBe(true);
    expect(res.data.dryRun).toBe(true);
    expect(res.data.plan.identity).toBe(identity);
    expect(loadRepoIndex()[identity]).toBe(from);
    expect(events).toEqual([]);
  });

  test("a refusal comes back as a typed error, and nothing is emitted", async () => {
    const plain = join(scratch, "plain");
    mkdirSync(plain);

    const res = await handlers["repos:locate"]({ newPath: plain });

    expect(res.ok).toBe(false);
    expect(res.error).toContain("not-a-git-repo");
    expect(events).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test lib/daemon/__tests__/repos-handlers.test.ts`
Expected: FAIL — `../handlers/repos.ts` does not exist.

- [ ] **Step 3: Write the handler**

Create `lib/daemon/handlers/repos.ts`:

```ts
/**
 * Repo-index IPC verbs.
 *
 * `repos:locate` runs the whole apply inside the reconciler's hold: a
 * reconcile pass that sees a healed index path against un-rewritten registry
 * paths prunes every registry row as "no matching worktree", and replenish
 * then mints replacement trees for a pool that never lost anything.
 */

import { parseIdentity } from "../../settings/identity.ts";
import { applyLocate, isRefusal, planLocate } from "../../repo-locate.ts";
import type { HandlerMap } from "./types.ts";

export interface ReposHandlerOpts {
  /** Exclusive access to the worktree registry for the duration of `fn`. */
  withReconcilerHeld: <T>(fn: () => Promise<T>) => Promise<T>;
  /** Re-point the hooks guard's per-repo git-config watchers once paths have moved. */
  refreshWatchedRepos: () => void;
  /** Events-bus emit — the router's shared `emitEvent`. */
  emitEvent: (topic: string, payload: unknown) => void;
}

// Named-key return type (not a bare HandlerMap): under
// noUncheckedIndexedAccess a plain Record makes handlers["repos:locate"]
// resolve to `Handler | undefined` for every caller, tests included.
export function createReposHandlers(
  opts: ReposHandlerOpts,
): Record<"repos:locate", (payload: any) => Promise<any>> & HandlerMap {
  return {
    "repos:locate": async (payload) => {
      const newPath = payload?.newPath;
      if (typeof newPath !== "string" || newPath.length === 0) return { ok: false, error: "newPath-required" };
      const repo = typeof payload?.repo === "string" ? payload.repo : undefined;
      if (repo !== undefined && parseIdentity(repo) === null) return { ok: false, error: "repo-unknown" };

      return opts.withReconcilerHeld(async () => {
        const plan = await planLocate({ newPath, repo });
        if (isRefusal(plan)) return { ok: false, error: `${plan.refusal}: ${plan.message}` };
        if (payload?.dryRun === true) return { ok: true, data: { dryRun: true, plan } };

        const result = await applyLocate(plan);
        if (!result.ok) return { ok: false, error: result.error ?? "locate-failed" };

        opts.refreshWatchedRepos();
        opts.emitEvent("repo:moved", { identity: result.identity, from: result.from, to: result.to });
        return { ok: true, data: result };
      });
    },
  };
}
```

- [ ] **Step 4: Register it**

In `lib/daemon/command-router.ts`, add the import beside the others:

```ts
import { createReposHandlers } from "./handlers/repos.ts";
```

Add the opt to `buildRoutedHandlers`'s parameter object (after `homeSnapshot`):

```ts
  /** Reconciler hold + hooks-guard rewire the repos:locate verb drives. */
  repos: {
    withReconcilerHeld: <T>(fn: () => Promise<T>) => Promise<T>;
    refreshWatchedRepos: () => void;
  };
```

And add to the returned object, next to `createSettingsHandlers()`:

```ts
    ...createReposHandlers({ ...opts.repos, emitEvent }),
```

In `lib/daemon.ts`, add to the `buildRoutedHandlers({ … })` call (after `homeSnapshot,`):

```ts
    repos: {
      withReconcilerHeld: worktreeReconciler.withReconcilerHeld,
      refreshWatchedRepos: hooksGuard.refreshWatchedRepos,
    },
```

In `lib/daemon/__tests__/rt-client-commands.test.ts`, add to the `buildRoutedHandlers({ … })` call:

```ts
      repos: { withReconcilerHeld: async (fn) => fn(), refreshWatchedRepos: () => {} },
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test lib/daemon/__tests__/repos-handlers.test.ts lib/daemon/__tests__/rt-client-commands.test.ts lib/state/__tests__/source-guards.test.ts`
Expected: PASS.

- [ ] **Step 6: Typecheck**

Run: `bunx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 7: Commit**

```bash
git add lib/daemon/handlers/repos.ts lib/daemon/command-router.ts lib/daemon.ts lib/daemon/__tests__/repos-handlers.test.ts lib/daemon/__tests__/rt-client-commands.test.ts
git commit -m "feat(daemon): repos:locate verb, applied under the reconciler hold"
```

---

## Task 8: `rt repos locate` CLI

**Files:**
- Create: `lib/repo-locate-dispatch.ts`
- Modify: `commands/repos.ts` (append the `locate` verb)
- Modify: `lib/command-tree-def.ts:998-1007` (add the subcommand after `prune`)
- Test: `commands/__tests__/repos-locate.test.ts` (create)

**Interfaces:**
- Consumes: `planLocate`, `applyLocate`, `findLocateCandidates`, `isRefusal`, `LocatePlan`, `LocateResult`, `LocateCandidate` (Task 5); `missingRepoRefusal` / `KnownRepo.missing` (Task 4); `resolveRepoArg(arg: string, fail: (msg: string) => never): Promise<string>` from `lib/repo-arg.ts`; `envelope(body)` from `lib/setup/contract.ts`; `UserActionableError`, `exitUserError` from `lib/setup/errors.ts`; `getKnownRepos()` from `lib/repo-index.ts`.
- Consumes (daemon transport): **`isDaemonRunning(): Promise<boolean>`** and **`daemonSocketQuery(cmd, payload?, timeoutMs?): Promise<DaemonResponse | null>`**, both from `lib/daemon-client.ts`. `daemonSocketQuery` is the read-only variant deliberately: unlike `daemonQuery` it never POSTs `/daemon/start` to the tray and never prints a "daemon down" warning, so a locate can probe without starting anything.
- Produces:
  - `lib/repo-locate-dispatch.ts`: `type LocateOutcome = { via: "daemon" | "local"; ok: true; dryRun: false; result: LocateResult } | { via: "daemon" | "local"; ok: true; dryRun: true; plan: LocatePlan } | { via: "daemon" | "local"; ok: false; error: string }`; `locateMovedRepo(req: { newPath: string; repo?: string; dryRun?: boolean }): Promise<LocateOutcome>`; `LOCATE_TIMEOUT_MS: number`.
  - `commands/repos.ts`: `reposLocate(args: string[], ctx?: CommandContext, deps?: RegisterDeps): Promise<void>` (same `RegisterDeps` = `{ print: (s: string) => void }` the other two verbs take).

- [ ] **Step 1: Write the failing test**

Create `commands/__tests__/repos-locate.test.ts`:

```ts
/**
 * The CLI runs the local path here: under a throwaway HOME no daemon socket
 * exists, so `isDaemonRunning()` is false and the apply happens in-process —
 * which is exactly the "no daemon, nothing to race" branch.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeStateDb, setKvValue } from "../../lib/state/index.ts";
import { loadRepoIndex } from "../../lib/repo-index.ts";
import { saveRegistry, loadRegistry } from "../../lib/worktree/registry.ts";
import { deriveRepoIdentity, serializeIdentity } from "../../lib/settings/identity.ts";
import { reposLocate, type RegisterDeps } from "../repos.ts";

function testDeps(): RegisterDeps & { lines: string[] } {
  const lines: string[] = [];
  return { print: (s) => lines.push(s), lines };
}

async function runExpectingProcessExit(fn: () => Promise<void>): Promise<number | undefined> {
  const exitSpy = spyOn(process, "exit").mockImplementation(() => {
    throw new Error("process.exit sentinel");
  });
  try {
    await fn();
    return undefined;
  } catch {
    return exitSpy.mock.calls.at(-1)?.[0] as number | undefined;
  } finally {
    exitSpy.mockRestore();
  }
}

describe("reposLocate", () => {
  const origHome = process.env.HOME;
  let home: string;
  let scratch: string;

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "rt-locate-cli-home-")));
    scratch = realpathSync(mkdtempSync(join(tmpdir(), "rt-locate-cli-repos-")));
    process.env.HOME = home;
    closeStateDb();
  });

  afterEach(() => {
    process.env.HOME = origHome;
    closeStateDb();
    rmSync(home, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  });

  async function movedRepo(name: string): Promise<{ identity: string; from: string; to: string }> {
    const dir = join(scratch, name);
    mkdirSync(dir, { recursive: true });
    execSync("git init -q -b main", { cwd: dir, stdio: "pipe" });
    execSync(`git remote add origin https://gitlab.com/g/${name}.git`, { cwd: dir, stdio: "pipe" });
    execSync("git -c user.email=t@t -c user.name=t commit --allow-empty -q -m init", { cwd: dir, stdio: "pipe" });
    const from = realpathSync(dir);
    const identity = serializeIdentity(await deriveRepoIdentity(from));
    setKvValue("repo-index", identity, from);
    saveRegistry(identity, [{ name: "main", path: from, kind: "main", branch: "main", createdAt: "2026-01-01T00:00:00.000Z" }]);
    const to = join(scratch, `${name}-moved`);
    renameSync(from, to);
    return { identity, from, to };
  }

  test("locates a moved repo and says where it went", async () => {
    const { identity, from, to } = await movedRepo("alpha");
    const deps = testDeps();

    await reposLocate([to], {}, deps);

    expect(loadRepoIndex()[identity]).toBe(to);
    expect(loadRegistry(identity)[0]?.path).toBe(to);
    expect(deps.lines.join("\n")).toContain(from);
    expect(deps.lines.join("\n")).toContain(to);
  });

  test("--dry-run reports the plan and writes nothing", async () => {
    const { identity, from, to } = await movedRepo("beta");
    const deps = testDeps();

    await reposLocate([to, "--dry-run"], {}, deps);

    expect(loadRepoIndex()[identity]).toBe(from);
    expect(deps.lines.join("\n")).toContain("would move");
  });

  test("--json emits a contract envelope", async () => {
    const { identity, to } = await movedRepo("gamma");
    const deps = testDeps();

    await reposLocate([to, "--json"], {}, deps);

    const parsed = JSON.parse(deps.lines[0]!);
    expect(parsed.contract).toBe(1);
    expect(parsed.located.identity).toBe(identity);
    expect(parsed.located.to).toBe(to);
  });

  test("--repo resolves to an identity and is honoured", async () => {
    const { identity, to } = await movedRepo("delta");
    const deps = testDeps();

    await reposLocate([to, "--repo", identity], {}, deps);

    expect(loadRepoIndex()[identity]).toBe(to);
  });

  test("a refusal exits 2 with the typed message", async () => {
    const plain = join(scratch, "plain");
    mkdirSync(plain);
    const deps = testDeps();

    const code = await runExpectingProcessExit(() => reposLocate([plain], {}, deps));

    expect(code).toBe(2);
    expect(deps.lines.join("\n")).toContain("not a git repository");
  });

  test("an unknown flag is a usage error", async () => {
    const deps = testDeps();
    const code = await runExpectingProcessExit(() => reposLocate(["--nope"], {}, deps));
    expect(code).toBe(2);
    expect(deps.lines.join("\n")).toContain("usage: rt repos locate");
  });

  test("no path and no lost rows exits 1 saying so", async () => {
    const deps = testDeps();
    const code = await runExpectingProcessExit(() => reposLocate([], {}, deps));
    expect(code).toBe(1);
    expect(deps.lines.join("\n")).toContain("no indexed repo is missing");
  });

  test("no path, a lost row and no candidate lists the lost row and exits 1", async () => {
    setKvValue("repo-index", "remote:gitlab.com%2Fg%2Fghost", join(scratch, "ghost"));
    const deps = testDeps();

    const code = await runExpectingProcessExit(() => reposLocate([], {}, deps));

    expect(code).toBe(1);
    expect(deps.lines.join("\n")).toContain("remote:gitlab.com%2Fg%2Fghost");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test commands/__tests__/repos-locate.test.ts`
Expected: FAIL — `reposLocate` is not exported from `../repos.ts`.

- [ ] **Step 3: Write the dispatcher**

Create `lib/repo-locate-dispatch.ts`:

```ts
/**
 * The one place that decides whether a locate runs in the daemon or in this
 * process.
 *
 * The daemon is the single writer of the worktree registry, so a locate must
 * never run locally while it answers: a reconcile pass landing between the
 * index write and the registry write is exactly the prune this feature exists
 * to prevent. A daemon that is up but does not answer is a hard stop, not a
 * fall-through — `daemonSocketQuery` is the read-only client, so probing never
 * starts a daemon or warns.
 */

import { daemonSocketQuery, isDaemonRunning } from "./daemon-client.ts";
import { applyLocate, isRefusal, planLocate, type LocatePlan, type LocateResult } from "./repo-locate.ts";

/** git worktree repair across a large pool is the slow part; the 2s default IPC timeout is a client number, not a daemon-op one. */
export const LOCATE_TIMEOUT_MS = 2 * 60_000;

export type LocateOutcome =
  | { via: "daemon" | "local"; ok: true; dryRun: false; result: LocateResult }
  | { via: "daemon" | "local"; ok: true; dryRun: true; plan: LocatePlan }
  | { via: "daemon" | "local"; ok: false; error: string };

export async function locateMovedRepo(req: {
  newPath: string;
  repo?: string;
  dryRun?: boolean;
}): Promise<LocateOutcome> {
  const dryRun = req.dryRun === true;

  if (await isDaemonRunning()) {
    const res = await daemonSocketQuery(
      "repos:locate",
      { newPath: req.newPath, ...(req.repo ? { repo: req.repo } : {}), dryRun },
      LOCATE_TIMEOUT_MS,
    );
    if (!res) {
      return {
        via: "daemon",
        ok: false,
        error: "the rt daemon is running but did not answer repos:locate — not applying locally, which would race the worktree reconciler",
      };
    }
    if (!res.ok) return { via: "daemon", ok: false, error: res.error ?? "repos:locate failed" };
    return dryRun
      ? { via: "daemon", ok: true, dryRun: true, plan: res.data.plan as LocatePlan }
      : { via: "daemon", ok: true, dryRun: false, result: res.data as LocateResult };
  }

  const plan = await planLocate({ newPath: req.newPath, repo: req.repo });
  if (isRefusal(plan)) return { via: "local", ok: false, error: `${plan.refusal}: ${plan.message}` };
  if (dryRun) return { via: "local", ok: true, dryRun: true, plan };

  const result = await applyLocate(plan);
  return result.ok
    ? { via: "local", ok: true, dryRun: false, result }
    : { via: "local", ok: false, error: result.error ?? "locate failed" };
}
```

- [ ] **Step 4: Write the CLI verb**

Append to `commands/repos.ts` (and add the imports it needs to the existing import block: `getKnownRepos` from `../lib/repo-index.ts`, `findLocateCandidates` and the plan/result types from `../lib/repo-locate.ts`, `locateMovedRepo` from `../lib/repo-locate-dispatch.ts`, `resolveRepoArg` from `../lib/repo-arg.ts`):

```ts
// ─── locate ──────────────────────────────────────────────────────────────────

const LOCATE_USAGE = "usage: rt repos locate [<new-path>] [--repo <id|name>] [--dry-run] [--json]";
const LOCATE_FLAGS = ["--json", "--dry-run", "--repo"];

/** Every non-flag token that is not `--repo`'s value. */
function locatePositionals(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--repo") {
      i++;
      continue;
    }
    if (a.startsWith("--")) continue;
    out.push(a);
  }
  return out;
}

/**
 * rt repos locate — tell rt where a repo moved to.
 *
 * A folder move keeps the repo identity but leaves every stored path stale.
 * The daemon owns the apply whenever it answers; a local apply only happens
 * when nothing is up to race.
 */
export async function reposLocate(args: string[], _ctx: CommandContext = {}, deps: RegisterDeps = realRegisterDeps()): Promise<void> {
  const json = args.includes("--json");
  const dryRun = args.includes("--dry-run");
  for (const a of args) {
    if (a.startsWith("--") && !LOCATE_FLAGS.includes(a)) {
      exitUserError(new UserActionableError("usage", `unknown flag "${a}" — ${LOCATE_USAGE}`), json, "repos locate", deps.print);
    }
  }

  const repoArg = flagValue(args, "--repo");
  const repo = repoArg
    ? await resolveRepoArg(repoArg, (msg) =>
        exitUserError(new UserActionableError("repo-unknown", msg), json, "repos locate", deps.print))
    : undefined;

  const newPath = locatePositionals(args)[0] ?? (await pickLocateTarget(json, deps));

  const outcome = await locateMovedRepo({ newPath, ...(repo ? { repo } : {}), dryRun });
  if (!outcome.ok) {
    exitUserError(new UserActionableError("refused", outcome.error), json, "repos locate", deps.print);
  }

  if (outcome.dryRun) {
    const p = outcome.plan;
    if (json) {
      deps.print(JSON.stringify(envelope({ plan: p, dryRun: true })));
      return;
    }
    deps.print(`would move ${p.identity} from ${p.oldPath} to ${p.newPath}`);
    deps.print(`  index rows: ${p.indexKeys.join(", ")}`);
    deps.print(`  worktree records: ${p.registryRewrites.reduce((n, r) => n + r.movedPaths.length, 0)}`);
    deps.print(`  endpoint claims: ${p.claimRewrites.length}`);
    deps.print(`  git worktree repair: ${p.gitRepairPaths.length === 0 ? "(main worktree only)" : p.gitRepairPaths.join(", ")}`);
    return;
  }

  const r = outcome.result;
  if (json) {
    deps.print(JSON.stringify(envelope({ located: r, via: outcome.via })));
    return;
  }
  deps.print(`located ${r.identity}: ${r.from} → ${r.to}`);
  deps.print(`  ${r.treesRewritten} worktree record${r.treesRewritten === 1 ? "" : "s"}, ${r.claimsRewritten} endpoint claim${r.claimsRewritten === 1 ? "" : "s"}, ${r.repaired.length} tree${r.repaired.length === 1 ? "" : "s"} repaired`);
  for (const stale of r.stalePaths) deps.print(`  stale record kept for the reconciler to prune: ${stale}`);
  for (const row of r.legacyRows) {
    deps.print(row.outcome === "collapsed"
      ? `  collapsed the legacy row ${row.key}`
      : `  kept the legacy row ${row.key} — its data dir could not all move`);
  }
}

/**
 * No `<new-path>`: propose, never auto-pick. One candidate still asks; several
 * open a picker; none is a hard stop that names what is lost.
 */
async function pickLocateTarget(json: boolean, deps: RegisterDeps): Promise<string> {
  const lost = getKnownRepos().filter((r) => r.missing);
  if (lost.length === 0) {
    deps.print(json ? JSON.stringify(envelope({ lost: [], candidates: [] })) : "no indexed repo is missing — nothing to locate");
    process.exit(1);
  }

  const candidates = await findLocateCandidates();
  if (candidates.length === 0 || !process.stdin.isTTY) {
    if (json) {
      deps.print(JSON.stringify(envelope({ lost: lost.map((r) => ({ repo: r.repoName, path: r.worktrees[0]?.path })), candidates })));
    } else {
      deps.print("missing repos:");
      for (const r of lost) deps.print(`  ${r.repoName} — last seen at ${r.worktrees[0]?.path}`);
      deps.print(candidates.length === 0
        ? `pass the new path: ${LOCATE_USAGE}`
        : "run interactively to pick a candidate, or pass the new path");
    }
    process.exit(1);
  }

  if (candidates.length === 1) {
    const only = candidates[0]!;
    const { confirm } = await import("../lib/rt-render.tsx");
    const ok = await confirm({ message: `Locate ${only.identity} at ${only.path}?`, stderr: true });
    if (!ok) process.exit(0);
    return only.path;
  }

  const { filterableSelect } = await import("../lib/rt-render.tsx");
  const picked = await filterableSelect({
    message: "Which directory did it move to?",
    options: candidates.map((c) => ({ value: c.path, label: c.path, hint: c.identity })),
    stderr: true,
  });
  if (!picked) process.exit(0);
  return picked;
}
```

- [ ] **Step 5: Register the subcommand**

In `lib/command-tree-def.ts`, add after the `prune` entry (`lib/command-tree-def.ts:1006`), still inside `repos.subcommands`:

```ts
      locate: {
        description: "Tell rt where a repo moved to — re-points the index, worktree registry, endpoint claims and git's worktree admin files together",
        module: "./commands/repos.ts",
        fn: "reposLocate",
        args: [
          { name: "New path", type: "text", placeholder: "/path/to/moved-repo", hint: "Where the repo lives now; omit to pick from candidates under rt.repoRoots" },
          { name: "Repo", flag: "--repo", type: "text", placeholder: "repo-tools", hint: "Which indexed repo moved (identity, path, or name); omit to match by the new path's own identity" },
          { name: "Dry run", flag: "--dry-run", type: "boolean", default: false, hint: "Print what would be re-pointed without writing" },
          SETUP_JSON_ARG,
        ],
      },
```

`commands/repos.ts` is already thunked in `lib/module-registry.ts` — no registry change.

- [ ] **Step 6: Run tests to verify they pass**

Run: `bun test commands/__tests__/repos-locate.test.ts commands/__tests__/repos.test.ts`
Expected: PASS.

- [ ] **Step 7: Typecheck and the command-tree guards**

Run: `bunx tsc --noEmit && bun test lib/__tests__/no-eager-tui.test.ts lib/__tests__/command-tree.test.ts lib/__tests__/command-tree-def.test.ts`
Expected: no errors; PASS. `no-eager-tui` is the guard that a command module stays lazily reachable — a failure there means a static `lib/rt-render.tsx`/`ink` import crept into a command-tree path.

- [ ] **Step 8: Commit**

```bash
git add lib/repo-locate-dispatch.ts commands/repos.ts lib/command-tree-def.ts commands/__tests__/repos-locate.test.ts
git commit -m "feat(repos): rt repos locate — daemon-first, local when nothing answers"
```

---

## Task 9: The implicit heal is move-aware

**Files:**
- Modify: `lib/repo-index.ts:133-153` (`updateRepoIndex`)
- Modify: `commands/repos.ts:125-134` (`reposRegister` uses the async seam)
- Test: `lib/__tests__/repo-locate-heal.test.ts` (create)

**Interfaces:**
- Consumes: `locateMovedRepo(req: { newPath: string; repo?: string; dryRun?: boolean }): Promise<LocateOutcome>` (Task 8).
- Produces:
  - `updateRepoIndex(repoName: string, repoRoot: string): void` — unchanged signature and unchanged behavior EXCEPT that it no longer overwrites a stored path that has stopped existing (that row is a move, and re-pointing it alone is the destructive ordering).
  - `updateRepoIndexAsync(repoName: string, repoRoot: string): Promise<void>` — the same write, plus the move heal for callers that can await.

- [ ] **Step 1: Write the failing test**

Create `lib/__tests__/repo-locate-heal.test.ts`:

```ts
/**
 * The implicit heal must move a repo, not re-point one row of it: the sync
 * seam is reachable from the daemon thread (no sync git there) and cannot
 * await `git worktree repair`, so it declines the write and the async seam
 * performs the whole locate.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execSync } from "child_process";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { closeStateDb, setKvValue } from "../state/index.ts";
import { loadRepoIndex, updateRepoIndex, updateRepoIndexAsync } from "../repo-index.ts";
import { loadRegistry, saveRegistry } from "../worktree/registry.ts";
import { deriveRepoIdentity, serializeIdentity } from "../settings/identity.ts";

describe("move-aware index heal", () => {
  const origHome = process.env.HOME;
  let home: string;
  let scratch: string;

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "rt-heal-home-")));
    scratch = realpathSync(mkdtempSync(join(tmpdir(), "rt-heal-repos-")));
    process.env.HOME = home;
    closeStateDb();
  });

  afterEach(() => {
    process.env.HOME = origHome;
    closeStateDb();
    rmSync(home, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  });

  async function movedRepo(name: string): Promise<{ identity: string; from: string; to: string; tree: string }> {
    const dir = join(scratch, name);
    mkdirSync(dir, { recursive: true });
    execSync("git init -q -b main", { cwd: dir, stdio: "pipe" });
    execSync(`git remote add origin https://gitlab.com/g/${name}.git`, { cwd: dir, stdio: "pipe" });
    execSync("git -c user.email=t@t -c user.name=t commit --allow-empty -q -m init", { cwd: dir, stdio: "pipe" });
    const from = realpathSync(dir);
    const tree = join(from, ".worktrees", "t1");
    execSync(`git worktree add -q -b feat ${tree}`, { cwd: from, stdio: "pipe" });
    const identity = serializeIdentity(await deriveRepoIdentity(from));
    setKvValue("repo-index", identity, from);
    saveRegistry(identity, [
      { name: "main", path: from, kind: "main", branch: "main", createdAt: "2026-01-01T00:00:00.000Z" },
      { name: "t1", path: tree, kind: "ephemeral", state: "on-deck", branch: "feat", createdAt: "2026-01-01T00:00:00.000Z" },
    ]);
    const to = join(scratch, `${name}-moved`);
    renameSync(from, to);
    return { identity, from, to, tree };
  }

  test("the sync seam refuses to re-point a row whose stored path is gone", async () => {
    const { identity, from, to } = await movedRepo("alpha");

    updateRepoIndex(identity, to);

    expect(loadRepoIndex()[identity]).toBe(from);
  });

  test("the sync seam still writes a live path and a brand-new row", async () => {
    const dir = join(scratch, "beta");
    mkdirSync(dir, { recursive: true });
    execSync("git init -q -b main", { cwd: dir, stdio: "pipe" });
    const live = realpathSync(dir);

    updateRepoIndex("beta-key", live);
    expect(loadRepoIndex()["beta-key"]).toBe(live);

    updateRepoIndex("beta-key", live);
    expect(loadRepoIndex()["beta-key"]).toBe(live);
  });

  test("the async seam heals the move as one unit", async () => {
    const { identity, to } = await movedRepo("gamma");

    await updateRepoIndexAsync(identity, to);

    expect(loadRepoIndex()[identity]).toBe(to);
    expect(loadRegistry(identity).map((t) => t.path).sort()).toEqual(
      [to, join(to, ".worktrees", "t1")].sort(),
    );
    expect(loadRegistry(identity).find((t) => t.path === join(to, ".worktrees", "t1"))?.state).toBe("on-deck");
    expect(execSync("git worktree list --porcelain", { cwd: to, encoding: "utf8" })).toContain(join(to, ".worktrees", "t1"));
  });

  test("the async seam is a plain write when nothing moved", async () => {
    const dir = join(scratch, "delta");
    mkdirSync(dir, { recursive: true });
    execSync("git init -q -b main", { cwd: dir, stdio: "pipe" });
    const live = realpathSync(dir);

    await updateRepoIndexAsync("delta-key", live);

    expect(loadRepoIndex()["delta-key"]).toBe(live);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test lib/__tests__/repo-locate-heal.test.ts`
Expected: FAIL — `updateRepoIndexAsync` is not exported, and the sync seam overwrites the row.

- [ ] **Step 3: Write the implementation**

In `lib/repo-index.ts`, replace `updateRepoIndex` (`lib/repo-index.ts:133-153`) with the extracted probe plus the two seams:

```ts
/** The repo's MAIN worktree path as git reports it, degrading to `repoRoot`. */
function observedMainPath(repoRoot: string): string {
  try {
    const listed = execSync("git worktree list --porcelain", {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: "pipe",
    });
    return listed.split("\n")[0]?.replace("worktree ", "").trim() || repoRoot;
  } catch {
    return repoRoot;
  }
}

/** True when the stored row names a directory that is gone and the repo is now somewhere else — a MOVE, not a second clone. */
function storedPathMoved(stored: string | undefined, mainPath: string): stored is string {
  return stored !== undefined && stored !== mainPath && !existsSync(stored);
}

export function updateRepoIndex(repoName: string, repoRoot: string): void {
  const mainPath = observedMainPath(repoRoot);
  try {
    // loadRepoIndex() can throw (an unopenable state.db — e.g. root-owned
    // after a sudo invocation) — inside the try along with the write it
    // depends on, so getRepoIdentity() (which every in-repo command calls)
    // degrades to skipping the index update rather than crashing the command.
    //
    // A moved repo is NOT written here: re-pointing the index row ahead of the
    // worktree registry is what makes the reconciler prune every claimed tree,
    // and the repair this seam would owe is async git — forbidden on the
    // daemon thread, which reaches this function through
    // resolveIndexPathForIdentity. The row stays lost (visible as `missing`)
    // until `updateRepoIndexAsync` or `rt repos locate` moves it as one unit.
    if (storedPathMoved(loadRepoIndex()[repoName], mainPath)) return;
    setKvValue(REPO_INDEX_NS, repoName, mainPath);
    writeRepoIndexCompat(loadRepoIndex());
  } catch { /* best effort */ }
}

/**
 * `updateRepoIndex` for callers that can await: the same write, plus the move
 * heal the sync seam cannot perform. The locate runs in the daemon whenever it
 * answers — imported lazily so this module's sync path never pulls the daemon
 * client into every rt command's startup.
 */
export async function updateRepoIndexAsync(repoName: string, repoRoot: string): Promise<void> {
  const mainPath = observedMainPath(repoRoot);
  let stored: string | undefined;
  try {
    stored = loadRepoIndex()[repoName];
  } catch {
    stored = undefined;
  }
  if (!storedPathMoved(stored, mainPath)) {
    updateRepoIndex(repoName, mainPath);
    return;
  }
  const { locateMovedRepo } = await import("./repo-locate-dispatch.ts");
  const outcome = await locateMovedRepo({ newPath: mainPath, repo: repoName });
  if (!outcome.ok) console.warn(`rt: ${repoName} moved to ${mainPath} but could not be located (${outcome.error})`);
}
```

In `commands/repos.ts`, switch `reposRegister`'s write to the async seam (`commands/repos.ts:126`) and add `updateRepoIndexAsync` to its `../lib/repo-index.ts` import:

```ts
    await updateRepoIndexAsync(identity, real);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test lib/__tests__/repo-locate-heal.test.ts commands/__tests__/repos.test.ts commands/__tests__/repos-locate.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and re-run the index suites**

Run: `bunx tsc --noEmit && bun test lib/__tests__/repo-index.test.ts lib/__tests__/repo-index-rename.test.ts lib/__tests__/repo-index-missing.test.ts lib/__tests__/repo.test.ts`
Expected: no errors; PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/repo-index.ts commands/repos.ts lib/__tests__/repo-locate-heal.test.ts
git commit -m "feat(repos): implicit index heal moves a repo instead of re-pointing one row"
```

---

## Task 10: Real-state verification

**Files:**
- Test: `lib/__tests__/repo-locate-e2e.test.ts` (create)

**Interfaces:**
- Consumes everything the earlier tasks produced: `planLocate`, `applyLocate`, `isRefusal` (Task 5); `loadRegistry`/`saveRegistry` (existing); `loadClaims`/`saveClaims` (existing); `pruneRepoIndex` (Task 3); `reconcileRepoRegistry(deps: { repoName: string; repoPath: string; emit: (type: string, data: unknown) => void; log: Logger }): Promise<TreeRecord[]>` from `lib/daemon/worktree-reconciler.ts`.
- Produces: no source changes — this task adds the end-to-end proof and runs the full gate.

- [ ] **Step 1: Write the test**

Create `lib/__tests__/repo-locate-e2e.test.ts`:

```ts
/**
 * The whole story against real state: a repo with a linked worktree under
 * `.worktrees/`, an ephemeral on-deck record, and a live endpoint claim, moved
 * on disk and then located. The assertion that matters most is the last one —
 * a reconcile pass over the located repo must prune nothing.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execSync } from "child_process";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { Logger } from "pino";
import { closeStateDb, listEndpointClaims, setKvValue } from "../state/index.ts";
import { loadRepoIndex, pruneRepoIndex } from "../repo-index.ts";
import { loadRegistry, saveRegistry } from "../worktree/registry.ts";
import { saveClaims } from "../endpoint/store.ts";
import { deriveRepoIdentity, serializeIdentity } from "../settings/identity.ts";
import { applyLocate, isRefusal, planLocate } from "../repo-locate.ts";
import { reconcileRepoRegistry } from "../daemon/worktree-reconciler.ts";

const silentLog = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as unknown as Logger;

describe("repo locate — real state", () => {
  const origHome = process.env.HOME;
  let home: string;
  let scratch: string;

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "rt-locate-e2e-home-")));
    scratch = realpathSync(mkdtempSync(join(tmpdir(), "rt-locate-e2e-repos-")));
    process.env.HOME = home;
    closeStateDb();
  });

  afterEach(() => {
    process.env.HOME = origHome;
    closeStateDb();
    rmSync(home, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  });

  test("a moved repo with a claimed pool survives locate intact", async () => {
    // ── a throwaway repo with a linked worktree under .worktrees/
    const dir = join(scratch, "acme-dev");
    mkdirSync(dir, { recursive: true });
    execSync("git init -q -b main", { cwd: dir, stdio: "pipe" });
    execSync("git remote add origin https://gitlab.com/acme/acme-dev.git", { cwd: dir, stdio: "pipe" });
    execSync("git -c user.email=t@t -c user.name=t commit --allow-empty -q -m init", { cwd: dir, stdio: "pipe" });
    const from = realpathSync(dir);
    const oldTree = join(from, ".worktrees", "tree-1");
    execSync(`git worktree add -q -b on-deck/tree-1 ${oldTree}`, { cwd: from, stdio: "pipe" });

    // ── registered in an isolated HOME's state.db: index row, registry with an
    //    ephemeral on-deck record, and an endpoint_claims row
    const identity = serializeIdentity(await deriveRepoIdentity(from));
    setKvValue("repo-index", identity, from);
    saveRegistry(identity, [
      { name: "main", path: from, kind: "main", branch: "main", createdAt: "2026-01-01T00:00:00.000Z" },
      {
        name: "tree-1",
        path: oldTree,
        kind: "ephemeral",
        state: "on-deck",
        branch: "on-deck/tree-1",
        createdAt: "2026-01-02T00:00:00.000Z",
        readyAt: "2026-01-02T01:00:00.000Z",
        readyStamp: "abc123",
      },
    ]);
    saveClaims(identity, [{ worktree: oldTree, role: "web", port: 4010, pid: 4242, ts: "2026-01-02T02:00:00.000Z" }]);

    // ── mv the repo
    const to = join(scratch, "moved", "acme-dev");
    mkdirSync(join(scratch, "moved"), { recursive: true });
    renameSync(from, to);
    const newTree = join(to, ".worktrees", "tree-1");

    // ── locate it, locally
    const plan = await planLocate({ newPath: to });
    if (isRefusal(plan)) throw new Error(`unexpected refusal: ${plan.message}`);
    const result = await applyLocate(plan);
    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();

    // index path updated
    expect(loadRepoIndex()[identity]).toBe(to);

    // registry record path updated, state intact
    const trees = loadRegistry(identity);
    expect(trees.map((t) => t.path).sort()).toEqual([to, newTree].sort());
    expect(trees.find((t) => t.path === newTree)).toMatchObject({
      kind: "ephemeral",
      state: "on-deck",
      branch: "on-deck/tree-1",
      readyStamp: "abc123",
    });

    // claim row updated
    expect(listEndpointClaims(identity)).toEqual([
      { worktree: newTree, role: "web", port: 4010, pid: 4242, ts: "2026-01-02T02:00:00.000Z" },
    ]);

    // git worktree list shows the new path (and not the old one)
    const listed = execSync("git worktree list --porcelain", { cwd: to, encoding: "utf8" });
    expect(listed).toContain(newTree);
    expect(listed).not.toContain(oldTree);

    // no prunable entries
    expect(pruneRepoIndex({ dryRun: true })).toEqual([]);

    // and the reconciler prunes nothing: the ordering this whole feature exists for
    const reconciled = await reconcileRepoRegistry({
      repoName: identity,
      repoPath: to,
      emit: () => {},
      log: silentLog,
    });
    expect(reconciled.map((t) => t.path).sort()).toEqual([to, newTree].sort());
    expect(reconciled.find((t) => t.path === newTree)).toMatchObject({ state: "on-deck", readyStamp: "abc123" });
  });
});
```

- [ ] **Step 2: Run the test**

Run: `bun test lib/__tests__/repo-locate-e2e.test.ts`
Expected: PASS. If the reconcile assertion fails because git still lists the old path, the repair arguments are wrong — fix `planLocate`'s `gitRepairPaths`, never the assertion.

- [ ] **Step 3: Run the full gate**

Run: `bunx tsc --noEmit && bun test lib commands`
Expected: no type errors; no test delta from the baseline other than the suites this plan added. Record the counts in the commit body.

- [ ] **Step 4: Commit**

```bash
git add lib/__tests__/repo-locate-e2e.test.ts
git commit -m "test(repos): end-to-end locate against real git state and a live reconcile"
```

---

## Self-review notes (already applied)

- **Spec coverage:** 1→T1, 2→T2, 3→T3, 4→T5, 5→T6+T7, 6→T8, 7→T4, 8→T9, "Verification"→T10. Parity anchors: wire keys via `lib/settings/identity.ts` (T5, T7), legacy pair discovered through the index rows the additive heal leaves (T5, never by basename), `worktree-registry` mirrored in both modules (T2 keeps both), `ctx.log`-only logging (T7 adds none), module registry untouched (T8), constraint-only comments throughout.
- **Out of scope, deliberately absent:** gitq's commonDir-hash store, `uow.json`, `board.cwds`, `rt.workspacePrefs.workspaces` — those owners react to `repo:moved`, which T7 emits and nothing here consumes.
- **Type consistency:** `LocatePlan`/`LocateResult`/`LocateRefusal` field names are used identically in T5 (definition), T7 (handler), T8 (dispatcher and CLI), T9 (heal), T10 (assertions). `withReconcilerHeld`'s generic signature is identical in T6 (implementation), T7 (`ReposHandlerOpts`, `buildRoutedHandlers` opt, daemon wiring, and the `rt-client-commands` stub). `DataMigration["registry"]` gains exactly one member (`"merged"`) in T2 and is read in T2's CLI branch only.
