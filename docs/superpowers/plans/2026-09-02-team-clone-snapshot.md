# Team Clone Snapshot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The daemon auto-commits, pushes and pulls every `~/.mattstack/teams/<slug>` clone the way it already snapshots the home repo, so a joiner's recipient, roster, secrets and tracking propagate with no hand git.

**Architecture:** `lib/daemon/home-snapshot.ts` becomes a spec-driven engine (`startSnapshot(spec, deps)`); the home call site builds today's values as a spec and stays behavior-identical. A team spec adds a path scope, a token source and a pull stage (fetch, ff or rebase, conflict abort + marker). A supervisor discovers team clones and runs one engine instance each. A `team.sync` checklist row, `rt team pull`, and richer `rt team status` expose it; Install's `verify` waits for the first pull.

**Tech Stack:** Bun/TypeScript, the daemon's injected exec/watch/timer seams, `bun:sqlite` kv via `lib/state`, `bun test` with the fake exec/timer/watch doubles in `lib/daemon/__tests__/home-snapshot.test.ts`.

**Spec:** `docs/superpowers/specs/2026-09-02-team-clone-snapshot-design.md`

## Global Constraints

- Every git call on a team clone that touches the remote (fetch, push) goes through `gitWithToken` from `lib/team/git-credential.ts` with the token from `lib/team/stored-forge-token.ts`: env only, never argv, never the URL.
- A team spec stages only paths under `mattstack/`, `.sops.yaml`, `.claude-plugin/`; nothing else in a team clone is ever auto-committed.
- A rebase conflict is aborted and surfaced (`team:conflict`, kv marker, `team.sync` row); neither side is discarded.
- The home instance's behavior is what it is today: no new git calls, no env change on its push (the token path applies only to specs with `tokenFor`). The refactor commit must pass the existing `home-snapshot.test.ts` with no assertion changed; typed test literals elsewhere may gain the new `SnapshotStatus`/handle fields (listed per task).
- Daemon error envelopes are `{ ok: false, error: <message string>, failure: { code, message } }` (lib/daemon.ts:167); never `error: { code, message }`.
- `daemonQuery` (lib/daemon-client.ts) returns `null` when the daemon is unreachable; every CLI caller handles `!res` before reading `res.ok`.
- Pull cadence: `rt.teamSnapshot.pullIntervalSec` default 300; a pull precedes every push and runs once at boot.
- No `execSync` on the daemon thread; all git through the injected `exec` (default `runCapture`).
- Feature code logs domain events only (`log.info` on commit/pull/conflict); outcomes are logged at the daemon seams.
- Comments state constraints the code cannot show; no narration, no ticket numbers in source.
- Commit after every task; run `bun run test` + `bun x tsc --noEmit` + `bun run docs:check` before pushing to main; tsc must print no errors.

---

## File structure

| File | Responsibility |
|---|---|
| `lib/daemon/home-snapshot.ts` | The engine. Exports `startSnapshot(spec, deps)`, `homeSnapshotSpec()`, `teamSnapshotSpec(slug, dir, opts)`, `SnapshotSpec`, and keeps `startHomeSnapshot(deps)` as a thin wrapper (Task 1). Pull stage added in Task 3. |
| `lib/daemon/home-snapshot-plan.ts` | Unchanged planning; Task 2 adds `scopeEntries(entries, scope)`. |
| `lib/daemon/team-snapshots.ts` | Supervisor: discovers clones under `teams/`, one engine instance each, aggregate `status()`, `pullNow(slug)`. |
| `lib/daemon/handlers/team-snapshot.ts` | Daemon verbs `team:snapshot-status`, `team:pull`. |
| `lib/setup/validators/rt-health.ts` | `teamSyncRow()` beside `homeBackupRow()`. |
| `lib/setup/steps/verify.ts` | `team.sync` joins the settling rows. |
| `commands/team.ts` | `rt team pull`; `rt team status` gains `lastPull`, `lastPushAt`, `conflicted`. |
| `lib/command-tree-def.ts` | `team pull` leaf. |
| `packages/rt-client/src/settings/registry-defs.ts` | `rt.teamSnapshot` row. |
| `rt-tray/vm/run/host/team-propagate.sh` | Drops the two hand steps; asserts the daemon did them. |

---

### Task 1: Spec-driven engine (pure refactor, behavior-preserving)

**Files:**
- Modify: `lib/daemon/home-snapshot.ts`, `lib/home/push-record.ts`
- Modify: `lib/daemon/__tests__/home-snapshot.test.ts` (new describe block only)
- Modify (typed literals gain `id`): `lib/daemon/__tests__/home-handlers.test.ts`, `commands/__tests__/home.test.ts` (~line 1619 `okStatus: SnapshotStatus`)
- Test: `lib/daemon/__tests__/home-snapshot.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface SnapshotSpec {
    id: string;
    repoDir: string;
    kvNamespace: string;
    eventPrefix: "home" | "team";
    scope?: (relPath: string) => boolean;
    pull?: { intervalSec: number };
    tokenFor?: () => Promise<string | null>;
    /** Home only: the retired pre-kv state file to import once. */
    legacyStatePath?: string;
  }
  export function homeSnapshotSpec(repoDir?: string): SnapshotSpec;
  export function startSnapshot(spec: SnapshotSpec, deps: SnapshotDeps): SnapshotHandle;
  export function startHomeSnapshot(deps: HomeSnapshotDeps): HomeSnapshotHandle; // wrapper, unchanged signature
  ```
  `SnapshotDeps` = today's `HomeSnapshotDeps` minus `repoDir` (the spec carries it). `HomeSnapshotDeps`/`HomeSnapshotHandle`/`SnapshotStatus` stay exported under their current names; `SnapshotStatus` gains `id: string`.

- [ ] **Step 1: Add the spec test to the existing suite (RED)**

Append to `lib/daemon/__tests__/home-snapshot.test.ts`:

```ts
import { homeSnapshotSpec, startSnapshot } from "../home-snapshot.ts";

describe("startSnapshot — spec", () => {
  test("homeSnapshotSpec is today's home values, and startSnapshot(homeSpec) equals startHomeSnapshot", async () => {
    const spec = homeSnapshotSpec(FAKE_REPO_DIR);
    expect(spec).toMatchObject({ id: "home", repoDir: FAKE_REPO_DIR, kvNamespace: "home-snapshot", eventPrefix: "home" });
    expect(spec.scope).toBeUndefined();
    expect(spec.pull).toBeUndefined();
    expect(spec.tokenFor).toBeUndefined();

    const { fn } = makeFakeExec(defaultResponders({ statusZ: "?? a.txt\0" }));
    const { deps, broadcasts } = baseDeps({ exec: fn });
    const { repoDir: _repoDir, ...specDeps } = deps;
    const handle = startSnapshot(spec, specDeps);
    await handle.ready;
    const result = await handle.runNow("manual");
    expect(result.committed).toBe(true);
    expect(broadcasts[0]?.type).toBe("home:snapshot");
    expect(handle.status().id).toBe("home");
    handle.stop();
  });

  test("a spec's eventPrefix and kvNamespace name the broadcasts and the kv rows", async () => {
    const { fn } = makeFakeExec(defaultResponders({ statusZ: "?? a.txt\0" }));
    const { deps, broadcasts } = baseDeps({ exec: fn });
    const { repoDir: _repoDir, ...specDeps } = deps;
    const spec = { ...homeSnapshotSpec(FAKE_REPO_DIR), id: "team:acme", kvNamespace: "team-snapshot:acme", eventPrefix: "team" as const };
    const handle = startSnapshot(spec, specDeps);
    await handle.ready;
    await handle.runNow("manual");
    expect(broadcasts[0]?.type).toBe("team:snapshot");
    expect(getKvValue("team-snapshot:acme", "state", null, deps.db!)).not.toBeNull();
    handle.stop();
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `bun test lib/daemon/__tests__/home-snapshot.test.ts -t "startSnapshot — spec"`
Expected: FAIL, `homeSnapshotSpec` is not exported.

- [ ] **Step 3: Refactor the engine around a spec**

In `lib/daemon/home-snapshot.ts`:

```ts
export interface SnapshotSpec {
  id: string;
  repoDir: string;
  kvNamespace: string;
  eventPrefix: "home" | "team";
  /** Paths (relative to repoDir) the engine may stage; undefined = everything outside claimed zones. */
  scope?: (relPath: string) => boolean;
  /** Fetch + rebase policy; absent = never pull (the home repo is single-writer). */
  pull?: { intervalSec: number };
  /** The forge token rt holds for origin; absent = git's own credentials. */
  tokenFor?: () => Promise<string | null>;
  /** The retired pre-kv state file to import once; home only. */
  legacyStatePath?: string;
}

export type SnapshotDeps = Omit<HomeSnapshotDeps, "repoDir">;
export type SnapshotHandle = HomeSnapshotHandle;

export function homeSnapshotSpec(repoDir = join(mattstackHome(), "user")): SnapshotSpec {
  return { id: "home", repoDir, kvNamespace: HOME_SNAPSHOT_NS, eventPrefix: "home", legacyStatePath: join(rtDir(), "home-snapshot-state.json") };
}

export function startHomeSnapshot(rawDeps: HomeSnapshotDeps): HomeSnapshotHandle {
  const { repoDir, ...rest } = rawDeps;
  return startSnapshot(homeSnapshotSpec(repoDir), rest);
}

export function startSnapshot(spec: SnapshotSpec, rawDeps: SnapshotDeps): SnapshotHandle {
  // body = today's startHomeSnapshot body with these substitutions
}
```

Substitutions inside the body (mechanical, no behavior change):
- `const repoDir = rawDeps.repoDir ?? join(mattstackHome(), "user")` → `const repoDir = spec.repoDir`.
- `deps.log.warn(..., "home-snapshot: ...")` strings stay literally `home-snapshot:` for now (log text is not a contract); do not rename.
- `deps.broadcast("home:snapshot", ...)` → `deps.broadcast(`${spec.eventPrefix}:snapshot`, ...)`; `"home:push-failed"` → `` `${spec.eventPrefix}:push-failed` ``.
- `loadState`/`persistState`/`persistPushRecord` take `spec` and use `spec.kvNamespace` instead of `HOME_SNAPSHOT_NS`; `legacyStatePath()` becomes `spec.legacyStatePath` and the legacy import runs only when it is set. `recordHomePush(db, record)` gains a namespace parameter: change `lib/home/push-record.ts` to `recordHomePush(db, record, ns = HOME_SNAPSHOT_NS)` and `readHomePushRecord(db?, ns = HOME_SNAPSHOT_NS)`.
- `status()` returns `{ id: spec.id, ...today's fields }`.

- [ ] **Step 4: Run the whole snapshot suite**

Run: `bun test lib/daemon/__tests__/home-snapshot.test.ts lib/daemon/__tests__/home-handlers.test.ts commands/__tests__/home.test.ts lib/home`
Expected: all PASS, including the two new tests; no pre-existing assertion changed. `tsconfig.json` type-checks tests, so add `id: "home"` to the `SnapshotStatus` literals in `home-handlers.test.ts` and `commands/__tests__/home.test.ts`.

- [ ] **Step 5: Typecheck and commit**

Run: `bun x tsc --noEmit` → no errors.

```bash
git add lib/daemon/home-snapshot.ts lib/home/push-record.ts lib/daemon/__tests__/home-snapshot.test.ts lib/daemon/__tests__/home-handlers.test.ts commands/__tests__/home.test.ts
git commit -m "snapshot: the engine takes a spec; the home instance is the same spec it always was"
```

---

### Task 2: Commit scope

**Files:**
- Modify: `lib/daemon/home-snapshot-plan.ts`
- Modify: `lib/daemon/home-snapshot.ts` (add/commit pathspec)
- Test: `lib/daemon/__tests__/home-snapshot-plan.test.ts`, `lib/daemon/__tests__/home-snapshot.test.ts`

**Interfaces:**
- Produces: `export function scopeEntries(entries: StatusEntry[], scope: ((relPath: string) => boolean) | undefined): StatusEntry[]` in `home-snapshot-plan.ts`; `export const TEAM_SCOPE_ROOTS = ["mattstack", ".sops.yaml", ".claude-plugin"] as const` and `export function teamScope(relPath: string): boolean` in `home-snapshot.ts`.

- [ ] **Step 1: Write the failing tests**

In `lib/daemon/__tests__/home-snapshot-plan.test.ts` (create it if absent, beside the existing plan tests; check `ls lib/daemon/__tests__`):

```ts
import { describe, test, expect } from "bun:test";
import { scopeEntries, type StatusEntry } from "../home-snapshot-plan.ts";
import { teamScope } from "../home-snapshot.ts";

describe("scopeEntries", () => {
  const entries: StatusEntry[] = [
    { xy: " M", path: "mattstack/settings.team.jsonc" },
    { xy: "??", path: ".sops.yaml" },
    { xy: " M", path: ".claude-plugin/marketplace.json" },
    { xy: " M", path: "src/index.ts" },
    { xy: "??", path: "docs/plan.md" },
  ];
  test("undefined scope keeps everything", () => {
    expect(scopeEntries(entries, undefined)).toHaveLength(5);
  });
  test("teamScope keeps only the team store, the recipients file and the marketplace", () => {
    expect(scopeEntries(entries, teamScope).map((e) => e.path)).toEqual([
      "mattstack/settings.team.jsonc", ".sops.yaml", ".claude-plugin/marketplace.json",
    ]);
  });
  test("teamScope is prefix-safe: mattstack-tools/ is not mattstack/", () => {
    expect(teamScope("mattstack-tools/x")).toBe(false);
    expect(teamScope("mattstack/secrets/board.json")).toBe(true);
    expect(teamScope(".sops.yaml")).toBe(true);
    expect(teamScope(".sops.yaml.bak")).toBe(false);
  });
});
```

(`StatusEntry` is `{ xy, path, origPath? }` in `home-snapshot-plan.ts`.)

In `lib/daemon/__tests__/home-snapshot.test.ts` add to `describe("startSnapshot — spec")`:

```ts
  test("a scoped spec stages and commits only scoped paths, and the pathspec is exactly those paths", async () => {
    const statusZ = " M mattstack/settings.team.jsonc\0 D .sops.yaml\0 M src/index.ts\0";
    const { fn, calls } = makeFakeExec(defaultResponders({ statusZ }));
    const { deps } = baseDeps({ exec: fn });
    const { repoDir: _repoDir, ...specDeps } = deps;
    const handle = startSnapshot({ ...homeSnapshotSpec(FAKE_REPO_DIR), id: "team:acme", kvNamespace: "team-snapshot:acme", eventPrefix: "team", scope: teamScope }, specDeps);
    await handle.ready;
    const result = await handle.runNow("manual");
    expect(result.paths).toEqual(["mattstack/settings.team.jsonc", ".sops.yaml"]);
    const add = calls.find((c) => gitVerb(c) === "add")!;
    expect(add).toEqual(["git", "add", "-A", "--", "mattstack/settings.team.jsonc", ".sops.yaml"]);
    const commit = calls.find((c) => gitVerb(c) === "commit")!;
    expect(commit.slice(-3)).toEqual(["--", "mattstack/settings.team.jsonc", ".sops.yaml"]);
    handle.stop();
  });
```

- [ ] **Step 2: Run them to see them fail**

Run: `bun test lib/daemon/__tests__/home-snapshot-plan.test.ts lib/daemon/__tests__/home-snapshot.test.ts -t "scope"`
Expected: FAIL, `scopeEntries`/`teamScope` not exported.

- [ ] **Step 3: Implement**

`lib/daemon/home-snapshot-plan.ts`:

```ts
/** Entries a spec may stage; undefined keeps every entry (the home repo's rule is "everything outside claimed zones"). */
export function scopeEntries(entries: StatusEntry[], scope: ((relPath: string) => boolean) | undefined): StatusEntry[] {
  return scope ? entries.filter((e) => scope(e.path)) : entries;
}
```

`lib/daemon/home-snapshot.ts`:

```ts
export const TEAM_SCOPE_ROOTS = ["mattstack", ".sops.yaml", ".claude-plugin"] as const;

/** A team clone can also be a working repo (acme-tools carries src/ and docs/); only the store, the recipients file and the marketplace are the daemon's to commit. */
export function teamScope(relPath: string): boolean {
  return TEAM_SCOPE_ROOTS.some((root) => relPath === root || relPath.startsWith(`${root}/`));
}
```

In `doRun`: `const entries = scopeEntries(parsePorcelainZ(statusResult.stdout), spec.scope);` and build the pathspec once:

```ts
const scopeArgs: string[] = spec.scope ? [...new Set(entries.flatMap((e) => (e.origPath ? [e.origPath, e.path] : [e.path])))] : ["."];
```

then `["git", "add", "-A", "--", ...scopeArgs, ...excludeArgs]` and the commit's trailing `"--", ...scopeArgs, ...excludeArgs`.

A scoped spec's pathspec is the scoped entries' own paths (deduped, in status order), never the roots: `git add -A -- mattstack .sops.yaml .claude-plugin` exits 128 and stages nothing when any root is absent from both tree and index (verified), and a clone that lost its marketplace would then fail every cycle as `add-failed`. Entry paths always match (a ` D` entry names an index path; `??` names a worktree path; a rename carries `origPath`, which rides along so the old path's deletion lands in the same commit). The home spec keeps `.` exactly as today.

- [ ] **Step 4: Run the tests**

Run: `bun test lib/daemon`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/daemon/home-snapshot-plan.ts lib/daemon/home-snapshot.ts lib/daemon/__tests__/home-snapshot-plan.test.ts lib/daemon/__tests__/home-snapshot.test.ts
git commit -m "snapshot: a spec can scope what the engine stages; the team scope is the store, recipients and marketplace"
```

---

### Task 3: Pull stage (fetch, ff or rebase, conflict abort) with the token

**Files:**
- Modify: `lib/daemon/home-snapshot.ts`
- Test: `lib/daemon/__tests__/home-snapshot.test.ts`

**Interfaces:**
- Produces on `SnapshotHandle`: `pullNow(): Promise<PullResult>`; `export type PullResult = { outcome: "up-to-date" | "fast-forwarded" | "rebased" | "conflict" | "skipped"; detail: string | null }`; `SnapshotStatus` gains `lastPullAt: number`, `lastPullError: string | null`, `lastPullSkipped: string | null` (the most recent skip reason, e.g. a rebase refused for a dirty `src/`; null after any non-skipped pull), `conflicted: { at: number; detail: string } | null`. Broadcast `` `${eventPrefix}:conflict` `` `{ id, detail }`. kv key `"conflict"` under `spec.kvNamespace` holding `{ at, detail }`; absent when clear.

- [ ] **Step 1: Write the failing tests**

Add to `lib/daemon/__tests__/home-snapshot.test.ts`:

```ts
function teamSpecFor(tokenValue: string | null = "glpat-team") {
  return {
    ...homeSnapshotSpec(FAKE_REPO_DIR),
    id: "team:acme",
    kvNamespace: "team-snapshot:acme",
    eventPrefix: "team" as const,
    scope: teamScope,
    pull: { intervalSec: 300 },
    tokenFor: async () => tokenValue,
  };
}

/**
 * Responders for the pull stage. `gitVerb` (line ~29 of this file) skips the
 * `-c` pairs `gitWithToken` and the rebase prepend, so `argv[1]` is never the
 * verb here. `ahead`/`behind` are `git rev-list --left-right --count
 * origin/main...HEAD` as "<behind>\t<ahead>". `rebase: "conflict"` makes the
 * rebase exit 1 AND creates `<FAKE_REPO_DIR>/.git/rebase-merge` (the engine
 * classifies by that directory, not by the exit code); `rebase: "refused"`
 * exits 1 with "cannot rebase: You have unstaged changes" and no directory.
 */
function pullResponders(opts: { behind: number; ahead: number; rebase?: "ok" | "conflict" | "refused" }): Responder[] {
  const rebaseDir = join(FAKE_REPO_DIR, ".git", "rebase-merge");
  return [
    (argv) => gitVerb(argv) === "fetch" ? { stdout: "", stderr: "", exitCode: 0 } : undefined,
    (argv) => gitVerb(argv) === "symbolic-ref" ? { stdout: "main\n", stderr: "", exitCode: 0 } : undefined,
    (argv) => gitVerb(argv) === "rev-list" && argv.includes("--left-right") ? { stdout: `${opts.behind}\t${opts.ahead}\n`, stderr: "", exitCode: 0 } : undefined,
    (argv) => gitVerb(argv) === "rev-parse" && argv.includes("--git-dir") ? { stdout: ".git\n", stderr: "", exitCode: 0 } : undefined,
    (argv) => gitVerb(argv) === "merge" && argv.includes("--ff-only") ? { stdout: "", stderr: "", exitCode: 0 } : undefined,
    (argv) => {
      if (gitVerb(argv) !== "rebase" || argv.includes("--abort")) return undefined;
      if (opts.rebase === "conflict") { mkdirSync(rebaseDir, { recursive: true }); return { stdout: "", stderr: "CONFLICT (content): mattstack/settings.team.jsonc", exitCode: 1 }; }
      if (opts.rebase === "refused") return { stdout: "", stderr: "error: cannot rebase: You have unstaged changes.", exitCode: 1 };
      return { stdout: "", stderr: "", exitCode: 0 };
    },
    (argv) => gitVerb(argv) === "rebase" && argv.includes("--abort") ? (rmSync(rebaseDir, { recursive: true, force: true }), { stdout: "", stderr: "", exitCode: 0 }) : undefined,
  ];
}

describe("startSnapshot — pull", () => {
  test("fetch and push carry the token through the env, never argv", async () => {
    const { fn, calls, optsLog } = makeFakeExec([...pullResponders({ behind: 0, ahead: 0 }), ...defaultResponders()]);
    const { deps } = baseDeps({ exec: fn });
    const { repoDir: _r, ...specDeps } = deps;
    const handle = startSnapshot(teamSpecFor("glpat-team"), specDeps);
    await handle.ready;
    await handle.pullNow();
    const i = calls.findIndex((c) => gitVerb(c) === "fetch");
    expect(calls[i]).toContain("credential.helper=");
    expect(calls[i]!.join(" ")).not.toContain("glpat-team");
    expect((optsLog[i] as { env?: Record<string, string> }).env?.RT_GIT_TOKEN).toBe("glpat-team");
    handle.stop();
  });

  test("behind only: fast-forward; ahead only: nothing to pull; both: rebase", async () => {
    for (const [behind, ahead, expected] of [[1, 0, "fast-forwarded"], [0, 1, "up-to-date"], [1, 1, "rebased"], [0, 0, "up-to-date"]] as const) {
      const { fn, calls } = makeFakeExec([...pullResponders({ behind, ahead }), ...defaultResponders()]);
      const { deps } = baseDeps({ exec: fn });
      const { repoDir: _r, ...specDeps } = deps;
      const handle = startSnapshot(teamSpecFor(), specDeps);
      await handle.ready;
      expect((await handle.pullNow()).outcome).toBe(expected);
      expect(calls.some((c) => gitVerb(c) === "merge")).toBe(expected === "fast-forwarded");
      expect(calls.some((c) => gitVerb(c) === "rebase")).toBe(expected === "rebased");
      handle.stop();
    }
  });

  test("a rebase refused for unstaged out-of-scope changes is skipped with the reason, never a conflict", async () => {
    const { fn } = makeFakeExec([...pullResponders({ behind: 1, ahead: 1, rebase: "refused" }), ...defaultResponders()]);
    const { deps, broadcasts } = baseDeps({ exec: fn });
    const { repoDir: _r, ...specDeps } = deps;
    const handle = startSnapshot(teamSpecFor(), specDeps);
    await handle.ready;
    const result = await handle.pullNow();
    expect(result.outcome).toBe("skipped");
    expect(result.detail).toContain("unstaged");
    expect(handle.status().lastPullSkipped).toContain("unstaged");
    expect(handle.status().conflicted).toBeNull();
    expect(broadcasts.some((b) => b.type === "team:conflict")).toBe(false);
    handle.stop();
  });

  test("a rebase conflict aborts, persists the marker, broadcasts once, suspends push and pull until it clears", async () => {
    const exec = makeSwitchableExec([...pullResponders({ behind: 1, ahead: 1, rebase: "conflict" }), ...defaultResponders()]);
    const { deps, broadcasts } = baseDeps({ exec: exec.fn });
    const { repoDir: _r, ...specDeps } = deps;
    const handle = startSnapshot(teamSpecFor(), specDeps);
    await handle.ready;

    const first = await handle.pullNow();
    expect(first.outcome).toBe("conflict");
    expect(exec.calls.some((c) => gitVerb(c) === "rebase" && c.includes("--abort"))).toBe(true);
    expect(handle.status().conflicted?.detail).toContain("settings.team.jsonc");
    expect(getKvValue("team-snapshot:acme", "conflict", null, deps.db!)).not.toBeNull();
    expect(broadcasts.filter((b) => b.type === "team:conflict")).toHaveLength(1);

    const pushesBefore = exec.calls.filter((c) => gitVerb(c) === "push").length;
    await handle.runNow("manual");
    expect(exec.calls.filter((c) => gitVerb(c) === "push").length).toBe(pushesBefore);
    expect((await handle.pullNow()).outcome).toBe("skipped");
    expect(broadcasts.filter((b) => b.type === "team:conflict")).toHaveLength(1);

    exec.setResponders([...pullResponders({ behind: 0, ahead: 0 }), ...defaultResponders()]);
    expect((await handle.pullNow()).outcome).toBe("up-to-date");
    expect(handle.status().conflicted).toBeNull();
    expect(getKvValue("team-snapshot:acme", "conflict", null, deps.db!)).toBeNull();
    handle.stop();
  });

  test("a push is preceded by a pull, and a non-fast-forward rejection pulls and retries once", async () => {
    let pushes = 0;
    const responders: Responder[] = [
      ...pullResponders({ behind: 0, ahead: 1 }),
      (argv) => gitVerb(argv) === "push" ? (++pushes === 1
        ? { stdout: "", stderr: "! [rejected] main -> main (fetch first)", exitCode: 1 }
        : { stdout: "", stderr: "", exitCode: 0 }) : undefined,
      ...defaultResponders({ statusZ: " M mattstack/settings.team.jsonc\0" }),
    ];
    const { fn, calls } = makeFakeExec(responders);
    const { deps, timers } = baseDeps({ exec: fn });
    const { repoDir: _r, ...specDeps } = deps;
    const handle = startSnapshot(teamSpecFor(), specDeps);
    await handle.ready;
    await handle.runNow("manual");
    timers.fire(() => true);
    await flushAsync();
    const order = calls.map((c) => gitVerb(c)).filter((v) => v === "fetch" || v === "push");
    expect(order[0]).toBe("fetch");
    expect(pushes).toBe(2);
    expect(handle.status().pushPending).toBe(false);
    handle.stop();
  });

  test("a failed fetch leaves lastPullAt untouched and records the error, so the row can call the clone stale", async () => {
    const responders: Responder[] = [
      // First responder wins: this must precede pullResponders' own fetch answer.
      (argv) => gitVerb(argv) === "fetch" ? { stdout: "", stderr: "remote: HTTP Basic: Access denied", exitCode: 128 } : undefined,
      ...pullResponders({ behind: 0, ahead: 0 }),
      ...defaultResponders(),
    ];
    const { fn } = makeFakeExec(responders);
    const { deps } = baseDeps({ exec: fn });
    const { repoDir: _r, ...specDeps } = deps;
    const handle = startSnapshot(teamSpecFor(), specDeps);
    await handle.ready;
    const result = await handle.pullNow();
    expect(result.outcome).toBe("skipped");
    expect(handle.status().lastPullAt).toBe(0);
    expect(handle.status().lastPullError).toContain("Access denied");
    handle.stop();
  });

  test("the pull timer fires every pullIntervalSec and at boot", async () => {
    const { fn, calls } = makeFakeExec([...pullResponders({ behind: 0, ahead: 0 }), ...defaultResponders()]);
    const { deps, timers } = baseDeps({ exec: fn });
    const { repoDir: _r, ...specDeps } = deps;
    const handle = startSnapshot(teamSpecFor(), specDeps);
    await handle.ready;
    await flushAsync();
    expect(calls.filter((c) => gitVerb(c) === "fetch")).toHaveLength(1);
    expect([...timers.pending.values()].some((t) => t.ms === 300_000)).toBe(true);
    handle.stop();
  });

  test("the home spec never pulls", async () => {
    const { deps, execCalls } = baseDeps();
    const { repoDir: _r, ...specDeps } = deps;
    const handle = startSnapshot(homeSnapshotSpec(FAKE_REPO_DIR), specDeps);
    await handle.ready;
    expect((await handle.pullNow()).outcome).toBe("skipped");
    expect(execCalls.some((c) => gitVerb(c) === "fetch")).toBe(false);
    handle.stop();
  });
});
```

`makeFakeTimers()` (line ~136 of the test file) returns `{ setTimeoutFn, clearTimeoutFn, pending, fire }`: `pending` is a `Map<number, { cb, ms }>` and `fire(predicate)` runs the matching timers; the snippets above use exactly those. `FAKE_REPO_DIR` is a real temp dir, so the conflict responder can create `.git/rebase-merge` under it; add `rmSync(join(FAKE_REPO_DIR, ".git", "rebase-merge"), { recursive: true, force: true })` at the top of each pull test.

- [ ] **Step 2: Run them to see them fail**

Run: `bun test lib/daemon/__tests__/home-snapshot.test.ts -t "startSnapshot — pull"`
Expected: FAIL, `pullNow` is not a function.

- [ ] **Step 3: Implement the pull stage**

In `lib/daemon/home-snapshot.ts`:

```ts
import { gitWithToken } from "../team/git-credential.ts";

export interface PullResult { outcome: "up-to-date" | "fast-forwarded" | "rebased" | "conflict" | "skipped"; detail: string | null }
const CONFLICT_KEY = "conflict";
const FETCH_TIMEOUT_MS = 30_000;
```

State inside `startSnapshot`: `let lastPullAt = 0; let lastPullError: string | null = null; let lastPullSkipped: string | null = null; let conflicted: { at: number; detail: string } | null = null; let pullTimer = null; let pullInFlight: Promise<PullResult> | null = null; let cachedToken: { value: string | null; at: number } | null = null;`. In `init()`, after `loadState`, load the conflict marker: `conflicted = getKvValue(spec.kvNamespace, CONFLICT_KEY, null, resolveDb())`. If `spec.pull` and enabled: `void pullNow()` then `schedulePull()`.

One git operation at a time per clone:

```ts
let gitLock: Promise<unknown> = Promise.resolve();
/** Serializes the commit cycle and the pull; a timer-driven rebase never overlaps an add/commit. Push stays OUTSIDE the lock: it calls pullNow(), which takes the lock itself, so a push inside it would wait on itself. */
function withGitLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = gitLock.then(fn, fn);
  gitLock = run.catch(() => undefined);
  return run;
}
```

`runNow` wraps `doRun(reason)` in `withGitLock`; `pullNow` wraps `doPull()` in it; the existing `runInFlight`/`pushInFlight` coalescing stays as is on top. `doPushInner` calls `pullNow()` (which locks), never `doPull()` directly, and is itself never placed inside the lock.

```ts
/** `runCapture` REPLACES the child's environment when `env` is given (lib/subprocess.ts:60), so the token vars ride on top of a full copy of process.env or git loses PATH and HOME. A spec without `tokenFor` (home) keeps today's plain exec, env untouched. The token is read once per pull interval, not per git call: `storedForgeToken` is a keychain read plus a sops decrypt. */
async function remoteGit(args: string[], timeoutMs: number): Promise<RunResult> {
  if (!spec.tokenFor) return deps.exec(["git", ...args] as [string, ...string[]], { cwd: spec.repoDir, timeoutMs, stderr: "pipe" });
  const ttlMs = (spec.pull?.intervalSec ?? 300) * 1000;
  if (!cachedToken || deps.now() - cachedToken.at > ttlMs) cachedToken = { value: await spec.tokenFor(), at: deps.now() };
  const cmd = gitWithToken(args, cachedToken.value, { ...(process.env as Record<string, string>), GIT_TERMINAL_PROMPT: "0" });
  return deps.exec(cmd.argv as [string, ...string[]], { cwd: spec.repoDir, timeoutMs, stderr: "pipe", env: cmd.env });
}
```

`ExecFn`'s opts type gains `env?: Record<string, string>`; `runCapture` already accepts `env` (it replaces, see the comment above).

```ts
function schedulePull(): void {
  if (!spec.pull || stopped) return;
  if (pullTimer) deps.clearTimeout(pullTimer);
  pullTimer = deps.setTimeout(() => {
    pullTimer = null;
    void pullNow().finally(() => { if (!stopped) schedulePull(); });
  }, spec.pull.intervalSec * 1000);
}

async function pullNow(): Promise<PullResult> {
  await readyPromise;
  if (!spec.pull || disabledReason || safeReadSettings().enabled === false) return { outcome: "skipped", detail: "pull not enabled for this repo" };
  if (pullInFlight) return pullInFlight;
  const p = doPull();
  pullInFlight = p;
  try { return await p; } finally { pullInFlight = null; }
}

async function doPull(): Promise<PullResult> {
  if (!(await hasRemote(deps.exec, spec.repoDir))) return { outcome: "skipped", detail: "no remote" };
  const branchResult = await deps.exec(["git", "symbolic-ref", "--short", "HEAD"], { cwd: spec.repoDir, timeoutMs: GIT_TIMEOUT_MS, stderr: "pipe" });
  if (branchResult.exitCode !== 0) return { outcome: "skipped", detail: "detached HEAD" };
  const branch = branchResult.stdout.trim();
  const fetch = await remoteGit(["fetch", "-q", "origin", branch], FETCH_TIMEOUT_MS);
  if (fetch.exitCode !== 0) {
    lastPullError = redactCredentials(fetch.stderr);
    return { outcome: "skipped", detail: lastPullError };
  }
  // Stamped only here: a pull that never reached the remote must read as stale, or a joiner with a bad token would look in sync.
  lastPullAt = deps.now();
  lastPullError = null;
  const counts = await deps.exec(["git", "rev-list", "--left-right", "--count", `refs/remotes/origin/${branch}...HEAD`], { cwd: spec.repoDir, timeoutMs: GIT_TIMEOUT_MS, stderr: "pipe" });
  if (counts.exitCode !== 0) return { outcome: "skipped", detail: "no remote-tracking ref yet" };
  const [behind, ahead] = counts.stdout.trim().split(/\s+/).map(Number);
  // A conflict marker clears itself only once local is no longer ahead: the human's rebase or reset happened.
  if (conflicted && ahead === 0) clearConflict();
  if (conflicted) return { outcome: "skipped", detail: conflicted.detail };
  if (behind === 0) return { outcome: "up-to-date", detail: null };
  if (ahead === 0) {
    const ff = await deps.exec(["git", "merge", "-q", "--ff-only", `refs/remotes/origin/${branch}`], { cwd: spec.repoDir, timeoutMs: GIT_TIMEOUT_MS, stderr: "pipe" });
    if (ff.exitCode !== 0) return { outcome: "skipped", detail: redactCredentials(ff.stderr) };
    deps.log.info({ id: spec.id, behind }, "snapshot: fast-forwarded");
    return { outcome: "fast-forwarded", detail: null };
  }
  const rebase = await deps.exec(["git", "-c", "commit.gpgsign=false", "rebase", "-q", `refs/remotes/origin/${branch}`], { cwd: spec.repoDir, timeoutMs: GIT_TIMEOUT_MS, stderr: "pipe" });
  if (rebase.exitCode === 0) {
    deps.log.info({ id: spec.id, behind, ahead }, "snapshot: rebased");
    return { outcome: "rebased", detail: null };
  }
  // A rebase that never started (unstaged changes outside the scope, a lock) exits 1 too, but leaves no rebase-merge/rebase-apply behind; only a rebase that stopped mid-way is a conflict.
  const gitDir = await resolveGitDir();
  const rebaseStopped = existsSync(join(gitDir, "rebase-merge")) || existsSync(join(gitDir, "rebase-apply"));
  if (!rebaseStopped) {
    const reason = redactCredentials(rebase.stderr.trim() || "rebase refused");
    deps.log.warn({ id: spec.id, reason }, "snapshot: rebase refused; will retry next tick");
    return { outcome: "skipped", detail: reason };
  }
  await deps.exec(["git", "rebase", "--abort"], { cwd: spec.repoDir, timeoutMs: GIT_TIMEOUT_MS, stderr: "pipe" });
  const detail = redactCredentials(rebase.stderr.trim() || "rebase stopped");
  conflicted = { at: deps.now(), detail };
  try { setKvValue(spec.kvNamespace, CONFLICT_KEY, conflicted, resolveDb()); } catch (err) { deps.log.warn({ err }, "snapshot: failed to persist the conflict marker"); }
  if (pushTimer) { deps.clearTimeout(pushTimer); pushTimer = null; }
  if (pushRetryTimer) { deps.clearTimeout(pushRetryTimer); pushRetryTimer = null; }
  deps.log.warn({ id: spec.id, detail }, "snapshot: rebase conflict; pushes and pulls suspended until the clone is rebased by hand");
  deps.broadcast(`${spec.eventPrefix}:conflict`, { id: spec.id, detail });
  return { outcome: "conflict", detail };
}

function clearConflict(): void {
  conflicted = null;
  try { deleteKvValue(spec.kvNamespace, CONFLICT_KEY, resolveDb()); } catch (err) { deps.log.warn({ err }, "snapshot: failed to clear the conflict marker"); }
  deps.log.info({ id: spec.id }, "snapshot: conflict cleared");
}
```

`deleteKvValue(ns, key, db)` lives in `lib/state/kv-blob.ts` and is re-exported through `lib/state/index.ts`, where the engine already imports `getKvValue`/`setKvValue`.

Wire the push side in `doPushInner`: after the enabled and `hasRemote` checks, when `spec.pull` is set, `const pulled = await pullNow(); if (pulled.outcome === "conflict" || conflicted) return;`. The push itself becomes `await remoteGit(["push", "-q", "origin", "HEAD"], PUSH_TIMEOUT_MS)` (for the home spec that is the same argv and env as today). On failure, if `spec.pull` and `/\[rejected\]|non-fast-forward|fetch first/i.test(result.stderr)` and this is the first rejection of the streak (`pushRetryAttempt === 0`): `await pullNow(); ` then retry once inline (`const again = await remoteGit([...])`; on success take the success branch; on failure fall through to the existing failure branch).

`pullNow` records the outcome: after `doPull()` resolves, `lastPullSkipped = result.outcome === "skipped" ? result.detail : null`. `doRun` gates commits on `conflicted`: after the merge-in-progress check, `if (conflicted) return { committed: false, sha: null, paths: [], reason, skipped: "conflict" }` (add `"conflict"` to `SkipReason`). `status()` adds `lastPullAt, lastPullError, lastPullSkipped, conflicted`. `stop()` clears `pullTimer`. Return `{ stop, runNow, pullNow, status, ready }`.

- [ ] **Step 4: Run the suite**

Run: `bun test lib/daemon lib/home lib/team commands/__tests__/home.test.ts`
Expected: PASS. The handle gains `pullNow` and `SnapshotStatus` gains `lastPullAt`, `lastPullError`, `conflicted`: add them to the typed literals in `lib/daemon/__tests__/home-handlers.test.ts` and `commands/__tests__/home.test.ts` (`pullNow: async () => ({ outcome: "skipped", detail: null })`, `lastPullAt: 0, lastPullError: null, conflicted: null`).

- [ ] **Step 5: Commit**

```bash
git add lib/daemon/home-snapshot.ts lib/daemon/__tests__/home-snapshot.test.ts lib/daemon/__tests__/home-handlers.test.ts commands/__tests__/home.test.ts
git commit -m "snapshot: a spec with a pull policy fetches, fast-forwards or rebases, and surfaces a conflict instead of resolving it"
```

---

### Task 4: `rt.teamSnapshot` setting and the team spec builder

**Files:**
- Modify: `packages/rt-client/src/settings/registry-defs.ts`, `packages/rt-client/src/settings/__tests__/registry.test.ts`
- Modify: `lib/daemon/home-snapshot.ts`
- Test: `lib/daemon/__tests__/home-snapshot.test.ts`

**Interfaces:**
- Produces: registry row `rt.teamSnapshot` (machine, object, deep, migrated, default `{ enabled: true, debounceSec: 20, pushDelaySec: 60, janitorThresholdHours: 6, janitorIntervalMin: 30, pullIntervalSec: 300 }`); `export function teamSnapshotSpec(slug: string, repoDir: string, opts: { pullIntervalSec: number; originUrl: string; probes: Probes }): SnapshotSpec`.

- [ ] **Step 1: Failing tests**

`packages/rt-client/src/settings/__tests__/registry.test.ts`, beside the `rt.homeSnapshot` assertions. The row is `migrated: true`, so it joins `migratedTrueKeys` (the list at ~line 219, 25 → 26, and the test title "has exactly the 25 migrated:true keys" → 26) and the migrated-key list around lines 57-63; `suiteKeys` stays at 43.

```ts
    test("rt.teamSnapshot mirrors rt.homeSnapshot plus a pull interval", () => {
      const def = getDef("rt.teamSnapshot");
      expect(def?.scopes).toEqual(["machine"]);
      expect(def?.merge).toBe("deep");
      expect(def?.default).toEqual({ enabled: true, debounceSec: 20, pushDelaySec: 60, janitorThresholdHours: 6, janitorIntervalMin: 30, pullIntervalSec: 300 });
    });
```

`lib/daemon/__tests__/home-snapshot.test.ts`:

```ts
describe("teamSnapshotSpec", () => {
  test("names the clone by slug, scopes to the team roots, pulls on the interval, and reads the stored forge token for origin", async () => {
    const p = { ...fakeProbes({ home: "/h" }) };
    const spec = teamSnapshotSpec("acme", "/h/.mattstack/teams/acme", { pullIntervalSec: 120, originUrl: "https://gitlab.com/acme/team.git", probes: p, readToken: async () => "glpat-x" });
    expect(spec).toMatchObject({ id: "team:acme", repoDir: "/h/.mattstack/teams/acme", kvNamespace: "team-snapshot:acme", eventPrefix: "team", pull: { intervalSec: 120 } });
    expect(spec.scope!("mattstack/x")).toBe(true);
    expect(spec.scope!("src/x")).toBe(false);
    expect(await spec.tokenFor!()).toBe("glpat-x");
    expect(spec.legacyStatePath).toBeUndefined();
  });
});
```

(`fakeProbes` comes from `lib/setup/__tests__/fakes.ts`.)

- [ ] **Step 2: Run to see them fail**

Run: `cd packages/rt-client && bun test src/settings/__tests__/registry.test.ts; cd ../..; bun test lib/daemon/__tests__/home-snapshot.test.ts -t teamSnapshotSpec`
Expected: both FAIL.

- [ ] **Step 3: Implement**

Registry row (after `rt.homeSnapshot`):

```ts
  {
    key: "rt.teamSnapshot",
    type: "object",
    scopes: ["machine"],
    default: { enabled: true, debounceSec: 20, pushDelaySec: 60, janitorThresholdHours: 6, janitorIntervalMin: 30, pullIntervalSec: 300 },
    merge: "deep",
    migrated: true,
    description: "Team-clone snapshot daemon config: the home snapshot's fields plus pullIntervalSec, the fast-forward/rebase pull cadence for every clone under ~/.mattstack/teams.",
  },
```

Then `cd packages/rt-client && bun run build` (the `file:` consumers copy `dist/`).

`lib/daemon/home-snapshot.ts`:

```ts
import { storedForgeToken } from "../team/stored-forge-token.ts";
import type { Probes } from "../setup/probes.ts";

export function teamSnapshotSpec(
  slug: string,
  repoDir: string,
  opts: { pullIntervalSec: number; originUrl: string; probes: Probes; readToken?: (p: Probes, remote: string) => Promise<string | null> },
): SnapshotSpec {
  const readToken = opts.readToken ?? storedForgeToken;
  return {
    id: `team:${slug}`,
    repoDir,
    kvNamespace: `team-snapshot:${slug}`,
    eventPrefix: "team",
    scope: teamScope,
    pull: { intervalSec: opts.pullIntervalSec },
    tokenFor: () => readToken(opts.probes, opts.originUrl),
  };
}
```

- [ ] **Step 4: Run the tests**

Run: `cd packages/rt-client && bun test; cd ../..; bun test lib/daemon`
Expected: PASS (the dist-freshness test included).

- [ ] **Step 5: Commit**

```bash
git add packages/rt-client/src/settings lib/daemon/home-snapshot.ts lib/daemon/__tests__/home-snapshot.test.ts
git commit -m "snapshot: rt.teamSnapshot and the team spec builder"
```

---

### Task 5: Team clone supervisor

**Files:**
- Create: `lib/daemon/team-snapshots.ts`
- Test: `lib/daemon/__tests__/team-snapshots.test.ts`

**Interfaces:**
- Consumes: `startSnapshot`, `teamSnapshotSpec`, `SnapshotHandle`, `SnapshotStatus`, `PullResult` (Tasks 1, 3, 4).
- Produces:
  ```ts
  export interface TeamSnapshotsDeps {
    log: Logger;
    broadcast: (type: string, data: unknown) => void;
    teamsDir?: string;                       // default join(mattstackHome(), "teams")
    probes?: Probes;                         // default createRealProbes()
    readSettings?: () => TeamSnapshotSettings; // default getSetting("rt.teamSnapshot").value
    start?: typeof startSnapshot;            // test seam
    watch?: WatchFn; setTimeout?: TimeoutFn; clearTimeout?: ClearTimeoutFn;
    exec?: ExecFn; db?: Database;
  }
  export interface TeamSnapshotsHandle {
    stop(): void;
    rescan(): Promise<void>;
    status(): TeamSnapshotEntry[];           // { slug, ...SnapshotStatus }
    pullNow(slug: string): Promise<PullResult>;  // rejects with UserActionableError("no-team") for an unknown slug
    ready: Promise<void>;
  }
  export function startTeamSnapshots(deps: TeamSnapshotsDeps): TeamSnapshotsHandle;
  ```

- [ ] **Step 1: Failing tests**

`lib/daemon/__tests__/team-snapshots.test.ts`:

```ts
import { describe, test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { startTeamSnapshots } from "../team-snapshots.ts";
import { fakeProbes } from "../../setup/__tests__/fakes.ts";

function fakeLog() {
  const calls: { level: string; args: unknown[] }[] = [];
  const mk = (level: string) => (...args: unknown[]) => { calls.push({ level, args }); };
  return { calls, info: mk("info"), warn: mk("warn"), error: mk("error"), debug: mk("debug"), child: () => fakeLog() } as unknown as import("pino").Logger & { calls: typeof calls };
}

function clone(root: string, slug: string, withOrigin = true): string {
  const dir = join(root, slug);
  mkdirSync(join(dir, ".git"), { recursive: true });
  writeFileSync(join(dir, ".git", "config"), withOrigin ? `[remote "origin"]\n\turl = https://gitlab.com/acme/${slug}.git\n` : "");
  return dir;
}

function harness() {
  const root = mkdtempSync(join(tmpdir(), "rt-team-snapshots-"));
  const started: { spec: { id: string; repoDir: string }; stopped: boolean }[] = [];
  let listener: ((ev: string, f: string | null) => void) | null = null;
  const deps = {
    log: fakeLog(),
    broadcast: () => {},
    teamsDir: root,
    probes: fakeProbes({ home: root }),
    readSettings: () => ({ enabled: true, debounceSec: 20, pushDelaySec: 60, janitorThresholdHours: 6, janitorIntervalMin: 30, pullIntervalSec: 300 }),
    start: ((spec: { id: string; repoDir: string }) => {
      const entry = { spec, stopped: false };
      started.push(entry);
      return {
        stop: () => { entry.stopped = true; },
        runNow: async () => ({ committed: false, sha: null, paths: [], reason: "manual" as const }),
        pullNow: async () => ({ outcome: "up-to-date" as const, detail: null }),
        status: () => ({ id: spec.id, repoDir: spec.repoDir }),
        ready: Promise.resolve(),
      };
    }) as unknown as typeof import("../home-snapshot.ts").startSnapshot,
    watch: (_p: string, _o: unknown, l: (ev: string, f: string | null) => void) => { listener = l; return { close() {} }; },
    // Only the debounce timer fires synchronously; the interval rescan stays pending so tests drive rescan() themselves.
    setTimeout: (cb: () => void, ms: number) => { if (ms < 10_000) cb(); return 0 as unknown as ReturnType<typeof setTimeout>; },
    clearTimeout: () => {},
  };
  return { root, started, deps, emit: (f: string) => listener?.("rename", f), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe("startTeamSnapshots", () => {
  test("boot starts one instance per clone with an origin and skips one without", async () => {
    const h = harness();
    clone(h.root, "acme"); clone(h.root, "no-remote", false);
    const handle = startTeamSnapshots(h.deps);
    await handle.ready;
    expect(h.started.map((s) => s.spec.id)).toEqual(["team:acme"]);
    expect(h.deps.log.calls.some((c) => c.level === "warn" && JSON.stringify(c.args).includes("no-remote"))).toBe(true);
    handle.stop();
    expect(h.started[0]!.stopped).toBe(true);
    h.cleanup();
  });

  test("a clone that appears after boot starts on the teams/ watch event; a removed one stops", async () => {
    const h = harness();
    const handle = startTeamSnapshots(h.deps);
    await handle.ready;
    expect(h.started).toHaveLength(0);
    const dir = clone(h.root, "late");
    h.emit("late");
    await handle.rescan();
    expect(h.started.map((s) => s.spec.id)).toEqual(["team:late"]);
    rmSync(dir, { recursive: true, force: true });
    h.emit("late");
    await handle.rescan();
    expect(h.started[0]!.stopped).toBe(true);
    handle.stop();
    h.cleanup();
  });

  test("status lists every instance by slug and pullNow routes to it; an unknown slug is refused", async () => {
    const h = harness();
    clone(h.root, "acme");
    const handle = startTeamSnapshots(h.deps);
    await handle.ready;
    expect(handle.status().map((s) => s.slug)).toEqual(["acme"]);
    expect((await handle.pullNow("acme")).outcome).toBe("up-to-date");
    await expect(handle.pullNow("nope")).rejects.toThrow(/not cloned/);
    handle.stop();
    h.cleanup();
  });

  test("a clone whose origin arrives later (team publish --remote) starts on the interval rescan", async () => {
    const h = harness();
    const dir = clone(h.root, "late-origin", false);
    const handle = startTeamSnapshots(h.deps);
    await handle.ready;
    expect(h.started).toHaveLength(0);
    writeFileSync(join(dir, ".git", "config"), `[remote "origin"]\n\turl = https://gitlab.com/acme/late-origin.git\n`);
    await handle.rescan();
    expect(h.started.map((s) => s.spec.id)).toEqual(["team:late-origin"]);
    handle.stop();
    h.cleanup();
  });

  test("disabled: no instances, status empty, rescan stays inert", async () => {
    const h = harness();
    clone(h.root, "acme");
    const handle = startTeamSnapshots({ ...h.deps, readSettings: () => ({ ...h.deps.readSettings(), enabled: false }) });
    await handle.ready;
    expect(h.started).toHaveLength(0);
    handle.stop();
    h.cleanup();
  });
});
```

- [ ] **Step 2: Run to see them fail**

Run: `bun test lib/daemon/__tests__/team-snapshots.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`lib/daemon/team-snapshots.ts`:

```ts
/**
 * One snapshot engine per team clone under ~/.mattstack/teams. Clones
 * appear (team.join, team.create) and disappear while the daemon runs, so
 * the set is rescanned on a teams/ watch event, never fixed at boot.
 */

import { existsSync, readdirSync, readFileSync, watch as fsWatch } from "fs";
import { join } from "path";
import type { Database } from "bun:sqlite";
import type { Logger } from "pino";
import { getSetting } from "../settings/resolve.ts";
import { mattstackHome } from "../rt-paths.ts";
import { createRealProbes, type Probes } from "../setup/probes.ts";
import { parseOriginUrl } from "../setup/team-settings.ts";
import { UserActionableError } from "../setup/errors.ts";
import { startSnapshot, teamSnapshotSpec, type PullResult, type SnapshotHandle, type SnapshotStatus, type HomeSnapshotSettings } from "./home-snapshot.ts";

export interface TeamSnapshotSettings extends HomeSnapshotSettings { pullIntervalSec: number }
export interface TeamSnapshotEntry extends SnapshotStatus { slug: string }

export interface TeamSnapshotsDeps {
  log: Logger;
  broadcast: (type: string, data: unknown) => void;
  teamsDir?: string;
  probes?: Probes;
  readSettings?: () => TeamSnapshotSettings;
  start?: typeof startSnapshot;
  watch?: (path: string, options: { recursive: boolean }, listener: (eventType: string, filename: string | null) => void) => { close(): void };
  setTimeout?: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeout?: (h: ReturnType<typeof setTimeout>) => void;
  exec?: Parameters<typeof startSnapshot>[1]["exec"];
  db?: Database;
}

export interface TeamSnapshotsHandle {
  stop(): void;
  rescan(): Promise<void>;
  status(): TeamSnapshotEntry[];
  pullNow(slug: string): Promise<PullResult>;
  ready: Promise<void>;
}

const RESCAN_DEBOUNCE_MS = 2000;
/** A clone that gains its origin after boot (`rt team publish --remote`) edits .git/config, which the non-recursive teams/ watch never sees; the interval rescan, on the pull interval, is what picks it up. */

function originOf(dir: string): string | null {
  try {
    return parseOriginUrl(readFileSync(join(dir, ".git", "config"), "utf8"));
  } catch {
    return null;
  }
}

export function startTeamSnapshots(rawDeps: TeamSnapshotsDeps): TeamSnapshotsHandle {
  const teamsDir = rawDeps.teamsDir ?? join(mattstackHome(), "teams");
  const probes = rawDeps.probes ?? createRealProbes();
  const start = rawDeps.start ?? startSnapshot;
  const watch = rawDeps.watch ?? (fsWatch as unknown as NonNullable<TeamSnapshotsDeps["watch"]>);
  const setTimer = rawDeps.setTimeout ?? ((cb, ms) => setTimeout(cb, ms));
  const clearTimer = rawDeps.clearTimeout ?? ((h) => clearTimeout(h));
  const readSettings = rawDeps.readSettings ?? (() => getSetting<TeamSnapshotSettings>("rt.teamSnapshot").value);
  const instances = new Map<string, { handle: SnapshotHandle; dir: string }>();
  const skippedNoRemote = new Set<string>();
  let watcher: { close(): void } | null = null;
  let debounce: ReturnType<typeof setTimeout> | null = null;
  let interval: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  function scheduleRescan(): void {
    if (stopped) return;
    interval = setTimer(() => { interval = null; void rescan().finally(scheduleRescan); }, Math.max(30, settings().pullIntervalSec) * 1000);
  }

  function settings(): TeamSnapshotSettings {
    try {
      return readSettings();
    } catch (err) {
      rawDeps.log.warn({ err }, "team-snapshots: failed to read rt.teamSnapshot; treating as enabled with defaults");
      return { enabled: true, debounceSec: 20, pushDelaySec: 60, janitorThresholdHours: 6, janitorIntervalMin: 30, pullIntervalSec: 300 };
    }
  }

  function snapshotSettings(s: TeamSnapshotSettings): HomeSnapshotSettings {
    const { pullIntervalSec: _p, ...rest } = s;
    return rest;
  }

  async function rescan(): Promise<void> {
    if (stopped) return;
    const s = settings();
    if (s.enabled === false) {
      for (const [slug, inst] of instances) { inst.handle.stop(); instances.delete(slug); }
      return;
    }
    const present = new Set<string>();
    if (existsSync(teamsDir)) {
      for (const slug of readdirSync(teamsDir).sort()) {
        const dir = join(teamsDir, slug);
        if (!existsSync(join(dir, ".git"))) continue;
        present.add(slug);
        if (instances.has(slug)) continue;
        const originUrl = originOf(dir);
        if (!originUrl) {
          if (!skippedNoRemote.has(slug)) {
            rawDeps.log.warn({ slug, dir }, "team-snapshots: clone has no origin; snapshotted once `rt team publish --remote` gives it one (picked up within the rescan interval)");
            skippedNoRemote.add(slug);
          }
          continue;
        }
        skippedNoRemote.delete(slug);
        const spec = teamSnapshotSpec(slug, dir, { pullIntervalSec: Math.max(30, s.pullIntervalSec), originUrl, probes });
        const handle = start(spec, {
          log: rawDeps.log.child({ team: slug }),
          broadcast: rawDeps.broadcast,
          exec: rawDeps.exec,
          watch: rawDeps.watch,
          setTimeout: rawDeps.setTimeout,
          clearTimeout: rawDeps.clearTimeout,
          db: rawDeps.db,
          readSettings: () => snapshotSettings(settings()),
        });
        instances.set(slug, { handle, dir });
        rawDeps.log.info({ slug }, "team-snapshots: watching");
      }
    }
    for (const [slug, inst] of instances) {
      if (!present.has(slug)) {
        inst.handle.stop();
        instances.delete(slug);
        rawDeps.log.info({ slug }, "team-snapshots: clone removed; stopped");
      }
    }
  }

  const ready = rescan().then(() => {
    if (stopped || settings().enabled === false) return;
    try {
      watcher = watch(teamsDir, { recursive: false }, () => {
        if (debounce) clearTimer(debounce);
        debounce = setTimer(() => { debounce = null; void rescan(); }, RESCAN_DEBOUNCE_MS);
      });
    } catch (err) {
      rawDeps.log.warn({ err, teamsDir }, "team-snapshots: cannot watch teams/; new clones are picked up on the interval rescan");
    }
    scheduleRescan();
  });

  return {
    ready,
    rescan,
    stop() {
      stopped = true;
      if (watcher) { try { watcher.close(); } catch { /* already closed */ } watcher = null; }
      if (debounce) clearTimer(debounce);
      if (interval) clearTimer(interval);
      for (const inst of instances.values()) inst.handle.stop();
      instances.clear();
    },
    status: () => [...instances.entries()].map(([slug, inst]) => ({ slug, ...inst.handle.status() })),
    async pullNow(slug) {
      const inst = instances.get(slug);
      if (!inst) throw new UserActionableError("no-team", `team "${slug}" is not cloned locally (or has no origin)`);
      return inst.handle.pullNow();
    },
  };
}
```

`readSettings` on the engine deps receives the home-shaped settings (the engine clamps them); a missing `teams/` dir is the team-of-none case and stays quiet.

- [ ] **Step 4: Run the tests**

Run: `bun test lib/daemon/__tests__/team-snapshots.test.ts lib/daemon`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/daemon/team-snapshots.ts lib/daemon/__tests__/team-snapshots.test.ts
git commit -m "daemon: one snapshot engine per team clone, discovered at boot and on teams/ changes"
```

---

### Task 6: Daemon wiring and verbs

**Files:**
- Create: `lib/daemon/handlers/team-snapshot.ts`
- Modify: `lib/daemon.ts` (start/stop beside `homeSnapshot`), `lib/daemon/handlers/types.ts` (`InternalCommands`, ~line 121: the verb contract map), `lib/daemon/command-router.ts` (opts + spread)
- Modify (typed router opts gain `teamSnapshots`): `lib/daemon/__tests__/rt-client-commands.test.ts` (~line 99), `lib/daemon/__tests__/router-no-db-key.test.ts` (~line 66)
- Test: `lib/daemon/__tests__/handlers-team-snapshot.test.ts`

**Interfaces:**
- Produces verbs: `team:snapshot-status` → `{ ok: true, data: TeamSnapshotEntry[] }`; `team:pull` payload `{ slug: string }` → `{ ok: true, data: PullResult }`, or the daemon's standard failure envelope `{ ok: false, error: <message>, failure: { code: "no-team", message } }` for an unknown slug.

- [ ] **Step 1: Failing test**

`lib/daemon/__tests__/handlers-team-snapshot.test.ts` (mirror `handlers-home.test.ts` if it exists; else):

```ts
import { describe, test, expect } from "bun:test";
import { createTeamSnapshotHandlers } from "../handlers/team-snapshot.ts";
import { UserActionableError } from "../../setup/errors.ts";

const fakeHandle = {
  status: () => [{ slug: "acme", id: "team:acme" }],
  pullNow: async (slug: string) => {
    if (slug !== "acme") throw new UserActionableError("no-team", `team "${slug}" is not cloned locally`);
    return { outcome: "up-to-date" as const, detail: null };
  },
} as unknown as import("../team-snapshots.ts").TeamSnapshotsHandle;

describe("team snapshot handlers", () => {
  test("status returns every entry; pull routes by slug; unknown slug is a user error, not a throw", async () => {
    const h = createTeamSnapshotHandlers(fakeHandle);
    expect(await h["team:snapshot-status"]({})).toEqual({ ok: true, data: [{ slug: "acme", id: "team:acme" }] });
    expect(await h["team:pull"]({ slug: "acme" })).toEqual({ ok: true, data: { outcome: "up-to-date", detail: null } });
    const bad = await h["team:pull"]({ slug: "nope" });
    expect(bad.ok).toBe(false);
    expect((bad as { error: string; failure: { code: string } }).error).toContain("not cloned");
    expect((bad as { error: string; failure: { code: string } }).failure.code).toBe("no-team");
  });
});
```

Read `lib/daemon/handlers/home.ts` and copy its return type exactly (the `Record<..., (payload: any) => Promise<any>> & HandlerMap` shape) so the test's `h["team:snapshot-status"]({})` typechecks.

- [ ] **Step 2: Run to see it fail**

Run: `bun test lib/daemon/__tests__/handlers-team-snapshot.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`lib/daemon/handlers/team-snapshot.ts`:

```ts
import { UserActionableError } from "../../setup/errors.ts";
import type { TeamSnapshotsHandle } from "../team-snapshots.ts";

export function createTeamSnapshotHandlers(teamSnapshots: TeamSnapshotsHandle): Record<"team:snapshot-status" | "team:pull", (payload: any) => Promise<any>> {
  return {
    "team:snapshot-status": async () => ({ ok: true as const, data: teamSnapshots.status() }),
    "team:pull": async (payload: { slug?: string }) => {
      try {
        return { ok: true as const, data: await teamSnapshots.pullNow(String(payload?.slug ?? "")) };
      } catch (err) {
        if (err instanceof UserActionableError) return { ok: false as const, error: err.message, failure: { code: err.code, message: err.message } };
        throw err;
      }
    },
  };
}
```

`lib/daemon.ts`: declare `let teamSnapshots: ReturnType<typeof startTeamSnapshots>;`, start it right after `homeSnapshot = startHomeSnapshot({...})` with `startTeamSnapshots({ log: loggerHandle.childLogger("team-snapshots"), broadcast: emit })`, stop it in the same `stop()` as `homeSnapshot?.stop()`, pass `teamSnapshots` into the router opts. In `lib/daemon/handlers/types.ts`, add to `InternalCommands`:

```ts
  "team:snapshot-status": { payload: Record<string, never>; data: TeamSnapshotEntry[] };
  "team:pull": { payload: { slug: string }; data: PullResult };
```

`lib/daemon/command-router.ts`: `teamSnapshots: TeamSnapshotsHandle` in opts; `...createTeamSnapshotHandlers(opts.teamSnapshots)` beside the home spread. The two router tests listed above construct opts literals; give them a stub `teamSnapshots: { stop() {}, rescan: async () => {}, status: () => [], pullNow: async () => ({ outcome: "skipped", detail: null }), ready: Promise.resolve() }`.

- [ ] **Step 4: Run tests + tsc**

Run: `bun test lib/daemon; bun x tsc --noEmit`
Expected: PASS; no tsc errors.

- [ ] **Step 5: Commit**

```bash
git add lib/daemon/handlers/team-snapshot.ts lib/daemon/handlers/types.ts lib/daemon.ts lib/daemon/command-router.ts lib/daemon/__tests__
git commit -m "daemon: team:snapshot-status and team:pull; the team supervisor starts beside the home snapshot"
```

---

### Task 7: `team.sync` row and `verify` settling

**Files:**
- Modify: `lib/setup/validators/rt-health.ts`
- Modify: `lib/setup/steps/verify.ts`
- Test: `lib/setup/__tests__/validators-rt-health.test.ts`, `lib/setup/__tests__/steps-c.test.ts` (or wherever `settleChecks` is tested; `grep -rn settleChecks lib/setup/__tests__`)

**Interfaces:**
- Produces: `export async function teamSyncRow(slugs: string[], readStatus: () => Promise<TeamSnapshotEntry[] | null>, now: () => number, pullIntervalSec: number): Promise<Row | null>` (null when no team is cloned); row id `team.sync`, kind `tool`, required `false`, recheck `on-activate`.

- [ ] **Step 1: Failing tests**

```ts
describe("teamSyncRow", () => {
  const now = () => 1_000_000;
  test("no teams: no row", async () => {
    expect(await teamSyncRow([], async () => [], now, 300)).toBeNull();
  });
  test("daemon unreachable: missing", async () => {
    const r = await teamSyncRow(["acme"], async () => null, now, 300);
    expect(r?.status).toBe("missing");
    expect(r?.detail).toContain("daemon");
  });
  test("every clone pulled within the interval and nothing pending: ready", async () => {
    const r = await teamSyncRow(["acme"], async () => [{ slug: "acme", lastPullAt: 900_000, pushPending: false, lastPushError: null, conflicted: null } as never], now, 300);
    expect(r?.status).toBe("ready");
  });
  test("a conflict names the clone and is needs-you", async () => {
    const r = await teamSyncRow(["acme"], async () => [{ slug: "acme", lastPullAt: 900_000, pushPending: false, lastPushError: null, conflicted: { at: 1, detail: "CONFLICT settings.team.jsonc" } } as never], now, 300);
    expect(r?.status).toBe("needs-you");
    expect(r?.detail).toContain("acme");
    expect(r?.detail).toContain("rebase");
  });
  test("a standing fetch error is needs-you even when the last successful pull was recent", async () => {
    const r = await teamSyncRow(["acme"], async () => [{ slug: "acme", lastPullAt: 900_000, lastPullError: "remote: HTTP Basic: Access denied", pushPending: false, lastPushError: null, conflicted: null } as never], now, 300);
    expect(r?.status).toBe("needs-you");
    expect(r?.detail).toContain("fetch failing");
  });

  test("a stale pull (older than two intervals) or a standing push error is needs-you", async () => {
    const stale = await teamSyncRow(["acme"], async () => [{ slug: "acme", lastPullAt: 0, pushPending: false, lastPushError: null, conflicted: null } as never], now, 300);
    expect(stale?.status).toBe("needs-you");
    const failing = await teamSyncRow(["acme"], async () => [{ slug: "acme", lastPullAt: 900_000, pushPending: true, lastPushError: "denied", conflicted: null } as never], now, 300);
    expect(failing?.status).toBe("needs-you");
    expect(failing?.detail).toContain("denied");
  });
});
```

And for `verify`: in the settle test file, add a case where the only critical failure is named `team.sync` and assert `settleChecks` re-reads (same shape as the existing `tool.daemon` settle test; copy it and change the name).

- [ ] **Step 2: Run to see them fail**

Run: `bun test lib/setup/__tests__/validators-rt-health.test.ts -t teamSyncRow`
Expected: FAIL, not exported.

- [ ] **Step 3: Implement**

In `rt-health.ts`:

```ts
/** Every clone's daemon-side sync state in one row: a joiner who cannot decrypt is almost always a clone that has not pulled the owner's recipients yet. */
export async function teamSyncRow(
  slugs: string[],
  readStatus: () => Promise<TeamSnapshotEntry[] | null>,
  now: () => number,
  pullIntervalSec: number,
): Promise<Row | null> {
  if (slugs.length === 0) return null;
  const base = { id: "team.sync", kind: "tool" as const, title: "Team sync", why: "Your team clone pulls the roster, recipients and packs on a timer and pushes your own team edits; this is whether that is keeping up.", required: false, optionalNote: "Works without this; `rt team pull` and `rt team publish` do the same by hand.", recheck: "on-activate" as const };
  const entries = await readStatus();
  if (entries === null) return row({ ...base, status: "missing", detail: "rt daemon not reachable — team clones sync once it is running" });
  const staleMs = pullIntervalSec * 2 * 1000;
  const problems: string[] = [];
  for (const slug of slugs) {
    const e = entries.find((x) => x.slug === slug);
    if (!e) { problems.push(`${slug}: not watched (no origin?)`); continue; }
    if (e.conflicted) { problems.push(`${slug}: rebase conflict — ${e.conflicted.detail}; rebase the clone by hand, then rt team publish`); continue; }
    if (e.lastPushError) { problems.push(`${slug}: push failing — ${e.lastPushError}`); continue; }
    if (e.lastPullError) { problems.push(`${slug}: fetch failing — ${e.lastPullError}`); continue; }
    if (e.lastPullAt === 0 || now() - e.lastPullAt > staleMs) problems.push(`${slug}: last pull ${e.lastPullAt === 0 ? "never" : `${Math.round((now() - e.lastPullAt) / 60_000)} min ago`}`);
  }
  if (problems.length > 0) return row({ ...base, status: "needs-you", detail: problems.join("; "), action: RECHECK_ACTION });
  // A pull skipped every tick (a dirty src/ refusing the rebase) is not a failure, but it is why a member's store edits are not moving; say so without changing the status.
  const skips = slugs.map((slug) => entries.find((x) => x.slug === slug)?.lastPullSkipped).filter((d): d is string => !!d);
  const detail = `${slugs.length} clone${slugs.length === 1 ? "" : "s"} in sync${skips.length ? `; last pull skipped: ${skips.join("; ")}` : ""}`;
  return row({ ...base, status: "ready", detail });
}
```

Wire it where `homeBackupRow` is called (line ~469): read status through `p.daemon` (the probes' daemon call the `tool.daemon` row already uses; null on any failure or a non-ok envelope), `slugs` from `discoverTeams(p)` (module-private in `lib/setup/apply.ts:246` today; export it), `pullIntervalSec` from `getSetting("rt.teamSnapshot").value?.pullIntervalSec ?? 300`. Push the row only when non-null.

`verify.ts`: `const SETTLING_ROWS = new Set(["tool.daemon", "team.sync"]);` and, since the row is `required: false`, it never becomes a critical failure; the settle loop must also wait while `team.sync` is `needs-you` with `last pull never` right after a join: extend `settleChecks` to also keep re-reading while a check named `team.sync` has status `warn` and its detail contains `never` (up to `SETTLE_ATTEMPTS`, the same 5 × 3 s budget `tool.daemon` gets; the boot pull is immediate, so the wait is for the engine to start, not for a timer). Assert this in the settle test.

- [ ] **Step 4: Run the tests**

Run: `bun test lib/setup`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/setup/validators/rt-health.ts lib/setup/steps/verify.ts lib/setup/__tests__
git commit -m "checklist: team.sync row; verify waits for a joiner's first pull"
```

---

### Task 8: `rt team pull` and richer `rt team status`

**Files:**
- Modify: `commands/team.ts`, `lib/command-tree-def.ts`
- Test: `commands/__tests__/team.test.ts`
- Docs: `bun run docs:gen` output (whatever `docs:check` regenerates)

**Interfaces:**
- Produces: `rt team pull [--team <slug>] [--json]` → envelope `{ contract: 1, at, slug, outcome, detail }`; `rt team status --json` adds `lastPull: string | null`, `lastPushAt: string | null`, `lastPullSkipped: string | null`, `conflicted: { at: string; detail: string } | null` (ISO strings; nulls when the daemon is unreachable).

- [ ] **Step 1: Failing tests**

In `commands/__tests__/team.test.ts`, `TeamDeps` gains an optional `daemon?: (cmd: string, payload: unknown) => Promise<unknown>` seam; add:

```ts
describe("teamPull", () => {
  test("--json prints the daemon's pull result in the contract envelope", async () => {
    const deps = depsWithZone({ daemon: async (cmd, payload) => (cmd === "team:pull" ? { ok: true, data: { outcome: "fast-forwarded", detail: null } } : { ok: false }) });
    await teamPull(["--team", "acme", "--json"], {}, deps);
    const { at, ...body } = JSON.parse(deps.lines[0]!);
    expect(body).toEqual({ contract: 1, slug: "acme", outcome: "fast-forwarded", detail: null });
  });
  test("daemon unreachable (daemonQuery returns null) exits 2 with a plain message, never a stack", async () => {
    const deps = depsWithZone({ daemon: async () => null });
    const code = await runExpectingProcessExit(() => teamPull(["--team", "acme"], {}, deps));
    expect(code).toBe(2);
    expect(deps.lines.join("\n")).toContain("daemon");
  });
  test("a daemon failure envelope surfaces its code", async () => {
    const deps = depsWithZone({ daemon: async () => ({ ok: false, error: "team \"acme\" is not cloned locally", failure: { code: "no-team", message: "team \"acme\" is not cloned locally" } }) });
    await runExpectingProcessExit(() => teamPull(["--team", "acme", "--json"], {}, deps));
    expect(JSON.parse(deps.lines[0]!).error.code).toBe("no-team");
  });
});

test("teamStatus --json carries the daemon's sync fields, null when the daemon is down", async () => {
  const deps = depsWithZone({ daemon: async () => ({ ok: true, data: [{ slug: "acme", lastPullAt: 1_700_000_000_000, lastPushAt: 0, conflicted: null }] }) });
  await teamStatus(["--team", "acme", "--json"], {}, deps);
  const body = JSON.parse(deps.lines[0]!);
  expect(body.lastPull).toBe(new Date(1_700_000_000_000).toISOString());
  expect(body.lastPushAt).toBeNull();
  expect(body.conflicted).toBeNull();
});
```

Look at how the existing `teamStatus` test seeds its zone and exec (`depsWithZone`, the `git log` responder) and keep those.

- [ ] **Step 2: Run to see them fail**

Run: `bun test commands/__tests__/team.test.ts -t "teamPull|sync fields"`
Expected: FAIL.

- [ ] **Step 3: Implement**

`commands/team.ts`: the real `daemon` seam is `daemonQuery` from `lib/daemon-client.ts` (what `commands/home.ts` uses; it returns `null` when the daemon is unreachable and a `DaemonResponse` otherwise). Add:

```ts
export async function teamPull(args: string[], _ctx: CommandContext = {}, deps: TeamDeps = realTeamDeps()): Promise<void> {
  const json = args.includes("--json");
  try {
    const slug = resolveTeamSlug(args);
    const call = deps.daemon ?? daemonQuery;
    const res = (await call("team:pull", { slug })) as { ok: boolean; data?: { outcome: string; detail: string | null }; error?: string; failure?: { code: string; message: string } } | null;
    if (!res) throw new UserActionableError("daemon-unreachable", `rt daemon is not reachable — start it with \`rt daemon start\`, or pull by hand with git in ~/.mattstack/teams/${slug}`);
    if (!res.ok || !res.data) throw new UserActionableError(res.failure?.code ?? "team-pull-failed", res.failure?.message ?? res.error ?? "team pull failed");
    if (json) { deps.print(JSON.stringify(envelope({ slug, outcome: res.data.outcome, detail: res.data.detail }))); return; }
    deps.print(`rt team pull: ${slug} — ${res.data.outcome}${res.data.detail ? ` (${res.data.detail})` : ""}`);
  } catch (err) {
    if (err instanceof UserActionableError) exitUserError(err, json, "team pull", deps.print);
    throw err;
  }
}
```

`teamStatus`: after computing `result`, call `deps.daemon?.("team:snapshot-status", {})` inside a try; on success find the slug's entry and add `lastPull`, `lastPushAt` (ISO or null when 0), `lastPullSkipped` and `conflicted` (with `at` as ISO); on any failure set all four to null. Human line gains `, sync: <ok|conflict|unknown>` and, when set, ` (last pull skipped: <reason>)`.

`lib/command-tree-def.ts`: under `team`, add `pull` with `--team` (text, optional) and `--json`; no required positional, so no `omitBehavior`. Register `teamPull` in the module's export map the tree uses (`fn: "teamPull"`).

Run `bun run docs:gen` (or whatever `docs:check` expects; see `package.json`) so the generated reference includes the verb.

- [ ] **Step 4: Run tests, picker check, docs check**

Run: `bun test commands/__tests__/team.test.ts lib/__tests__/picker-conformance.test.ts; bun run picker:check; bun run docs:check`
Expected: PASS / clean.

- [ ] **Step 5: Commit**

```bash
git add commands/team.ts lib/command-tree-def.ts commands/__tests__/team.test.ts docs
git commit -m "team: rt team pull; rt team status shows the daemon's sync state"
```

---

### Task 9: The harness stops doing the daemon's job

**Files:**
- Modify: `rt-tray/vm/run/host/team-propagate.sh`
- Modify: `rt-tray/vm/run/guest/assert-team.sh`
- Modify: `rt-tray/vm/README.md`

- [ ] **Step 1: Replace the hand steps with waits**

Owner side: keep `members sync`; replace `git add -A; git commit; rt team publish` with a wait: poll `/tmp/rt-new team status --team "$SLUG" --json` until `.lastPushAt` is later than the sync's `at`, up to 3 minutes (the pushDelaySec 60 default plus a pull), else `echo "owner: daemon never pushed"; exit 1`.

Joiner side: replace the credentialed `git pull` with `/tmp/rt-new team pull --team "$SLUG" --json` (exercises the verb) followed by the existing `assert-team.sh`.

`assert-team.sh`: add `TEAM ok/FAIL team.sync row ready` via `"$RT" setup status --json` (find the `team.sync` row; `ready` passes).

- [ ] **Step 2: Rebuild and run the kitchen-sink pass**

```bash
bun build --compile --target=bun-darwin-arm64 ./cli.ts --outfile dist/rt --define RT_VERSION='"2.8.0-vm8"' && (cd rt-tray && ./build.sh release)
```

Then the sequence from `rt-tray/vm/README.md` (owner create with `--keep`, `team-load.sh` with `fixtures/team-kitchen-sink`, one join with `--keep`, `team-propagate.sh`). Expected: `TEAM fails=0` with the propagate script having run no git commit/push/pull of its own. The pass is the acceptance test; record the run ids on MAT-405.

- [ ] **Step 3: README**

Update the Status paragraph: the two hand steps are gone; `team-propagate.sh` now only runs `members sync` and waits.

- [ ] **Step 4: Commit**

```bash
git add rt-tray/vm
git commit -m "vm: the propagation pass waits for the daemon instead of committing, publishing and pulling by hand"
```

---

### Task 10: Full gate and docs

- [ ] **Step 1: Run everything**

Run: `bun run test && bun run test:e2e && bun x tsc --noEmit && bun run docs:check && bun run picker:check`
Expected: green.

- [ ] **Step 2: Docs**

`docs/settings-architecture.md`: add `rt.teamSnapshot` beside `rt.homeSnapshot` in the key table. `CLAUDE.md` "Logging architecture" needs no change (domain events only). The spec's "Rules this design binds" go into `rt-tray/vm/README.md`'s rules list if that list exists there; otherwise into MAT-386 §9 via Linear.

- [ ] **Step 3: Commit and push**

```bash
git add docs
git commit -m "docs: rt.teamSnapshot"
git pull --rebase origin main && git push origin main
```

Post the run ids and the closing note on MAT-405; flip the MAT-386 §7b "Team-clone snapshot" box; MAT-393 can close per Matt's ruling (kept open until MAT-405 lands).
