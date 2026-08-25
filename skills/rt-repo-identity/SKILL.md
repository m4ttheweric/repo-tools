---
name: rt:repo-identity
description: Use when writing or reviewing code in a mattstack app (rt, mr-board, console, gitq, deck) that stores anything per-repo, keys a cache/table/kv/dir by repo, sends a repo to an rt daemon verb or REST path, adds a repo-scoped settings key, or displays a repo name or chat handle — anywhere a git repo needs a string key or label. Also use when a repo-keyed daemon verb or REST call returns empty for a repo that exists.
---

# The repo identity contract

Every per-repo key in the mattstack estate is a stable serialized repo
identity, not a name. The instinct "key on something stable" is right; the
codec is not yours to write.

## The contract

1. Identities come from `@mattstack/rt-client` 0.4.0+ (`deriveRepoIdentity`,
   `serializeIdentity`, `parseIdentity`, `identityFromRemote`) — never
   re-derive with your own git calls, URL surgery, or basename. Inside
   repo-tools itself, import the same helpers from `lib/settings/identity.ts`.
2. The SERIALIZED wire form (`remote:gitlab.com%2Fgroup%2Frepo` /
   `path:%2Fabs%2Fpath` — kind, literal colon, encodeURIComponent'd id,
   slash-free) keys state.db tables and kv, daemon payloads, REST path
   segments (`encodeURIComponent` it again inside a URL), and the repo index.
3. The RAW `host/path` form keys settings-store sections (`repos.<identity>`)
   and everything the settings resolver touches. Never swap the two forms.
4. Anything a human reads goes through a label decode — `repoLabel()` in
   repo-tools, `parseIdentity` then last path segment (remote) or basename
   (path) in consumers. `parseIdentity` hands back the id ALREADY decoded —
   never `decodeURIComponent` it again. The wire form is a key, never copy;
   a label never goes back as a key. Chat handles (`[a-z0-9._-]+`) forbid
   `%` and `:` — build them from the label, not the wire.
5. `parseIdentity` is strict-canonical: only wires `serializeIdentity` emits
   parse, and it is the guard at every repo-keyed daemon verb — a bare name
   resolves EMPTY, never an error. Exception: `runs:*` verbs treat `repo` as
   an opaque run-dir key; pass back verbatim what `runs:list` handed out.

Legacy state heals itself: the daemon boot migration re-keys old stores
one-shot, the repo index heals additively, and `rt repos prune` collapses
leftover name/identity pairs. An empty result for a repo you know exists
means wrong key form or an untouched legacy row — resolve through rt-client,
never name-match around it.

## Where the details live

| Need | Read |
|---|---|
| Full contract: derivation rules, verb families, legacy re-key/heal/prune, footguns | `~/Documents/GitHub/repo-tools/docs/repo-identity.md` |
| Settings scopes, registry checklist, adding a repo-scoped key | `~/Documents/GitHub/repo-tools/docs/settings-architecture.md` |
| Codec signatures + copy-paste example while standing in a consumer repo | `node_modules/@mattstack/rt-client/README.md` (from that repo's root) |
