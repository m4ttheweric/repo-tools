# Preset launch via the runner board: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `rt run` presets launch as a seeded `rt runner` board (each preset entry a tracked board row), replacing the raw-pane `launchInHerdr` path; non-herdr keeps `launchFallback`.

**Architecture:** The Runner gains a `seed` of pre-resolved entries launched on open (reusing its own launch path, minus the picker). `commands/runner.ts` exposes a seeded entry point. `commands/run.ts` `launchPreset` maps a preset's entries to that seed and routes to the runner when herdr is available.

**Tech Stack:** Bun 1.3.x + TypeScript. The runner (`lib/runner/*`), the rt-ui board (Go, unchanged), herdr engine over `lib/herdr/client.ts`, fakes in `lib/herdr/__tests__/fake-herdr.ts` and `lib/ui/__tests__/fake-rt-ui.ts`.

**Spec:** `docs/superpowers/specs/2026-08-31-preset-runner-launch-design.md`

**Contract:** `PresetEntry` (`lib/run-presets.ts`) is `{ packageRelPath: string; packageLabel: string; script: string; variationName?: string; command?: string }`.

## Global Constraints

- Never use em dashes or en dashes; never write the phrase "load bearing". Comments state constraints the code cannot show, not narration.
- The command never calls the daemon; no herdr logic outside `lib/runner/engine.ts`. The seed reuses the runner's existing launch path.
- `run()` resolves only after the session ends and teardown ran; it never calls `process.exit`.
- The runner's locked contracts hold: the board emits `quit` via `tea.Sequence` (closed is the final wire line); `deriveState` holds a `stopping` entry until its `__rt_exit` sentinel.
- Tests drive injected fakes only. NEVER a real herdr socket or a real `rt-ui` spawn.
- Commit trailer, exactly: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- Gates per task as listed; the whole-branch gate is `bunx tsc --noEmit`, `bun test lib/runner commands`, `bun run picker:check`, `bun run docs:check`.

---

### Task 1: Seed the Runner

**Files:**
- Modify: `lib/runner/runner.ts`
- Test: `lib/runner/__tests__/runner.test.ts`

**Interfaces:**
- Produces: `export interface SeedEntry { name: string; command: string; cwd: string; pkg: string; repo: string }`; `RunnerDeps` gains `seed?: SeedEntry[]`; a private `launchResolved(seed: SeedEntry): Promise<void>` reused by `add()` and the seed loop.
- Consumes: existing `newEntry`, `launch`, `push`, `openBoard` in `runner.ts`.

- [ ] **Step 1: Write the failing test**

Add to `lib/runner/__tests__/runner.test.ts` a test that a seeded runner launches its seed entries on open, with no `resolve()` call. Use the existing fake engine/session pattern in that file (a `deps()` helper builds `RunnerDeps`; a `FakeEngine` records `run:<paneId>:<cwd>:<command>` calls; `resolve` can be a spy that throws if called). Seed two entries and assert both reached `engine.run` with the right cwd+command, that `runner.entries` has both (state `starting`), and that `resolve` was never called:

```ts
test("a seeded runner launches its seed entries on open without the picker", async () => {
  const engine = new FakeEngine();
  let resolveCalls = 0;
  const seed = [
    { name: "dev", command: "bun run dev", cwd: "/repo/web", pkg: "web", repo: "acme" },
    { name: "api", command: "bun run api", cwd: "/repo/api", pkg: "backend", repo: "acme" },
  ];
  const r = new Runner(deps({ engine, resolve: async () => { resolveCalls++; return { kind: "launched" as const }; }, seed }));
  const finished = r.run();
  // drive the session to quit so run() resolves (mirror the file's existing quit-to-finish helper)
  await quitAndFinish(r, finished); // use whatever the file already uses to end a session
  expect(resolveCalls).toBe(0);
  expect(r.entries.map((e) => e.name)).toEqual(["dev", "api"]);
  expect(engine.calls.some((c) => c.startsWith("run:") && c.includes("/repo/web") && c.includes("bun run dev"))).toBe(true);
  expect(engine.calls.some((c) => c.startsWith("run:") && c.includes("/repo/api") && c.includes("bun run api"))).toBe(true);
});
```

Match the exact fake/driver helpers already in the file (FakeEngine's call-log format, the session-quit helper, and how `deps()` is written); adapt the assertions to that format. If `deps()` does not yet accept overrides for `seed`, extend it to pass `seed` through.

- [ ] **Step 2: Run it to make sure it fails**

Run: `bun test lib/runner/__tests__/runner.test.ts -t "seeded runner launches"`
Expected: FAIL (seed not launched; `resolve` may be called or entries empty).

- [ ] **Step 3: Implement the seed**

In `lib/runner/runner.ts`:
- Add `export interface SeedEntry { name: string; command: string; cwd: string; pkg: string; repo: string }`.
- Add `seed?: SeedEntry[]` to `RunnerDeps`.
- Extract the create-and-launch tail of `add()` into `private async launchResolved(s: SeedEntry): Promise<void>` that does `const entry = newEntry(++this.seq, s.name, s.command, s.cwd, s.pkg, s.repo); this.entries.push(entry); await this.launch(entry);`. Have `add()` call `await this.launchResolved({ name: r.script || basename(r.targetDir), command: r.commandTemplate, cwd: r.targetDir, pkg: r.packageLabel, repo: basename(r.worktree) })` after a resolved result (preserve the existing add behavior exactly).
- In `run()`, after `openBoard()` and before the intent loop, add: `for (const s of this.deps.seed ?? []) { await this.launchResolved(s); } this.push();`. Leave the rest of `run()` (loop, finally-teardown) unchanged.

- [ ] **Step 4: Run the tests**

Run: `bun test lib/runner/` and `bunx tsc --noEmit`
Expected: PASS (new test green, existing runner tests still green, tsc clean).

- [ ] **Step 5: Commit**

```bash
git add lib/runner/runner.ts lib/runner/__tests__/runner.test.ts
git commit -m "runner: seed pre-resolved entries launched on open"
```

---

### Task 2: A seeded entry point in the runner command

**Files:**
- Modify: `commands/runner.ts`
- Test: `commands/__tests__/runner-command.test.ts`

**Interfaces:**
- Consumes: Task 1's `SeedEntry`, `RunnerDeps.seed`; existing `buildRunnerDeps`, the gate (`interactive()`, `herdrAvailable()`), `Runner`.
- Produces: `buildRunnerDeps(args, ctx, sock, seed?)` carrying the seed; `export async function runSeededBoard(seed: SeedEntry[], ctx: CommandContext): Promise<void>` (same gate + build + run as `runnerCommand`, but with the seed and no args-driven resolve for the seeded rows).

- [ ] **Step 1: Write the failing test**

Add to `commands/__tests__/runner-command.test.ts` a test that `buildRunnerDeps` carries a passed seed into the deps, and that `runSeededBoard` gates like `runnerCommand` (prints one line + exits 1 when not interactive or herdr unavailable). Reuse the existing gate seams (`gate.__test__`, `spawn.__test__`) the file already uses:

```ts
test("buildRunnerDeps carries the seed through", () => {
  const seed = [{ name: "dev", command: "bun run dev", cwd: "/repo/web", pkg: "web", repo: "acme" }];
  const deps = buildRunnerDeps([], fakeCtx(), "/tmp/sock", seed);
  expect(deps.seed).toEqual(seed);
});

test("runSeededBoard exits 1 with one line when herdr is unavailable", async () => {
  // set the gate seams so interactive() is true but herdrAvailable() is false, mirroring the existing gated-out test
  // assert exit code 1 and exactly one stderr line, and that no Runner/herdr work happened
});
```

Model the gate-out assertions on the existing `runnerCommand` gated-out tests in the same file (same seam-setting, same exit/stderr expectations).

- [ ] **Step 2: Run it to make sure it fails**

Run: `bun test commands/__tests__/runner-command.test.ts -t "seed"`
Expected: FAIL (`buildRunnerDeps` has no seed param; `runSeededBoard` undefined).

- [ ] **Step 3: Implement**

In `commands/runner.ts`:
- Add an optional `seed?: SeedEntry[]` parameter to `buildRunnerDeps(args, ctx, sock, seed?)` and include `seed` in the returned `RunnerDeps`. Import `SeedEntry` from `lib/runner/runner.ts` and re-export it.
- Factor the gate + engine/deps build + `new Runner(deps).run()` sequence out of `runnerCommand` into a small internal helper `async function gateAndRun(ctx, seed?): Promise<void>` (runs `interactive()`/`herdrAvailable()` checks with the one-line + exit(1) behavior, resolves the sock, builds deps via `buildRunnerDeps([], ctx, sock, seed)` for the seeded case, and runs). `runnerCommand` keeps its current arg-driven resolve path; for the seeded path the `resolve` closure can stay as the normal `() => resolveRun([], ctx)` (used only if the user presses `a` in-board). Export `runSeededBoard(seed, ctx) { return gateAndRun(ctx, seed); }`.
- Do NOT change `runnerCommand`'s externally observable behavior (its own tests must still pass).

- [ ] **Step 4: Run the tests**

Run: `bun test commands/__tests__/runner-command.test.ts` and `bunx tsc --noEmit` and `bun run picker:check` and `bun run docs:check`
Expected: PASS all (the existing runnerCommand tests unchanged, the two new tests green, gates green).

- [ ] **Step 5: Commit**

```bash
git add commands/runner.ts commands/__tests__/runner-command.test.ts
git commit -m "runner command: seeded entry point (buildRunnerDeps seed + runSeededBoard)"
```

---

### Task 3: Route launchPreset through the runner

**Files:**
- Modify: `commands/run.ts`
- Test: `commands/__tests__/run-preset-launch.test.ts` (new)

**Interfaces:**
- Consumes: Task 2's `runSeededBoard`, `SeedEntry`; existing `findPreset`/`Preset`, `detectPackageManager`, `herdrAvailable`, `launchFallback`, `LaunchItem`.

- [ ] **Step 1: Write the failing test**

Create `commands/__tests__/run-preset-launch.test.ts`. Extract the preset->seed mapping into a pure, exported function so it is testable without spawning anything, and test it directly:

```ts
import { presetToSeed } from "../run.ts";

test("presetToSeed maps preset entries to seed entries", () => {
  const preset = { name: "backend-lite", entries: [
    { packageRelPath: "apps/web", script: "dev" },
    { packageRelPath: "apps/api", script: "start", command: "node server.js" },
  ]};
  const seed = presetToSeed(preset, "/home/me/repo");
  expect(seed).toEqual([
    { name: "dev", command: expect.stringContaining("run dev"), cwd: "/home/me/repo/apps/web", pkg: "apps/web", repo: "repo" },
    { name: "start", command: "node server.js", cwd: "/home/me/repo/apps/api", pkg: "apps/api", repo: "repo" },
  ]);
});
```

(Match the exact `pkg` label the current `LaunchItem.label` derivation uses; if it is a package display label rather than the rel path, use that same derivation in `presetToSeed` and in the assertion.)

- [ ] **Step 2: Run it to make sure it fails**

Run: `bun test commands/__tests__/run-preset-launch.test.ts`
Expected: FAIL (`presetToSeed` not exported).

- [ ] **Step 3: Implement**

In `commands/run.ts`:
- Add `export function presetToSeed(preset: Preset, worktreePath: string): SeedEntry[]` that maps each `PresetEntry` to a `SeedEntry` per the spec (`name` = script; `command` = `e.command ?? \`${detectPackageManager(join(worktreePath, e.packageRelPath))} run ${e.script}\``; `cwd` = `join(worktreePath, e.packageRelPath)`; `pkg` = the same package label the current `LaunchItem.label` uses; `repo` = `basename(worktreePath)`). Import `SeedEntry` from `commands/runner.ts` (or `lib/runner/runner.ts`).
- In `launchPreset`, replace the `isInsideHerdr()` -> `launchInHerdr(items)` branch: build `const seed = presetToSeed(preset, worktreePath)`; if `await herdrAvailable()` then `await runSeededBoard(seed, ctx)`; else `launchFallback(items)`. Keep the `preset <name>` breadcrumb. `launchPreset` will need the `ctx` (thread `CommandContext` in from its caller; the caller already has it in the resolve flow).

- [ ] **Step 4: Run the tests + gates**

Run: `bun test commands/ lib/runner` and `bunx tsc --noEmit` and `bun run picker:check` and `bun run docs:check`
Expected: PASS all.

- [ ] **Step 5: Commit**

```bash
git add commands/run.ts commands/__tests__/run-preset-launch.test.ts
git commit -m "run: launch presets via the seeded runner board"
```

## Self-Review

- Spec coverage: Task 1 (seed the Runner), Task 2 (seeded entry point), Task 3 (launchPreset routing) cover the spec's three design points. Non-herdr fallback preserved in Task 3.
- Placeholder scan: each step has concrete code/commands; adapt the fake/label derivations to the exact existing forms named in the steps.
- Type consistency: `SeedEntry` defined in Task 1, consumed in Tasks 2 and 3; `runSeededBoard`/`buildRunnerDeps(...,seed)` produced in Task 2, consumed in Task 3.
