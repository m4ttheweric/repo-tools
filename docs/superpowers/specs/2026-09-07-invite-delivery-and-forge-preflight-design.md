# Invite delivery and the joiner's forge-auth preflight (MAT-396)

Two halves of the same trip: how an invite reaches a teammate, and how that
teammate finds out their forge account cannot see the team repo *before* the
clone fails.

Rulings from Matt, 2026-09-07, are binding here and are quoted where they land.

## Where this starts

`mattstack.dev/join#<code>` is built and merged (mattstack.dev PR #1). It reads
the code out of the fragment, offers the download, and fires
`mattstack://join/<code>`. Ruling 3a holds: the code lives in the fragment and
never reaches a server.

Nothing in rt produces that URL. `pasteBlock()` (`lib/team/invite.ts:33`) still
hands the owner a GitHub releases link plus a `mattstack://` deep link that does
nothing on a machine without the app, so delivery is what it always was: copy 77
characters, paste them into a chat.

On the joiner's side the checklist does most of the right things and says the
wrong thing at the one moment that matters:

- `joinDryRun` (`lib/team/join.ts:203`) probes `git ls-remote` with **no** token.
  A private team repo answers "could not read Username", which the dry-run
  correctly refuses to read as a verdict, so Team Continue defers every time.
- `access.team-repo` does attach rt's stored/staged token (24f76ce6). With no
  token at all it returns `status: "error"`, "git has no credential configured
  for this host yet ... couldn't determine access": a required row, no action,
  no way forward, when the true and actionable statement is "connect your GitHub
  account".
- Any non-`ok` verdict blocks Team Continue today
  (`TeamChoiceModel.swift:107`), including a denial only the repo's owner can
  clear.

## Decisions

**D1. The link is the invite.** rt mints `https://mattstack.dev/join#<code>` and
leads with it everywhere an invite is handed over. No new service, no per-invite
artifact, no third party: the code travels in a URL fragment and the clipboard
only. Matt, 2026-09-07: sending the invite by email or SMS is *permanently* off
the table, because it would put user data on mattstack infrastructure.

**D2. The preflight warns, it never blocks.** Team Continue runs a token-aware
probe and shows the verdict inline; the joiner proceeds either way. The required
checklist rows (`account.<forge>`, `access.team-repo`) hold the line before
Install. Matt: this is the estate's own precedent from the section-6 rulings,
never gate a screen on an action only someone else can perform.

**D3. One probe, two callers.** The dry-run and the row call the same function
with the same token precedence, so they can never disagree about what the
joiner's credentials can see.

**D4. rt reports access, it does not grant it.** A denial names the owner and
the org admin as the people who grant it. rt manages forge membership only on
repos it created itself (the `createdByRt` latch in `lib/team/team-local.ts`);
that path belongs to MAT-409 and is out of scope here. Nothing in this design
writes team scope or pushes the team repo: members are pull-only.

## Half 1: delivery

### The link

```ts
// lib/team/invite.ts
export const DEFAULT_JOIN_BASE_URL = "https://mattstack.dev/join";
export function joinLinkBase(env: Record<string, string | undefined>): string;
export function joinLink(base: string, code: string): string; // `${base}#${code}`
```

`RT_JOIN_BASE_URL` overrides the constant. This mirrors
`DEFAULT_INVITE_RELAY_URL` / `RT_INVITE_RELAY_URL`
(`lib/team/relay-client.ts:12`) rather than introducing a settings key: it is
the same class of value (a mattstack-hosted endpoint with a working default),
it is read only by rt itself, and the VM harness needs to point it at a local
fixture without touching a team store.

The code goes in the fragment. Nothing else about the URL is per-invite, so
there is no query string to get wrong.

### `InviteResult` and the paste block

`InviteResult` gains `link: string`. The paste block leads with it:

```
You have been invited to the <team display name> mattstack team.

  https://mattstack.dev/join#<code>

That page installs mattstack and hands the invite to the app.
Already have mattstack? Open mattstack://join/<code>, or paste this code
into Setup -> Join a team:

<code>

Download by hand: https://github.com/m4ttstack/rt/releases/latest
```

The deep link and the bare code stay in the block on purpose: the deep link is
the fast path for someone who already has the app, and the bare code is the only
thing that works when a chat client mangles URLs. The releases URL stays as the
last-resort fallback and keeps `pasteBlock`'s existing `downloadUrl` parameter.

`rt team invite` prints the link on its own line above the block so a terminal
user can click it.

### Owner UI (Settings -> Team)

`TeamPane.swift` renders the minted invite as today, plus:

- **Copy invite link** (primary) ... copies `inv.link`.
- **Share...** ... `NSSharingServicePicker` over `inv.link`, anchored to the
  button, which is how the link reaches Messages, Mail, or AirDrop without rt
  ever handling a recipient.
- **Copy paste block** stays, unchanged, for a chat that wants the whole thing.

`InviteResult` in `Sources-core/Contract/OtherResults.swift` gains an optional
`link` so an older CLI still decodes; the buttons that need it are hidden when
it is absent rather than copying an empty string.

### Deploy dependency (not a design input)

`mattstack.dev` prod serves the holding page today, so `/join` is not reachable
in prod even though it is merged. A link-first invite is inert until
`bunx wrangler pages deploy .` restores the full site. That is a deploy step
owned outside this worktree, recorded here so the release gate does not discover
it during a live invite.

## Half 2: the forge-auth preflight

### The probe

New `lib/team/repo-access.ts`, the only place that decides what a joiner's
credentials can see:

```ts
export type RepoAccessVerdict =
  | { kind: "ok"; detail: string }            // ls-remote exit 0, or 2 for an empty repo
  | { kind: "no-clt"; detail: string }        // git is still the xcode-select shim
  | { kind: "no-account"; detail: string }    // rt holds no token and git offered none
  | { kind: "denied"; detail: string }        // 403 / Authentication failed / Permission denied
  | { kind: "unreachable"; detail: string }   // timeout or network
  | { kind: "indeterminate"; detail: string }; // rt had a token and git still could not ask

export async function probeTeamRepoAccess(
  p: Probes,
  remote: string,
  token: string | null,
): Promise<RepoAccessVerdict>;
```

It runs `git ls-remote --exit-code <remote> HEAD` through `gitWithToken`
(`lib/team/git-credential.ts:19`) with `GIT_TERMINAL_PROMPT=0`, so the token
reaches git through the inline helper's env and never through argv or the URL.

The `no-account` verdict is the one new judgement, and it is deliberately
narrow: it is returned only when git reports "could not read Username" *and* rt
holds no token for that host. When rt holds no token but git answers anyway (the
user's own credential helper, for instance the one `gh auth setup-git` writes),
the probe reports what git found. rt does not claim a credential is missing on
the strength of its own store alone.

Token precedence is the existing stored-then-staged rule, factored out of
`lib/setup/steps/forge-token.ts:12` so the probe, the Install step, and the row
share one implementation instead of three.

### `access.team-repo`

`teamRepoRow` maps the verdict:

| verdict | status | detail / action |
| --- | --- | --- |
| `ok` | `ready` | "reachable" or "empty repo (will be initialized)" |
| `no-clt` | `missing` | unchanged: needs Apple's Command Line Tools first |
| `no-account` | `needs-you` | "connect your GitHub account so rt can prove access", with the same connect action `account.<forge>` offers |
| `denied` | `needs-you` | "your `<forge>` account cannot see `<repo>` yet ... ask `<owner>` or your org admin to grant read access" |
| `unreachable` | `error` | the network detail |
| `indeterminate` | `error` | today's "couldn't determine access" wording, now reachable only when rt did hold a token |

The denial wording never promises rt will fix it (D4). The row stays `required`,
so a joiner still cannot reach Install without access.

### `joinDryRun`

Three changes:

1. It attaches rt's token (same precedence) before probing, so Team Continue
   gives a real answer instead of always deferring.
2. It writes the setup intent whenever the pointer is valid, including when
   access is not yet `ok`. The intent is per-machine state under
   `~/.mattstack/rt/`; nothing here writes team scope.
3. `JoinResult` gains `intent: "written" | "not-written"` and widens `access` to
   `"ok" | "deferred" | "no-account" | "denied" | "unreachable"`.

`intent` is the field the app gates Continue on, and it separates the two
failures that today both arrive as `access: "unreachable"`: a bad or expired
invite (no pointer, nothing to continue with, still blocks) from a repo the
joiner cannot read yet (pointer in hand, Continue proceeds).

Messages the CLI and the app share:

- `deferred` ... "access to the team repo is checked on the next screen" (CLT
  not installed yet; unchanged copy).
- `no-account` ... "connect your GitHub account on the next screen so rt can
  reach `<repo>`".
- `denied` ... "your GitHub account cannot see `<repo>` yet ... ask `<owner>` to
  add you".

### Team screen

`TeamChoiceModel.prepare` stops gating on `access == "ok"` and gates on
`intent == "written"`. A non-`ok` verdict becomes a warning carried alongside
`joinSummary` and rendered under the code field; Continue stays enabled. A
result with `intent: "not-written"` keeps today's blocking failure copy.

## What this deliberately does not change

**`account.<forge>` reading `ready` off a live `gh auth status` session while
rt's own store is empty.** It is a real asymmetry: rt's clone and probe use rt's
token, that row can be satisfied by gh's. It is not a defect worth a secrets
change here, because the access row now says "connect your GitHub account"
exactly when rt's missing token is what blocks the probe, and because a gh
session that has run `setup-git` genuinely does let git clone. Importing gh's
token into rt's store is a separate decision about where credentials live.

**Granting forge access.** MAT-409, other lane, `createdByRt` latch.

## Testing

Unit (`bun run test`):

- `joinLink` / `joinLinkBase`: default, env override, fragment placement, no
  code in the query string.
- `pasteBlock`: contains the link, the deep link, and the bare code.
- `mintInvite`: `link` present in `InviteResult`.
- `probeTeamRepoAccess`: one case per verdict off a seamed exec, including the
  two "could not read Username" cases (token held, no token held) that separate
  `indeterminate` from `no-account`.
- `teamRepoRow`: verdict-to-row table above, including the connect action.
- `joinDryRun`: intent written on `denied` / `no-account`; not written on an
  unreachable relay; `access` and `message` per verdict.

Swift (`MattstackCoreChecks`):

- `InviteResult` decodes with and without `link`.
- `TeamChoiceModel` proceeds on `access: "denied"` with `intent: "written"` and
  still blocks when `intent: "not-written"`.

E2E (`bun run test:e2e`): `rt team invite --json` envelope carries `link`.

Docs: `website/docs/reference/team/invite.mdx` regenerates for the new field
(`bun run docs:check` gates it).

## Verification

`bun run test:all`, `bunx tsc --noEmit`, `bun run docs:check`,
`bun run picker:check`, `bash scripts/repo-purity.sh`. No new command leaf, so
no `omitBehavior` declaration is needed; no new module registry entry.

Live proof belongs to the VM join leg (MAT-393): an owner mints, the link opens
`/join#<code>`, the app takes the deep link, and a joiner with no forge grant
sees the denial named at Team Continue instead of a failed clone.
