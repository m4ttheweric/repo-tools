# Settings page in the console — design

A settings surface inside the mattstack console: browse what is configured,
see why a key has the value it has, and change it. Modelled on VS Code's
settings editor.

**Owner split.** This spec defines the substrate contract — what the resolver
returns, what it refuses, and which refusals are the user's fault. The console
lane builds the page on a branch in the console repo, against its rail/PageShell
conventions and Mantine implementation.

## Why it exists

Matt, 2026-08-23: *"I open this when I need to verify what the settings are,
maybe because I saw something that's a little strange, or I wanna change
something. It's just a way to look under the hood exactly like in VS Code when
you go to the settings. I just don't wanna overbuild it."*

That is two moments — verify, and change — and both start without a specific key
in mind. This is the entrance the console's existing explain-a-key lens does not
serve: the lens answers *"why is this key this value"* and requires you to
already know the key.

### Relationship to the console design's "config is a lens" ruling

`2026-08-22-console-design.md` refuses a browsable settings page, on the grounds
that it "would produce a spreadsheet nobody opens and would tempt the console
toward becoming a config editor, which is where a second source of truth is
born."

That objection is to a flat grid, and it stands. What makes VS Code's settings
editor navigable rather than a wall is **search plus a modified-first default**:
you land on the handful of keys someone actually changed, not on the whole
registry. The console lane withdrew the pushback on that basis; this is a third
option, not an override.

The guardrails from that ruling are adopted verbatim and are what keep the page
a view onto rt rather than an authority: writes happen at the layer row, staged
with the CLI command named; composite keys are read-only; secrets are never
writable.

**One upstream correction this spec is the authority for.** The console design's
explain-lens example copy — *"lists concatenate; the user layer appends"* — is
false against this substrate. `merge` is only `"replace" | "deep"`, and
`deepMerge` treats arrays as leaves, so **lists always replace atomically; they
never concatenate**. Do not ship that sentence.

## Surface

Rail entry → PageShell. The drawer carries per-app navigation (`rt.`, `deck.`,
`board.`, `gitq.`, `mattstack.`, `claude.`), so the main pane stays a flat
searchable result set rather than a grouped outline.

**Main pane:** one searchable list. Default filter is **modified only**, with an
"all" toggle. Each row: key, effective value, winning scope.

**Row expansion is the explain lens** — the same component the palette's
"why is this key this value" opens. The list and the lens are one feature with
two entrances: arriving without a key in mind, and arriving with one.

**Every panel names the command that produced its data and when** — the console's
existing rule. Reads happen in-process, so there is no literal shell invocation;
display the equivalent verb: `rt settings list` for the main pane, `rt settings
explain <key>` for an expanded row.

## Read contract

All reads are in-process on the console's server (`getSetting` reads stores via
`fs` and is Node-only). The browser never imports rt-client. v1 calls
`listSettings` and `explainSetting` **with no opts** (`allDefs` takes none) — see
"Repo-scoped keys" for what that forecloses.

### Catalogue — `allDefs(): SettingDef[]`

```ts
interface SettingDef {
  key: string;
  type: "string" | "number" | "boolean" | "object" | "array";
  scopes: SettingScope[];          // "user" | "team" | "machine"
  default?: unknown;
  merge: "replace" | "deep";
  teamLocked?: boolean;
  secret?: boolean;
  repoScoped?: boolean;
  migrated?: boolean;
  legacyFile?: string;
  pathGuardFields?: string[];
  description: string;
}
```

**Every rendering decision comes from the def, never from inspecting the runtime
value.** `type` decides scalar vs composite; `secret` decides presence-only;
`scopes` decides which layer rows are editable; `repoScoped` decides whether repo
rungs are reachable at all. Deciding by inspection gets an unset key wrong.

**`migrated` is a trap — never test `def.migrated === true`.** The real test is
`isMigrated(def)`, which returns `def.migrated !== false`: the flag is *absent*
on most rows and absence means migrated. Testing the field directly would render
the majority of the registry — every `deck.`, `board.`, `gitq.`, `mattstack.`,
and `claude.` key — as non-editable, which is most of what is editable at all.
Use `isMigrated(def)`, or `ListedSetting.migrated`, which has already applied it.

### Values — `listSettings(opts): ListedSetting[]`

```ts
interface ListedSetting {
  key: string;
  value: unknown;
  provenance: Provenance[];        // ALWAYS an array, weakest-first
  migrated: boolean;               // isMigrated() already applied
  unregistered?: true;             // found in a file, absent from the registry
  invalid?: InvalidScope[];        // scopes skipped, with the reason each was refused
  expandError?: string;            // value could not be expanded here; `value` is raw
}

interface Provenance { scope: Scope; file: string | null; }  // file null = registry default
interface InvalidScope { scope: Scope; file: string | null; reason: string; }
```

**Computing "modified":** a key is untouched iff every `provenance` entry has
scope `"default"`. Not `provenance[0]` — deep-merge keys carry one entry per
contributing layer, so a key whose weakest contributor is the default may still
be set elsewhere.

**Most keys have no default and are unset**, resolving to `value: undefined` with
`provenance: []`. The modified test stays correct (vacuously true on an empty
array), but the row contract has no value and no winning scope for those keys in
"all" mode — render that state explicitly, and never index
`provenance[provenance.length - 1]` without checking length.

**`invalid[]` and `expandError` must be surfaced, not dropped.** They are the
difference between "this key is unset" and "this key has a value that rt refused
to use," which is exactly the class of strangeness that brings someone here.

**`unregistered` rows have no def at all** — they were found in a store file but
are not in the registry. Since every rendering decision comes from the def, these
render as read-only with their file and value, labelled as unregistered. They are
never editable: `setSetting` refuses unknown keys.

### Provenance — `explainSetting(key, opts): ExplainRow[]`

```ts
interface ExplainRow {
  scope: Scope;
  file: string | null;
  present: boolean;                // value !== undefined at this layer
  value?: unknown;                 // AS AUTHORED — never variable-expanded
  shadowed?: "teamLocked";
  invalid?: string;
}
```

Rows are pushed in `SCOPE_ORDER` — `default, team, user, team.repo, user.repo,
machine, machine.repo`, weakest first — and **losers are included**, with
`present` distinguishing "authored here" from "this layer exists but is empty."

**The row set is NOT a fixed seven-row ladder.** Two consequences an engineer
will otherwise get wrong:

- **`scope: "team"` can repeat.** One row is emitted per cloned team with a local
  store, or a single absent row with `file: null` when no team is cloned. **Do
  not key rows by scope** — they will collide.
- **Repo rungs never appear in v1.** `team.repo` / `user.repo` / `machine.repo`
  are omitted entirely unless the key is `repoScoped` *and* a `repoIdentity` was
  supplied. v1 passes no opts, so these are always absent.

**Rendering the stack.** Iterate in array order, label `shadowed` and `invalid`
rows rather than hiding them. How the winner renders depends on `merge`:

- **`merge: "replace"`** — one winner: the strongest row with `present &&
  !shadowed && !invalid`. Highlight it; strike through weaker present rows.
- **`merge: "deep"`** — **there is no single winner.** Several layers contribute
  simultaneously, and a weaker layer's surviving leaves must not be struck
  through. `ExplainRow` carries no leaf-level attribution, so the contributing
  set comes from the same key's `ListedSetting.provenance` (or `getSetting`),
  which lists exactly the layers that own a surviving leaf. Highlight every
  contributing layer; strike through only present rows absent from that set.
  **Match a `Provenance` entry to an `ExplainRow` on `(scope, file)`, not scope
  alone** — with two cloned teams both `team` rows would otherwise highlight when
  only one contributes. Both types carry `file`.

## Write contract

```ts
setSetting(key: string, value: unknown, scope: SettingScope, opts?: SetSettingOpts): void

interface SetSettingOpts {
  repoIdentity?: string;  // required to target a repoScoped key's repos.<identity> section
  team?: string;          // which team's local store, for scope "team"; ignored otherwise
}
```

**`scope` here is `SettingScope` (`"user" | "team" | "machine"`), not the `Scope`
the layer rows use.** The `default` row is never a write target, and repo rungs
would require `opts.repoIdentity` — which v1 does not supply, consistent with
repo rungs never rendering.

Validate against the def with `validateValue` before calling.

### Editable, in v1

Scalar keys (`type` of `string` | `number` | `boolean`) that satisfy
`isMigrated(def)` and are not `secret`. Writes happen at the layer row being
viewed, so the write target is always the row you are looking at. Staged as an
old → new delta with the `rt settings set <key> <value> --scope <scope>` command
named; Apply commits and the chain re-reads.

### Not editable, and the row says why

- **Composite** (`type` of `object` | `array`) — *"composite value — edit the
  file"*. An absent affordance with no explanation reads as broken rather than as
  a decision.
- **Secret-typed** (`secret: true`) — presence and which store holds it, never a
  value, no reveal.
- **Disallowed scopes** — labelled, not hidden. A key with `scopes: ["machine"]`
  shows its user and team rows as unavailable, because "why can't I set this
  here" is a question the page should answer.
- **`teamLocked`** — rows shadowed by a team lock render with that reason.

**`secret`, `teamLocked`, `migrated: false`, and `legacyFile` have no rows in the
registry today.** They are real def fields and forward-looking; the rules above
are what the page must do when a row appears. Two consequences: no rotation
command can be named until a secret key exists (defer that copy rather than
inventing one), and their tests need synthetic defs, not registry fixtures.

### The refusal ladder

`setSetting` throws a plain `Error` with a `rt: ` prose message on every failure.
**There is no code, subclass, or field to discriminate on** — so the page must not
try to classify a caught throw by parsing it.

**The rule: pre-validate, so only environment faults are reachable.** Before
calling, check with the def and `validateValue` that the key is registered,
`isMigrated`, not `secret`, scalar, and that the scope is in `def.scopes`. Then
any throw that still escapes is an environment fault and renders as an error, not
as validation feedback.

Classified by who is at fault:

**User-facing — the user's input is wrong, show as validation feedback:**
- value fails `validateValue` (wrong type, or a path-guard violation)

**Bugs — the page should have prevented these; surface as errors:**
- unknown key (not in the registry)
- key not `isMigrated`
- **scope not in `def.scopes`** — no user input can produce this, because
  `scopes` is what decides which layer rows are editable in the first place.
  Reaching it means the page offered a write it had already been told was
  illegal.
- `repoIdentity` passed for a non-`repoScoped` key

**Environment faults — not the user's input, and not a bug in the page:**
- malformed JSONC in the target store (rt refuses to edit a malformed file)
- team store missing for the named team
- no local team store found
- several team stores found with no `opts.team` to disambiguate — the page can
  offer the fix, since `SetSettingOpts.team` selects one
- store file does not exist

**The page must never offer an unregistered or unmigrated key for editing.**
Both are refused, and a refusal the UI could have prevented is a defect in the UI.

**One asymmetry to know:** `setSetting` strips `pathGuardFields` for
`scope: "machine"`, so a machine-scope value that a bare `validateValue(def,
value)` rejects would actually be accepted. Latent in v1 — the only key with
`pathGuardFields` is an object, hence read-only — but pre-validation should
mirror the same exemption if a scalar ever gains a path guard.

## Deliberately out of scope

Named because each is a natural next feature and none is why this page exists:
bulk edit, import/export, diff-across-scopes, "reset all", and a `state.db`
browser. State is derived cache — repo index, scan caches, endpoint claims —
and inspecting it is a debugging act, not a look-under-the-hood-at-my-config act.
It is also a second data path. Ship settings; add state only if the need appears.

**Repo-scoped keys** ship labelled but without a repo picker in v1. Honest
display of a `repoScoped` key requires choosing a repo context; v1 shows the
global resolution and labels the key as repo-scoped. This is why v1 passes no
opts and why repo rungs never render. The picker is a v2 question, and pretending
otherwise would mean showing a value that is true for no repo in particular.

## Testing

- **Read shape:** a key at each interesting state — unset with empty provenance,
  set at one scope, deep-merged across several, with an `invalid` scope, with an
  `expandError`, `unregistered` — renders the right layer stack and the right
  modified state.
- **`isMigrated`, not `def.migrated`:** a key whose def omits `migrated` renders
  as editable. This is the case that silently locks most of the registry.
- **Def-driven rendering:** an UNSET composite key still renders read-only, and
  an unset secret key still renders presence-only. This is the case that fails if
  anything decides by inspecting the value. Secret and `teamLocked` cases need
  synthetic defs — no registry row sets either.
- **Deep-merge stack:** a `merge: "deep"` key with two contributing layers
  highlights both and strikes through neither.
- **Repeated team rows:** two cloned teams produce two `scope: "team"` rows and
  the stack renders both.
- **Refusal handling:** pre-validation blocks the user-facing and bug cases
  before any call; an environment fault renders as an error, never as validation
  feedback.
- **The prevention rule:** the page never renders an edit affordance for an
  unregistered, unmigrated, secret, or composite key.
