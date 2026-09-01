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

Read-only guarantee: resolving a repo's identity (the very first step,
before the daemon is even asked) never registers that repo into rt's index.
The hook derives the identity, then checks whether that identity is
*already* an index row -- a repo rt has never seen before reads as
unregistered and goes straight to the `.claude/worktrees/<name>` fallback,
even though the identity itself was perfectly derivable. Only a repo that
was registered some other way (an earlier `rt` command run inside it, a
prior worktree lifecycle command) reaches the real daemon-provisioning
path. The hook is never itself the reason a repo becomes known to rt.

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

This is the recipe used to prove the hook live, end to end, without
touching a real repo, the real `~/.claude`, or the real rt state. The
`env HOME=<isolated home>` on the hook command is the load-bearing part: it
is what makes the hook's own `rt` invocation read and write an isolated
`~/.mattstack`, never the real one, so the run cannot register a scratch
repo into (or read a stale answer from) rt's real index.

```bash
# 1. throwaway repo, isolated from any real work
mkdir -p /tmp/smoke/base /tmp/smoke/home
cd /tmp/smoke/base
git init -q
git commit --allow-empty -q -m "init"

# 2. a settings.json whose WorktreeCreate command runs the hook's rt code
#    under an isolated HOME (resolve bun with `which bun`)
cat > /tmp/smoke/settings.json <<'JSON'
{
  "hooks": {
    "WorktreeCreate": [
      { "hooks": [ { "type": "command",
        "command": "env HOME=/tmp/smoke/home <absolute bun> run <repo>/cli.ts worktree claude-hook" } ] }
    ]
  }
}
JSON

# 3. from inside base, run Claude Code headless against that settings file
claude -p "Use the EnterWorktree tool with name 'smoke1'. Then run pwd via Bash and report both outputs verbatim." \
  --allowedTools "EnterWorktree,Bash(pwd)" \
  --settings /tmp/smoke/settings.json
```

What to expect: the isolated HOME's rt index starts empty, so this scratch
repo reads as unregistered no matter what its identity derives to. The hook
falls back without ever asking the daemon, `EnterWorktree` reports a
created worktree at `/tmp/smoke/base/.claude/worktrees/smoke1`, and `pwd`
inside the session confirms that same path. Nothing under the isolated
home's `repo-index` namespace or the real `~/.mattstack` should show this
scratch repo afterward -- that is the read-only guarantee holding.

Clean up afterward: remove `/tmp/smoke` (both `base` and `home` are
throwaway and confined to the isolated HOME; nothing under the real
`~/.mattstack` needs pruning as a result of this recipe).
