# Daemon Spawn-Env Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make daemon-spawned subprocesses inherit the PATH the daemon resolves, so worktree ready steps stop failing with `env: node: No such file or directory` under launchd, and clean up the host config and observability gaps the failure exposed.

**Architecture:** Four repo changes and two host-config changes. In the repo: `runCapture` passes the live `process.env` to `Bun.spawn` (the actual fix), the output-tail helper moves into `lib/subprocess.ts` so freshen can log *why* a ready step failed, `resolveUserPath` probes for `node`, and provision's `create-failed` refusal names any on-deck trees held by retry backoff. On the host: `~/.zshenv`'s fnm bootstrap stops depending on inherited PATH, and the 147k-entry fnm multishell leak gets pruned. Tasks 1–4 are independent of each other; 5–6 are host-only; 7 unwedges the pool and resumes the parked ACME-2899 work.

**Tech Stack:** Bun (runtime + `bun test`), TypeScript, zsh dotfiles, launchd/SMAppService.

**Spec:** `docs/superpowers/specs/2026-08-21-daemon-spawn-env-contract.md`

## Global Constraints

- Repo is `/Users/matt/Documents/GitHub/repo-tools`, branch `main`, clean at plan time. Work on a branch off `main`; the MAT-383 worktrees (`mat-383-app-shell`, `mat-383-clean-room`) touch none of these files, so there is no conflict risk.
- Unit tests: `bun test lib commands packages`. Scope to a single file while iterating: `bun test lib/__tests__/subprocess.test.ts`.
- Do **not** run `test:e2e` / `test:all`; the e2e suite has a 60s-per-test timeout and is not needed for any change here.
- `dist/` is gitignored — no dist rebuild, no dist commit.
- `rt` runs in **dev mode from source**, so `lib/` changes take effect only after `rt daemon restart`. Do not restart until Task 7; an early restart re-resolves PATH and muddies the before/after evidence.
- Commit subjects use the `RT: ` prefix (repo convention; this work has no ticket).
- Comments earn their place only by stating something the code cannot show. Do not narrate the change, cite this plan, or leave reviewer-facing notes in source.
- Tasks 5 and 6 modify the developer's machine, not the repo. They have no commit step. Task 6 deletes files — its guard (skip live PIDs) is load-bearing.

---

### Task 1: `runCapture` passes the live process env

**Files:**
- Modify: `lib/subprocess.ts:22-34`
- Test: `lib/__tests__/subprocess.test.ts` (create)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `runCapture(argv, opts)` where `opts` gains `env?: Record<string, string | undefined>`. When omitted, children receive `{ ...process.env }`. Tasks 2–4 rely on nothing from this task; Task 7 depends on its behavior at runtime.

- [ ] **Step 1: Write the failing test**

Create `lib/__tests__/subprocess.test.ts`:

```ts
import { describe, test, expect, afterEach } from "bun:test";
import { runCapture } from "../subprocess.ts";

const SENTINEL = "RT_SPAWN_ENV_SENTINEL";

describe("runCapture env", () => {
  afterEach(() => {
    delete process.env[SENTINEL];
  });

  test("children see values assigned to process.env after startup", async () => {
    process.env[SENTINEL] = "visible";

    const r = await runCapture(["/bin/sh", "-c", `printf %s "$${SENTINEL}"`]);

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("visible");
  });

  test("an explicit env replaces the inherited one", async () => {
    process.env[SENTINEL] = "inherited";

    const r = await runCapture(["/bin/sh", "-c", `printf %s "$${SENTINEL}"`], {
      env: { [SENTINEL]: "explicit" },
    });

    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe("explicit");
  });
});
```

Note on the template string: in a JS template literal `$` is literal unless followed by `{`, so `` `$${SENTINEL}` `` produces the shell text `$RT_SPAWN_ENV_SENTINEL`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test lib/__tests__/subprocess.test.ts`
Expected: BOTH tests FAIL, and both fail at runtime with `r.stdout` empty — `Bun.spawn` does not observe post-startup assignments to `process.env`, and the not-yet-supported `env` option is silently ignored rather than rejected. `bun test` transpiles without type-checking, so do not expect a type error on the unknown option.

- [ ] **Step 3: Write the implementation**

In `lib/subprocess.ts`, extend the options type and pass `env`. Replace lines 22-34:

```ts
export async function runCapture(
  argv: [string, ...string[]],
  opts: {
    cwd?: string;
    timeoutMs?: number;
    stderr?: "ignore" | "pipe";
    env?: Record<string, string | undefined>;
  } = {},
): Promise<RunResult> {
  const captureStderr = opts.stderr === "pipe";
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(argv, {
      cwd: opts.cwd,
      // Bun.spawn ignores assignments made to process.env after startup, so an
      // inherited env strands the PATH the daemon resolves at boot
      // (lib/daemon.ts) and leaves `#!/usr/bin/env node` shebangs unresolvable
      // under launchd. execSync, which this replaces, reads process.env per call.
      env: opts.env ?? { ...process.env },
      stdin: "ignore",
      stdout: "pipe",
      stderr: captureStderr ? "pipe" : "ignore",
    });
```

Then extend the function's existing JSDoc (immediately above `export async function runCapture`) with one line:

```
 * Children inherit the caller's live `process.env` unless `opts.env` overrides it.
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test lib/__tests__/subprocess.test.ts`
Expected: PASS, 2 tests.

- [ ] **Step 5: Run the callers' tests**

`runCapture` has 22 call sites across 11 files; this changes what every one of them hands its children.

Run: `bun test lib commands packages`
Expected: PASS, no new failures. If a test fails because it asserted on a child running with a bare environment, that test was encoding the bug — fix the test to pass an explicit `env` rather than reverting the default.

- [ ] **Step 6: Commit**

```bash
git add lib/subprocess.ts lib/__tests__/subprocess.test.ts
git commit -m "RT: runCapture hands children the live process env

Bun.spawn ignores post-startup process.env assignments, so the PATH the
daemon resolves at boot never reached ready steps. Under SMAppService that
left them with launchd's PATH and no node, so every pnpm/bun install step
died on its env-node shebang."
```

---

### Task 2: freshen logs why a ready step failed

**Files:**
- Modify: `lib/subprocess.ts` (add exported `MAX_LOGGED_OUTPUT` and `outputTail`)
- Modify: `lib/worktree/create.ts:37-44` (delete the local copies, import instead)
- Modify: `lib/daemon/worktree-reconciler.ts:753`
- Test: `lib/__tests__/subprocess.test.ts` (extend the file created in Task 1)

**Interfaces:**
- Consumes: `lib/__tests__/subprocess.test.ts` exists (Task 1). If Task 1 has not run, create the file with the imports shown below.
- Produces: `outputTail(output: string, maxChars: number): string` and `MAX_LOGGED_OUTPUT = 2000`, both exported from `lib/subprocess.ts`.

- [ ] **Step 1: Write the failing test**

Append to `lib/__tests__/subprocess.test.ts`, and add `outputTail` and `MAX_LOGGED_OUTPUT` to the existing import from `../subprocess.ts`:

```ts
describe("outputTail", () => {
  test("passes short output through, trimmed", () => {
    expect(outputTail("  env: node: No such file or directory\n", 2000))
      .toBe("env: node: No such file or directory");
  });

  test("keeps the tail, not the head, and marks the elision", () => {
    const output = `${"x".repeat(50)}THE-REAL-ERROR`;

    const tail = outputTail(output, 20);

    expect(tail.startsWith("…")).toBe(true);
    expect(tail.endsWith("THE-REAL-ERROR")).toBe(true);
    expect(tail.length).toBe(21);
  });

  test("MAX_LOGGED_OUTPUT is the shared cap", () => {
    expect(MAX_LOGGED_OUTPUT).toBe(2000);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test lib/__tests__/subprocess.test.ts`
Expected: FAIL — `outputTail` and `MAX_LOGGED_OUTPUT` are not exported from `lib/subprocess.ts` (they are private to `lib/worktree/create.ts`).

- [ ] **Step 3: Move the helpers into `lib/subprocess.ts`**

Add to `lib/subprocess.ts`, after the `RunResult` interface:

```ts
/** Longest slice of a failed step's output carried into a log line. */
export const MAX_LOGGED_OUTPUT = 2000;

/** The tail of a step's output — a failing install reports at the end, not the start. */
export function outputTail(output: string, maxChars: number): string {
  const trimmed = output.trim();
  return trimmed.length <= maxChars ? trimmed : `…${trimmed.slice(-maxChars)}`;
}
```

In `lib/worktree/create.ts`, delete lines 37-44 (the local `MAX_LOGGED_OUTPUT` const, the local `outputTail` function, and both of their comments — through `outputTail`'s closing brace) and add the import beside the existing imports:

```ts
import { MAX_LOGGED_OUTPUT, outputTail } from "../subprocess.ts";
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test lib/__tests__/subprocess.test.ts lib/worktree/__tests__/create.test.ts`
Expected: PASS. `create.test.ts` must still pass — the helpers moved, their behavior did not.

- [ ] **Step 5: Log the output on freshen failure**

In `lib/daemon/worktree-reconciler.ts`, add to the imports:

```ts
import { MAX_LOGGED_OUTPUT, outputTail } from "../subprocess.ts";
```

Replace line 753:

```ts
    log.warn({ ...fields, failedStep: readyResult.failedStep }, "freshen: ready step failed");
```

with:

```ts
    log.warn(
      {
        ...fields,
        failedStep: readyResult.failedStep,
        output: outputTail(readyResult.output, MAX_LOGGED_OUTPUT),
      },
      "freshen: ready step failed",
    );
```

- [ ] **Step 6: Run the reconciler tests**

Run: `bun test lib/daemon/__tests__/worktree-reconciler.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add lib/subprocess.ts lib/worktree/create.ts lib/daemon/worktree-reconciler.ts lib/__tests__/subprocess.test.ts
git commit -m "RT: freshen logs the failing ready step's output

Only createTree logged output, so a freshen that failed the same way logged
a step name and nothing else. The env-node diagnosis existed only because a
cold create happened to fail too."
```

---

### Task 3: `resolveUserPath` reports whether node is on the resolved PATH

**Files:**
- Modify: `lib/daemon/user-path.ts:39-44`
- Modify: `lib/daemon.ts:88-91` (comment only)
- Test: `lib/daemon/__tests__/user-path.test.ts` (create)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `probeTools(pathValue: string, names: string[]): Record<string, boolean>`, exported from `lib/daemon/user-path.ts`, keyed `has<Name>` (`hasNode`, `hasPnpm`, `hasDoppler`).

- [ ] **Step 1: Write the failing test**

Create `lib/daemon/__tests__/user-path.test.ts`:

```ts
import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { probeTools } from "../user-path.ts";

describe("probeTools", () => {
  let binDir: string;

  beforeEach(() => {
    binDir = mkdtempSync(join(tmpdir(), "rtpath-"));
    const node = join(binDir, "node");
    writeFileSync(node, "#!/bin/sh\nexit 0\n");
    chmodSync(node, 0o755);
  });

  test("reports a tool present on the path", () => {
    expect(probeTools(binDir, ["node"])).toEqual({ hasNode: true });
  });

  test("reports a tool absent from the path", () => {
    expect(probeTools(binDir, ["pnpm"])).toEqual({ hasPnpm: false });
  });

  test("probes every requested name across every path entry", () => {
    const probed = probeTools(`/nonexistent-rt-test:${binDir}`, ["node", "pnpm"]);

    expect(probed).toEqual({ hasNode: true, hasPnpm: false });
  });

  test("an empty path finds nothing", () => {
    expect(probeTools("", ["node"])).toEqual({ hasNode: false });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test lib/daemon/__tests__/user-path.test.ts`
Expected: FAIL — `probeTools` is not exported from `../user-path.ts`.

- [ ] **Step 3: Write the implementation**

In `lib/daemon/user-path.ts`, add above `resolveUserPath`:

```ts
/** Which of `names` is a non-empty file on `pathValue`, keyed `has<Name>`. */
export function probeTools(pathValue: string, names: string[]): Record<string, boolean> {
  const entries = pathValue.split(":").filter((p) => p.length > 0);
  const probed: Record<string, boolean> = {};
  for (const name of names) {
    probed[`has${name[0]!.toUpperCase()}${name.slice(1)}`] = entries.some((p) => {
      try {
        return Bun.file(`${p}/${name}`).size > 0;
      } catch {
        return false;
      }
    });
  }
  return probed;
}
```

Then replace the logging block (lines 39-44, from `// Log so we can verify` through the `log.info(...)` call) with:

```ts
  // Log so we can verify key tools are present after restarts
  const pathEntries = resolvedPath.split(":");
  log.info(
    { entries: pathEntries.length, ...probeTools(resolvedPath, ["node", "pnpm", "doppler"]) },
    "PATH resolved",
  );
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test lib/daemon/__tests__/user-path.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Correct the stale comment in `lib/daemon.ts`**

The comment at `lib/daemon.ts:88-91` says the overlay exists "so direct execSync calls ... inherit pnpm/doppler/bun". After Task 1 that is no longer the limit of its reach, and the old wording is what made the gap invisible. Replace the comment (keep the code beneath it unchanged):

```ts
// Resolve the user's full PATH once at startup and overlay it onto the daemon's
// own env. Under launchd the inherited PATH is /usr/bin:/bin:/usr/sbin:/sbin, so
// without this nothing the daemon spawns can find node, pnpm, doppler or bun.
// runCapture forwards process.env explicitly (lib/subprocess.ts) because
// Bun.spawn would otherwise ignore this assignment.
```

- [ ] **Step 6: Commit**

```bash
git add lib/daemon/user-path.ts lib/daemon/__tests__/user-path.test.ts lib/daemon.ts
git commit -m "RT: PATH-resolved log reports node, not just pnpm and doppler

node was the one tool actually missing and the only one the probe never
checked."
```

---

### Task 4: provision's `create-failed` names on-deck trees held by backoff

**Files:**
- Modify: `lib/daemon/handlers/worktree.ts:103-112` (`createFailedError`), `:280-286` (the cold-create call site)
- Test: `lib/daemon/__tests__/worktree-handlers.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `backoffNote(trees: TreeRecord[], now: number): string | null` and `createFailedError(created: { failedStep?: string; output?: string }, note?: string | null): string`, both exported from `lib/daemon/handlers/worktree.ts`. The `create-failed:<step>` prefix is unchanged — skills prefix-match it.

- [ ] **Step 1: Write the failing test**

Append to `lib/daemon/__tests__/worktree-handlers.test.ts`, adding `backoffNote` and `createFailedError` to its existing import from `../handlers/worktree.ts`:

```ts
describe("backoffNote", () => {
  const now = Date.parse("2026-08-21T16:20:00.000Z");
  const onDeck = (name: string, nextRetryAt?: string): TreeRecord => ({
    name,
    path: `/tmp/${name}`,
    kind: "ephemeral",
    state: "on-deck",
    branch: `on-deck/${name}`,
    createdAt: "2026-08-20T18:15:30.271Z",
    ...(nextRetryAt ? { nextRetryAt } : {}),
  });

  test("is null when no on-deck tree is held", () => {
    expect(backoffNote([onDeck("cho")], now)).toBeNull();
  });

  test("is null when a backoff has already expired", () => {
    expect(backoffNote([onDeck("cho", "2026-08-21T16:19:59.000Z")], now)).toBeNull();
  });

  test("counts held trees and names the earliest retry", () => {
    const note = backoffNote(
      [
        onDeck("cho", "2026-08-21T16:52:42.822Z"),
        onDeck("dean", "2026-08-21T16:35:05.233Z"),
        onDeck("dudley"),
      ],
      now,
    );

    expect(note).toBe("2 on-deck trees held by retry backoff until 2026-08-21T16:35:05.233Z");
  });

  test("singular for one held tree", () => {
    const note = backoffNote([onDeck("cho", "2026-08-21T16:52:42.822Z")], now);

    expect(note).toBe("1 on-deck tree held by retry backoff until 2026-08-21T16:52:42.822Z");
  });
});

describe("createFailedError", () => {
  test("keeps the prefix and output tail when there is no note", () => {
    const error = createFailedError({
      failedStep: "pnpm install",
      output: "env: node: No such file or directory",
    });

    expect(error).toBe("create-failed:pnpm install\nenv: node: No such file or directory");
  });

  test("appends the note as its own line", () => {
    const error = createFailedError(
      { failedStep: "pnpm install", output: "env: node: No such file or directory" },
      "2 on-deck trees held by retry backoff until 2026-08-21T16:35:05.233Z",
    );

    expect(error).toBe(
      "create-failed:pnpm install\nenv: node: No such file or directory\n" +
        "2 on-deck trees held by retry backoff until 2026-08-21T16:35:05.233Z",
    );
  });

  test("appends the note even with no output", () => {
    const error = createFailedError({ failedStep: "pnpm install" }, "1 on-deck tree held by retry backoff until 2026-08-21T16:35:05.233Z");

    expect(error).toBe(
      "create-failed:pnpm install\n1 on-deck tree held by retry backoff until 2026-08-21T16:35:05.233Z",
    );
  });
});
```

If `TreeRecord` is not already imported in that test file, add:

```ts
import type { TreeRecord } from "../../worktree/registry.ts";
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test lib/daemon/__tests__/worktree-handlers.test.ts`
Expected: FAIL — `backoffNote` does not exist and `createFailedError` is neither exported nor accepts a second argument.

- [ ] **Step 3: Write the implementation**

In `lib/daemon/handlers/worktree.ts`, replace `createFailedError` (lines 103-112, function signature through its closing brace; keep the JSDoc above it at 96-102) with:

```ts
export function createFailedError(
  created: { failedStep?: string; output?: string },
  note?: string | null,
): string {
  const step = created.failedStep ?? "unknown";
  const tail = (created.output ?? "")
    .trim()
    .split("\n")
    .slice(-CREATE_FAILED_TAIL_LINES)
    .join("\n")
    .trim();
  return [`create-failed:${step}`, tail, note].filter((part) => part).join("\n");
}
```

Add below it:

```ts
/**
 * On-deck trees provision could not select because their last freshen failed and
 * they are inside its retry backoff. Without this the refusal reads as one
 * unlucky create when the whole pool is failing the same way.
 */
export function backoffNote(trees: TreeRecord[], now: number): string | null {
  const held = trees.filter(
    (t) =>
      t.kind === "ephemeral" &&
      t.state === "on-deck" &&
      t.nextRetryAt !== undefined &&
      Date.parse(t.nextRetryAt) > now,
  );
  if (held.length === 0) return null;

  const earliest = Math.min(...held.map((t) => Date.parse(t.nextRetryAt!)));
  const noun = held.length === 1 ? "tree" : "trees";
  return `${held.length} on-deck ${noun} held by retry backoff until ${new Date(earliest).toISOString()}`;
}
```

Then at the cold-create call site (line 285), replace:

```ts
          return { ok: false, error: createFailedError(created) };
```

with:

```ts
          return {
            ok: false,
            error: createFailedError(created, backoffNote(loadRegistry(repoName), Date.now())),
          };
```

Leave the second `createFailedError` call site (the `worktree:create` verb, line 434) unchanged — it is an explicit create request, not a pool selection, so a pool note there would be noise.

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test lib/daemon/__tests__/worktree-handlers.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the full unit suite and the docs gate**

Run: `bun test lib commands packages`
Expected: PASS.

Run: `bun scripts/check-docs.ts`
Expected: PASS. This repo gates its docs; the new spec and plan added under `docs/superpowers/` must satisfy it. If it reports an unindexed file, add the entry it asks for.

- [ ] **Step 6: Commit**

```bash
git add lib/daemon/handlers/worktree.ts lib/daemon/__tests__/worktree-handlers.test.ts
git commit -m "RT: provision refusal names on-deck trees held by retry backoff

A wedged pool refused as a bare create-failed, which reads as one unlucky
create rather than three trees failing the same way."
```

- [ ] **Step 7: Commit the spec and plan**

```bash
git add docs/superpowers/specs/2026-08-21-daemon-spawn-env-contract.md docs/superpowers/plans/2026-08-21-daemon-spawn-env-contract.md
git commit -m "RT: spec + plan for the daemon spawn-env contract"
```

---

### Task 5: `~/.zshenv`'s fnm bootstrap stops depending on inherited PATH

**Files:**
- Modify: `~/.zshenv` (host config — outside the repo, no commit)

**Interfaces:**
- Consumes: nothing.
- Produces: a non-interactive zsh started with a minimal PATH resolves `node` at the version the cwd's version file pins.

- [ ] **Step 1: Record the failure this fixes**

```bash
cd /Users/matt/Documents/GitHub/acme/web
env -i HOME="$HOME" SHELL=/bin/zsh PATH=/usr/bin:/bin:/usr/sbin:/sbin \
  /bin/zsh -lc 'command -v node || echo "NODE-MISSING"'
```

Expected before the fix: `NODE-MISSING`. This is the exact condition a launchd-started daemon hands its children.

- [ ] **Step 2: Back up the file**

```bash
cp ~/.zshenv ~/.zshenv.bak-2026-08-21
```

- [ ] **Step 3: Replace the fnm block**

The current block is the end of `~/.zshenv` — lines 21-27, a three-line comment followed by the four-line `if`:

```zsh
if [[ ! -o interactive ]] && command -v fnm >/dev/null 2>&1; then
  eval "$(fnm env --version-file-strategy=recursive --shell zsh)"
  fnm use --silent-if-unchanged >/dev/null 2>&1 || true
fi
```

Replace it, and its preceding comment, with:

```zsh
# fnm for non-interactive shells (agents, scripts, launchd-started daemons);
# interactive setup lives in .zshrc. This file runs BEFORE ~/.zprofile's
# `brew shellenv`, so a `command -v fnm` guard here silently no-ops for every
# shell launchd starts — which strands `#!/usr/bin/env node` shebangs. Hence the
# absolute lookup. `fnm use` resolves the version file from the starting cwd,
# the non-interactive stand-in for .zshrc's chpwd hook; the `default` fallback
# mirrors that hook, because a cwd with no version file must still get a node.
if [[ ! -o interactive ]]; then
  for _fnm_candidate in /opt/homebrew/bin/fnm "$HOME/.local/bin/fnm" /usr/local/bin/fnm; do
    if [[ -x $_fnm_candidate ]]; then
      eval "$("$_fnm_candidate" env --version-file-strategy=recursive --shell zsh)"
      "$_fnm_candidate" use --silent-if-unchanged >/dev/null 2>&1 \
        || "$_fnm_candidate" use default --silent-if-unchanged >/dev/null 2>&1
      break
    fi
  done
  unset _fnm_candidate
fi
```

- [ ] **Step 4: Verify the minimal-PATH case now resolves the pinned version**

`/Users/matt/Documents/GitHub/acme/web/.nvmrc` pins `22.22.0`, while fnm's `default` alias is `v24.19.0` — so this also proves the per-repo version file wins over the default.

```bash
cd /Users/matt/Documents/GitHub/acme/web
env -i HOME="$HOME" SHELL=/bin/zsh PATH=/usr/bin:/bin:/usr/sbin:/sbin \
  /bin/zsh -lc 'node --version'
```

Expected: `v22.22.0`.

- [ ] **Step 5: Verify a repo with no version file still gets a node**

```bash
cd /tmp
env -i HOME="$HOME" SHELL=/bin/zsh PATH=/usr/bin:/bin:/usr/sbin:/sbin \
  /bin/zsh -lc 'node --version'
```

Expected: `v24.19.0` (the `default` alias, via the fallback).

- [ ] **Step 6: Verify interactive shells are unchanged**

```bash
cd /Users/matt/Documents/GitHub/acme/web && zsh -ic 'node --version'
```

Expected: `v24.19.0` — the `default` alias, *not* the repo's pinned 22.22.0. That is pre-existing and correct to leave alone: `.zshrc` runs `fnm env` at startup but only calls `fnm use` from its `chpwd` hook, so an interactive shell started inside a repo keeps the default until the first `cd`. Both the old and new `.zshenv` blocks gate on `[[ ! -o interactive ]]`, so this path is untouched by the change — the assertion here is "unchanged", not a particular version.

---

### Task 6: prune the fnm multishell leak

**Files:**
- Modify: `~/.local/state/fnm_multishells/` (host state — deletes files, no commit)

**Interfaces:**
- Consumes: Task 5 (do this after, so the new block's churn is included in the before-count and the guard is exercised against it).
- Produces: a pruned multishell directory. No repo artifact.

Every `fnm env` creates one symlink here and nothing removes them; the directory holds **over 150,000** entries and climbing (147,755 when the spec was written, 150,648 an hour later), with its link count saturated at 65535. Task 5 makes non-interactive shells bootstrap fnm successfully, which *increases* the rate. The guard below never deletes an entry whose owning PID is still alive, so a running shell — including the current daemon, whose resolved PATH points at one of these — cannot be stranded.

- [ ] **Step 1: Count what is there**

```bash
ls -1 ~/.local/state/fnm_multishells/ | wc -l
```

Expected: over 150,000, and higher than any figure quoted in this plan — the count grows with every non-interactive shell, so treat the number as a baseline to compare against step 4, not as a value to match.

- [ ] **Step 2: Dry-run the guard on a sample**

Confirm the PID guard both keeps live entries and identifies dead ones before deleting anything:

```bash
cd ~/.local/state/fnm_multishells
live=0; dead=0
for d in $(ls -1 | head -200); do
  pid=${d%%_*}
  if kill -0 "$pid" 2>/dev/null; then live=$((live+1)); else dead=$((dead+1)); fi
done
echo "sample of 200 → live:$live dead:$dead"
```

Expected: mostly `dead`, with `live` small. If `live` is 0 and `dead` is 200, that is fine; if the loop errors on a name without `_`, stop and report rather than deleting.

- [ ] **Step 3: Prune entries whose owning process is gone**

```bash
cd ~/.local/state/fnm_multishells
removed=0
for d in *(N); do
  pid=${d%%_*}
  [[ $pid == <-> ]] || continue
  kill -0 "$pid" 2>/dev/null && continue
  rm -f -- "$d" && removed=$((removed+1))
done
echo "removed: $removed"
```

The `[[ $pid == <-> ]]` test (zsh numeric-glob) skips any name that is not `<pid>_<ts>`, so an unexpected entry is left alone rather than deleted. `*(N)` is zsh's null_glob qualifier — an already-empty directory is not an error.

- [ ] **Step 4: Verify the survivors are live and node still resolves**

```bash
ls -1 ~/.local/state/fnm_multishells/ | wc -l
cd /Users/matt/Documents/GitHub/acme/web && zsh -ic 'node --version'
```

Expected: a much smaller count, and `v22.22.0` — the interactive shell re-creates its own entry on demand, so pruning cannot break it.

---

### Task 7: unwedge the pool and resume ACME-2899

**Files:**
- No file changes. Runtime operations plus one edit to the parked unit-of-work record.

**Interfaces:**
- Consumes: Tasks 1–6. Task 1 is what actually fixes the spawn; Tasks 5–6 harden the host.
- Produces: a provisioned worktree and branch for ACME-2899, and `stages.provision = "done"` with `branch` and `worktree` written into `~/.mattstack/work/acme-2899/uow.json`.

- [ ] **Step 1: Restart the daemon onto the fixed source**

rt runs in dev mode from source, so the running daemon (pid 29465) still has the old `runCapture`.

```bash
rt daemon restart
rt daemon status
```

Expected: `● running` with a fresh pid and uptime.

- [ ] **Step 2: Confirm the resolved PATH now reports node**

```bash
grep -h "PATH resolved" ~/.mattstack/rt/logs/daemon.$(date +%Y-%m-%d).*.log | tail -1
```

Expected: a line including `"hasNode":true` alongside `"hasPnpm":true` — the field Task 3 added.

- [ ] **Step 3: Force a freshen on each held tree**

Naming a tree bypasses its backoff (`worktree-reconciler.ts:795` skips the `nextRetryAt` check when a specific tree is requested). The tree is a positional argument, not a flag.

```bash
rt worktree freshen --repo acme-dev cho
rt worktree freshen --repo acme-dev dean
rt worktree freshen --repo acme-dev dudley
```

Expected: `✓ <name> freshened` for each. A `pnpm install` failure here means Task 1 did not take effect — check the daemon restarted onto the new source before going further.

- [ ] **Step 4: Confirm the pool is claimable again**

```bash
jq -r '.trees[] | select(.state=="on-deck") | "\(.name) nextRetryAt=\(.nextRetryAt // "none")"' \
  ~/.mattstack/rt/repos/acme-dev/worktrees.json
```

Expected: `nextRetryAt=none` for all three — `freshenOne` deletes it on success (`worktree-reconciler.ts:762`).

- [ ] **Step 5: Provision ACME-2899**

```bash
rt worktree provision --repo acme-dev --ticket acme-2899 \
  --title "Keep Emma Chat in URL when Navigating to Other Vehicles" --json
```

Expected: `{"ok":true, ... "data":{"path":"...","branch":"acme-2899-...","wasOnDeck":true}}`. `wasOnDeck:true` confirms it claimed a pool tree rather than cold-creating.

- [ ] **Step 6: Write the provision result into the unit-of-work record**

The record is parked at `stages.provision = "failed"`. Substitute the `branch` and `worktree` values the previous step returned:

```bash
cd ~/.mattstack/work/acme-2899
jq --arg branch '<branch from step 5>' --arg worktree '<data.path from step 5>' \
  '.branch = $branch | .worktree = $worktree | .stages.provision = "done"' uow.json > t \
  && mv t uow.json
cat uow.json
```

Expected: `branch` and `worktree` populated, `stages.provision` = `"done"`. The `acme:work` pipeline resumes at the `plan` stage from there.

---

## Self-Review

**Spec coverage.** Every decision and gap in the spec maps to a task: decision 1 → Task 1; decision 2 and 3 → Task 5 (step 4 proves the 22.22.0-over-default point); decision 4's accepted cost → Task 6; the three observability gaps → Tasks 2, 3 and 4 respectively; the wedged pool → Task 7. The spec's "long-term direction" and the gitlab 403/502 failures are marked out of scope there and carry no task, deliberately.

**Placeholders.** Two intentional substitutions remain, both in Task 7 step 6 (`<branch from step 5>`, `<data.path from step 5>`) — values that cannot exist until the command in step 5 runs. Every other step carries literal content.

**Type consistency.** `outputTail(output, maxChars)` and `MAX_LOGGED_OUTPUT` keep the signatures they had as private members of `create.ts`, so Task 2's move is behavior-preserving and `create.test.ts` stays valid. `probeTools` returns `Record<string, boolean>` keyed `has<Name>`, matching how Task 3's log spread and its tests consume it. `createFailedError`'s new second parameter is optional, so the untouched call site at line 434 still compiles. `backoffNote` takes `TreeRecord[]`, which is what `loadRegistry` returns.
