# The repo identity contract

How every mattstack app names a repo when it stores, sends, or displays
anything per-repo. Read this before keying a store, calling a repo-keyed
daemon verb, or printing a repo name. The dated design record is
`docs/superpowers/specs/2026-08-24-repo-identity-rekey-design.md`; this file
is the live contract. The settings-store half of the story (scopes, registry,
resolver) is [settings-architecture.md](settings-architecture.md).

## Why identities: names drift

rt used to key per-repo stores on a derived display name — the origin URL's
last path segment, or the directory's basename. Rename the folder, change the
remote, or register from a second worktree and the same repo minted a second
name: data written under one key was silently invisible under the other. The
fix is one stable identity per repo, everywhere, derived from the thing that
doesn't move — the normalized origin remote, or for remote-less repos, the
main worktree's realpath.

Identities come from `@mattstack/rt-client` (0.4.0+). Never re-derive one
with your own git calls — the derivation has rules (below) that a casual
`git remote get-url` reimplementation gets wrong.

## The two string forms

The same repo has a **raw** form and a **serialized wire** form, and they are
not interchangeable:

| Form | Looks like | Keys |
|---|---|---|
| Raw `host/path` | `gitlab.com/acme/acme-dev` | Settings sections only: `repos.<identity>` in the settings stores, and everything the settings resolver touches (`ResolveOpts.repoIdentity`). |
| Serialized wire | `remote:gitlab.com%2Facme%2Facme-dev` or `path:%2FUsers%2Fdev%2Fscratch` | Everything else: state.db tables and kv namespaces, daemon command payloads, REST path segments, the repo index, per-repo data dirs. |

Wire anatomy: `kind` (`remote` or `path`), a literal `:` delimiter, then the
id passed through `encodeURIComponent`. That makes the wire slash-free by
construction, so it always fits in one URL path segment and is a legal
directory name. `encodeURIComponent` it again when it rides in a URL
(`/api/runs/${encodeURIComponent(identity)}/${runId}`).

Legal directory name is NOT PATH-safe: the delimiter colon splits any PATH
entry the directory ends up inside (a worktree's `node_modules/.bin` during
installs, RT-95). Any identity-keyed directory whose subtree can land in
PATH uses the friendly pool segment instead: `gh-<org>-<repo>` (host alias,
else the dashed hostname), `local-<basename>` for path-kind
(`worktreePoolRoot` in `lib/rt-paths.ts`). The segment is a derived
directory name, never parsed back and never a key; its dash join is
ambiguous only if two registered repos collide on it, which the host
prefix confines to a single host. State.db keys, kv namespaces, payloads,
and URLs keep the raw wire, and anything HUMAN-RENDERED goes through
`lib/repo-label.ts` (`lib/__tests__/no-wire-in-ui.test.ts` is the ratchet).

Never swap the forms: settings lookups miss on the wire form, and daemon
verbs refuse the raw one (silently — see below). A `path`-kind repo has no
`host/path`, so it gets no repo-scoped settings sections at all
(`repoIdentityFor` in `lib/daemon/handlers/endpoint.ts` resolves it to null
on purpose).

## The codec

```ts
import {
  deriveRepoIdentity,  // (repoPath) => Promise<RepoIdentity> — never null
  serializeIdentity,   // (RepoIdentity) => wire string
  parseIdentity,       // (wire) => RepoIdentity | null — THE validity check
  identityFromRemote,  // (remoteUrl) => RepoIdentity | null — sync, overrides applied
} from "@mattstack/rt-client";

const identity = serializeIdentity(await deriveRepoIdentity(repoPath));
```

Inside this repo, `@mattstack/rt-client` does not resolve from `lib/` or
`commands/` — import the same helpers from the local barrel
`lib/settings/identity.ts` instead. Consumer repos (board, console, gitq)
import from `@mattstack/rt-client` directly.

`parseIdentity` is strict-canonical: only wires that `serializeIdentity`
emits parse (the id segment must re-encode byte-for-byte). This is
deliberate — guard sites validate with `parseIdentity` and then use the wire
as a single path component, so a hand-built wire with a literal `/`
(`path:../..`) must not parse. Corollary: never hand-assemble or
string-split a wire; use the codec.

## Derivation rules

What `deriveRepoIdentity(repoPath)` actually does, in order:

1. **Remote read**: `git -C <repoPath> config --get remote.origin.url` — NOT
   `git remote get-url`, which applies `insteadOf` rewrites and would mint a
   second identity for the same repo on machines that use them.
2. **Overrides**: `identityFromRemote` first consults
   `rt.repoIdentityOverrides` in the machine settings store (keyed by the
   observed remote URL — the fork/multi-remote escape hatch), then
   `normalizeRemote`: lowercase host, credentials and `.git` stripped, path
   case preserved.
3. **Path fallback** (no usable remote): the *main* worktree's realpath, so
   every linked worktree of a repo derives the same identity. The main
   worktree comes from `git worktree list --porcelain` (first entry) resolved
   through `rev-parse --show-toplevel` — not `--git-common-dir/..`, which
   points outside the tree under `--separate-git-dir`.
4. **Degrade, never throw**: a directory that no longer exists realpaths to
   its literal path (`safeRealpath`) — dispose flows derive identities for
   trees mid-removal.

The result is never null: every repo has at least a path-kind identity.
Remote-kind results are memoized per process; path-kind results are retried
on every call so a repo that gains a remote later isn't stuck.

## Daemon verbs and REST

Repo-keyed daemon verbs (`worktree:*`, `endpoint:*`, `hooks:*`,
`project-mrs:read`, `discussions:read`, `secrets:forge-token`, `mr:by-branch`,
tracking) accept **serialized identities only**. The guard at every handler
is `parseIdentity(payload.repo) === null → empty result` — a bare name does
not error, it resolves nothing. If a verb returns empty for a repo you know
exists, the first suspicion is the key form, not the data.

**The one exception**: `runs:list` / `runs:get` / `runs:abandon` read on-disk
run directories whose names are writer-controlled. The `repo` field that
`runs:list` returns is an *opaque key* — pass it back verbatim, never
validate or re-derive it. New runs key by identity; pre-cutover runs keep
whatever their pipeline wrote, and refusing those keys would 404 exactly the
rows the verb itself hands out.

The CLI is friendlier than the daemon on purpose: `--repo <arg>` accepts an
identity, a path, or a bare name (reverse-resolved through the repo index by
`resolveRepoArg` in `lib/repo-arg.ts`). That resolution happens CLI-side;
what crosses the socket is always the identity.

## Display

The wire form is a key, never copy. Anything a human reads — picker rows,
list output, log lines, chat handles — goes through a label decode:
`repoLabel()` in `lib/repo-arg.ts` (last path segment for remote-kind,
basename for path-kind); consumers do the same via `parseIdentity`, whose
returned `id` is already decoded — decoding it again corrupts ids that
contain a literal `%`. Keys go
down the wire, labels go on the screen, and the two never swap in either
direction: a label is ambiguous by construction and will silently miss as a
key.

Chat handles specifically: the handle charset `[a-z0-9._-]+` forbids `%` and
`:`, so a serialized identity leaking into a handle is an invalid-join bug,
not a cosmetic one. Build handles from the label, slugified.

## The legacy world

Machines carry pre-cutover, name-keyed state until it is healed. Four
mechanisms, none of which callers should reimplement:

- **Daemon boot migration** (`lib/daemon/boot-migrate.ts`): one-shot at every
  daemon start, re-keys all ten stores (worktree registry, events cursor,
  `rt.repoTracking`, `run_history`, `endpoint_claims`, `branch_cache`,
  `project_mrs` + meta + demands, `discussions`). Idempotent — already-keyed
  rows are skipped — and each store's re-key is isolated, so one failure
  never blocks the rest. Rows whose legacy name can no longer be resolved are
  retained and re-warned, never corrupted. There is no ordering guarantee
  against a CLI-side `rt repos prune` racing boot; the verb-layer guards are
  the safety net, and the bounded worst case is a few retained legacy rows.
- **Additive index heal** (`resolveIndexPathForIdentity` in
  `lib/repo-index.ts`): a reader that misses on an identity scans the legacy
  name rows, derives each row's identity from its path, and on a match ADDS
  the identity row beside the legacy one. Additive on purpose — the legacy
  row must survive for prune to collapse the pair.
- **`rt repos prune`**: collapses the name/identity pairs the heal leaves
  behind. Until it runs, both rows point at the same directory, and
  name-matching code that counts rows will see doubles. The identity row
  always wins the pair, whatever the timestamps say — the retired name's data
  dir is carried onto it, and its worktree registry too: when BOTH names own
  a registry they are **merged** (union by path; the managed record wins a
  collision) rather than refused, and only then is the retired row evicted. A
  row whose data could not all move is kept and reported, because eviction is
  what makes a leftover unreachable — and so is a `missing` row that still
  owns a registry, reported `retained` with the hint to run `rt repos locate`
  instead.
- **`rt repos locate <new-path>`**: the verb for a repo whose folder MOVED.
  The identity survives a move, so this re-points paths and never re-keys:
  every index row of the pair, both registries (re-rooted onto the new root,
  external worktrees keeping their own paths, then merged onto the identity)
  and the pair's `endpoint_claims` rows (merged onto the identity too, the
  legacy key emptied) — one `state.db` transaction, matched by identity and
  never by name, with the `repos.json` mirror rewritten as it commits.
  - **Repair before commit.** `git worktree repair` and the
    `git worktree list` verification run FIRST, while the index still names
    the dead path: a reconcile pass that interleaves there finds a repo whose
    path does not exist and bails, where a healed index over un-rewritten
    registry paths would prune every claimed tree and replenish a fresh pool.
    Nothing is written unless the whole move verifies, which is why there is
    no rollback. A legacy row retained by a data-dir conflict is written back
    to the OLD path for the same reason — a legacy row must never name a live
    path without owning a registry.
  - **The daemon is never stopped for a move.** It owns the registry, so the
    CLI hands the work to the `repos:locate` verb whenever a daemon is
    present — presence being a live pid file OR a socket on disk, not a ping,
    since a stalled daemon still holds the registry. Present but unanswering
    is a hard stop, never a local apply. The handler runs the whole apply
    inside the reconciler's in-flight hold.
  - **The sync seam cannot do this.** `updateRepoIndex` refuses to re-point a
    row whose stored path is gone (the repair it owes is async git, forbidden
    on the daemon thread): the row stays `missing` until a locate moves it as
    one unit. `updateRepoIndexAsync` — what `rt repos register` calls — routes
    that case through the same locate and surfaces a refusal instead of
    reporting success over an unhealed index.

What this means for a caller: an empty result for a repo that exists usually
means its row hasn't been touched since the upgrade. Resolve through
rt-client and let the heal run — don't name-match around it.

## Footguns

- The classic: wire form in a settings lookup, or raw `host/path` in a daemon
  payload. Both fail silently (miss / empty result), not loudly.
- A daemon verb returning empty is what "wrong key form" looks like. Check
  the payload against `parseIdentity` before suspecting the store.
- `runs:*` keys are opaque. Running them through `parseIdentity` "for
  safety" rejects real pre-cutover rows.
- The wire form in a URL still needs `encodeURIComponent` — the `%` signs in
  the stored form are themselves not URL-safe.
- Identity work inside this repo imports from `lib/settings/identity.ts`,
  not `@mattstack/rt-client` (which doesn't resolve here). Consumers do the
  opposite.
