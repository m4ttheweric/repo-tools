# rt user plugins

Add your own commands to rt. A plugin is a folder under `~/.rt/plugins/<name>/` with a declarative `plugin.json` manifest and either TypeScript files (run in-process with an injected API) or existing executables (run as subprocesses). Plugin commands live in the root command tree next to built-ins and inherit everything the tree provides: fzf navigation, breadcrumbs, repo/worktree context resolution, alt-enter arg forms, invocation logging, and error capture.

Two properties worth knowing up front:

- **A broken plugin can never break rt.** Discovery parses JSON and validates structure without executing any plugin code; a malformed plugin is skipped with a warning naming it and why. Plugin code only loads when its own command runs.
- **No build step.** rt's embedded Bun runtime transpiles your `.ts` files on import. Edit the file, run the command.

## Quickstart

```bash
rt plugin new my-tool     # scaffold ~/.rt/plugins/my-tool/ + IDE types, runs bun install
rt my-tool                # run it
rt plugin list            # installed plugins and their health
rt plugin validate        # deep checks: files exist, modules import, exports match
```

`rt plugin new` leaves you with a working command. Open `~/.rt/plugins/my-tool/` in your editor and you get full autocomplete on the injected API (see IDE setup below).

## Plugin anatomy

```
~/.rt/plugins/my-tool/
  plugin.json          # manifest (required): declares your commands
  my-tool.ts           # handler modules referenced by the manifest
  helper.ts            # relative imports between plugin files work
  scripts/deploy.sh    # exec targets referenced by the manifest
  package.json         # dev-time only: types for your IDE
  tsconfig.json        # dev-time only
  node_modules/        # dev-time only (bun install)
```

rt reads `plugin.json` and your handler files at runtime. `package.json`, `tsconfig.json`, and `node_modules` exist purely so your editor is happy; rt never reads them.

State lives outside the plugin folder:

- `~/.rt/plugin-data/<name>/` scoped JSON storage (created on first write)
- `~/.rt/logs/plugins.YYYY-MM-DD.log` your domain events, visible in `rt daemon logs`

## The manifest

```json
{
  "name": "my-tool",
  "apiVersion": 1,
  "commands": {
    "standup": {
      "description": "Draft my standup",
      "module": "./standup.ts",
      "aliases": ["su"],
      "context": "worktree"
    },
    "notes": {
      "description": "Scratch notes",
      "subcommands": {
        "add":  { "description": "Add a note",  "module": "./notes.ts", "fn": "add" },
        "list": { "description": "List notes",  "module": "./notes.ts", "fn": "list" }
      }
    },
    "deploy": {
      "description": "Run my deploy script",
      "exec": "./scripts/deploy.sh",
      "context": "repo"
    }
  }
}
```

Top-level fields: `name` (kebab-case, should match the folder), `apiVersion` (must be `1`), optional `description`, and `commands`. Unknown fields anywhere are validation errors, so typos fail loudly instead of being ignored.

Each command node takes:

| Field | Type | Notes |
|---|---|---|
| `description` | string | required; shown in pickers and usage |
| `module` | string | relative path to a `.ts`/`.tsx` file |
| `fn` | string | export to call, default `"run"`; only with `module` |
| `exec` | string or string[] | executable to spawn; array form is `[cmd, ...fixedArgs]` |
| `subcommands` | object | nested nodes, same shape |
| `aliases` | string[] | kebab-case; e.g. `["su"]` |
| `hidden` | boolean | runnable but not shown in pickers/usage |
| `context` | `"repo"` or `"worktree"` | rt resolves identity before your handler runs |
| `requiresTTY` | boolean | refuse to run outside an interactive terminal |
| `fullscreen` | boolean | skip the breadcrumb header; command owns the screen |
| `args` | array | declared args; alt-enter at the picker opens a form (fields: `name`, `flag`, `type` of `text`/`boolean`/`select`, `hint`, `placeholder`, `default`, `options`) |

Every node needs `description` plus exactly one of `module`, `exec`, or `subcommands`. Command names and aliases are kebab-case.

## TypeScript commands (`module`)

Your handler signature:

```ts
import type { RtCommandContext } from "rt-plugin";

export async function run(args: string[], ctx: RtCommandContext) {
  const team = await ctx.rt.pick(["cv", "platform"], { label: "team" });
  if (!team) return;

  const store = ctx.rt.store<string[]>("history");
  const history = (await store.get()) ?? [];
  history.push(team);
  await store.set(history);

  ctx.rt.log.info("ran", { team, repo: ctx.identity?.repoName });
}
```

`args` is everything after your command name on the command line. `ctx` carries:

- `ctx.identity` (when the node declares `context`): `{ repoName, repoRoot, dataDir, remoteUrl, baseUrl }`. With `"context": "worktree"` rt auto-detects from cwd or shows its repo/worktree picker first, exactly like built-in commands. `ctx.autoResolved` is true when it came from cwd without user interaction.
- `ctx.rt` the injected API:

| Method | Behavior |
|---|---|
| `pick(items, opts?)` | rt's fuzzy palette. Items are strings or `{ value, label?, hint? }`. Resolves `null` on Esc. |
| `prompt(label, opts?)` | single-line text input (`placeholder`, `default`) |
| `confirm(label, opts?)` | yes/no, `default` picks the preselected answer |
| `store<T>(key)` | `get()`/`set(v)` JSON persistence at `~/.rt/plugin-data/<plugin>/<key>.json`; keys are letters, digits, `.`, `_`, `-` |
| `log.info/warn/debug(msg, data?)` | JSON lines to `~/.rt/logs/plugins.YYYY-MM-DD.log`; `debug` only writes when `RT_LOG_LEVEL=debug` |

The runtime contract is the standard library (Bun/Node builtins) plus this API. npm dependencies in plugin runtime code are not supported in v1. You never need to log invocations, durations, or errors yourself; the dispatcher records those for every command in `~/.rt/logs/cli.YYYY-MM-DD.log`.

Throwing is fine: the error and stack land in the CLI log with your command's name, and rt exits 1.

## Executable commands (`exec`)

For mounting existing scripts with zero TypeScript. The target runs with inherited stdio (interactive programs and TUIs work), your invocation args appended after any fixed args, and cwd wherever rt resolved to (so `context` still matters). If the spec contains a `/` it resolves relative to the plugin folder; a bare name uses `PATH`.

Environment passed to the child:

| Variable | When |
|---|---|
| `RT_PLUGIN_NAME`, `RT_PLUGIN_DATA_DIR` | always |
| `RT_REPO_NAME`, `RT_REPO_ROOT`, `RT_REPO_DATA_DIR`, `RT_REMOTE_URL`, `RT_BASE_URL`, `RT_AUTO_RESOLVED` | when the node declares `context` |

A non-zero child exit becomes rt's own exit code, logged as an error outcome at the seam. Exec nodes do not get the injected API; that is the module/exec trade-off.

## Collisions and reserved names

Plugin commands merge into the root tree on every invocation. Built-ins always win, including their aliases and reserved entry points like `verify`; the losing plugin command is not mounted and a warning names both sides. Between plugins, the first by directory sort order wins. A clean setup prints nothing.

## IDE setup

rt writes a types-only package to `~/.rt/plugin-api/` (regenerated automatically whenever the embedded contract changes, e.g. after an rt upgrade). The scaffolded `package.json` depends on it via `"rt-plugin": "file:../../plugin-api"`, which is why `import type { RtCommandContext } from "rt-plugin"` resolves in your editor after `bun install`. The import is type-only and erased at runtime; if you accidentally value-import `rt-plugin`, it throws with a message explaining the API arrives via `ctx`.

If your editor shows red squiggles in a plugin folder, run `bun install` in that folder. Typecheck a plugin any time with `bunx tsc --noEmit` from its folder.

## Letting an agent build your plugin

This repo ships an agent skill at [`skills/rt-create-plugin/`](../skills/rt-create-plugin/SKILL.md) that teaches a coding agent the full authoring loop (scaffold, manifest, handlers, validate, run). To use it with Claude Code, symlink or copy the folder into your skills directory:

```bash
ln -s /path/to/repo-tools/skills/rt-create-plugin ~/.claude/skills/rt-create-plugin
```

(Cursor: `~/.cursor/skills/`; other harnesses: wherever they discover skills.) Then ask your agent for the command you want, e.g. "create an rt plugin that adds a `standup` command".

## Trust model

Plugin code runs in-process with rt's privileges. This is personal tooling for your own machine: only install plugin directories you trust, and read third-party plugin code before installing it, because installing it is agreeing to run it.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `skipping plugin "x": plugin.json is unreadable or not valid JSON` | broken manifest; fix the JSON, rt is unaffected meanwhile |
| `skipping plugin "x": <node>: unknown field "modle"` | manifest typo; unknown fields are rejected by design |
| `plugin x: ./cmd.ts does not export "run"` | export the function the manifest names (`fn`, default `run`) |
| command missing from `rt --help` | collision (see the warning) or `hidden: true` |
| `rt plugin validate` fails on a module | it dry-imports your file; top-level errors surface here before you hit them at runtime |
| editor cannot find `rt-plugin` | run `bun install` in the plugin folder |
