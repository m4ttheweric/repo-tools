# Claude Code worktree hook

## What it is

Claude Code fires a `WorktreeCreate` hook whenever its `EnterWorktree` tool
runs, and a `WorktreeRemove` hook on the matching teardown. rt can sit behind
both: on create it asks the daemon to provision a real rt-managed tree for
the name Claude passed (ticket-shaped names like `RT-40-fix-thing` parse into
a ticket + title); on remove it disposes that tree if rt's registry claims
it. The hook is a hidden, agent-facing verb (`rt worktree claude-hook`),
never run by a person directly. Installing it is opt-in: `rt worktree hook
install` writes the two entries into `~/.claude/settings.json`, and every
worktree lifecycle command offers to install it once on a TTY if it sees the
settings file but no hook yet.

## Install, uninstall, status

```bash
rt worktree hook install     # writes the WorktreeCreate + WorktreeRemove pair
rt worktree hook uninstall   # drops rt's entries (escape hatch, see below)
rt worktree hook status      # reports installed/not, the command, binary health
```

All three accept `--json`. `install` refuses if `rt` is not on PATH. `status`
reads `~/.claude/settings.json` directly; it does not call the daemon.

## Behavior

The create hook decides in this order: resolve a repo identity for the given
cwd, ask the daemon to provision, and fall back to a plain `git worktree add`
under `<repo root>/.claude/worktrees/<name>` whenever the daemon path cannot
answer for it.

| Situation | What happens |
| --- | --- |
| Repo identity resolves and the daemon provisions cleanly | Claude lands in the real rt-managed tree; stdout is that tree's path. |
| Daemon unreachable (not installed, socket gone, restart attempt fails) | Silent fallback to `git worktree add` under `.claude/worktrees/<name>`. |
| Daemon answers `repo-unknown` for the identity | Same fallback as above. |
| Daemon answers any other refusal (branch already attached, validation failure, provisioning step failure) | Loud refusal: Claude's `EnterWorktree` call fails and shows the error, with the escape hatch named in the message. |

One nuance worth knowing: resolving a repo's identity (the very first step,
before the daemon is even asked) has a side effect of registering that repo
into rt's own index if it was not there already. So "the daemon has never
heard of this repo" is not the same as "the daemon replies `repo-unknown`" --
a brand new git repo the hook fires against gets folded into rt's index on
that very first call, then goes through the real provisioning path. If that
repo has an `origin` remote, provisioning usually succeeds (a real rt tree,
not a `.claude/worktrees` one). If it does not, provisioning fails at the
`git fetch origin <branch>` step and the hook refuses loudly rather than
falling back. The clean `repo-unknown` -> fallback path in the table above
is really the daemon-unreachable case; a locally resolvable git repo rarely
takes it.

## Failure mode: binary gone

The installed hook command is an absolute path to the `rt` binary at install
time. If that binary is moved, uninstalled, or the machine's rt install is
removed, `WorktreeCreate` (and `WorktreeRemove`) fail for every repo that
has the hook installed, because Claude Code has no fallthrough when a hook
command cannot run at all -- `EnterWorktree` simply breaks, everywhere, until
the entries are gone. The escape hatch is:

```bash
rt worktree hook uninstall
```

Run it from anywhere the `rt` binary still resolves (or a fresh install), or
by hand-editing `hooks.WorktreeCreate` / `hooks.WorktreeRemove` out of
`~/.claude/settings.json` if no working `rt` is available at all. `rt worktree
hook status` names the same escape hatch when it detects the binary is
missing.

## Manual verification (headless smoke recipe)

This is the recipe used to prove the hook live, end to end, without touching
a real repo or the real `~/.claude`. Run it in a throwaway scratch directory.

```bash
# 1. throwaway repo, isolated from any real work
mkdir -p /tmp/smoke && cd /tmp/smoke
git init base -q
cd base && git commit --allow-empty -q -m "init"

# 2. a settings.json whose WorktreeCreate command points straight at the
#    worktree checkout's cli.ts via bun (resolve bun with `which bun`)
cat > /tmp/smoke/settings.json <<'JSON'
{
  "hooks": {
    "WorktreeCreate": [
      { "hooks": [ { "type": "command",
        "command": "<absolute bun> run <repo>/cli.ts worktree claude-hook" } ] }
    ]
  }
}
JSON

# 3. from inside base, run Claude Code headless against that settings file
claude -p "Use the EnterWorktree tool with name 'smoke1'. Then run pwd via Bash and report both outputs verbatim." \
  --allowedTools "EnterWorktree,Bash(pwd)" \
  --settings /tmp/smoke/settings.json
```

What to expect: since this scratch repo has no `origin` remote, the identity
resolution step still registers it (see the nuance above), so real
provisioning is attempted and fails at `git fetch origin master`. The
`EnterWorktree` call surfaces that failure verbatim (including the
`rt worktree hook uninstall` escape hatch), and `pwd` confirms Claude never
left the original directory. A scratch repo with a working `origin` remote
would instead land in a real rt-provisioned tree.

Clean up afterward: remove the scratch repo and (since resolving its
identity registers it) run `rt repos prune --dry-run` once the path is gone
to confirm nothing was left dangling in rt's own index.
