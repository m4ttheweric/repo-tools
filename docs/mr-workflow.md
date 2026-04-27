# MR workflow — `rt mr` / `rt pr`

Atomic commands for the push → MR-description → MR-create flow against a GitLab
remote. Each command is independently useful; `rt mr ship` is the all-in-one
composite for daily use.

GitLab only today (`glab` must be installed + authenticated). GitHub repos exit
with a hint to use `gh pr create` directly — GitHub support will land later.

`mr` and `pr` are interchangeable — `rt mr open` and `rt pr open` point at the
same handler.

## Atoms at a glance

| Command | Does | Shape |
|---|---|---|
| `rt mr open` | Creates a bare MR via `glab` | Thin wrapper, no agent |
| `rt mr describe` | Drafts a description with an agent | Streams to stdout |
| `rt mr ship` | Push + describe + open | Daily driver composite |

---

## The three atoms

### `rt mr open`
[commands/mr.ts:openCommand](../commands/mr.ts)

Opens a bare MR on the current (already-pushed) branch. Thin wrapper around
`glab mr create` — no agent, no description magic.

```
rt mr open                                   # uses commit info (glab --fill) for body
rt mr open --description-file draft.md       # read body from a file
printf "body\n" | rt mr open --description-file -   # body from stdin
rt mr open --title "fix: foo" --target main --draft
rt mr open --web                             # open MR in browser after creation
rt mr open --dry-run                         # print the glab command, don't run
```

**Guards** — exits with an actionable message if:
- the remote isn't GitLab,
- the branch isn't pushed (`run rt git push first`),
- there are zero commits between the branch and target.

**Title** defaults to the last commit subject. **Target** defaults to
`mr.json.target`, then `origin/HEAD`.

---

### `rt mr describe`
[commands/mr.ts:describeCommand](../commands/mr.ts)

Drafts an MR description with an agent, using the per-repo prompts + context
defined in `mr.json`. **Streams the description to stdout**; status chatter
goes to stderr. Designed to pipe cleanly into `rt mr open`.

```
rt mr describe                       # stream draft to terminal
rt mr describe > draft.md            # capture; status still visible on stderr
rt mr describe | rt mr open --description-file -
rt mr describe --inline "call out the breaking flag change"
rt mr describe --debug               # print the assembled prompt, skip the agent
rt mr describe --target main         # override target for the diff base
```

**Agent** defaults to `claude -p`. Override via `mr.json`'s `agent` block
(e.g. `cursor-agent` or `codex`).

**Diff cap** defaults to 80KB; oversized diffs get truncated with a marker.
Raise via `agent.maxDiffKb` in `mr.json`.

---

### `rt mr ship`
[commands/mr.ts:shipCommand](../commands/mr.ts)

The daily driver. Composite that chains:

1. `rt git push` (auto upstream-fix; prompts force-with-lease if diverged)
2. `rt mr describe` (streams the agent's draft live)
3. `rt mr open` (passes the captured draft as `--description`)
4. Prints the MR URL

```
rt mr ship                      # the whole flow, end to end
rt mr ship --inline "highlight the RLS change"
rt mr ship --draft --web
rt mr ship --dry-run            # rehearsal: nothing pushed, no MR created
rt mr ship --debug              # stops after the draft is printed, no MR
```

If any step fails (push rejection, agent error, glab error) the command exits
before the next step runs. You can recover by invoking the remaining atoms by
hand.

---

## Config — `~/.rt/<repo>/mr.json`

Sibling of `sync.json`. All fields optional — zero-config works with sensible
defaults; the agent-related fields only matter for `describe` / `create`.

```jsonc
{
  // Open-atom defaults
  "target": "master",
  "draft": false,
  "removeSourceBranch": true,   // true → pass --remove-source-branch; unset → use project default
  "squash": false,              // true → pass --squash-before-merge

  // Describe-atom inputs
  "prompts": [
    "~/.cursor/rules/mr-writing-style.mdc"
  ],
  "context": {
    "include": [
      "docs/feature-management/skills/fm-mr-writeup/SKILL.md",
      "docs/feature-management/skills/fm-mr-writeup/references/*.md"
    ],
    "exclude": ["**/ignore/**"]
  },
  "inline": "Always flag RLS or schema-migration MRs in the summary.",

  // Agent override
  "agent": {
    "cli": "claude",         // default; "codex" uses args ["exec", "-"]
    "args": ["-p"],          // optional override
    "maxDiffKb": 80          // default diff-truncation cap
  }
}
```

### `prompts` vs `context`

Both end up concatenated into the agent's prompt, but differ in loading rules
and intent.

| | **`prompts`** | **`context.include`** |
|---|---|---|
| **Path style** | Explicit paths, one per entry | Repo-root-relative **globs** |
| **Resolution** | Absolute / `~/...` / relative to `~/.rt/<repo>/` | Matched via `git ls-files` from repo root |
| **File source** | Anywhere on disk | Only git-tracked files in the current repo |
| **`.mdc` frontmatter** | Stripped automatically | Passed through raw |
| **Missing file** | Yellow warning on stderr | Silently skipped |
| **Prompt section** | `# Style and template guidance` | `# Additional context files` (wrapped in code fences) |
| **Intended for** | The **instructions** — how to write | The **material** the instructions reference |

Rule of thumb: user-level style guides and anything not in the repo go in
`prompts`; repo-tracked templates / reference docs go in `context` so every
worktree of the repo picks them up automatically.

### Path resolution for `prompts`

- `/absolute/path` → used as-is.
- `~/something` → `$HOME/something`.
- `something/else` → resolved against `~/.rt/<repo>/`.

### `context` globs

Matched via `git ls-files -- <glob>` from the repo root, so:
- `.gitignore` is honored (non-tracked files never appear).
- Patterns are standard git pathspecs (`docs/**/*.md`, etc.).
- Works from any worktree without hardcoded worktree paths.

`exclude` patterns are then applied on top using `Bun.Glob`.

### Agent invocation

The agent runner ([lib/agent-runner.ts](../lib/agent-runner.ts)) spawns the
configured CLI with the assembled prompt piped on stdin. Defaults are
agent-aware:

```
claude -p < <assembled-prompt>
codex exec - < <assembled-prompt>
```

Stdout streams live to your terminal and is simultaneously captured for the
composite command (`rt mr ship`) to forward into `glab mr create
--description`.

---

## Typical workflows

### Daily driver

```bash
# on a feature branch with commits
rt mr ship
```

Watch push happen, watch the agent draft the description, see the URL.

### Draft in a branch, polish, then open manually

```bash
rt git push
rt mr describe > /tmp/draft.md
$EDITOR /tmp/draft.md
rt mr open --description-file /tmp/draft.md --web
```

### One-off override without editing `mr.json`

```bash
rt mr ship --inline "heads-up: flips the ff_new_pricing default to on"
```

### Dry-run the whole chain

```bash
rt mr ship --dry-run
```

Push prints the command without running; describe calls the agent for real
(it's the only non-destructive step); open prints the glab command without
running.

### See the exact prompt the agent receives

```bash
rt mr describe --debug
```

No agent call — the assembled prompt prints to stdout (status to stderr).
Handy for tuning `prompts` / `context` / `inline`.

---

## Pipeline composition

The atoms are designed to pipe:

```bash
rt mr describe | rt mr open --description-file -
```

`describe`'s stdout is pure markdown (all status goes to stderr) so downstream
consumers — `open --description-file -`, `tee`, your editor — get clean input.

---

## Failure modes

| Symptom | Cause | Fix |
|---|---|---|
| `GitHub not supported yet` | `github.com` remote | Use `gh pr create`. |
| `<branch> has not been pushed yet` | `open` can't find `origin/<branch>` | Run `rt git push` first (or use `rt mr ship`). |
| `no commits between origin/<target> and <branch>` | Branch is up to date with target | Commit something, rebase off a stale target, or pick a different `--target`. |
| `prompt not found: ...` (yellow) | A `prompts[]` path didn't resolve | Fix the path, or remove it from `mr.json`. |
| `agent exited <N>` | The CLI (`claude` / `cursor-agent` / `codex`) failed | Check CLI auth; try the command directly with the prompt piped in. |
| `glab exited <N>` | glab rejected the MR | Read the stderr — usually a project-rule violation (missing template fields, invalid target). |

---

## Related files

- [commands/mr.ts](../commands/mr.ts) — all three handlers + shared helpers.
- [lib/mr-config.ts](../lib/mr-config.ts) — config loader, path resolution, `.mdc` frontmatter strip.
- [lib/agent-runner.ts](../lib/agent-runner.ts) — generic `runAgent({ cli, args, prompt, stream })`. Reusable by future `rt commit describe`, `rt pr review`, etc.
- [commands/git/push.ts](../commands/git/push.ts) — the push atom that `rt mr ship` calls in step 1.
