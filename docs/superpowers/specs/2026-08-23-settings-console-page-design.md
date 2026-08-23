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
you land on the handful of keys someone actually changed, not on 48 rows. The
console lane withdrew the pushback on that basis; this is a third option, not an
override.

The guardrails from that ruling are adopted verbatim and are what keep the page
a view onto rt rather than an authority: writes happen at the layer row, staged
with the CLI command named; composite keys are read-only; secrets are never
writable.

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
existing rule, already enforced across its surfaces. This page names its rt verb
and an as-of time; it does not invent a competing provenance treatment.

## Read contract

All reads are in-process on the console's server (`getSetting` reads stores via
`fs` and is Node-only). The browser never imports rt-client.

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

### Values — `listSettings(opts): ListedSetting[]`

```ts
interface ListedSetting {
  key: string;
  value: unknown;
  provenance: Provenance[];        // ALWAYS an array, weakest-first
  migrated: boolean;
  unregistered?: true;             // found in a file, absent from the registry
  invalid?: InvalidScope[];        // scopes skipped, with the reason each was refused
  expandError?: string;            // value could not be expanded here; `value` is raw
}

interface Provenance { scope: Scope; file: string | null; }  // file null = registry default
interface InvalidScope { scope: Scope; file: string | null; reason: string; }
```

**Computing "modified":** a key is untouched iff every `provenance` entry has
scope `"default"`. Not `provenance[0]` — deep-merge keys carry several entries,
and a key whose weakest contributor is the default may still be set elsewhere.

**`invalid[]` and `expandError` must be surfaced, not dropped.** They are the
difference between "this key is unset" and "this key has a value that rt refused
to use," which is exactly the class of strangeness that brings someone here.

### Provenance — `explainSetting(key, opts): ExplainRow[]`

```ts
interface ExplainRow {
  scope: Scope;
  file: string | null;
  present: boolean;
  value?: unknown;                 // AS AUTHORED — never variable-expanded
  shadowed?: "teamLocked";
  invalid?: string;
}
```

Rows arrive in `SCOPE_ORDER` — `default, team, user, team.repo, user.repo,
machine, machine.repo`, weakest first — and **losers are included**, with
`present` distinguishing "authored here" from "this layer exists but is empty."
So the layer stack renders directly: iterate in order, highlight the winner,
strike through overridden values, label `shadowed`/`invalid` rows rather than
hiding them.

`value` is as-authored, so a layer showing `${repoRoot}/x` is showing the truth,
not a rendering bug. Where the effective value differs, that difference is the
point.

## Write contract

`setSetting(key, value, scope, opts)`. Validate against the def first with
`validateValue`.

### Editable, in v1

Scalar keys (`type` of `string` | `number` | `boolean`) that are `migrated` and
not `secret`. Writes happen at the layer row being viewed, so the write target is
always the row you are looking at. Staged as an old → new delta with the
`rt settings set <key> <value> --scope <scope>` command named; Apply commits and
the chain re-reads.

### Not editable, and the row says why

- **Composite** (`type` of `object` | `array`) — *"composite value — edit the
  file"*. An absent affordance with no explanation reads as broken rather than as
  a decision.
- **Secret-typed** (`secret: true`) — presence and which store holds it, never a
  value, no reveal. Name the rotation command.
- **Disallowed scopes** — labelled, not hidden. A key with `scopes: ["machine"]`
  shows its user and team rows as unavailable, because "why can't I set this
  here" is a question the page should answer.
- **`teamLocked`** — rows shadowed by a team lock render with that reason.

### The refusal ladder, split

`setSetting` throws on every failure below. The console's rule is that it never
presents an upstream failure as a user error, so these divide:

**User-facing — show as the user's problem:**
- value fails `validateValue` (wrong type, or a path-guard violation)
- scope not in `def.scopes`

**Bugs — the console should have prevented these; surface as errors, not
validation feedback:**
- unknown key (not in the registry)
- key not `migrated`
- `repoIdentity` passed for a non-`repoScoped` key

**Environment faults — not the user's input, and not a bug in the page:**
- malformed JSONC in the target store (rt refuses to edit a malformed file)
- team store missing, or several present with no `opts.team` to disambiguate
- store file does not exist

**The page must never offer an unregistered or unmigrated key for editing.**
Both are refused by `setSetting`, and a refusal the UI could have prevented is a
defect in the UI.

## Deliberately out of scope

Named because each is a natural next feature and none is why this page exists:
bulk edit, import/export, diff-across-scopes, "reset all", and a `state.db`
browser. State is derived cache — repo index, scan caches, endpoint claims —
and inspecting it is a debugging act, not a look-under-the-hood-at-my-config act.
It is also a second data path. Ship settings; add state only if the need appears.

**Repo-scoped keys** ship labelled but without a repo picker in v1. Honest
display of a `repoScoped` key requires choosing a repo context; v1 shows the
global resolution and labels the key as repo-scoped. The picker is a v2
question, and pretending otherwise would mean showing a value that is true for no
repo in particular.

## Testing

- **Read shape:** a key at each of the interesting states — untouched, set at one
  scope, deep-merged across several, `teamLocked`, with an `invalid` scope, with
  an `expandError` — renders the right layer stack and the right modified state.
- **Def-driven rendering:** an UNSET composite key still renders read-only, and
  an unset secret key still renders presence-only. This is the case that fails if
  anything decides by inspecting the value.
- **Refusal split:** each user-facing refusal renders as validation feedback;
  each environment fault renders as an error. No refusal renders as the wrong
  kind.
- **The prevention rule:** the page never renders an edit affordance for an
  unregistered, unmigrated, secret, or composite key.
