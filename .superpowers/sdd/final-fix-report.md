# Final Fix Report

## Fix 1 (CRITICAL) -- TunnelManager async getProcess

**Files changed:** `lib/daemon/tunnel-manager.ts`, `lib/daemon/handlers/tunnel.ts`

Both synchronous `getProcess` callers in TunnelManager were fixed:

- `apply()` (line 70): changed to `await this.deps.processManager.getProcess(id)`.
- `status()` (line 90): changed to `await this.deps.processManager.getProcess(id)` and the method signature made `async`, returning `Promise<TunnelStatus>`.
- `tunnel.ts` handler for `tunnel:status`: updated to `await ctx.tunnelManager.status(boardName)` (one caller, already in an async handler -- no ripple).

**Other synchronous getProcess callers in lib/:** Surveyed with grep. The only other callers are:
- `lib/daemon/suspend-manager.ts` lines 69 and 79: already use `await this.processManager.getProcess(...)` -- no change needed.
- Test files (`suspend-manager.test.ts`, `process-manager*.test.ts`, `herdr-process-manager.test.ts`): all correct for their respective sync/async managers.
- Definition sites in `process-manager.ts` and `herdr-process-manager.ts`: not call sites.

No other production callers needed fixing.

## Fix 2 (IMPORTANT) -- Thread `kind` through herdr records

**Files changed:** `lib/daemon/herdr/pane-map.ts`, `lib/daemon/herdr-process-manager.ts`, `lib/daemon/herdr/records.ts`, `lib/daemon/herdr/__tests__/records.test.ts`

- `PaneRef` interface in `pane-map.ts`: added `kind?: "terminal"`.
- `HerdrProcessManager.spawn()`: added `kind: opts.kind` to the `PaneRef` object stored in `paneMap.set(ref)`.
- `paneToRecord()` in `records.ts`: added `kind: ref?.kind` to the returned `ProcessRecord`.
- `records.test.ts`: added three new tests covering `kind:"terminal"` propagation, `kind` omitted from ref (undefined), and no ref (undefined).

All 28 herdr tests pass (5 files).

## Fix 3 (MINOR) -- herdr userPath

**No change needed.** In `lib/daemon.ts`, the single `processManager` variable holds either `HerdrProcessManager` or `ProcessManager` depending on `useHerdr`. The assignment at line 326:

```ts
processManager.userPath = resolvedPath || process.env.PATH;
```

applies to whichever backend is active. Both `HerdrProcessManager` and `ProcessManager` have a `userPath` property. The herdr manager already receives the full resolved PATH.

## Test results

- `bun test lib/daemon/herdr/__tests__/`: 28 pass, 0 fail
- `bun test lib/daemon/__tests__/herdr-process-manager.test.ts`: 6 pass, 0 fail
- `bun test lib/daemon/__tests__/`: 196 pass, 0 fail
- `bun test lib/`: 326 pass, 3 skip, 0 fail

## TypeScript check

No errors in any of the modified files (`tunnel-manager.ts`, `herdr/pane-map.ts`, `herdr-process-manager.ts`, `herdr/records.ts`, `handlers/tunnel.ts`). Pre-existing errors in `daemon.ts` and vscode extension files are unrelated to these changes.
