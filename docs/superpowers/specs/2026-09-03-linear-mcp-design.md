# Linear MCP on a fresh install: one step, one row, one VM assertion

2026-09-03, MAT-406 (under MAT-386). The Linear MCP server is a per-machine
Claude Code config that nothing in rt writes, checks, or names. Skills in the
ClaimView pack call `mcp__linear__*` and fail late on a machine that never got
one. This branch makes the server land during Install, makes its absence
visible on the checklist, and asserts it in the VM join pass.

Baseline for this branch: `mat-406-linear-mcp` off `cad2ff20`.

## What the investigation found

**The credential is a secret, not a setting.** `rt.linearApiKey` reads like a
settings key and is not one: it is the sops address `{ domain: "rt", key:
"linearApiKey" }` (`lib/setup/integrations.ts:196`). `getSetting("rt.linearApiKey")`
throws `unknownKey`. It is read through `SecretPresence.has("rt",
"linearApiKey")` (`lib/setup/plan.ts:172-186`), which returns `string | null`
and falls back to the pre-age staging file. So the branch's "register no new
settings key" hold costs nothing here: the two values this work needs
(`rt`/`linearApiKey` and the team's `mattstack.integrations.linear.teamKey`)
both already exist, and neither is a new registry row.

**Two different Authorization shapes, one key.** `INTEGRATIONS.linear.validate`
sends the key **bare** to `https://api.linear.app/graphql`
(`integrations.ts:200`); the MCP endpoint at `https://mcp.linear.app/mcp` takes
`Bearer <key>`, which is what the real entries on this machine carry. The step
must not copy the GraphQL header shape.

**Nothing in rt writes any MCP config today.** No `claude mcp add`, no
`.mcp.json`, no `mcpServers` writer anywhere in `lib/` or `commands/`. The
closest precedent is `lib/claude-settings.ts`, which read-modify-writes
`~/.claude/settings.json` for the worktree hooks, takes the path as a
parameter (so tests never touch a real HOME), and preserves unknown keys
through an index signature. That is the model.

**The name the skills bind to does not exist on any machine.**
`claimview-tools/packages/assured-skills/skills/{provision,checkout,capture-evidence}`
call `mcp__linear__get_issue`, `save_issue`, `list_comments`,
`extract_images`. Machines carry `linear-matt` and `linear-work`. Those tools
resolve on neither. `onboard/SKILL.md:98` documents a third shape entirely
(`claude mcp add linear -- npx -y @anthropic-ai/linear-mcp-server`, a stdio
server) that nobody runs.

**The checklist already probes this exact credential.** `account.linear`
exists whenever the team declares Linear (`validators/accounts.ts:102`), and
its `def.validate()` is a real `api.linear.app` round trip against the same
stored secret. A second probe in a second row would double the checklist's
network cost and could disagree with the first.

**The VM harness proves things through rt, not through third parties.** Every
`curl` in the guest assert scripts is `--unix-socket` against `tray.sock`;
neither script calls out to the internet, though the guest has egress.
`assert-team.sh` is the fixture-driven script, has `jq` on PATH, and already
carries the "assert one `setup status` row by id" idiom
(`assert-team.sh:18-27`). `assert-installed.sh` is fixture-free by design and
has no `jq` on its PATH.

## Design

### The name: setup writes `linear`

The step writes the server under the name the skills call, `linear`. The
alternative half of the fix, editing the ClaimView skills to call
`mcp__linear-matt__*`, is rejected on two grounds: those skills live in
another repo and outside this branch's fence, and no single existing name is
right for everyone (`linear-matt` is one person's account). One canonical
name that setup owns is the only shape that works for a joiner who has
nothing.

**An entry named `linear` is never overwritten.** If one exists, the step
does nothing at all, whatever it points at. Existing `linear-matt` /
`linear-work` entries are never read for auth, never renamed, never removed.
The write is purely additive: one new key under `mcpServers`.

**A linear-ish entry under another name does not make the row ready.** This
departs from the letter of the "detection accepts any working `linear*`
server" ruling, and it is deliberate: on a machine carrying only
`linear-matt`, `mcp__linear__get_issue` does not resolve, so a `ready` row
there would be a false green for precisely the failure MAT-406 exists to
remove. The row instead reports `missing` and names what it found, so the
detection still happens and nothing is silently trampled. The cost is honest
and stated: a machine with `linear-matt` and a stored key grows a second
Linear MCP server (duplicate tool surface in every session) when Install
runs, and the user can delete whichever one they no longer want. The
never-clobber half of the ruling holds in full; only the "counts as
satisfied" half is narrowed, and it is narrowed to keep the row truthful.

### The file

Path resolution mirrors `claudeConfigDirs` (`tools-install.ts:351`) but
targets the config file rather than the directory:

```ts
export function claudeJsonPath(p: Pick<Probes, "env" | "home">): string {
  const dir = p.env.CLAUDE_CONFIG_DIR;
  return dir ? join(dir, ".claude.json") : join(p.home, ".claude.json");
}
```

Verified against this machine: the live 217KB config is `~/.claude.json`,
while `~/.claude/.claude.json` is a 389-byte relic from August that Claude
Code does not read. Deriving the path from the config *directory* would have
picked the relic.

Shape written, matching the entries that work today verbatim:

```json
{ "mcpServers": { "linear": {
  "type": "http",
  "url": "https://mcp.linear.app/mcp",
  "headers": { "Authorization": "Bearer <rt/linearApiKey>" }
} } }
```

Merge rules: parse the whole file, add exactly one key under `mcpServers`
(creating that object only if absent), re-serialize with 2-space indent, and
write. Every other key in the file survives byte-for-byte in value, including
the 62 `projects` entries. A file that does not parse is never written to;
the step fails with the parse error rather than replacing the user's config
with a fresh object.

**The write is atomic.** The target is Claude Code's live state file, and a
partial `writeFileSync` over 217KB would corrupt it. The step writes
`<path>.rt-tmp` and renames. `Probes` has no rename, so this adds one method,
`rename(from, to)`, alongside the existing `symlink` / `removeFile` / `chmod`
file verbs; `fakeProbes` models it by moving the in-memory entry and
recording the call. A residual race remains and is accepted: if Claude Code
writes the file between our read and our rename, its update is lost. The
window is milliseconds, the write happens at most once per machine, and the
file is never left corrupt.

**The key never reaches argv.** This is why the step writes the file directly
instead of shelling out to `claude mcp add-json`, which would put the API key
in a process command line (and into any exec log that records argv). The
value passes through `ctx.redact()` before it can reach a log line or a
`detail`.

### The step: `linear.mcp`

New `StepId`, inserted directly after `plugins.install` and before
`fastbrowser.setup`: `plugins.install` is what guarantees a Claude config
exists on a fresh machine, and this step has no other ordering constraint.
`kind: "rt"`, `applies: () => true`.

Outcomes:

| Condition | Outcome |
|---|---|
| Config file present but does not parse | `failed`, remedy naming the file |
| `mcpServers.linear` already present | `skipped`, "already configured" |
| No stored `rt`/`linearApiKey` | `skipped`, "no Linear key stored (connect Linear, then Retry)" |
| Otherwise | `done`, "added linear to `<path>`" |

A missing key is `skipped`, not `failed`: per the ruling, an unconnected
Linear is a thing the user has not done yet, never an install error. `skipped`
is non-fatal by contract (`apply.ts:197-204`), so the run continues.

### The row: `tool.linear-mcp`

In `validators/tools.ts`, `kind: "tool"`, title "Linear MCP", why "Skills that
read and update Linear tickets reach them through this MCP server."

| Condition | Status | Detail |
|---|---|---|
| Config file present but unparsable | `error` | names the file |
| `mcpServers.linear` present with an `Authorization` header | `ready` | `linear` |
| `mcpServers.linear` present without auth | `needs-you` | "linear configured without an Authorization header" |
| No `linear`, other `linear*` entries present | `missing` | "linear-matt configured; skills call mcp__linear__*" |
| No `linear`, no key stored | `needs-you` | "no Linear account connected", action: connect linear |
| No `linear`, key stored | `missing` | "installed by Install (linear.mcp)" |

**The row is `required: false` in every state**, carrying
`optionalNote: "Installed by Install (linear.mcp)."`. It is therefore not
added to `INSTALL_SATISFIED_IDS`: that set's flip is id-keyed and
unconditional, so joining it would make status mode force `required: true`
even in the no-key state, and `rowToCheck` would turn "this person does not
use Linear" into a critical `rt verify` failure. Permanently optional gives
`canInstall` no new way to deadlock, gives `rt verify` a `warn` that names the
gap, and leaves criticality where it already belongs: `account.linear` is
required whenever the team declares Linear, and it goes red on a bad key
without any help from this row. The fresh-install guarantee is enforced where
it is actually checkable, in the VM assertion, which demands `ready`.

**The row makes no network call.** It is a wiring check: is the entry there,
does it carry auth, is a key stored. The credential proof is `account.linear`,
one row away, hitting `api.linear.app` with the same secret. Duplicating it
here would double the checklist's network cost and create two rows that can
disagree about one key. The gap this leaves is narrow and worth stating: a
user whose team declares no Linear integration gets no `account.linear` row,
so a stored-but-dead key would read `ready` here. Without a team Linear
config there is nothing to validate the key against anyway.

Both the step and the row read the same predicates from one new module,
`lib/setup/linear-mcp.ts` (server name, URL, path resolution, parse, detect,
merge), following `base-plugins.ts`'s precedent: a shared constant module so a
validator never imports a step and the two never drift.

### Where this touches `~/.claude.json`, and why that is allowed

`steps/plugins.ts:11-12` states the installer "never touches
~/.claude/settings.json, hooks, or ~/.claude.json". That rule stands for
`plugins.install`. This is a deliberate, scoped exception carried by a
separate step whose entire job is the one `mcpServers` key: `plugins.install`
is not changed, and the exception is written into both step docblocks so the
next reader finds the boundary rather than a contradiction.

### VM assertion

Lands in `assert-team.sh`, not `assert-installed.sh`: the entry only exists
when a Linear key reached the machine, which is a fixture-supplied input, and
`assert-installed.sh` is fixture-free by design and has no `jq`. Gated on the
fixture's `expect.json` declaring it, so fixtures without a Linear key are
unaffected.

Three checks, in the script's existing `ok`/`bad` idiom:

1. `jq -e '.mcpServers.linear.url == "https://mcp.linear.app/mcp"'` over the
   joiner's `~/.claude.json`.
2. `rt setup status --json` row `tool.linear-mcp` is `ready`.
3. `rt setup status --json` row `account.linear` is `ready`, which is the
   credential proof: rt itself made the `api.linear.app` call. The script
   does not curl Linear directly, matching the harness's house style of
   proving through rt rather than through a third party.

The key has to reach the guest first. The harness convention for a
harness-held credential is the forge PAT: a host env var whose *name* is
passed as a flag (`--pat-env`) and whose value is forwarded over the ssh
command line, then typed into the Connect field, never logged. The invite-code
path is the file-shaped sibling: written host-side, scp'd, read, and `rm -f`'d
on the guest. Matt names the key file; the mechanism is confirmed with him
before the assertion lands. If the key is not available when the code is
ready, the code and its unit proof land and the VM leg is reported pending.

## Testing

All step tests run against an isolated HOME. `test-setup.ts` (the bunfig
preload) repoints HOME for every test process, and the step tests fake HOME
again per test the way `steps-c.test.ts:99-111` does; the config path comes
from `fakeProbes({ home })`, so the assertion is on `p.calls.writes[...]`
inside the fake and the developer's real `~/.claude.json` is never opened.
One test asserts exactly that: given a fake home, the set of written paths
contains no path outside it.

- `lib/setup/__tests__/linear-mcp.test.ts` for the shared module: path
  resolution with and without `CLAUDE_CONFIG_DIR`, detection across
  (`linear`, `linear-matt`, both, neither, `linear` without auth), and the
  merge preserving unrelated `mcpServers` entries plus unrelated top-level
  keys.
- Step tests in the `steps-*` suite: the four outcomes above, plus
  **idempotence proven directly** by running the step twice and asserting the
  second run writes nothing and returns `skipped`, and **an existing
  `linear-matt` survives untouched** across a run that adds `linear`.
- `validators-tools.test.ts`: all six row states.
- `contract.test.ts`: the hard-coded step-id array grows to 25, in order.
- `check-vm-scripts.sh` already `bash -n`s every guest script, so the
  assertion edit is syntax-gated with no new wiring.

Gates before done: `bun run test`, `bun x tsc --noEmit`, `bun run docs:check`,
`bun run picker:check`, `scripts/repo-purity.sh`. No `rt-tray` Swift change,
so no `swift build`.

## What does not change

No new settings key and no registry edit. No `rt-client` publish. No new
command module, so `lib/module-registry.ts` is untouched. No new leaf
positional, so `omitBehavior` is untouched. `plugins.install` keeps its
never-touch rule. Nothing drives a browser.

## Follow-ups

**`onboard/SKILL.md:98` documents a third server shape.** It tells a joiner to
run `claude mcp add linear -- npx -y @anthropic-ai/linear-mcp-server`, a stdio
server unrelated to the hosted one everything else uses. It is in
claimview-tools, outside this fence. Filed for that repo: replace the line
with "Install writes this; if the `tool.linear-mcp` row is not ready, connect
Linear and re-run Install."

**Uninstall has no mirror.** `rt uninstall`'s `UninstallActionId` list gains
nothing here, so an entry this step wrote survives an uninstall. Consistent
with `plugins.uninstall` being an explicit, separate action; noted rather than
absorbed.

**cswap accounts each have their own config.** Four per-account
`.claude-config-*.json` files exist under `~/.claude-swap-backup/configs`, and
this step writes only the active one. A joiner has a single account, so this
is a Matt-only concern; recorded, not solved.
