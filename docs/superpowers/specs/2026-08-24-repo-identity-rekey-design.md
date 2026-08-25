# Stable repo identity for rt's name-keyed stores (RT-62)

**Status:** design, awaiting review
**Ticket:** RT-62
**Supersedes the deferral in:** RT-60 (which fixed two stores by migration and
explicitly left the identity question open)

## Problem

A git repository's identity in rt is a **derived name**, and the derivation is
not stable. `deriveRepoName` (`lib/repo.ts:43`) takes the last path segment of
the origin remote, falling back to the directory basename for remote-less
repos. Renaming a repo's directory *or* its remote mints a second identity for
the same tree; `rt repos register` mints a third, from `basename(realpath)`.

That name is used as a **key** in roughly six stores, and readers and writers
do not all derive it the same way. The daemon keys by whatever string sits in
the repo index; the CLI keys by `deriveRepoName(origin)`. When those diverge, a
store written under one name is invisible under the other. The failure is
always silent: a background service stops, a cache re-syncs from zero, a port
claim orphans. RT-60 fixed exactly this for the worktree registry — after it
had already orphaned 8 live tree records on the developer's machine — and a
follow-up audit (recorded on RT-62) found five more stores on the same footing,
the most consequential being `rt.repoTracking`, whose loss silently stops live
watching, branch-cache refresh, discussions polling, project-MR sync, and the
`secrets:forge-token` gate that gitq and mr-board depend on.

The audit's verdict: this is systemic, not a second one-off. Teaching each
migration about "store number seven" is a treadmill. The fix is to key on an
identity that does not move.

**One surface already got this right and is the template:** the settings
resolver keys `repos.<identity>` sections on `identityFromRemote` — a
normalized `host/path` derived from the remote, never a name, never a
filesystem path — so `rt.worktrees`, `rt.presets`, `rt.variations`,
`rt.intercepts` and `rt.hooks` are immune to every rename. This design
generalizes that identity to the stores that still key by name, and — because
the identity function is published in `@mattstack/rt-client` and consumed by
other mattstack apps — coordinates the change across the estate.

## Goals

- One identity for a git tree, stable across directory renames, remote-URL
  renames, worktree location, and `rt repos register`.
- Every rt store that is per-repo keys on that identity.
- Every mattstack app that derives a repo identity or reads rt's `repos.json`
  moves to the same scheme, in a defined order, with no silent break.
- Existing on-disk data migrates without user action and without loss.

## Non-goals

- Changing what the settings resolver already does (it is the template, not a
  target).
- Writing anything into a target repo to anchor identity. The rt-repo-stealth
  invariant holds: rt never writes into repos it operates on. Identity is
  derived, never stamped.
- A general repo-rename *command*. This makes rename non-destructive; it does
  not add a verb to perform one.

## The identity model

### Two kinds, one wire string

Identity is a tagged value in process:

```ts
type RepoIdentity =
  | { kind: "remote"; id: string }   // normalized host/path, e.g. "gitlab.com/group/repo"
  | { kind: "path";   id: string };  // main-worktree realpath, e.g. "/Users/matt/Documents/GitHub/x"
```

- **`remote`** is the existing `identityFromRemote` output: lowercase host,
  path case preserved, `.git` and credentials stripped. Survives directory
  renames and worktree moves; a *remote* rename changes it (acceptable — a
  remote rename is a genuine identity change, and rare).
- **`path`** is the fallback for a repo with no recognized remote (bare local
  paths, or no origin at all). It is the **main worktree's** realpath — the
  same key `partitionByRealpath` already uses to decide two index rows are one
  tree, so realpath is already rt's de-facto identity where it had to be right.
  Survives worktree moves; a *directory* rename reads as a new repo. This is
  the honest floor: with nothing written into the repo, git offers nothing more
  stable for an origin-less tree.

The tag is not decoration. It records *why* an identity has the value it does,
so a later migration can re-anchor a `path:` identity onto a `remote:` one if
the repo gains an origin — instead of silently stranding it the way derived
names do today. A design that erased the tag (a bare hash) would forfeit that.

### The wire form: reversible, path-segment-safe

Stores, daemon-verb payloads, `board`'s config, and console's `/runs/:repo/...`
URL all need identity as a single **string**. Two of those forbid a raw slash
(console routes on one path segment), so `host/path` cannot go on the wire
literally.

The serialized form is `<kind>:<percent-encoded id>`:

```
remote:gitlab.com%2Fgroup%2Frepo
path:%2FUsers%2Fmatt%2FDocuments%2FGitHub%2Fx
```

`encodeURIComponent`/`decodeURIComponent` is the transform — reversible, legible
enough to read a key at a glance, and safe as a single URL path segment by
construction. Chosen over an opaque hash specifically to keep re-anchoring and
readability; the cost accepted is that keys are longer and every store key
visibly changes at migration.

`serializeIdentity(RepoIdentity): string` and
`parseIdentity(string): RepoIdentity` are pure inverses, live in rt-client, and
are the only code that knows the wire encoding. Nothing else concatenates or
splits it.

### rt-client's changed surface (the breaking change)

Today, all three return `string | null`:

```ts
normalizeRemote(remote: string): string | null
identityFromRemote(remote: string): string | null
deriveRepoIdentity(repoPath: string): Promise<string | null>
```

After:

```ts
// unchanged — a remote string in hand may legitimately not normalize
normalizeRemote(remote: string): string | null
identityFromRemote(remote: string): RepoIdentity | null   // null only if the input isn't a usable remote

// path in hand → ALWAYS resolvable, because the realpath fallback exists
deriveRepoIdentity(repoPath: string): Promise<RepoIdentity>   // no longer nullable

// new, the wire boundary
serializeIdentity(id: RepoIdentity): string
parseIdentity(wire: string): RepoIdentity | null   // null on a malformed wire string

// new, a ONE-TIME rewrite helper for board's existing config (not a runtime path)
resolveNameToIdentity(name: string, reposJsonPath?: string): RepoIdentity | null
```

`resolveNameToIdentity` earns its place only as the tool that rewrites board's
existing name-valued config to `host/path` once. It is deliberately **not** a
runtime translation layer and the daemon never calls it — see the hard-cutover
rollout below.

`deriveRepoIdentity` losing its `null` is a genuine shape change, but **no
consumer catches it at compile time** — a correction to an earlier draft of
this spec. gitq does not call `deriveRepoIdentity`; it calls `repoNameForPath`
(unchanged, still `string | null`) and forwards the result to a daemon verb. So
every identity-touching consumer breaks *silently* or not at all, and the safety
net is not the compiler — it is the hard-cutover **ordering**: the daemon
re-keys its stores and the `repos.json` mirror before any consumer reads them,
after which `repoNameForPath` returns an identity (the mirror's key) that the
identity-only daemon accepts. The estate section carries the per-consumer
detail.

**The settings resolver is deliberately left alone.** It keeps consuming
`identityFromRemote`, and its on-disk `repos.<identity>` section keys stay in
their current raw `host/path` spelling — they are **not** re-encoded to the new
`<kind>:<percent-encoded>` wire form. The wire codec is for the six re-keyed
stores, the daemon verb payloads, board's config, and console's URLs; settings
sections are none of those and no implementer should touch them. The one
observable consequence is that the same remote repo is spelled two ways on
disk — `gitlab.com/group/repo` in a settings section, `remote:gitlab.com%2F…`
in a re-keyed store — which is acceptable because nothing joins the two by
string; both derive from the same `RepoIdentity` in memory. For a `path`-kind
repo the resolver behaves exactly as it does today for a null-identity repo:
repo-scoped sections unreachable, global scopes apply. Giving settings a
`path`-scoped section is a possible future change, out of scope here.

## The stores

Six stores key by repo name today and move to the serialized identity. Each
is re-keyed at its write site and its read site together, and its existing rows
migrate once (below).

| Store | Location | Today's key | Note |
|---|---|---|---|
| `repo-index` kv | `lib/repo-index.ts` | derived name | The index maps identity → main path. `rt repos register` and `getRepoIdentity` both write it; both derive identity the same new way. |
| `worktree-registry` kv | `lib/worktree/registry.ts` | repo name | Already migrated name→name by RT-60; that migration is replaced by the identity re-key. |
| `rt.repoTracking` grants | `lib/repo-tracking.ts` | repo name | The severe finding. Machine-settings map, re-keyed to identity strings. |
| `run_history` table | `lib/state` / `lib/run-history.ts` | `repo` col | Recents and `rt run again`. |
| `endpoint_claims` table | `lib/state` | `repo` col | Port claims. |
| `branch_cache` + `project_mrs`/`_meta`/`_demands` + `discussions` tables | `lib/state/*.ts`, `lib/state/db.ts:76-116` | `repo` col | The MR/discussion caches and the dispose squash-merge anchor. |

`events-cursor` is self-consistent (daemon writes and reads it under the index
name) and its non-migration only costs a documented watcher cold-start; it is
re-keyed for uniformity but is not a correctness fix. The singleton namespaces
(`worktree-reactor`, `notifier`, `home-snapshot`, …) are not repo-keyed and are
untouched.

## Migration of existing data

One-shot, on first read, per the established `state.db` pattern
(`LEGACY_IMPORTS`), **not** a user-run command. For each store, the first read
after upgrade:

1. lists rows still under a legacy name key,
2. resolves each legacy name to an identity — via the index row's path if the
   name still resolves there, else `deriveRepoIdentity` of that path,
3. writes the row under the serialized identity,
4. **verifies the write persisted before removing the legacy row**, and
5. leaves an unresolvable legacy row *in place* rather than dropping it.

Step 4 is not optional and is the scar from RT-60: `persistOrWarn` swallows
`SQLITE_BUSY`, so a returned write is not a landed write. A migration that
deletes the source before confirming the destination is exactly how RT-60
orphaned the registry.

Collision policy carries over from RT-60's `migrateRepoData`: `run_history`
merges by timestamp (each line self-dates); any other same-key collision keeps
both and is reported, never guessed. The repo index's own `rt repos prune`
retains — never evicts — a row whose migration left anything behind.

`repos.json` (the deprecated compat mirror) is regenerated from the re-keyed
index as it is today; its shape does not change, but its keys become serialized
identities. See the estate section for why that is safe.

## Estate coordination

The survey (recorded on RT-62) found **5 of 7** rt-client consumers touch repo
identity. deck and local-apps use rt-client for global settings only and are
**unaffected**. The five:

| Consumer | Dep | What it does | Break mode without care |
|---|---|---|---|
| gitq | published `^0.3.0` | `repoNameForPath(path)` → forwarded to `secrets:forge-token` / `mr:by-branch` | **Silent, but self-correcting under ordering** — `repoNameForPath` is unchanged and returns the mirror's key, which is an identity post-migration; gitq forwards it unchanged. No code change, only a reinstall. |
| board | published `^0.3.0` | operator-authored `config.rtRepos[path]` = a **name**, → `project-mrs:read` / `discussions:read` | **Silent** — human-written map goes stale |
| mr-board | published `^0.3.0` | identical to board | Silent |
| mr-board-wt-invite-onboarding | **file:** dep | board fork | Silent |
| console | **file:** dep | daemon `RunSummary.repo` in URL + `runs:*` | **Silent + structural** — `/runs/:repo/:runId` breaks on a slash |

Three decisions fall out:

**1. board/mr-board config values become remote-derived identities the
operator writes, not rt names.** `config.rtRepos` today maps a project path to
an rt *name* — the value that goes stale on a re-key, because a human typed it.
The fix removes names from that file entirely: the value becomes a legible
`host/path` (what the operator reads straight off their git remote, e.g.
`gitlab.com/group/repo`), and board normalizes + serializes it to the wire form
at the daemon boundary, exactly as console does with the identity in its URLs.
No names, so nothing to go stale; no percent-encoded ugliness in a
human-edited file; and no persistent translation layer — one identity, board is
just its encoder at its own edge. The operator's *existing* name entries are
rewritten to `host/path` **once**, as a one-time config migration (a small
handful on this machine); `resolveNameToIdentity(name)` exists solely as that
one-shot rewrite helper, not as a runtime path. Whether board can drop the map
altogether and derive identity from the project path it already holds
(`deriveRepoIdentity(path)`) is a board-internal simplification for its own
implementer, noted but not mandated here.

**2. console is protected by the wire form, not a route change.** Because the
serialized identity is percent-encoded, it is already a single safe path
segment — `/runs/remote:gitlab.com%2Fgroup%2Frepo/<runId>` routes fine. Console
needs no route change; it needs only to stop assuming `repo` is human-readable.
This is the concrete reason the wire form had to be slash-free, and why hashing
would also have worked here but was rejected for the re-anchoring reason above.

**3. rt-client publishes as a major bump (0.4.0).** All installed copies are at
0.3.0 today with no drift. A major bump means `^0.3.0` consumers stay on the old
behavior until each app's `package.json` is explicitly raised — a deliberate,
trackable, per-repo step — rather than silently absorbing a shape change on
their next ordinary `bun install`.

### Rollout: a coordinated hard cutover, no compat window

The estate is single-operator today, so there is no need to let apps adopt
asynchronously — and asynchronous adoption is exactly what would keep a
name/identity split alive in the daemon. **The daemon accepts identities only;
there is no legacy-name acceptance path and no compat window.** The cost is a
brief flag-day where the estate is inconsistent until the sequence completes;
that is acceptable because one person controls the timing and nothing external
depends on it.

The dependency edges are strict and the whole thing lands as one sequence:

1. **rt-client** gains the tagged identity and the wire codec, and publishes
   0.4.0. The two **file:**-dep consumers (console, the onboarding fork) pick it
   up at their next `bun install`, so their adoption commits land together with
   this — they cannot lag.
2. **The rt daemon** adopts identity keys and the identity-only verb payloads;
   the `state.db` one-shot migration runs on its first read. Rebuilt and
   restarted **in lockstep** with the store re-key — a re-keyed store under an
   old daemon, or the reverse, is the split this whole change removes.
3. **The three published-pin consumers** (gitq, board, mr-board) bump to
   `^0.4.0` and adopt — gitq only reinstalls (it forwards `repoNameForPath`'s
   now-identity key unchanged), board switches its
   config values to `host/path` and encodes at the boundary — as part of the
   same landing, not on their own schedule. The major bump is what makes each
   bump a deliberate, tracked step rather than an ambient one; it is not a
   license to stagger.

Because there is no window to close, there is no follow-up ticket for closing
one. The sequence is done when all consumers are on 0.4.0 and the daemon has
migrated.

## Failure handling

- **Unresolvable legacy name at migration:** row left in place, one `warn` with
  the name and store; never dropped, never guessed onto an identity.
- **`deriveRepoIdentity` on a path with no readable remote:** returns
  `{kind:"path"}` — it cannot fail, which is the point of removing its `null`.
- **A daemon-side `parseIdentity` reject:** the payload is malformed (a
  post-cutover consumer must send a serialized identity). The verb returns its
  normal empty/absent result, exactly as a wrong name does today — no new
  failure mode, and no legacy-name fallback to reach for.
- **`SQLITE_BUSY` on a migration write:** the verify-persisted step catches it;
  the legacy row survives and the migration retries on the next read.

## Testing

- **Identity codec:** `serializeIdentity`/`parseIdentity` are exact inverses
  over remote and path kinds, including a path containing spaces and a remote
  with a multi-segment group; the serialized form contains no `/`.
- **Fallback:** `deriveRepoIdentity` on a real `git init` repo with no origin
  returns `{kind:"path", id: <main-worktree realpath>}`, identical from a linked
  worktree of the same repo (never the worktree's own path).
- **Migration, per store:** a row under a legacy name is readable under the
  identity after first read; a `SQLITE_BUSY` on the destination write (simulated)
  leaves the legacy row intact; an unresolvable name is left in place with a
  warn. Real `state.db`, real rows, not mocks — the RT-60 discipline.
- **register:** `rt repos register` on a checkout whose directory basename
  differs from its remote's last segment writes the **remote** identity, and a
  subsequent in-repo command resolves to the same row (no second key minted).
- **Daemon rejects names post-cutover:** a verb payload carrying a bare legacy
  name (not a serialized identity) resolves nothing — there is no name path.
- **board config migration:** `resolveNameToIdentity` on an operator's existing
  name yields the `host/path` written back to config; and board, given a
  `host/path` config value, sends the daemon the same serialized identity the
  store is keyed by.
- **console (in the console repo's suite):** a `host/path` repo's serialized
  identity round-trips through `/runs/:repo/:runId` without route breakage.

## Open questions

- **Does `rt.repoTracking` live in the machine store keyed by the *serialized
  identity string*, or does the tracking map gain structure?** The former keeps
  it a flat map like today; deciding it is a one-line call in the plan, not a
  design fork.
