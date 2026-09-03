# Setup installs: herdr, the chat plugin, and Fast Browser's Chrome extension

2026-09-03, MAT-401. Three "does the tool actually land" legs from MAT-386
section 7b. Each was investigated against the code that runs it before anything
was designed, and two of the three turned out to already work. The third
uncovered a day-one blocker nobody had seen, because the clean room cannot
reproduce it.

Baseline for this branch: `bun run test` green at `3e842efb`, 5965 pass, 3 skip,
0 fail.

## What the investigation found

### Leg 1: herdr. Nothing to build.

herdr is not bundled (`rt-tray/deps.lock` carries 15 helpers, none of them
herdr). It is installed by the `tool.herdr` checklist row's own action,
`{type:"install", tool:"herdr", via:"brew"|"vendor"}`, which reaches
`installTool` and runs `VENDOR_INSTALLERS.herdr` (`https://herdr.dev/install.sh`)
under the argv-only fetch-then-run path. The installer drops the binary in
`~/.local/bin`, and the MAT-386 section 6 PATH work already makes that visible:
`withLocalBinFallback` resolves a bare command there when PATH has no copy, and
`withLocalBinOnPath` puts the directory on every child's PATH. The
`herdr.integration` Install step then runs `herdr integration install claude`
per Claude config dir, and it runs after `plugins.install`, so `~/.claude`
exists by the time herdr's integration installer requires it.

The clean-room create walkthrough exercised all of this on 2026-09-01. The leg
is done; what remains on the MAT-401 line is a fresh-Mac observation, not code.

One thing the investigation did surface: **two different artifacts can be
called "the herdr chat plugin"**, and only one of them is in scope here. See
Follow-ups.

### Leg 2: the chat plugin. Installed already; invisible if it fails.

`chat@mattstack` is already in `BASE_PLUGINS`
(`lib/setup/steps/plugins.ts`), alongside `mattstack@mattstack` and
`fast-browser@mattstack`. The plugin's source of truth is this repo, at
`marketplace/plugins/chat` (v0.3.0, skills `sign-in`, `join`, `sign-out`,
`away`, plus session-start/session-end hooks), published to
`m4ttstack/mattstack-marketplace` by `scripts/release/marketplace.sh`. The
clean room's "2 marketplace(s), 3 plugin(s)" is exactly this set.

The gap is observability, not installation. Row ids are enumerable, and no row
watches the base plugins: `pack.<pack>` covers only team packs declared in a
`requirements.jsonc`. So a base plugin that failed to land is invisible to
`rt setup status`, to `rt verify`, and to the Done screen. `plugins.install`
does fail loudly on a non-zero `claude plugin install`, but nothing re-checks
the result afterwards, and nothing catches a plugin that was installed and then
removed.

### Leg 3: the Fast Browser extension. rt cannot install it, and Install is deadlocked.

**rt cannot install the extension, and that is a fact about fast-browser rather
than a hole in rt.** The extension is not in the fast-browser repo at all: a
pinned zip is downloaded from a GitHub release at setup time and unpacked to
`~/.fast-browser/extension/current/unpacked`. There is no CRX and no Chrome Web
Store listing. Chrome's only unattended install paths, the per-user
`External Extensions/<id>.json` file and `ExtensionSettings` policy, accept a
CRX or an update URL and have no "load this unpacked directory" form. Packing a
CRX that keeps the extension's stable id (`bjlfojdaaanoliidngocnbcalhpfmlie`,
derived from the fixed `key` in its manifest and asserted on every install)
needs the private half of that key, which fast-browser holds and rt does not.
fast-browser's own README states that unattended extension loading is not
supported.

So the manual step stays. What this branch fixes is everything around it.

**The blocker.** `fastBrowserRow` is `required: true` whenever Chrome is
installed, and `required: false` only when Chrome is absent. That was the
MAT-386 section 6 ruling ("optional until Chrome exists"), and
`validators-tools.test.ts` pins it with "extension not loaded with Chrome
installed -> still required".

But fast-browser's runtime and its extension files are both created by
`installExtension`/`installRuntime` inside `fast-browser setup`, which rt runs
as the `fastbrowser.setup` **Install step**. Before Install, neither exists. So
on a fresh Mac that has Chrome:

- `resolveTool` finds the bundled binary, so the row is not `missing`.
- `fast-browser doctor --json` reports the runtime not ready and the extension
  not loaded.
- Chrome is installed, so the row stays `required: true` at `needs-you`.
- `finalizePlan` puts `tool.fast-browser` in `requiredMissing`, `canInstall` is
  false, and the row's remedy points at a directory that does not exist yet.

No user action clears it. The clean room never caught this because the guest has
no Chrome, which is the exact condition under which the row goes optional.

This is the MAT-386 section 9 rule, "a checklist row that only Install can
satisfy must not gate Install", and the fix has direct precedent one function
away: `herdrRow` already keeps `required: true` for a missing or too-old binary
and drops to `required: false` with an `optionalNote` for the
integration-not-installed case. Section 6 ratified that as "binaries gate,
follow-ups don't". Fast Browser's runtime and extension are follow-ups by the
same definition.

## Design

### Rows

**`tool.fast-browser`** keeps `required: true` for exactly one status,
`missing`, which is the binary failing to resolve and therefore a broken bundle:
precisely the defect that should gate. Every other non-ready status, `needs-you`
for a runtime that is not ready and `error` for a doctor that timed out or
returned nothing parseable, drops to `required: false` with
`optionalNote: "Installed by Install (fastbrowser.setup)."`, matching
`herdrRow`'s shape and `INSTALLED_BY_INSTALL_NOTE`'s wording. The row's scope
narrows to the binary plus `doctor`'s `runtime.ok`; the extension leaves it.

**`tool.fast-browser-extension`** is new and owns `extension.loaded` and
`pairing.ok`. It never gates Install. It is `skipped` when Chrome is absent
(nothing to load into), `ready` when loaded and paired, and `needs-you`
otherwise, with a `steps` action that distinguishes the two states:

- not loaded: open `chrome://extensions`, turn on Developer mode, Load unpacked
  from `~/.fast-browser/extension/current/unpacked`, then pair, then
  `fast-browser doctor`.
- loaded but not paired: only the pairing steps.

Pairing is read from `doctor`'s own `pairing` check rather than from a rule of
rt's own. See the correction below: an earlier draft of this spec claimed a
loaded-but-unpaired extension was broken, which is not true of fast-browser's
default manual connection.

Because this row is never required, `rowToCheck` maps its non-ready states to
`warn`/`warning`, so `rt verify` reports it without failing and the `verify`
Install step does not end a successful run in failure.

**`tool.plugins`** is new and covers leg 2. It runs `claude plugin list` once
and checks the three `BASE_PLUGINS` entries with the same anchored matcher
`packRow` uses, so a plugin named `chat` can never match inside another entry.
It reports `ready` with the count when all three are present, `missing` naming
the absent ones, `skipped` when claude is not installed, and `error` on a
timeout or any other non-zero exit (never `skipped`, which would read as
"nothing to check here").

`tool.plugins` joins `INSTALL_SATISFIED_IDS` in `plan.ts`: `required: false`
with `INSTALLED_BY_INSTALL_NOTE` in plan mode so it cannot deadlock
`canInstall`, `required: true` in status mode so a chat plugin that failed to
land is a critical `rt verify` failure instead of nothing at all.

`ciNeverCritical` gains `tool.plugins` under the same reasoning that already
exempts `tool.claude`: a CI runner has no claude, so the row's absence there is
the designed shape rather than a break. Its existing
`tool.fast-browser && status !== "missing"` clause goes at the same time. That
clause forgave exactly the states the row no longer marks required, so it is now
dead: `rowToCheck` already returns `warn` for them, and `missing`, the one state
that still gates, was never covered by it.

### Done screen

`DoneScreen` says "Everything's working" unconditionally and has no surface for
a step the user still owes. `ReadinessModel` already exposes `allRows` and a
`limitedModeAvailable` notion built on the same predicate, so the data is
present.

The screen takes the `ReadinessModel`, calls `recheckAll()` once on appear, and
renders a "Still to do" section listing rows that are not `ready`, not
`required`, and carry a `steps` or `open-url` action. Each entry reuses the
existing `RowView`/`StepsSheet` path rather than growing a second renderer. When
the list is empty the section does not appear and the screen reads exactly as it
does today.

### What does not change

No new Install step, so `STEP_IDS`, the `STEPS` registry and the step list in
`docs/superpowers/specs/2026-08-21-rt-setup-contract.md` are untouched. No new
command module, so `lib/module-registry.ts` is untouched. No new settings key,
per the registry coordination hold on this branch (rt main's registry is behind
published rt-client 0.14.0). No `rt-client` publish. Nothing drives Chrome.

## Testing

- `validators-tools.test.ts`: the "still required" test is replaced by its
  inverse, with the reason stated in the test name. New cases for the binary
  gating, for a runtime that is not ready dropping to optional, and for the new
  extension row across Chrome absent, not loaded, loaded but unpaired, and
  loaded and paired.
- A new validator test for `tool.plugins` covering all three present, one
  absent, claude absent, a non-zero exit and a timeout.
- `plan.test.ts`: `tool.plugins` flips required across plan and status mode.
- `verify` test: the extension row's non-ready state is a warning, not a
  critical failure.
- Swift: a Done-screen test asserting the "Still to do" section appears with an
  unloaded extension and is absent when every optional row is ready.

## Follow-ups

**The Rust herdr plugin is installed by nothing.** MAT-401 defines "the herdr
chat plugin" as the Claude Code `chat` plugin, which is what this spec treats.
There is a second, unrelated artifact with a similar name:
`~/Documents/GitHub/herdr-chat`, a Rust herdr plugin (`herdr-plugin.toml`, id
`m4ttstack.chat`) installed with `herdr plugin install m4ttstack/herdr-chat`. It
is a sibling client of `rt chat`, not a dependency of the Claude plugin, and no
part of setup installs it. Recorded here rather than absorbed into this branch.

**Upstream, so the extension stops being manual.** Ticket body, to be filed
under MAT-386:

> Fast Browser's Chrome extension can only be installed by hand, and rt cannot
> change that. The extension ships as an unpacked directory downloaded from a
> pinned GitHub release; there is no CRX and no Web Store listing. Chrome's
> unattended paths (per-user `External Extensions/<id>.json`, or
> `ExtensionSettings` policy) both need a CRX or an update URL, and packing a
> CRX that preserves the stable id `bjlfojdaaanoliidngocnbcalhpfmlie` requires
> the private half of the manifest `key`, which only fast-browser holds.
> Two ways out, both owned by fast-browser: publish the extension to the Chrome
> Web Store, or ship a signed CRX behind a self-hosted update manifest. Once
> either exists, rt writes
> `~/Library/Application Support/Google/Chrome/External Extensions/bjlfojdaaanoliidngocnbcalhpfmlie.json`
> during `fastbrowser.setup` and the manual step disappears. Pairing (the
> Keychain reconnect token) is a separate manual step and would remain.

## Rulings this branch establishes

1. Fast Browser's binary gates Install; its runtime, extension and pairing do
   not. This reverses the MAT-386 section 6 "required once Chrome exists"
   ruling, which deadlocked any Chrome-having Mac, and brings the row in line
   with the herdr ruling in the same file. The correction below revises the
   root cause: the row was unclearable not only because Install creates the
   runtime, but because rt could not read `doctor` at all.
2. A row that observes work an Install step performs belongs in
   `INSTALL_SATISFIED_IDS`, not in a hand-rolled required flag.
3. A manual step that survives Install is named on the Done screen. "Everything's
   working" is only said when it is true.

## Correction, 2026-09-03: what `doctor` and `claude plugin list` actually emit

The whole-branch review found two Critical defects in the first implementation
of this design, and both were confirmed against the real CLIs on a live machine
rather than against fixtures. Both trace to the same root cause: the tests were
written from invented output shapes, so they agreed with code that had never
worked once on a real machine. The captures now live beside the plan in the
SDD workspace and every fixture is sampled from them.

**`fast-browser doctor --json` has no `runtime`/`extension`/`pairing` objects.**
It returns `{ schemaVersion, ok, profile, checks: [{ id, status, message,
remediation }] }`, with ids including `runtime-checksum`, `extension-artifact`,
`extension-installed`, `extension-loaded` and `pairing`. Every field the first
implementation read was `undefined` on every machine in every state. On a
machine where all 21 checks report `pass`, rt still said "runtime not ready" and
"not loaded in Chrome", and the Done screen told the user to load an extension
they had already loaded. The rows now look each check up by id and treat `pass`
as satisfied; an id absent from the report means rt could not determine the
answer and says so, rather than accusing the user of a step they did not skip.

This misread predates this branch, which is why it went unnoticed: under the old
gate, "extension not loaded" was the row's ordinary-looking state. Building a
dedicated row and a Done-screen section on top of it is what made the wrongness
permanent and user-visible.

**Pairing is not an unconditional outstanding step.** fast-browser's `pairing`
check passes whenever the connection mode is not `auto`, and manual connection
is its documented default. A manually connected Fast Browser drives Chrome
fine. So pairing is outstanding only when the user opted into auto pairing and
the token is missing, which is exactly what doctor's own check already encodes.
rt trusts that check instead of inventing a second rule.

**`claude plugin list` cannot be scraped.** Real output indents each entry and
prefixes it with a chevron glyph, so a `trim().startsWith(entry)` match is false
for every plugin even when all are installed and enabled. Because `tool.plugins`
is Install-satisfied, it is `required: true` in `mode: "status"`, the mode the
`verify` Install step runs... so `verify` failed critically after a SUCCESSFUL
install, the user never reached Done, and the wizard has no close button before
then. Both `tool.plugins` and `pack.<pack>` now read `claude plugin list --json`,
whose entries carry `id` and `enabled` directly, the same way
`lib/skills/sources.ts` already did. The pack rows had been silently
false-`missing` all along; this branch did not cause that, it put an
always-present row on the install's critical path and made it fatal.

`tool.plugins` also reports an installed-but-disabled baseline plugin as
`invalid` rather than `ready`: `plugins.install` treats `claude plugin enable` as
best effort, so a plugin that installed and failed to enable is inert.

**The Done screen tracks real obligations.** The first predicate, "optional, not
ready, action is steps or open-url", also selected rows whose own `optionalNote`
reads "Works without this" (`tool.chrome`, `home.backup`), so a solo Mac with no
Chrome and a local-only home repo read "2 steps left for you" when nothing was
owed. The wizard header also still said "Everything's working" unconditionally,
above a body saying the opposite.

### The rule this earns

A validator that parses another tool's output is only as good as the sample its
tests were written from. Capture the real output and build the fixture from it;
an invented fixture tests the author's belief about the format, which is exactly
what was wrong in both defects here.
