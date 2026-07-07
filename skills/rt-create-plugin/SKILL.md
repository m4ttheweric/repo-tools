---
name: rt-create-plugin
description: Use when asked to create, extend, debug, or validate an rt user plugin, to add a custom command to rt, or when working in a plugin folder under ~/.rt/plugins/.
---

# Building rt user plugins

rt supports user plugins: a folder at `~/.rt/plugins/<name>/` with a declarative `plugin.json` manifest whose commands are TypeScript modules (run in-process with an injected API) or existing executables (spawned as subprocesses). Plugin commands mount into rt's root command tree and inherit fzf navigation, context resolution, logging, and error capture for free.

Two contract references, in order of authority:

1. `~/.rt/plugin-api/index.d.ts` ... the exact injected-API types for the rt version installed on this machine (rt writes and refreshes this file itself). Trust it over anything else.
2. The full plugin guide (manifest reference, exec env vars, troubleshooting): `docs/plugins.md` in the repo-tools repo if it is checked out locally, otherwise fetch <https://raw.githubusercontent.com/m4ttheweric/repo-tools/main/docs/plugins.md>.

## Workflow

1. **Scaffold**: `rt plugin new <name>`. The name must be kebab-case and passed explicitly (omitting it opens an interactive prompt, which fails without a TTY). This creates a working single-command plugin, wires IDE types, and runs `bun install`. Do not hand-create the folder.
2. **Declare commands** in `plugin.json` (cheat sheet below). Nodes nest identically at any depth: `module` and `exec` both work inside `subcommands`. If you restructure away from the scaffolded root command, delete the leftover `<name>.ts`.
3. **Implement handlers**. Signature contract:

   ```ts
   import type { RtCommandContext } from "rt-plugin";

   export async function run(args: string[], ctx: RtCommandContext) {
     // args = everything after the command name
     // ctx.rt = injected API: pick, prompt, confirm, store<T>, log
     // ctx.identity = { repoName, repoRoot, dataDir, remoteUrl, baseUrl }
     //   (present only when the manifest node declares "context")
   }
   ```

   The manifest's `fn` field picks a different export; default is `"run"`.
4. **Validate**: `rt plugin validate <name>`. It checks structure, that files exist, that modules import, and that declared exports exist; its error strings name the exact schema problem, so iterate against it. Then typecheck: `bunx tsc --noEmit` in the plugin folder.
5. **Run it for real**: invoke each new command (`rt <command> ...`) and confirm output. Commands using `"context"` should be run from inside a git repo. Persistent data lands in `~/.rt/plugin-data/<name>/<key>.json`; plugin log lines in `~/.rt/logs/plugins.YYYY-MM-DD.log`; every invocation outcome in `~/.rt/logs/cli.YYYY-MM-DD.log`.

To experiment without touching the user's real setup, point rt at a throwaway home: `HOME=/tmp/rt-sandbox RT_SKIP_SETUP=1 rt ...`.

## Manifest cheat sheet

```json
{
  "name": "my-tool",
  "apiVersion": 1,
  "commands": {
    "standup": { "description": "Draft standup", "module": "./standup.ts", "aliases": ["su"], "context": "worktree" },
    "notes": {
      "description": "Scratch notes",
      "subcommands": {
        "add":  { "description": "Add a note",   "module": "./notes.ts", "fn": "add" },
        "list": { "description": "List notes",   "module": "./notes.ts", "fn": "list" }
      }
    },
    "deploy": { "description": "Run deploy script", "exec": "./scripts/deploy.sh", "context": "repo" }
  }
}
```

Rules the validator enforces loudly:

- Every node needs `description` plus exactly one of `module`, `exec`, `subcommands`.
- Unknown fields anywhere are errors (typos fail, they are not ignored).
- Command names and aliases are kebab-case; `apiVersion` must be `1`.
- `manifest.name` should match the folder name.

Exec nodes: a spec containing `/` resolves against the plugin folder, a bare name uses PATH; array form is `[cmd, ...fixedArgs]`; invocation args are appended; stdio is inherited (TUIs work); the child's non-zero exit becomes rt's exit code. Make scripts executable (`chmod +x`). Environment passed: `RT_PLUGIN_NAME` and `RT_PLUGIN_DATA_DIR` always; `RT_REPO_NAME`, `RT_REPO_ROOT`, `RT_REPO_DATA_DIR`, `RT_REMOTE_URL`, `RT_BASE_URL`, `RT_AUTO_RESOLVED` when the node declares `context`.

## Gotchas

| Symptom / temptation | Reality |
|---|---|
| `rt plugin --help` errors | Subtrees do not take `--help`; run bare `rt plugin` to see `new`, `list`, `validate` |
| Importing npm packages in handler code | Unsupported at runtime; `node_modules` exists for the IDE only. Runtime surface = Bun/Node builtins + `ctx.rt` |
| Command missing from `rt --help` | Name collision (built-ins always win; a warning names both sides) or `hidden: true`; rename the command |
| `pick`/`prompt`/`confirm` in scripts or CI | They need a TTY; take arguments as a non-interactive fallback |
| Editor cannot resolve `rt-plugin` | Run `bun install` in the plugin folder |
| `store` key rejected | Keys allow only letters, digits, `.`, `_`, `-` |
| Logging invocations/errors manually | Never needed; rt's dispatcher logs every command outcome already. Use `ctx.rt.log` for domain events only |

A structurally broken plugin never breaks rt: it is skipped at startup with a warning naming the file and reason. Fix and rerun; there is no build step, edits to `.ts` files are live.

## Done means verified

- `rt plugin validate <name>` prints `ok`.
- `bunx tsc --noEmit` in the plugin folder is clean.
- Every declared command was actually run, with output confirmed (context commands from inside a repo).
- No collision warnings printed when running rt.
