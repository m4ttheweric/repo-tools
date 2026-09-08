# Invite delivery and the joiner's forge-auth preflight (MAT-396)

Two halves of the same trip: how an invite reaches a teammate, and how that
teammate finds out their forge account cannot see the team repo *before* the
clone fails.

Rulings from Matt, 2026-09-07 and 2026-09-08, are binding here and are quoted
where they land.

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
  (`TeamChoiceModel.swift:108`), including a denial only the repo's owner can
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

**D5. The clipboard leg is built.** Matt, 2026-09-08: the live landing page
already copies `mattstack://join/<code>` on the Download click, so the app owes
the other half of that promise. Two constraints ride with the ruling. macOS
shows a "pasted from" notice whenever an app reads the pasteboard, so the read
happens only when the user arrives on the Team/Join surface and never on a
background timer. And the Join field must accept the deep link itself: today
pasting the copied link there fails `decodeCode`, because
`normalizedInviteCode` (`rt-tray/Sources-core/Setup/TeamChoiceModel.swift:53`)
only strips whitespace.

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

The code goes in the fragment, verbatim as `encodeCode` produced it ... dashes
included, since `join.js` normalizes them away before validating. Nothing else
about the URL is per-invite, so there is no query string to get wrong.

That fragment is a cross-repo contract with a page rt cannot see, so it gets
pinned on rt's side: a test asserts the fragment satisfies mattstack.dev's
`isValidCode` rules (77 chars once `-` and whitespace are stripped, every
character in the Crockford alphabet `0123456789ABCDEFGHJKMNPQRSTVWXYZ`) rather
than merely that a link was built. The page holds the mirror of this test
already.

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
  `AXID.settingsTeamCopyLink`.
- **Share...** ... `NSSharingServicePicker` over `inv.link`, anchored to the
  button, which is how the link reaches Messages, Mail, or AirDrop without rt
  ever handling a recipient. `AXID.settingsTeamShareInvite`.
- **Copy paste block** stays, unchanged, for a chat that wants the whole thing.

Both ids join `AXID` beside the existing `settingsTeamCopyPaste`, so the pane's
UI checks can drive them.

`InviteResult` in `Sources-core/Contract/OtherResults.swift` gains an optional
`link` so an older CLI still decodes; the buttons that need it are hidden when
it is absent rather than copying an empty string.

### Joiner UI: the clipboard hand-off

The landing page copies `mattstack://join/<code>` on the Download click. The
joiner then installs, launches, and lands on the Team screen with a code sitting
in their clipboard that nothing asks for. This closes that loop (D5).

**One extractor, three shapes.** Anywhere rt accepts a pasted invite it accepts
the bare code (dashed or not), `mattstack://join/<code>`, and
`https://mattstack.dev/join#<code>`. Whichever arrives, the bare code is what
reaches `decodeCode`.

```ts
// lib/team/invite-crypto.ts, beside normalizeCode
export function extractInviteCode(input: string): string | null;
```

Swift gets the mirror: `JoinLink.code(fromText:)` in
`rt-tray/Sources-core/Launch/LaunchGuard.swift`, reusing the existing
`code(from: URL)` for the deep-link shape, and `normalizedInviteCode`
(`TeamChoiceModel.swift:53`) routes through it instead of only stripping
whitespace. The CLI's own code reader (`commands/team.ts:61`, `defaultReadCode`)
routes through the TS one, so a terminal user pasting a link is no worse off
than one pasting a code.

Three implementations of the same rule now exist across two repos (the page's
`isValidCode` is the third), so the accepted and rejected shapes live in a
shared fixture file that both rt suites assert against, the way `ui/fixtures/`
is golden-tested from Go and TypeScript. Drift becomes a red test rather than an
invite that works in one field and not another.

**The offer.** On arriving at the Team screen with Join selected ... first
launch through `--resume-setup`, a `mattstack://join` link, or the user picking
Join ... the app reads `NSPasteboard.general` once and, if the string yields a
code and the field is empty, shows a card above it:

> Join a team? We found an invite on your clipboard. [Use it] [Ignore]

**Use it** fills the field; nothing else happens, so Continue still runs the
same dry-run gate and no join is ever automatic. **Ignore** dismisses the card
for that pasteboard `changeCount`, so switching away and back does not nag with
content the user already refused.

Constraints that are not negotiable, per D5 and the estate's honesty rules:

- The read happens on arrival at that surface and nowhere else. No timer, no
  `onChange` poll, no read from a background service. macOS shows a "pasted
  from" notice, and that notice must line up with a moment the user caused.
- The card is the disclosure. The clipboard is never read into the field
  silently, which is what makes the notice explicable rather than alarming.
- The code never reaches a log. `TrayLog` records that an invite was offered,
  never its value.

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
  | { kind: "indeterminate"; detail: string }; // git could not ask, and rt cannot say why: a token was held, or the store was unreadable

export async function probeTeamRepoAccess(
  p: Probes,
  remote: string,
  lookup: ForgeTokenLookup,
): Promise<RepoAccessVerdict>;
```

It runs `git ls-remote --exit-code <remote> HEAD` through `gitWithToken`
(`lib/team/git-credential.ts:19`) with `GIT_TERMINAL_PROMPT=0`, so the token
reaches git through the inline helper's env and never through argv or the URL.

The `no-account` verdict is the one new judgement, and it is deliberately
narrow: it is returned only when git reports "could not read Username" *and* the
token lookup came back `absent`. When rt holds no token but git answers anyway (the
user's own credential helper, for instance the one `gh auth setup-git` writes),
the probe reports what git found. rt does not claim a credential is missing on
the strength of its own store alone.

### The one token lookup

Three readers implement stored-then-staged today and disagree about failure:
`lib/setup/steps/forge-token.ts:13` returns null on any store error other than
`NoAgeKeyError`, `lib/team/stored-forge-token.ts:12` swallows every error and
never consults the stage, and `lib/setup/validators/access.ts:34` delegates to
`SecretPresence.has` (whose real implementation, `plan.ts:172`, rethrows
anything that is not `NoAgeKeyError`) and then swallows it anyway.

One survivor, in `lib/team/forge-token.ts`:

```ts
export type ForgeTokenLookup =
  | { kind: "token"; token: string }
  | { kind: "absent" }                        // no key for this host, or store and stage both empty
  | { kind: "unreadable"; reason: string };   // the store failed for a reason that is not a missing age key

export interface ForgeTokenSeams {
  readStored: (domain: string, key: string) => Promise<string | null>; // throws NoAgeKeyError before the key exists
  readStaged: (domain: string, key: string) => string | null;
}

export async function forgeTokenLookup(remote: string, seams: ForgeTokenSeams): Promise<ForgeTokenLookup>;
export function tokenOrNull(lookup: ForgeTokenLookup): string | null;
```

Error policy, one rule for every caller: `NoAgeKeyError` means "nothing
decryptable yet" and falls through to the stage; any other store error is
`unreadable` and is carried, not swallowed. The distinction is what keeps the
probe honest ... `absent` is what licenses the `no-account` verdict, while
`unreadable` can only ever produce `indeterminate`, because a store rt cannot
read is not evidence that the joiner has no account.

`tokenOrNull` keeps the Install-step callers (`lib/setup/steps/repos.ts:112`)
on their existing `string | null` shape, so clone behavior is unchanged.

### One classifier, not two

`lsRemoteOutcome` (`lib/setup/validators/access.ts:50`) is deleted. It is the
second classifier of the same git output, which is the thing D3 exists to
prevent. Both of its callers ... `teamRepoRow` (`:80`) and `repoRow` (`:116`) ...
re-implement on `probeTeamRepoAccess` plus a shared

```ts
function rowFromVerdict(verdict: RepoAccessVerdict, ctx: { remote: string; grantedBy: string }): Pick<Row, "status" | "detail" | "action">;
```

`grantedBy` is the caller's answer to "who can grant this": the team's owner for
`access.team-repo`, the repo's own admin for the per-repo `access.repo.<slug>`
rows, which have no team owner to name. `repoRow` stays optional and keeps its
own title and `why`; only the classification and the status mapping are shared.

### `access.team-repo`

`teamRepoRow` maps the verdict:

| verdict | status | detail / action |
| --- | --- | --- |
| `ok` | `ready` | "reachable" or "empty repo (will be initialized)" |
| `no-clt` | `missing` | unchanged: needs Apple's Command Line Tools first |
| `no-account` | `needs-you` | "connect your GitHub account so rt can prove access", with the same connect action `account.<forge>` offers |
| `denied` | `needs-you` | "your `<forge>` account cannot see `<repo>` yet ... ask `<owner>` or your org admin to grant read access" |
| `unreachable` | `error` | the network detail |
| `indeterminate` | `error` | today's "couldn't determine access" wording, now reachable only when rt held a token or could not read its own store (the store failure named in the detail) |

The denial wording never promises rt will fix it (D4). The row stays `required`,
so a joiner still cannot reach Install without access.

### `joinDryRun`

Three changes:

1. It passes the `ForgeTokenLookup` to the probe, so rt's own token is offered
   and Team Continue gives a real answer instead of always deferring.
2. It writes the setup intent whenever the pointer is valid, including when
   access is not yet `ok`. The intent is per-machine state under
   `~/.mattstack/rt/`; nothing here writes team scope.
3. `JoinResult` gains `intent: "written" | "not-written"` and widens `access` to
   the six values below.

`intent` is the field the app gates Continue on, and it separates the two
failures that today both arrive as `access: "unreachable"`: a bad or expired
invite (no pointer, nothing to continue with, still blocks) from a repo the
joiner cannot read yet (pointer in hand, Continue proceeds).

Every verdict maps, and every value carries copy. The message is one string,
written once and shown by both the CLI and the app:

| verdict | `access` | `intent` | message |
| --- | --- | --- | --- |
| `ok` | `ok` | written | "Joining `<name>` (owner `<owner>`)" |
| `no-clt` | `deferred` | written | "Joining `<name>` (owner `<owner>`) ... access to the team repo is checked on the next screen" (today's copy) |
| `no-account` | `no-account` | written | "Joining `<name>`. Connect your `<GitHub\|GitLab>` account on the next screen so rt can reach `<repo>`." |
| `denied` | `denied` | written | "Joining `<name>`. Your `<GitHub\|GitLab>` account cannot see `<repo>` yet ... ask `<owner>` or your org admin to grant read access." |
| `unreachable` | `unreachable` | written | "Joining `<name>`. Could not reach `<repo>`: `<detail>`. The next screen re-checks it." |
| `indeterminate` | `undetermined` | written | "Joining `<name>`. Could not determine access to `<repo>` yet: `<detail>`. The next screen re-checks it." |

A pointer that never resolved (relay unreachable, invite gone) is the one
`intent: "not-written"` case; it keeps `access: "unreachable"` and today's
blocking copy.

`unreachable` and `indeterminate` read as re-checked-later here and as `error`
on the checklist row, and that asymmetry is deliberate: at Team Continue a later
check genuinely is coming, while the row *is* that later check, so the same fact
is a dead end there.

The `access` enumeration is mirrored in a trailing comment on
`TeamJoinResult.access` (`rt-tray/Sources-core/Contract/OtherResults.swift:32`,
today `ok | denied | unreachable`); it moves with this change.

### Team screen

`TeamChoiceModel.prepare` stops gating on `access == "ok"`
(`rt-tray/Sources-core/Setup/TeamChoiceModel.swift:108`) and gates on
`intent == "written"`. A non-`ok` verdict becomes a warning carried alongside
`joinSummary` and rendered under the code field; Continue stays enabled. A
result with `intent: "not-written"` keeps today's blocking failure copy.

Version skew, both directions, because dev-mode runs an app and a CLI that are
not built together:

- **Newer CLI, older app.** An `access` value the app does not know must never
  block: the gate is `intent`, and any unrecognized value renders as a plain
  warning carrying the CLI's own `message`.
- **Older CLI, newer app.** `intent` is absent. The app falls back to today's
  rule ... treat it as `written` only when `access == "ok"`, blocking otherwise ...
  so an old CLI cannot silently wave a joiner past a denial.

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
  code in the query string, plus the `isValidCode` contract assertion above.
- `pasteBlock`: contains the link, the deep link, and the bare code.
- `extractInviteCode`: every shape in the shared fixture ... bare code with and
  without dashes, `mattstack://join/<code>`, `https://mattstack.dev/join#<code>`,
  surrounding whitespace ... plus the rejections (a bare URL with no code, a
  wrong scheme, a truncated code).
- `mintInvite`: `link` present in `InviteResult`, built from the same code the
  result carries.
- `forgeTokenLookup`: `token` from the store, `token` from the stage after a
  `NoAgeKeyError`, `absent` when both are empty, `unreadable` when the store
  throws anything else.
- `probeTeamRepoAccess`: one case per verdict off a seamed exec, including all
  three "could not read Username" cases (`token` held, `absent`, `unreadable`)
  that separate `indeterminate` from `no-account`.
- `teamRepoRow` and `repoRow`: the verdict-to-row table above, including the
  connect action and each row's own `grantedBy` clause.
- `joinDryRun`: the full verdict table ... `intent` written on every resolved
  pointer, not written on an unreachable relay, and `access` plus `message` per
  verdict.

Swift (`MattstackCoreChecks`):

- `InviteResult` decodes with and without `link`.
- `TeamChoiceModel` proceeds on `access: "denied"` with `intent: "written"`,
  proceeds on an unrecognized `access` value, and blocks both when
  `intent: "not-written"` and when `intent` is absent with a non-`ok` access.
- `rt-tray/Tests/stub-rt/stub.ts:166`'s invite fixture gains `link` so the
  pane's checks exercise the new buttons.
- `JoinLink.code(fromText:)` against the same shared fixture as the TS
  extractor, which is what keeps the two from drifting.
- The clipboard offer: a card appears when the pasteboard holds a usable invite
  and the field is empty, `Use it` fills the field without joining, `Ignore`
  suppresses it for that `changeCount`, and a pasteboard holding anything else
  produces no card and no read beyond the one on arrival.

No e2e leg: `rt team invite` needs a live relay and a cloned team store, which
no e2e fixture provides today, so the `--json` shape is proven at unit level
through `mintInvite` with a stub relay. Standing that fixture up is not this
ticket's work.

Docs: the generated `website/docs/reference/team/invite.mdx` is usage and flags
only, so a new result field produces no diff there and `docs:check` cannot gate
it. The link belongs in prose: a hand-written
`website/docs/reference/_partials/team/invite.mdx`, which `gen-docs` includes
via `hasPartial` (`scripts/gen-docs.ts:30`), describing the link as the thing
you send and the code as the fallback.

## Verification

`bun run test:all`, `bunx tsc --noEmit`, `bun run docs:check`,
`bun run picker:check`, `bash scripts/repo-purity.sh`. No new command leaf, so
no `omitBehavior` declaration is needed; no new module registry entry.

Live proof belongs to the VM join leg (MAT-393): an owner mints, the link opens
`/join#<code>`, the app takes the deep link, and a joiner with no forge grant
sees the denial named at Team Continue instead of a failed clone.
