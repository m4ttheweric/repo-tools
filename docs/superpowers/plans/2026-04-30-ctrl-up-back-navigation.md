# ctrl-up Back Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace all list-sentinel back-navigation entries (`↩ Switch repo`, `↩ Switch worktree`, `↰ ..`) with `ctrl-up`, shown as a header hint in the fzf picker.

**Architecture:** `filterableSelect` in `lib/rt-render.tsx` always passes `--expect=ctrl-up` and `--print-query` to fzf so output is always 3 lines (query / key / value). When `backLabel` is set and the key is `ctrl-up`, it throws `BackNavigation`. The `↩` sentinel row is removed from `filterableSelect`; `pickWorktreeWithSwitch` converts its hardcoded `SWITCH_REPO` sentinel to `backLabel`; `nav.ts` removes its `↰ ..` entry (ctrl-up already works there).

**Tech Stack:** TypeScript, Bun, fzf (CLI), Ink (fallback)

---

## Files

| File | Change |
|---|---|
| `lib/rt-render.tsx` | Remove sentinel injection; always use `--print-query` + `--expect=ctrl-up`; uniform 3-line output parsing; header hint; remove `startBindings` |
| `lib/pickers.ts` | `pickWorktreeWithSwitch`: drop SWITCH_REPO sentinel, use `backLabel`; `pickPackageWithEscape`: drop SWITCH_REPO sentinel, extend `backLabel` logic |
| `commands/nav.ts` | Remove `UP` constant, `↰ ..` option, and `choice === UP` branches |

---

### Task 1: Update `filterableSelect` — always-expect output parsing

**Files:**
- Modify: `lib/rt-render.tsx:323-408`

- [ ] **Step 1: Replace the `filterableSelect` function body**

Replace lines 323–408 with the following (keep the function signature and JSDoc intact; replace the body):

```typescript
export async function filterableSelect(opts: {
  message: string;
  options: SelectOption[];
  stderr?: boolean;
  /** When set, shows `ctrl-up: back` in the header and throws BackNavigation on ctrl-up. */
  backLabel?: string;
  /** Use fzf's exact-match mode instead of fuzzy matching. */
  exact?: boolean;
}): Promise<string | null> {
  const { spawnSync, execSync } = await import("child_process");

  const options = opts.options;

  let hasFzf = false;
  try {
    execSync("which fzf", { stdio: "pipe" });
    hasFzf = true;
  } catch {}

  if (!hasFzf) {
    return select({ ...opts, options });
  }

  const labelWidth = Math.max(...options.map((o) => o.label.length));
  const input = options
    .map((o) => {
      const pad = " ".repeat(labelWidth - o.label.length);
      const open = o.color ?? "";
      const close = o.color ? "\x1b[0m" : "";
      const hint = o.hint
        ? (o.color ? o.hint : `\x1b[2m${o.hint}\x1b[22m`)
        : "";
      return `${o.value}\t${open}\x1b[1m${o.label}\x1b[22m${pad}\t  ${hint}${close}`;
    })
    .join("\n");

  const header = opts.backLabel
    ? "enter: select  |: OR  !: exclude  ctrl-up: back"
    : "enter: select  |: OR  !: exclude";

  const result = spawnSync("fzf", [
    "--ansi",
    "--with-nth=2..",
    "--nth=1",
    "--delimiter=\t",
    "--tabstop=1",
    "--height=~100%",
    "--layout=reverse",
    "--border=rounded",
    `--border-label= ${opts.message} `,
    "--prompt=filter: ",
    `--header=${header}`,
    "--no-mouse",
    "--print-query",
    "--expect=ctrl-up",
    `--color=border:${toHex(T.pink)},label:${toHex(T.pink)}`,
    ...(opts.exact ? ["--exact"] : []),
  ], {
    input,
    stdio: ["pipe", "pipe", "inherit"],
    encoding: "utf8",
  });

  if (result.status !== 0) return null;

  // --print-query + --expect always produce 3 lines:
  //   line 0: query text
  //   line 1: key pressed ("" for Enter, "ctrl-up" if that key)
  //   line 2: selected row (tab-delimited)
  const lines = (result.stdout ?? "").split("\n");
  const key = lines[1]?.trim() || null;
  const raw = lines[2]?.trim() ?? "";

  if (key === "ctrl-up") {
    if (opts.backLabel) throw new BackNavigation();
    return null;
  }

  if (!raw) return null;
  return raw.split("\t")[0]!;
}
```

- [ ] **Step 2: Verify the Ink fallback `select()` still uses BACK sentinel**

Read `lib/rt-render.tsx` lines 103–138. Confirm `select()` still prepends `{ value: BACK, label: \`↩ ${opts.backLabel}\` }` and throws `BackNavigation` when `value === BACK`. No changes needed here — the Ink path is unchanged.

- [ ] **Step 3: Manual smoke test — no backLabel (no regression)**

Run `rt run` (or any command that invokes filterableSelect without backLabel). Verify the picker opens normally, filtering works, Enter selects, Escape cancels. ctrl-up with no parent level should simply close the picker (return null → process exits).

- [ ] **Step 4: Manual smoke test — backLabel present**

Run `rt cd` from inside a multi-worktree repo. Verify:
- The picker no longer shows a `↩ Switch to a different repo` row at the top
- The header shows `enter: select  |: OR  !: exclude  ctrl-up: back`
- Pressing ctrl-up returns to the repo picker

- [ ] **Step 5: Commit**

```bash
git add lib/rt-render.tsx
git commit -m "feat: replace filterableSelect back sentinel with ctrl-up"
```

---

### Task 2: Convert `pickWorktreeWithSwitch` to use `backLabel`

**Files:**
- Modify: `lib/pickers.ts:55-83`

- [ ] **Step 1: Update the import and function body**

Replace lines 55–83:

```typescript
export async function pickWorktreeWithSwitch(
  repo: KnownRepo,
  currentPath: string,
  opts?: { stderr?: boolean },
): Promise<string | typeof SWITCH_REPO> {
  const { filterableSelect, BackNavigation } = await import("./rt-render.tsx");

  if (repo.worktrees.length === 0) return SWITCH_REPO;

  const remoteUrl = await getRemoteUrl(repo.worktrees[0]?.path || currentPath);
  const options = await buildWorktreeOptions(repo.worktrees, remoteUrl);

  for (const opt of options) {
    if (opt.value === currentPath) opt.hint = "(current)";
  }

  try {
    return await filterableSelect({
      message: `${repo.repoName} worktrees`,
      options,
      backLabel: "Switch to a different repo",
      ...(opts?.stderr ? { stderr: true } : {}),
    }) as string;
  } catch (err) {
    if (err instanceof BackNavigation) return SWITCH_REPO;
    throw err;
  }
}
```

Note: the `as string` cast is safe — callers already guard against null with `if (!result) process.exit(0)`, preserving existing behaviour.

- [ ] **Step 2: Verify callers are unchanged**

Check that `commands/cd.ts` (line ~206) and `lib/pickers.ts` `pickPackageWithEscape` (line ~219) still call `pickWorktreeWithSwitch` and check `isSwitchRepo(result)` exactly as before. No changes needed — the function still returns `SWITCH_REPO` on ctrl-up.

- [ ] **Step 3: Manual smoke test**

Run `rt cd` inside a multi-worktree repo. Verify the worktree picker:
- No longer shows `↩ Switch to a different repo` row
- Header shows `ctrl-up: back`
- ctrl-up navigates to the repo picker

- [ ] **Step 4: Commit**

```bash
git add lib/pickers.ts
git commit -m "feat: convert pickWorktreeWithSwitch sentinel to ctrl-up backLabel"
```

---

### Task 3: Convert `pickPackageWithEscape` SWITCH_REPO sentinel to `backLabel`

**Files:**
- Modify: `lib/pickers.ts:183-230`

- [ ] **Step 1: Replace the while-loop body in `pickPackageWithEscape`**

Replace lines 183–230 (the `while (true)` block and its contents):

```typescript
  while (true) {
    const options: { value: string; label: string; hint: string }[] = [
      { value: worktreePath, label: "(root)", hint: currentBranch },
      ...packages.map((p) => ({
        value: join(worktreePath, p.path),
        label: p.name,
        hint: p.path,
      })),
    ];

    const backLabel = hasMultipleWorktrees
      ? "Switch worktree"
      : hasMultipleRepos
        ? "Switch repo"
        : undefined;

    try {
      const picked = await filterableSelect({
        message: `${repo.repoName}`,
        options,
        backLabel,
        ...(opts?.stderr ? { stderr: true } : {}),
      });

      if (!picked) process.exit(1);
      return picked;

    } catch (err) {
      if (err instanceof BackNavigation) {
        if (hasMultipleWorktrees) {
          // ctrl-up → "Switch worktree"
          if (hasMultipleRepos) {
            const wtResult = await pickWorktreeWithSwitch(repo, worktreePath, opts);
            if (isSwitchRepo(wtResult)) {
              return pickFromAllRepos(allRepos, { ...opts, includePackages: true });
            }
            return wtResult;
          } else {
            return await pickWorktreeFromRepo(repo, `${repo.repoName} worktrees`);
          }
        } else if (hasMultipleRepos) {
          // ctrl-up → "Switch repo" (no worktrees to switch between)
          return pickFromAllRepos(allRepos, { ...opts, includePackages: true });
        }
      }
      throw err;
    }
  }
```

- [ ] **Step 2: Verify `SWITCH_REPO` is no longer used in `pickPackageWithEscape`**

Grep for `SWITCH_REPO` in `lib/pickers.ts`. It should only appear in:
- `const SWITCH_REPO = "__switch_repo__"` (line 13)
- `pickWorktreeWithSwitch` return value (Task 2)
- `isSwitchRepo` helper (line ~155)
- Any callers of `isSwitchRepo` in `pickPackageWithEscape`'s BackNavigation catch

If `SWITCH_REPO` appears nowhere else in `pickPackageWithEscape`, proceed.

- [ ] **Step 3: Manual smoke test**

Run `rt cd` inside a monorepo with multiple repos but one worktree. Verify:
- Package picker shows no `↩ Switch repo` sentinel row
- Header shows `ctrl-up: back`
- ctrl-up navigates directly to repo picker

Run `rt cd` inside a monorepo with multiple worktrees. Verify:
- ctrl-up shows worktree picker
- ctrl-up from worktree picker shows repo picker (if multiple repos)

- [ ] **Step 4: Commit**

```bash
git add lib/pickers.ts
git commit -m "feat: convert pickPackageWithEscape SWITCH_REPO sentinel to ctrl-up"
```

---

### Task 4: Remove `↰ ..` sentinel from `rt nav`

**Files:**
- Modify: `commands/nav.ts:21,228-260,267-306`

- [ ] **Step 1: Remove `UP` constant**

Delete line 21:
```typescript
const UP = "__rt_nav_up__";
```

- [ ] **Step 2: Remove `↰ ..` from the options array**

In the `navigate` function's while loop, replace:

```typescript
    const options: FzfOption[] = [
      ...(!atRoot
        ? [{ value: UP, label: "↰ ..", hint: tildeify(dirname(cwd)) }]
        : []),

      ...folders.map((name) => ({
```

With:

```typescript
    const options: FzfOption[] = [
      ...folders.map((name) => ({
```

- [ ] **Step 3: Remove the `defaultPos` sentinel-skip and simplify the `runFzf` call**

Replace:

```typescript
    // Skip the "↰ .." sentinel for the initial cursor when present and no resume state.
    const defaultPos = !atRoot && options.length > 1 ? 2 : null;
    const { value: choice, key, query } = await runFzf(
      options,
      tildeify(cwd),
      undefined,
      undefined,
      resumeQuery,
      resumeValue,
      defaultPos,
    );
```

With:

```typescript
    const { value: choice, key, query } = await runFzf(
      options,
      tildeify(cwd),
      undefined,
      undefined,
      resumeQuery,
      resumeValue,
    );
```

- [ ] **Step 4: Remove `choice === UP` from the ctrl-k guard**

Replace:

```typescript
    if (key === "ctrl-k") {
      if (choice === null || choice === UP) {
        // No-op, but preserve filter state
        resumeQuery = query;
        resumeValue = choice ?? "";
        continue;
      }
```

With:

```typescript
    if (key === "ctrl-k") {
      if (choice === null) {
        resumeQuery = query;
        resumeValue = "";
        continue;
      }
```

- [ ] **Step 5: Remove the `if (choice === UP)` branch entirely**

Delete lines 298–306:

```typescript
    if (choice === UP) {
      if (key === "ctrl-space") {
        process.stdout.write = realStdoutWrite;
        realStdoutWrite(dirname(cwd) + "\n");
        return;
      }
      cwd = dirname(cwd);
      continue;
    }
```

- [ ] **Step 6: Manual smoke test**

Run `rt nav`. Verify:
- The `↰ ..` row no longer appears at the top of folder listings
- ctrl-up still navigates up a directory
- ctrl-space on a folder still cds to it
- ctrl-k still opens the action menu on files/folders (not on empty results)
- Escape cancels and returns to the shell

- [ ] **Step 7: Commit**

```bash
git add commands/nav.ts
git commit -m "feat: remove nav ↰ .. sentinel, ctrl-up already handles going up"
```
