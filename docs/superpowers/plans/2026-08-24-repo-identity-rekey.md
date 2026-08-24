# Repo Identity Re-key Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-key every per-repo rt store on a stable, remote-derived identity (with a realpath fallback for origin-less repos) instead of a mutable derived name, and cut the whole mattstack estate over to it in one coordinated landing.

**Architecture:** A tagged `RepoIdentity` value lives in `@mattstack/rt-client` and serializes to one slash-free, reversible wire string. `getRepoIdentity` (`lib/repo.ts`) is the single derivation seam: it gains an `identity` field, and `dataDir`, the repo index, and six state.db stores switch from keying on `repoName` (now a display label) to keying on `identity`. Existing rows migrate once, on first read, verify-persisted before the legacy row is dropped. The daemon accepts identities only — a hard cutover with no compat window — and the five identity-touching consumers (gitq, board, mr-board, its fork, console) adopt in the same landing.

**Tech Stack:** Bun + TypeScript, `bun:test`, `bun:sqlite` via `state.db`, the existing exec/`runCapture` seams, `@mattstack/rt-client` (published package).

**Spec:** `docs/superpowers/specs/2026-08-24-repo-identity-rekey-design.md` — read it first; it carries the reasoning these tasks implement.

## Global Constraints

- **Wire identity is `<kind>:<encodeURIComponent(id)>`** — `remote:gitlab.com%2Fgroup%2Frepo` or `path:%2FUsers%2F…`. Slash-free by construction (console routes on one path segment). `serializeIdentity`/`parseIdentity` in rt-client are the only code that knows this encoding; nothing else concatenates or splits it.
- **`RepoIdentity` is `{ kind: "remote" | "path"; id: string }`.** `remote` id is normalized `host/path`; `path` id is the **main worktree's** realpath (never a linked worktree's own path).
- **`deriveRepoIdentity(path)` never returns null** after this change — the `path` fallback always resolves. `identityFromRemote(remote)` may still return null (a remote string that isn't a usable remote).
- **Migration is one-shot on first read, and verifies the destination write persisted BEFORE removing the legacy row.** `persistOrWarn`/`setKvValue` swallow `SQLITE_BUSY`, so a returned write is not a landed write. This is the RT-60 scar; an unverified migration is a plan failure. Unresolvable legacy rows are left in place with one `warn`, never dropped.
- **rt never writes into a target repo.** Identity is derived, never stamped into `.git/`.
- **Hard cutover: the daemon accepts serialized identities only.** No legacy-name acceptance path in any verb. `resolveNameToIdentity` exists only as a one-time config-rewrite helper for board; the daemon never calls it.
- **rt-client publishes as `0.4.0` (major).** All consumers currently at `0.3.0` with no drift. Published-pin consumers (gitq, board, mr-board) bump `^0.4.0` in this landing; file-dep consumers (console, mr-board-wt-invite-onboarding) pick it up at `bun install`.
- **Comments constraint-only** — an invariant, an ordering trap, a non-obvious why. No narration, no ticket numbers, no reviewer-facing justification.
- **Gates per task, FOREGROUND:** the touched package's suite (`bun test lib commands packages` in repo-tools; the consumer repo's own `test` script in a consumer task) + `bun x tsc --noEmit`. State any delta from baseline.
- **One commit per task**, trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- **rt-client is a `file:`-dep copy in some consumers:** after changing `packages/rt-client`, a consumer that uses `file:` needs `bun install` to see it. Never edit a consumer's copy under `node_modules`.

---

## File structure

**rt-client (`packages/rt-client/`):**
- `src/settings/identity.ts` — tagged `RepoIdentity`, `serializeIdentity`/`parseIdentity`, `identityFromRemote`→tagged, `deriveRepoIdentity`→non-null, `resolveNameToIdentity` (new)
- `src/index.ts` — barrel: export the new symbols
- `package.json` — version → `0.4.0`

**rt core (`lib/`, `commands/`):**
- `lib/repo.ts` — `RepoIdentity` gains `identity`; `getRepoIdentity` derives it; `dataDir` + index key from `identity`
- `lib/rt-paths.ts` — `repoDataDir` takes the serialized identity (its argument is opaque; only the caller changes)
- `lib/repo-index.ts` — index keyed by identity; `migrateRepoData`/prune reconciled; RT-60's name-migration replaced
- `commands/repos.ts` — `register` derives identity, not `basename`
- `lib/repo-tracking.ts` — grants keyed by identity
- `lib/worktree/registry.ts` — registry keyed by identity
- `lib/run-history.ts`, `lib/state/*.ts` (`endpoint_claims`, `branch_cache`, `project_mrs*`, `discussions`) — `repo` column holds identity
- `lib/state/identity-migrate.ts` (new) — the shared one-shot re-key harness
- `lib/daemon/handlers/*.ts`, `lib/daemon/{freshness,cache-refresh,discussions-poller,project-sync}.ts` — identity payloads; name-reject

**Consumers (other repos):**
- `gitq/src/core/secrets.ts`, `gitq/src/server/data.ts`
- `board/src/config.ts`, `board/src/server.ts`; same in `mr-board/` and `mr-board-wt-invite-onboarding/`
- `console/src/server/runs.ts`, `console/src/app/routes.ts`

---

## Task 1: Tagged identity type and the wire codec (rt-client)

**Files:**
- Modify: `packages/rt-client/src/settings/identity.ts` (add type + codec near the top, after the regexes)
- Test: `packages/rt-client/src/settings/__tests__/identity.test.ts` (create if absent; else append)

**Interfaces:**
- Produces: `type RepoIdentity = { kind: "remote" | "path"; id: string }`; `serializeIdentity(id: RepoIdentity): string`; `parseIdentity(wire: string): RepoIdentity | null` (null on a malformed wire string — an unknown kind prefix or a value that fails to decode).

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, test } from "bun:test";
import { serializeIdentity, parseIdentity, type RepoIdentity } from "../identity.ts";

describe("identity wire codec", () => {
  const cases: RepoIdentity[] = [
    { kind: "remote", id: "gitlab.com/group/repo" },
    { kind: "remote", id: "gitlab.com/group/sub/repo" },
    { kind: "path", id: "/Users/matt/Documents/GitHub/x" },
    { kind: "path", id: "/tmp/a dir/with spaces" },
  ];

  test("serialize then parse is the identity function", () => {
    for (const id of cases) expect(parseIdentity(serializeIdentity(id))).toEqual(id);
  });

  test("the serialized form contains no forward slash", () => {
    for (const id of cases) expect(serializeIdentity(id)).not.toContain("/");
  });

  test("serialized form is <kind>:<encoded>", () => {
    expect(serializeIdentity({ kind: "remote", id: "gitlab.com/g/r" }))
      .toBe("remote:gitlab.com%2Fg%2Fr");
  });

  test("parse rejects an unknown kind prefix", () => {
    expect(parseIdentity("bogus:whatever")).toBeNull();
  });

  test("parse rejects a string with no kind prefix", () => {
    expect(parseIdentity("gitlab.com/g/r")).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd packages/rt-client && bun test src/settings/__tests__/identity.test.ts -t "wire codec"`
Expected: FAIL — `serializeIdentity` is not exported.

- [ ] **Step 3: Implement**

In `packages/rt-client/src/settings/identity.ts`, after the `SCP_RE` declaration:

```ts
export type RepoIdentity =
  | { kind: "remote"; id: string }
  | { kind: "path"; id: string };

/**
 * The wire form crosses the daemon socket, sits in board config, and lands in
 * console's `/runs/:repo/...` URL — all of which need one slash-free segment.
 * `encodeURIComponent` guarantees that and is exactly reversible.
 */
export function serializeIdentity(id: RepoIdentity): string {
  return `${id.kind}:${encodeURIComponent(id.id)}`;
}

export function parseIdentity(wire: string): RepoIdentity | null {
  const colon = wire.indexOf(":");
  if (colon === -1) return null;
  const kind = wire.slice(0, colon);
  if (kind !== "remote" && kind !== "path") return null;
  try {
    return { kind, id: decodeURIComponent(wire.slice(colon + 1)) };
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd packages/rt-client && bun test src/settings/__tests__/identity.test.ts -t "wire codec"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/rt-client/src/settings/identity.ts packages/rt-client/src/settings/__tests__/identity.test.ts
git commit -m "feat(rt-client): tagged RepoIdentity and its slash-free wire codec"
```

---

## Task 2: Identity derivation returns the tagged value; add the board rewrite helper (rt-client)

**Files:**
- Modify: `packages/rt-client/src/settings/identity.ts:78` (`identityFromRemote`), `:106` (`deriveRepoIdentity`), the memo type at `:90`
- Modify: `packages/rt-client/src/index.ts` (barrel exports)
- Modify: `packages/rt-client/package.json` (version → `0.4.0`)
- Test: `packages/rt-client/src/settings/__tests__/identity.test.ts`

**Interfaces:**
- Consumes: Task 1's `RepoIdentity`, `serializeIdentity`.
- Produces:
  - `identityFromRemote(remote: string): RepoIdentity | null` — `{kind:"remote"}` or null.
  - `deriveRepoIdentity(repoPath: string): Promise<RepoIdentity>` — **never null**; `{kind:"path", id: <realpath of main worktree>}` when no usable remote.
  - `resolveNameToIdentity(name: string, reposJsonPath?: string): RepoIdentity | null` — looks the name up in `repos.json`, returns the identity of the path it points at (via `deriveRepoIdentity`), or null if the name is unknown. One-shot config-rewrite helper only.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { execSync } from "child_process";
import { identityFromRemote, deriveRepoIdentity, clearIdentityMemo } from "../identity.ts";

describe("identity derivation → tagged", () => {
  test("a usable remote yields a remote-kind identity", () => {
    expect(identityFromRemote("git@gitlab.com:group/repo.git"))
      .toEqual({ kind: "remote", id: "gitlab.com/group/repo" });
  });

  test("a local-path remote yields null (not a usable remote)", () => {
    expect(identityFromRemote("/some/dir/origin.git")).toBeNull();
  });

  test("deriveRepoIdentity falls back to the main worktree realpath, never null", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "rt-id-"));
    try {
      const repo = join(scratch, "no-origin");
      mkdirSync(repo);
      execSync("git init -q -b main", { cwd: repo, stdio: "pipe" });
      execSync("git -c user.email=t@t -c user.name=t commit --allow-empty -q -m init", { cwd: repo, stdio: "pipe" });
      clearIdentityMemo();
      const id = await deriveRepoIdentity(repo);
      expect(id.kind).toBe("path");
      // realpath, so a /var vs /private/var symlink resolves consistently
      expect(id.id).toBe(require("fs").realpathSync(repo));
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd packages/rt-client && bun test src/settings/__tests__/identity.test.ts -t "derivation"`
Expected: FAIL — `identityFromRemote` returns a string, not an object; `deriveRepoIdentity` can return null.

- [ ] **Step 3: Implement the derivation change**

Rewrite `identityFromRemote` to wrap `normalizeRemote`'s string in a tag, and to return the override as a remote-kind identity:

```ts
export function identityFromRemote(remote: string): RepoIdentity | null {
  const store = readStore(machineSettingsPath());
  const overrides = store.global["rt.repoIdentityOverrides"];
  if (overrides !== null && typeof overrides === "object" && !Array.isArray(overrides)) {
    const hit = (overrides as Record<string, unknown>)[remote];
    if (typeof hit === "string") return { kind: "remote", id: hit };
  }
  const normalized = normalizeRemote(remote);
  return normalized === null ? null : { kind: "remote", id: normalized };
}
```

Change the memo type to `Map<string, Promise<RepoIdentity>>` and rewrite `deriveRepoIdentity` to fall back to the realpath. Import `realpathSync` from `fs` at the top:

```ts
export async function deriveRepoIdentity(repoPath: string): Promise<RepoIdentity> {
  const cached = memo.get(repoPath);
  if (cached) return cached;

  const result = await (async (): Promise<RepoIdentity> => {
    const spawned = await runCapture(["git", "-C", repoPath, "config", "--get", "remote.origin.url"]);
    if (spawned.exitCode === 0) {
      const remote = spawned.stdout.trim();
      const fromRemote = remote ? identityFromRemote(remote) : null;
      if (fromRemote) return fromRemote;
    }
    // No usable remote: the main worktree's realpath is the stable floor.
    const top = await runCapture(["git", "-C", repoPath, "rev-parse", "--path-format=absolute", "--git-common-dir"]);
    const base = top.exitCode === 0 && top.stdout.trim()
      ? realpathSync(join(top.stdout.trim(), ".."))
      : realpathSync(repoPath);
    return { kind: "path", id: base };
  })();

  // Only a remote-kind result is memoized for the process life; a path result
  // is cheap to recompute and must not pin a repo that later gains a remote.
  if (result.kind === "remote") memo.set(repoPath, Promise.resolve(result));
  return result;
}
```

Note: `--git-common-dir` resolves to the *main* worktree's `.git`, so `join(..,"..")` is the main worktree root even when called from a linked worktree — this is what makes every worktree of one repo share the `path` identity. `clearIdentityMemo` is unchanged.

- [ ] **Step 4: Add `resolveNameToIdentity`**

Append to `identity.ts`. It reuses `repoNameForPath`'s data source in reverse — name → path from `repos.json` — then derives:

```ts
import { readFileSync, existsSync } from "fs";

/**
 * One-shot helper for rewriting board's existing name-valued config to
 * host/path identities. NOT a runtime path — the daemon never calls it.
 * Resolves a repo name to the identity of the path it points at in repos.json.
 */
export async function resolveNameToIdentity(
  name: string,
  reposJsonPath: string,
): Promise<RepoIdentity | null> {
  if (!existsSync(reposJsonPath)) return null;
  try {
    const index = JSON.parse(readFileSync(reposJsonPath, "utf8")) as Record<string, unknown>;
    const path = index[name];
    if (typeof path !== "string") return null;
    return await deriveRepoIdentity(path);
  } catch {
    return null;
  }
}
```

- [ ] **Step 5: Export from the barrel and bump the version**

In `packages/rt-client/src/index.ts`, change the identity export line to:

```ts
export {
  normalizeRemote, identityFromRemote, deriveRepoIdentity, clearIdentityMemo,
  serializeIdentity, parseIdentity, resolveNameToIdentity,
  type RepoIdentity,
} from "./settings/identity.ts";
```

In `packages/rt-client/package.json`, set `"version": "0.4.0"`.

- [ ] **Step 6: Run tests and gates**

Run: `cd packages/rt-client && bun test && bun x tsc --noEmit`
Expected: PASS. Any call site inside rt-client that consumed the old `string | null` return of `identityFromRemote`/`deriveRepoIdentity` now type-errors — fix each to consume the tagged value (the resolver's `repos.<identity>` section key becomes `id.id` for a remote-kind identity; a `path`-kind or null identity means no repo section, unchanged behavior).

- [ ] **Step 7: Commit**

```bash
git add packages/rt-client/src/settings/identity.ts packages/rt-client/src/index.ts packages/rt-client/package.json packages/rt-client/src/settings/__tests__/identity.test.ts
git commit -m "feat(rt-client)!: identity derivation returns tagged RepoIdentity; bump 0.4.0"
```

---

## Task 3: The rt-core identity seam — `getRepoIdentity` gains `identity`

**Files:**
- Modify: `lib/repo.ts:29-38` (`RepoIdentity` interface), `:58-82` (`getRepoIdentity`)
- Test: `lib/__tests__/repo.test.ts` (append; create if absent)

**Interfaces:**
- Consumes: rt-client's **`identityFromRemote`** (sync) and **`serializeIdentity`** (sync) — *not* `deriveRepoIdentity`, which is async; `getRepoIdentity` is sync and stays sync, mirroring the file's existing sync `getRemoteUrl()`. Import from the in-repo `packages/rt-client/src` path the rest of `lib/` uses — match the existing import in `lib/settings/resolve.ts`.
- Produces: `RepoIdentity` (the `lib/repo.ts` interface — a **different, pre-existing type** from rt-client's tagged `{kind,id}` `RepoIdentity`; do not conflate them) gains `identity: string` — the serialized wire identity. `repoName` stays as a **display label**. `dataDir` is now `repoDataDir(identity)`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, test, afterEach, beforeEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { execSync } from "child_process";

describe("getRepoIdentity identity field", () => {
  let scratch: string;
  const origHome = process.env.HOME;
  beforeEach(() => { scratch = mkdtempSync(join(tmpdir(), "rt-repo-")); process.env.HOME = scratch; });
  afterEach(() => { process.env.HOME = origHome; rmSync(scratch, { recursive: true, force: true }); });

  test("a remote repo's identity is the serialized remote id, and dataDir derives from it", async () => {
    const repo = join(scratch, "work");
    mkdirSync(repo);
    execSync("git init -q -b main", { cwd: repo, stdio: "pipe" });
    execSync("git remote add origin git@gitlab.com:group/repo.git", { cwd: repo, stdio: "pipe" });
    const { getRepoIdentityForRoot } = await import("../repo.ts");
    const id = await getRepoIdentityForRoot(repo);
    expect(id!.identity).toBe("remote:gitlab.com%2Fgroup%2Frepo");
    expect(id!.dataDir).toContain("remote%3A"); // dataDir is keyed by the serialized identity
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test lib/__tests__/repo.test.ts -t "identity field"`
Expected: FAIL — `RepoIdentity` has no `identity`; `getRepoIdentityForRoot` does not exist.

- [ ] **Step 3: Extract an async, root-parameterized derivation**

`getRepoIdentity` today is sync and reads the cwd. Identity derivation is async (it may spawn git). Add an async core `getRepoIdentityForRoot(repoRoot: string): Promise<RepoIdentity | null>` that does the work, and keep `getRepoIdentity()` as a sync wrapper **only if** every current caller can move to the async form; if not, derive identity synchronously via a sync git spawn mirroring `getRemoteUrl()` (already sync in this file) and `serializeIdentity`. Prefer the sync path to avoid churning callers:

```ts
export interface RepoIdentity {
  repoName: string;      // display label only — NEVER a store key after this change
  identity: string;      // serialized wire identity — the store key
  repoRoot: string;
  dataDir: string;
  remoteUrl: string;
  baseUrl: string;
}
```

In `getRepoIdentity`, replace the `repoName`/`dataDir`/`updateRepoIndex` block:

```ts
const remoteUrl = getRemoteUrl();
const repoName = remoteUrl ? deriveRepoName(remoteUrl) : basename(repoRoot);
const identity = serializeIdentity(
  remoteUrl
    ? (identityFromRemote(remoteUrl) ?? { kind: "path", id: realpathSync(mainWorktreeRoot(repoRoot)) })
    : { kind: "path", id: realpathSync(mainWorktreeRoot(repoRoot)) },
);
const dataDir = repoDataDir(identity);
mkdirSync(dataDir, { recursive: true });
updateRepoIndex(identity, repoRoot);
```

Add a sync `mainWorktreeRoot(repoRoot)` helper in this file using `git rev-parse --git-common-dir` (sync, like `getRemoteUrl`), falling back to `repoRoot`. Import `identityFromRemote`, `serializeIdentity` from rt-client and `realpathSync` from `fs`.

Note the index key is now the identity, not the name — Task 5 makes `updateRepoIndex`/`repo-index.ts` consistent with that.

- [ ] **Step 4: Run to verify it passes**

Run: `bun test lib/__tests__/repo.test.ts -t "identity field"`
Expected: PASS.

- [ ] **Step 5: Run gates**

Run: `bun test lib commands packages` and `bun x tsc --noEmit`
Expected: PASS. Downstream reads of `identity.repoName` as a **key** now need to move to `identity.identity` — those are Tasks 5–10; where a compile error appears in a store this task doesn't own, change the minimum to keep the build green (read `.identity`) and let the owning task add the test.

- [ ] **Step 6: Commit**

```bash
git add lib/repo.ts lib/__tests__/repo.test.ts
git commit -m "feat(repo): RepoIdentity carries a serialized identity; dataDir + index key derive from it"
```

---

## Task 4: The one-shot re-key migration harness

**Files:**
- Create: `lib/state/identity-migrate.ts`
- Test: `lib/state/__tests__/identity-migrate.test.ts`

**Interfaces:**
- Consumes: `getKvValue`/`setKvValue`/`hasKvValue`/`deleteKvValue`, `getStateDb` from `lib/state/index.ts`; rt-client `parseIdentity`, `deriveRepoIdentity`, `serializeIdentity`; `loadRepoIndex` from `lib/repo-index.ts` (name→path, to resolve a legacy name).
- Produces: `rekeyKvNamespace(ns: string, opts?): Promise<RekeyReport>` and `rekeyTableColumn(table: string, col: string, opts?): Promise<RekeyReport>`, where `RekeyReport = { migrated: string[]; retained: string[] }`. Each resolves a legacy **name** key to a serialized identity via `resolveLegacyKey(name)`, writes the row under the identity, verifies it persisted, then deletes the legacy row; a key that is already a valid serialized identity (`parseIdentity` succeeds) is left untouched; an unresolvable name is retained with a `warn`.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, test, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { closeStateDb, setKvValue, listKvValues } from "../index.ts";
import { rekeyKvNamespace } from "../identity-migrate.ts";

describe("rekeyKvNamespace", () => {
  const origHome = process.env.HOME;
  let home: string;
  let warnSpy: ReturnType<typeof spyOn<Console, "warn">>;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), "rt-rek-")); process.env.HOME = home; closeStateDb(); warnSpy = spyOn(console, "warn").mockImplementation(() => {}); });
  afterEach(() => { warnSpy.mockRestore(); process.env.HOME = origHome; closeStateDb(); rmSync(home, { recursive: true, force: true }); });

  test("a legacy name resolvable to a remote identity is re-keyed", async () => {
    setKvValue("repo-index", "repo-tools", "/tmp/does-not-need-to-exist");
    setKvValue("demo-ns", "repo-tools", { v: 1 });
    // resolveLegacyKey is fed a fixed resolver in the test via opts:
    const report = await rekeyKvNamespace("demo-ns", {
      resolve: async (name) => (name === "repo-tools" ? "remote:gitlab.com%2Fg%2Frepo-tools" : null),
    });
    expect(report.migrated).toEqual(["repo-tools"]);
    const rows = listKvValues("demo-ns");
    expect(rows["remote:gitlab.com%2Fg%2Frepo-tools"]).toEqual({ v: 1 });
    expect(rows["repo-tools"]).toBeUndefined();
  });

  test("a key already a serialized identity is left untouched", async () => {
    setKvValue("demo-ns", "remote:gitlab.com%2Fg%2Fr", { v: 2 });
    const report = await rekeyKvNamespace("demo-ns", { resolve: async () => null });
    expect(report.migrated).toEqual([]);
    expect(listKvValues("demo-ns")["remote:gitlab.com%2Fg%2Fr"]).toEqual({ v: 2 });
  });

  test("an unresolvable legacy name is retained and warned, never dropped", async () => {
    setKvValue("demo-ns", "ghost", { v: 3 });
    const report = await rekeyKvNamespace("demo-ns", { resolve: async () => null });
    expect(report.retained).toEqual(["ghost"]);
    expect(listKvValues("demo-ns")["ghost"]).toEqual({ v: 3 });
    expect(warnSpy).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `bun test lib/state/__tests__/identity-migrate.test.ts`
Expected: FAIL — `rekeyKvNamespace` not defined.

- [ ] **Step 3: Implement**

```ts
import { getKvValue, setKvValue, deleteKvValue, hasKvValue, listKvValues } from "./index.ts";
import { parseIdentity } from "@mattstack/rt-client";

export interface RekeyReport { migrated: string[]; retained: string[]; }

interface RekeyOpts {
  /** name → serialized identity, or null when unresolvable. Defaults to the real resolver. */
  resolve?: (name: string) => Promise<string | null>;
}

export async function rekeyKvNamespace(ns: string, opts: RekeyOpts = {}): Promise<RekeyReport> {
  const resolve = opts.resolve ?? realResolveLegacyKey;
  const report: RekeyReport = { migrated: [], retained: [] };
  for (const [key, value] of Object.entries(listKvValues<unknown>(ns))) {
    if (parseIdentity(key) !== null) continue;        // already an identity
    const identity = await resolve(key);
    if (identity === null) {
      console.warn(`rt: could not re-key ${ns}/${key} to an identity — leaving it in place`);
      report.retained.push(key);
      continue;
    }
    if (hasKvValue(ns, identity)) {                    // destination already present: don't clobber
      console.warn(`rt: ${ns}/${identity} already exists; leaving legacy ${key} in place`);
      report.retained.push(key);
      continue;
    }
    setKvValue(ns, identity, value);
    if (!hasKvValue(ns, identity)) {                   // verify-persisted: SQLITE_BUSY is swallowed upstream
      console.warn(`rt: ${ns}/${identity} did not persist; leaving legacy ${key} in place`);
      report.retained.push(key);
      continue;
    }
    deleteKvValue(ns, key);
    report.migrated.push(key);
  }
  return report;
}
```

`realResolveLegacyKey(name)`: look the name up in `loadRepoIndex()` (name→path); if found, `serializeIdentity(await deriveRepoIdentity(path))`; else null. Put it in this file, importing `loadRepoIndex` lazily to avoid a cycle (`const { loadRepoIndex } = await import("../repo-index.ts")`).

`rekeyTableColumn(table, col, opts)` is the table analogue; add it in the same file (its store-specific tests ride with Tasks 8–9, but the function is written here):

```ts
import { getStateDb, persistOrWarn } from "./index.ts";

export async function rekeyTableColumn(table: string, col: string, opts: RekeyOpts = {}): Promise<RekeyReport> {
  const resolve = opts.resolve ?? realResolveLegacyKey;
  const db = getStateDb();
  const report: RekeyReport = { migrated: [], retained: [] };
  const keys = db.query(`SELECT DISTINCT ${col} AS k FROM ${table};`).all() as { k: string }[];
  for (const { k } of keys) {
    if (k == null || parseIdentity(k) !== null) continue;   // already an identity
    const identity = await resolve(k);
    if (identity === null) {
      console.warn(`rt: could not re-key ${table}.${col}=${k} to an identity — leaving it`);
      report.retained.push(k);
      continue;
    }
    persistOrWarn(() => db.query(`UPDATE ${table} SET ${col} = ? WHERE ${col} = ?;`).run(identity, k));
    const landed = db.query(`SELECT 1 FROM ${table} WHERE ${col} = ? LIMIT 1;`).get(identity);
    if (!landed) {
      console.warn(`rt: ${table}.${col} re-key to ${identity} did not persist — leaving ${k}`);
      report.retained.push(k);
      continue;
    }
    report.migrated.push(k);
  }
  return report;
}
```

`table`/`col` are internal literals from Tasks 8–9, never user input — no injection surface. A destination-collision (two legacy names resolving to one identity) merges rows under the identity, which is correct for these append/cache tables; the verify only needs one landed row.

- [ ] **Step 4: Run to verify they pass**

Run: `bun test lib/state/__tests__/identity-migrate.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/state/identity-migrate.ts lib/state/__tests__/identity-migrate.test.ts
git commit -m "feat(state): one-shot identity re-key harness with verify-persisted"
```

---

## Task 5: Repo index and `rt repos register` key on identity

**Files:**
- Modify: `lib/repo-index.ts` (`updateRepoIndex` signature already takes a string key; `migrateRepoData` semantics reconciled), `commands/repos.ts:110` (register)
- Test: `lib/__tests__/repo-index-rename.test.ts` (extend), `commands/__tests__/repos.test.ts`

**Interfaces:**
- Consumes: Task 3's `getRepoIdentity().identity`; rt-client `deriveRepoIdentity`, `serializeIdentity`.
- Produces: the repo index maps `serializedIdentity → mainPath`. `reposRegister` writes the identity, not `basename(realpath)`.

- [ ] **Step 1: Write the failing test**

```ts
test("register keys the index by the repo's identity, not its directory basename", async () => {
  // a checkout whose dir name differs from its remote's last segment
  const dir = realRepo("weird-dir-name");
  execSync("git remote add origin git@gitlab.com:group/canonical.git", { cwd: dir, stdio: "pipe" });
  await reposRegister([dir], {}, { print: () => {} });
  const keys = Object.keys(loadRepoIndex());
  expect(keys).toContain("remote:gitlab.com%2Fgroup%2Fcanonical");
  expect(keys).not.toContain("weird-dir-name");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test commands/__tests__/repos.test.ts -t "keys the index by"`
Expected: FAIL — register writes `basename`.

- [ ] **Step 3: Implement**

In `commands/repos.ts`'s `reposRegister`, replace `basename(real)` as the key with the derived identity. `updateRepoIndex` already takes `(key, path)`; feed it `serializeIdentity(await deriveRepoIdentity(real))`. `reposRegister` is already async. The `--track` write in the same loop (`rawTracking[name]`) must use the same identity key (Task 7 owns the tracking store shape; here just key by identity).

- [ ] **Step 4: Reconcile `migrateRepoData`**

RT-60's `migrateRepoData` moves a data dir + worktree registry from a losing **name** to a winning name during prune. With identity keys, prune's realpath dedupe now compares identity rows, and a legacy name row and its identity row are a duplicate pair pointing at one path — so prune's existing loser→winner migration carries the legacy-named data dir onto the identity-named one automatically. Verify (do not rewrite) that `migrateRepoData(loser, winner)` still holds when `winner` is a serialized identity: `repoDataDir(winner)` is `repos/remote%3A…/`, which is a valid directory name. Add a test asserting a `repos/<name>/run-history.jsonl` migrates onto `repos/<serializedIdentity>/` under prune.

- [ ] **Step 5: Run tests and gates**

Run: `bun test lib commands packages` and `bun x tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/repo-index.ts commands/repos.ts lib/__tests__/repo-index-rename.test.ts commands/__tests__/repos.test.ts
git commit -m "feat(repo-index): index and register key on identity"
```

---

## Task 6: Re-key `worktree-registry`, replacing RT-60's name migration

**Files:**
- Modify: `lib/worktree/registry.ts` (callers pass identity), `lib/daemon/worktree-reconciler.ts` (iterates index — keys are now identities), `lib/daemon/handlers/worktree.ts` (payload identity)
- Modify: `lib/repo-index.ts` — `migrateWorktreeRegistry` (RT-60) becomes a name→identity re-key via the Task 4 harness
- Test: `lib/daemon/__tests__/worktree-reconciler.test.ts`, `lib/__tests__/repo-index-rename.test.ts`

**Interfaces:**
- Consumes: Task 4 `rekeyKvNamespace`; identity from Task 3.
- Produces: `worktree-registry` kv keyed by serialized identity end to end (reconciler write, handler read, CLI read).

- [ ] **Step 1: Write the failing test**

```ts
test("a legacy name-keyed registry is re-keyed onto the repo's identity on first reconcile", async () => {
  const h = await reconcilerHarnessWithLegacyRegistry("repo-tools", "remote:gitlab.com%2Fg%2Frepo-tools");
  await h.runOnce();
  const keys = Object.keys(listKvValues("worktree-registry"));
  expect(keys).toContain("remote:gitlab.com%2Fg%2Frepo-tools");
  expect(keys).not.toContain("repo-tools");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test lib/daemon/__tests__/worktree-reconciler.test.ts -t "re-keyed onto"`
Expected: FAIL — the reconciler reads/writes the legacy name.

- [ ] **Step 3: Implement**

The reconciler iterates `deps.repoIndex()`, whose keys are now identities (Task 5). It calls `loadRegistry(key)`/`saveRegistry(key, …)` — passing the identity through unchanged makes both sides identity-keyed with no signature change; verify no caller re-derives a name here. In `lib/repo-index.ts`, replace `migrateWorktreeRegistry`'s name→name move with a call to `rekeyKvNamespace("worktree-registry")` run once from the same first-read point that RT-60 used. The handler (`lib/daemon/handlers/worktree.ts:90-94`) currently derives a name from the CLI payload — change it to take the serialized identity from the payload (the CLI computes it via Task 3's `getRepoIdentity().identity`).

- [ ] **Step 4: Run tests and gates**

Run: `bun test lib commands packages` and `bun x tsc --noEmit`
Expected: PASS. The RT-60 registry tests that asserted name-keyed migration are updated to identity keys.

- [ ] **Step 5: Commit**

```bash
git add lib/worktree/registry.ts lib/daemon/worktree-reconciler.ts lib/daemon/handlers/worktree.ts lib/repo-index.ts lib/daemon/__tests__/worktree-reconciler.test.ts lib/__tests__/repo-index-rename.test.ts
git commit -m "feat(worktree): registry keyed on identity; re-key legacy rows once"
```

---

## Task 7: Re-key `rt.repoTracking` grants (the severe finding)

**Files:**
- Modify: `lib/repo-tracking.ts` (grants map keyed by identity), `commands/daemon.ts:448-506` (`rt daemon track` writes identity), the daemon loops that read grants (`lib/daemon/freshness.ts:655`, `cache-refresh.ts:79`, `discussions-poller.ts:99`, `project-sync.ts:147`), `lib/daemon/handlers/secrets.ts:158`
- Modify: wire a one-shot `rekeyKvNamespace`/settings re-key at daemon first read
- Test: `lib/daemon/__tests__/repo-tracking.test.ts`

**Interfaces:**
- Consumes: Task 4 harness (or, since tracking lives in the machine **settings** store not kv, an equivalent settings re-key — resolve the open question: keep it a flat map, keyed by serialized identity string).
- Produces: `rt.repoTracking` keyed by serialized identity; every reader derives the same identity from the index it iterates.

- [ ] **Step 1: Write the failing test**

```ts
test("a grant survives a rename because it is keyed by identity, and prune no longer strands it", async () => {
  // grant under identity; index row renamed; grant still found by the daemon loop
  writeTracking({ "remote:gitlab.com%2Fg%2Frepo-tools": { mode: "live", caches: ["branches"] } });
  const grant = grantsForIdentity("remote:gitlab.com%2Fg%2Frepo-tools");
  expect(grant?.mode).toBe("live");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test lib/daemon/__tests__/repo-tracking.test.ts -t "keyed by identity"`
Expected: FAIL — `grants()` keys by name.

- [ ] **Step 3: Implement**

`rt.repoTracking` is a flat `Record<repoKey, {mode,caches}>` in the machine settings store (`lib/repo-tracking.ts:5,181-186,250`). Change every read/write of that map to key by the serialized identity. `rt daemon track <repo>` (`commands/daemon.ts:448`) currently validates a typed name against the index — change it to resolve the operator's argument (a name or path) to an identity via the index / `deriveRepoIdentity` and store under the identity. Each daemon loop iterates the index (identity keys now) and looks the grant up by the same identity — a one-line change from `.repoName` to the identity key at each of the four sites. `secrets:forge-token` (`handlers/secrets.ts:158`) takes the identity from the payload (gitq sends it — Task 11).

One-shot migration: at the tracking store's first read, re-key legacy name entries to identities using the same resolver as Task 4 (name→path→identity), verify, and rewrite the settings value. A settings write is not kv; use the settings store's write path and re-read to verify.

- [ ] **Step 4: Run tests and gates**

Run: `bun test lib commands packages` and `bun x tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/repo-tracking.ts commands/daemon.ts lib/daemon/freshness.ts lib/daemon/cache-refresh.ts lib/daemon/discussions-poller.ts lib/daemon/project-sync.ts lib/daemon/handlers/secrets.ts lib/daemon/__tests__/repo-tracking.test.ts
git commit -m "feat(tracking): repoTracking grants keyed on identity; re-key once"
```

---

## Task 8: Re-key `run_history` and `endpoint_claims` tables

**Files:**
- Modify: `lib/run-history.ts` (write path already uses `ctx.identity` — switch `.repoName` → `.identity`), `commands/run.ts:889,982,1000` (read/write), `lib/state/*` for the tables; `commands/endpoint.ts:63`, `lib/daemon/handlers/endpoint.ts:45,185`
- Test: `lib/__tests__/run-history.test.ts`, endpoint tests

**Interfaces:**
- Consumes: Task 3 identity; Task 4 `rekeyTableColumn`.
- Produces: `run_history.repo` and `endpoint_claims.repo` hold serialized identities; recents/`rt run again`/port-claims resolve under identity.

- [ ] **Step 1: Write the failing test**

```ts
test("run history is written and read under the repo identity", async () => {
  appendRunHistoryFor("remote:gitlab.com%2Fg%2Fr", { ts: "2026-08-24T00:00:00.000Z", cmd: "bun test" });
  expect(recentsFor("remote:gitlab.com%2Fg%2Fr").map(r => r.cmd)).toContain("bun test");
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test lib/__tests__/run-history.test.ts -t "under the repo identity"`
Expected: FAIL — write keys by name.

- [ ] **Step 3: Implement**

Switch every `ctx.identity.repoName` used as a **key** in these paths to `ctx.identity.identity`. `commands/run.ts:1000` reconciles recents against `getKnownRepos()` names — reconcile against identity instead (the index keys are identities now). Run `rekeyTableColumn("run_history","repo")` and `rekeyTableColumn("endpoint_claims","repo")` once at daemon first read.

- [ ] **Step 4: Run tests and gates**

Run: `bun test lib commands packages` and `bun x tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/run-history.ts commands/run.ts commands/endpoint.ts lib/daemon/handlers/endpoint.ts lib/state/ lib/__tests__/run-history.test.ts
git commit -m "feat(state): run_history and endpoint_claims key on identity"
```

---

## Task 9: Re-key the MR/discussion caches and `branch_cache`

**Files:**
- Modify: `lib/state/branch-cache.ts`, `lib/state/db.ts:76-116` (the `repo` columns are opaque — no schema change, only the values written), `lib/daemon/project-sync.ts`, `lib/daemon/discussions-poller.ts`, `lib/worktree/dispose.ts:144`, and the IPC read handlers for `project-mrs:read` / `discussions:read`
- Test: `lib/state/__tests__/branch-cache.test.ts`, project-sync/dispose tests

**Interfaces:**
- Consumes: Task 3 identity; Task 4 `rekeyTableColumn`.
- Produces: `branch_cache.repo`, `project_mrs`/`_meta`/`_demands`.repo, `discussions.repo` hold identities; the dispose squash-merge anchor and discussions gate compare identities.

- [ ] **Step 1: Write the failing test**

```ts
test("dispose finds a merged tree's MR anchor when branch_cache is keyed by identity", async () => {
  seedBranchCache({ repo: "remote:gitlab.com%2Fg%2Fr", branch: "feature/x", mr: 42 });
  const anchor = disposeAnchorFor("remote:gitlab.com%2Fg%2Fr", "feature/x");
  expect(anchor?.mr).toBe(42);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test lib/worktree/__tests__/dispose.test.ts -t "MR anchor"`
Expected: FAIL — attribution compares names.

- [ ] **Step 3: Implement**

Writers (`project-sync`, `cache-refresh`, `discussions-poller`) iterate the index — write the identity key. `dispose.ts:144` compares `entry.repoName` to `deps.repoName`; change both to the identity (the handler passes the CLI's serialized identity, the cache row now stores identity). The `project-mrs:read`/`discussions:read` IPC handlers take the identity from the payload (board/mr-board send it — Task 12). Run `rekeyTableColumn` once for each of `branch_cache`, `project_mrs`, `project_mrs_meta`, `project_mr_demands`, `discussions` at daemon first read.

- [ ] **Step 4: Run tests and gates**

Run: `bun test lib commands packages` and `bun x tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/state/ lib/daemon/project-sync.ts lib/daemon/discussions-poller.ts lib/worktree/dispose.ts lib/daemon/handlers/ lib/state/__tests__/ lib/worktree/__tests__/
git commit -m "feat(state): MR caches, discussions and branch_cache key on identity"
```

---

## Task 10: Daemon verbs reject bare names (hard cutover) and run the migration once

**Files:**
- Modify: the repo-keyed IPC handlers (`project-mrs:read`, `discussions:read`, `secrets:forge-token`, `mr:by-branch`, `runs:list/get/abandon`) to `parseIdentity` the payload's repo field and refuse a value that isn't a serialized identity
- Modify: the daemon boot path — run every `rekeyKvNamespace`/`rekeyTableColumn` once, guarded so it drains only when a legacy key is present
- Test: daemon handler tests

**Interfaces:**
- Consumes: Tasks 4–9.
- Produces: the daemon speaks identity only; a name payload resolves nothing (no crash).

- [ ] **Step 1: Write the failing test**

```ts
test("a repo-keyed verb rejects a bare legacy name and returns an empty result", async () => {
  const res = await handleProjectMrsRead({ repoName: "repo-tools" }); // a name, not an identity
  expect(res.mrs).toEqual([]);
});
test("the same verb resolves under a serialized identity", async () => {
  seedProjectMrs("remote:gitlab.com%2Fg%2Fr", [{ iid: 1 }]);
  const res = await handleProjectMrsRead({ repoName: "remote:gitlab.com%2Fg%2Fr" });
  expect(res.mrs.length).toBe(1);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test lib/daemon/__tests__/ -t "rejects a bare legacy name"`
Expected: FAIL — handler still name-matches.

- [ ] **Step 3: Implement**

At each repo-keyed handler, `if (parseIdentity(payload.repoName) === null) return <empty result>` before touching the store. Add a daemon-boot migration runner that calls the Task 4–9 re-key functions once, over the full set: kv namespaces `worktree-registry` and `events-cursor`; the `rt.repoTracking` settings map; and table columns `run_history.repo`, `endpoint_claims.repo`, `branch_cache.repo`, `project_mrs.repo`, `project_mrs_meta.repo`, `project_mr_demands.repo`, `discussions.repo`. Guard each with "namespace/table has at least one non-identity key" so a fully-migrated db does no work. Idempotent by construction (an identity key is skipped). `events-cursor` is included for uniformity only — it is self-consistent today (daemon writes and reads it under the index key), so a missed row costs a one-time watcher cold-start, not a correctness failure.

- [ ] **Step 4: Run tests and gates**

Run: `bun test lib commands packages` and `bun x tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/daemon/ lib/daemon/__tests__/
git commit -m "feat(daemon): identity-only verbs and one-shot boot migration"
```

---

## Task 11: gitq adopts identity (published consumer, loud break)

**Files (in `~/Documents/GitHub/gitq`):**
- Modify: `package.json` (`@mattstack/rt-client` → `^0.4.0`), `src/core/secrets.ts:67`, `src/server/data.ts:254-255`
- Test: gitq's own suite

**Interfaces:**
- Consumes: rt-client 0.4.0 — `deriveRepoIdentity` (now returns `RepoIdentity`), `serializeIdentity`.
- Produces: gitq sends the daemon a serialized identity for `secrets:forge-token` and `mr:by-branch`.

- [ ] **Step 1: Bump and reinstall**

In `gitq/package.json` set `"@mattstack/rt-client": "^0.4.0"`; `bun install`. `tsc` now errors where `repoNameForPath`'s value fed a daemon call — that is the intended loud break.

- [ ] **Step 2: Write the failing test**

```ts
test("forge-token resolution sends a serialized identity, not a name", async () => {
  const sent = captureDaemonPayload();
  await resolveForge({ repoPath: fixtureRepoWithRemote() });
  expect(sent.repoName).toMatch(/^remote:/);
});
```

- [ ] **Step 3: Implement**

Replace `repoNameForPath(path)` at both sites with `serializeIdentity(await deriveRepoIdentity(path))`, and pass that as the daemon payload's repo field. `repoNameForPath` is no longer the right call — it answered path→name; the daemon now wants path→identity.

- [ ] **Step 4: Run gates**

Run (in gitq): `bun run test && bun run check-types`
Expected: PASS.

- [ ] **Step 5: Commit (in gitq)**

```bash
git add package.json bun.lock src/core/secrets.ts src/server/data.ts
git commit -m "feat!: send rt repo identity, not name, to daemon verbs (rt-client 0.4)"
```

---

## Task 12: board / mr-board / fork adopt identity config

**Files (in `~/Documents/GitHub/board`, `mr-board`, `mr-board-wt-invite-onboarding`):**
- Modify: `package.json` (published pins → `^0.4.0`; the fork is file-dep, just reinstall), `src/config.ts` (config values become `host/path`), `src/server.ts` (encode at the daemon boundary)
- One-time: rewrite the operator's existing `config.rtRepos` name values to `host/path`
- Test: each repo's suite

**Interfaces:**
- Consumes: rt-client 0.4.0 — `normalizeRemote`, `serializeIdentity`, `resolveNameToIdentity` (one-shot).
- Produces: board sends `project-mrs:read`/`discussions:read` a serialized identity.

- [ ] **Step 1: Bump/reinstall each repo**

board & mr-board: `"@mattstack/rt-client": "^0.4.0"` then `bun install`. The fork: `bun install` (file-dep picks up 0.4.0).

- [ ] **Step 2: Write the failing test (board)**

```ts
test("a host/path config value is sent to the daemon as a serialized identity", () => {
  const payload = daemonRepoField({ rtRepos: { "/proj": "gitlab.com/group/repo" } }, "/proj");
  expect(payload).toBe("remote:gitlab.com%2Fgroup%2Frepo");
});
```

- [ ] **Step 3: Implement**

In `src/config.ts`, stop treating `rtRepos[path]` as an rt name; treat it as a `host/path` string. At the call sites in `src/server.ts` that pass it to `readProjectMRs`/`readDiscussions`, wrap it: `serializeIdentity(identityFromRemote(value) ?? …)`. Since a config value is already `host/path` (not a full remote URL), add a tiny adapter: `{ kind: "remote", id: value }` when it matches `host/path` shape, serialized. (If you prefer the operator to paste a full remote URL, normalize it first with `normalizeRemote`.)

- [ ] **Step 4: One-time config rewrite**

For the operator's existing config on this machine, rewrite each `rtRepos` value from an rt name to `host/path` using `resolveNameToIdentity(name, reposJsonPath)` → the `remote` id (or the printed identity for a `path` repo). This is a one-shot edit of the real config file, done by the orchestrator, not code that ships.

- [ ] **Step 5: Run gates (each repo)**

Run: that repo's `bun run test` / type-check.
Expected: PASS.

- [ ] **Step 6: Commit (each repo)**

```bash
git commit -am "feat!: rtRepos config values are host/path identities (rt-client 0.4)"
```

---

## Task 13: console encodes identity at the daemon boundary

**Files (in `~/Documents/GitHub/console`):**
- Modify: `src/server/runs.ts:18-90` (send the daemon a serialized identity), confirm `src/app/routes.ts:15` route survives an encoded segment
- Test: console's suite

**Interfaces:**
- Consumes: rt-client 0.4.0 (file-dep — reinstall). The daemon's `RunSummary.repo` is now a serialized identity string.
- Produces: console round-trips the identity through `/runs/:repo/:runId` without route breakage.

- [ ] **Step 1: Reinstall**

In console: `bun install` (file-dep picks up 0.4.0).

- [ ] **Step 2: Write the failing test**

```ts
test("a serialized identity round-trips through the runs route without breaking on a slash", () => {
  const repo = "remote:gitlab.com%2Fg%2Fr";
  const match = matchPath("/runs/:repo/:runId", `/runs/${repo}/run-7`);
  expect(match?.params.repo).toBe(repo);
});
```

- [ ] **Step 3: Implement**

The daemon already sends `RunSummary.repo` as the serialized identity (Task 10 makes `runs:*` identity-keyed). Because the identity is percent-encoded and slash-free, `matchPath('/runs/:repo/:runId', …)` matches it as one segment with no change. Verify `listRuns(repo)`/`getRun(runId, repo)`/`abandonRun(runId, repo, …)` pass the identity through unchanged; console never decodes it for a lookup, only for display (decode with `parseIdentity` where it shows a human-readable name).

- [ ] **Step 4: Run gates**

Run (in console): its `test` + type-check.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git commit -am "feat: runs repo field is an rt identity; route handles the encoded segment"
```

---

## Task 14: Land — publish rt-client, verify the estate on a real re-key

**Files:** none new — this is the cutover sequence and its live verification (orchestrator-only, per the operating rules).

- [ ] **Step 1: Publish rt-client 0.4.0**

From `packages/rt-client`: the repo's own publish path (`npm publish` per its scripts). This is what the `^0.4.0`-pinned consumers resolve against.

- [ ] **Step 2: Rebuild + restart the daemon under the normal dev-mode path**

Sync the shared checkout to the merged branch and restart the daemon (`launchctl kickstart -k`) — never a second competing instance. The boot migration (Task 10) runs on first read.

- [ ] **Step 3: Live verify against the real machine (orchestrator-only)**

Under the developer's real state, confirm on this machine's already-split `repo-tools`/`rt` pair: after the daemon migrates, the index, worktree registry, run history, and any tracking grant resolve under one serialized identity; `rt repos prune` reports nothing to strand; the daemon reconciles the repo (registry non-empty under the identity). This is the RT-60-class check — assert the specific rows, not "the whole run passes."

- [ ] **Step 4: Confirm each consumer end to end**

gitq resolves a forge token; board lists MRs; console opens a run URL. Each proves its own re-keyed path against the live daemon.

---

## Not in this plan

- Giving the settings resolver a `path`-scoped section (origin-less repos remain settings-global, as today).
- A repo-rename *command*. This makes rename non-destructive; it does not add a verb to perform one.
- The filesystem-path-origin `origin`/`unknown` name collapse (RT-62 medium finding) beyond what the identity change fixes: with identity derived from `normalizeRemote`, a local-path remote yields a `path`-kind identity keyed on realpath, so two such repos no longer collide on the name `origin`. No separate task needed; note it in the Task 3 test that a local-path remote produces a `path` identity, not `remote:origin`.
